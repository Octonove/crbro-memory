// ─── 2.11: what CRBRO costs in context, and whether its answers agree ──
//
// The audit of 2026-11-13 measured, on a lived-in brain: a boot of 21,527
// characters whose message said "33 open item(s), 15 recently closed" next to
// open_items_total 24 and recently_closed_total 12; a recall row that carried
// temporal, verification, freshness, relevance and provenance at their default
// values; an add_pending that echoed the whole context (> 20,000 characters)
// to confirm one item; "not found" answers without isError; a forget token
// that stayed valid when a preference was added. These tests pin the fixes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fitToBudget } from '../src/utils/budget.js';
import { sortOpenItems } from '../src/engine/prefrontal.js';

let root: string;
let client: Client;
const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<any>;
const body = (r: any) => JSON.parse(r.content[0].text);
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const contextFile = () => path.join(root, 'prefrontal', 'active_context.json');

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-cost-'));
  process.env.CRBRO_PATH = root;
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: 'cost-test', version: '0.0.0' });
  await client.connect(ct);
  await call('crbro_boot');
});

afterAll(async () => {
  await client?.close();
  delete process.env.CRBRO_PATH;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('fitToBudget: what is cut first, and what the notice says', () => {
  const payload = () => ({
    open_items: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, text: 'o'.repeat(200) })),
    recent_sessions: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, text: 's'.repeat(200) })),
  });

  it('cuts the dropFirst keys before a larger list that matters more', () => {
    const p = payload();
    p.open_items.push(...Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, text: 'o'.repeat(200) })));
    const out: any = fitToBudget(p, { budget: 6_000, dropFirst: ['recent_sessions', 'open_items'] });
    expect(out.truncated.entries_dropped.recent_sessions).toBeDefined();
    expect(out.recent_sessions.length).toBeLessThan(20);
    // Largest-first alone would have cut open_items (30 rows) before the sessions.
    expect(out.recent_sessions.length).toBeLessThanOrEqual(out.open_items.length);
  });

  it('names only the doors of what was actually cut', () => {
    const out: any = fitToBudget(payload(), {
      budget: 6_000, dropFirst: ['recent_sessions', 'open_items'],
      moreByKey: { recent_sessions: 'Sessions: view=sessions.', open_items: 'Open items: crbro_context.', hot_topics: 'Hot: view=neurons.' },
      howToGetMore: 'generic',
    });
    expect(out.truncated.how_to_get_more).toContain('view=sessions');
    expect(out.truncated.how_to_get_more).not.toContain('view=neurons');
  });

  it('says so when the kept blocks alone are over budget', () => {
    const out: any = fitToBudget({ protocol: 'p'.repeat(9_000), rows: [1, 2, 3] }, { budget: 2_000, keep: ['protocol'] });
    expect(out.protocol.length).toBe(9_000);
    expect(out.truncated.over_budget_after_cuts).toBe(true);
  });
});

describe('sortOpenItems', () => {
  it('puts what is due first, then the newest', () => {
    const out = sortOpenItems([
      { id: 'old', added: ago(90) }, { id: 'due-late', added: ago(5), due: '2099-01-01' },
      { id: 'new', added: ago(1) }, { id: 'due-soon', added: ago(50), due: '2030-01-01' },
    ]);
    expect(out.map(t => t.id)).toEqual(['due-soon', 'due-late', 'new', 'old']);
  });
});

describe('crbro_boot (2.11)', () => {
  it('serves coherent counts, newest open items first, titles for closed ones, and flags old undated items', async () => {
    const ctx = JSON.parse(await fs.readFile(contextFile(), 'utf8'));
    ctx.pending_tasks = [
      ...Array.from({ length: 14 }, (_, i) => ({
        id: `p_g${i}`, text: `Global item ${i} ` + 'x'.repeat(400), added: ago(100 - i), status: 'open',
      })),
      { id: 'p_alpha', text: 'Alpha item', added: ago(2), status: 'open', project: 'alpha' },
      { id: 'p_beta', text: 'Beta item', added: ago(1), status: 'open', project: 'beta' },
    ];
    ctx.recently_closed = Array.from({ length: 12 }, (_, i) => ({
      id: `p_c${i}`, text: `Closed ${i} ` + 'y'.repeat(300), added: ago(60), closed: ago(i + 1), status: 'done',
      ...(i % 3 === 0 ? { project: 'beta' } : {}),
    }));
    await fs.writeFile(contextFile(), JSON.stringify(ctx));

    const b = body(await call('crbro_boot'));
    // No project: every item, one order (S12): the newest first, not the oldest.
    expect(b.pending.scope).toBe('all');
    expect(b.pending.open_total).toBe(16);
    expect(b.pending.closed_total).toBe(12);
    expect(b.open_items.map((t: any) => t.id).slice(0, 3)).toEqual(['p_beta', 'p_alpha', 'p_g13']);
    expect(b.pending.open_returned).toBe(b.open_items.length);
    expect(b.message).toContain('16 open item(s), 12 recently closed');
    // Texts cut, ages shown, old undated items flagged — nothing deleted.
    for (const t of b.open_items) {
      expect(t.text.length).toBeLessThanOrEqual(201);
      expect(typeof t.age_days).toBe('number');
    }
    expect(b.open_items.find((t: any) => t.id === 'p_g13').review).toBe(true);
    expect(b.open_items.find((t: any) => t.id === 'p_beta').review).toBeUndefined();
    expect(b.pending.review.count).toBe(14);
    // Closed: a short list of titles.
    expect(b.recently_closed.length).toBeLessThanOrEqual(8);
    for (const c of b.recently_closed) {
      expect(Object.keys(c).sort()).toEqual(['closed', 'id', 'text']);
      expect(c.text.length).toBeLessThanOrEqual(81);
    }
    // What left the boot: reachable elsewhere, and the boot says where.
    expect(b.retired_tools).toBeUndefined();
    expect(b.open_items_total).toBeUndefined();
    expect(b.more).toContain('crbro_context');
    expect(b.memory_discipline.length).toBeLessThan(1_000);

    // With a project: the same counts in the message as in pending (S3).
    const p = body(await call('crbro_boot', { project: 'C:/code/beta' }));
    const id = p.project_context.id;
    const scoped = ctx.pending_tasks.filter((t: any) => !t.project || t.project === id).length;
    const closedScoped = ctx.recently_closed.filter((t: any) => !t.project || t.project === id).length;
    expect(p.pending.scope).toBe('project');
    expect(p.pending.open_total).toBe(scoped);
    expect(p.pending.closed_total).toBe(closedScoped);
    expect(p.message).toContain(`${scoped} open item(s), ${closedScoped} recently closed`);
  });

  it('a bound neuron that no longer exists is skipped and named, never a failed boot (S8)', async () => {
    const real = body(await call('crbro_learn', { topic: 'Gamma real', type: 'fact', content: 'Gamma existe de verdad.' })).neuron_id;
    const r = await call('crbro_boot', { project: 'C:/code/gamma', project_neurons: [real, 'project_que_ya_no_existe'] });
    expect(r.isError).toBeFalsy();
    const b = body(r);
    expect(b.unknown_project_neurons).toEqual(['project_que_ya_no_existe']);
    expect(b.project_context.neurons).toEqual([real]);
    expect(b.protocol_enforcement === undefined || typeof b.protocol_enforcement === 'string').toBe(true);
    await call('crbro_boot');   // back to no project for the next tests
  });
});

describe('crbro_recall rows (2.11)', () => {
  it('leaves out fields at their default, keeps relevance as a score', async () => {
    await call('crbro_learn', { topic: 'Halcon', type: 'fact', content: 'El servidor halcon escucha en el puerto 9443.', keywords: ['halcon'] });
    const r = await call('crbro_recall', { query: 'halcon puerto' });
    const row = r.structuredContent.results[0];
    expect(row.neuron_id).toBe('project_halcon');
    for (const k of ['temporal', 'verification', 'freshness', 'provenance', 'matched_terms', 'query_terms', 'relevance_score']) {
      expect(row, k).not.toHaveProperty(k);
    }
    expect(row.confidence).toBeTruthy();
    expect(typeof row.relevance.score).toBe('number');
    expect(row.relevance.meaning).toBeUndefined();
  });

  it('has_more does not count rows the history intent left out (S16)', async () => {
    await call('crbro_learn', { topic: 'Fenix actual', type: 'fact', content: 'Fenix corre en el nodo zafiro.' });
    await call('crbro_learn', { topic: 'Fenix archivo', type: 'fact', content: 'Fenix corria en el nodo zafiro en 2020.', temporal: 'historical' });
    const r = body(await call('crbro_recall', { query: 'fenix nodo zafiro', intent: 'history' }));
    expect(r.excluded_nonhistorical).toBe(1);
    expect(r.has_more).toBe(false);
    expect(r.hint).not.toMatch(/more neurons? matched/);
  });

  it('a corrupt neuron costs its labels, not the whole answer (S7)', async () => {
    const id = body(await call('crbro_learn', { topic: 'Grulla', type: 'fact', content: 'La grulla migra en otoño hacia Gallocanta.', keywords: ['grulla'] })).neuron_id;
    await fs.writeFile(path.join(root, 'cortex', `${id}.json`), '{ not json');
    const r = await call('crbro_recall', { query: 'grulla Gallocanta' });
    expect(r.isError).toBeFalsy();
    const out = body(r);
    expect(out.results.map((x: any) => x.neuron_id)).toContain(id);   // served from the index
    expect(out.unreadable_neurons).toEqual([id]);
    await fs.rm(path.join(root, 'cortex', `${id}.json`), { force: true });
  });
});

describe('writes confirm, they do not echo (2.11)', () => {
  it('crbro_context add_pending returns the item and the counts, not the context', async () => {
    const r = body(await call('crbro_context', { add_pending: 'Revisar el certificado de halcon', due: '2030-05-01' }));
    expect(r.written).toBe(true);
    expect(r.added).toMatchObject({ text: 'Revisar el certificado de halcon', due: '2030-05-01' });
    expect(r.added.id).toMatch(/^p_/);
    expect(typeof r.counts.open).toBe('number');
    expect(r.pending_tasks).toBeUndefined();
    expect(JSON.stringify(r).length).toBeLessThan(1_000);
    const full = body(await call('crbro_context', { resolve_pending: r.added.id, return_context: true }));
    expect(Array.isArray(full.pending_tasks)).toBe(true);
    expect(full.resolved).toHaveLength(1);
  });
});

describe('not found is an error (S13)', () => {
  it('revise, forget, map, space and share flag isError when nothing could be done', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['crbro_revise', { neuron: 'no_such_neuron', facts: ['x'] }],
      ['crbro_forget', { neuron: 'no_such_neuron', facts: ['x'] }],
      ['crbro_forget', { neuron: 'no_such_neuron', entire: true }],
      ['crbro_forget', { neuron: 'no_such_neuron', merge_into: 'project_halcon' }],
      ['crbro_forget', { neuron: 'project_halcon', merge_into: 'no_such_neuron' }],
      ['crbro_forget', { neuron: 'no_such_neuron', restore: true }],
      ['crbro_forget', { session: '1999-01-01' }],
      ['crbro_map', { neuron: 'no_such_neuron' }],
      ['crbro_space', { action: 'leave' }],
      ['crbro_space', { action: 'create', name: 'x' }],
      ['crbro_share', { neuron: 'no_such_neuron', space: 'nada' }],
    ];
    for (const [tool, args] of cases) {
      const r = await call(tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
    }
  });
});

describe('crbro_forget confirm_token covers the content (S15)', () => {
  it('goes stale when a preference is added or a fact is swapped for another', async () => {
    const id = body(await call('crbro_learn', { topic: 'Ibis', type: 'fact', content: 'El ibis vive en el humedal norte.' })).neuron_id;
    const t1 = body(await call('crbro_forget', { neuron: id, entire: true })).confirm_token;
    await call('crbro_learn', { neuron_id: id, type: 'preference', content: 'Prefiere los informes del ibis en tabla.' });
    const stale = await call('crbro_forget', { neuron: id, entire: true, confirm_token: t1 });
    expect(stale.isError).toBe(true);

    const t2 = body(await call('crbro_forget', { neuron: id, entire: true })).confirm_token;
    expect(t2).not.toBe(t1);
    // Same counts, different fact: still a different neuron than the one shown.
    await call('crbro_forget', { neuron: id, facts: ['El ibis vive en el humedal norte.'] });
    await call('crbro_learn', { neuron_id: id, type: 'fact', content: 'El ibis vive en el humedal sur.' });
    expect((await call('crbro_forget', { neuron: id, entire: true, confirm_token: t2 })).isError).toBe(true);

    const t3 = body(await call('crbro_forget', { neuron: id, entire: true })).confirm_token;
    expect(t3).toMatch(/^[a-f0-9]{8}$/);
    // Reading the neuron in between changes nothing.
    await call('crbro_inspect', { view: 'neuron', neuron: id });
    await call('crbro_recall', { query: 'ibis humedal' });
    expect(body(await call('crbro_forget', { neuron: id, entire: true, confirm_token: t3 })).removed).toBe('neuron');
  });
});

describe('crbro_learn soft warnings (M11)', () => {
  it('a long fact is stored with a suggestion to split it; a short one is not', async () => {
    const long = body(await call('crbro_learn', { topic: 'Jilguero', type: 'fact', content: 'El jilguero ' + 'canta mucho y vive en el parque. '.repeat(25) }));
    expect(long.action).not.toBe('skipped');
    expect(long.long_fact_warning).toMatch(/one claim per crbro_learn/);
    const short = body(await call('crbro_learn', { topic: 'Jilguero', type: 'fact', content: 'El jilguero come cardos.' }));
    expect(short.long_fact_warning).toBeUndefined();
    expect(short.large_neuron_warning).toBeUndefined();
  });

  it('a neuron past 300 entries is stored and pointed at move_to', async () => {
    const id = body(await call('crbro_learn', { topic: 'Kiwi', type: 'fact', content: 'Kiwi hecho 0.' })).neuron_id;
    const file = path.join(root, 'cortex', `${id}.json`);
    const n = JSON.parse(await fs.readFile(file, 'utf8'));
    n.patterns = Array.from({ length: 305 }, (_, i) => `Kiwi patron numero ${i} distinto`);
    await fs.writeFile(file, JSON.stringify(n));
    const r = body(await call('crbro_learn', { neuron_id: id, type: 'fact', content: 'Kiwi hecho final.' }));
    expect(r.action).not.toBe('skipped');
    expect(r.large_neuron_warning).toMatch(/crbro_revise move_to/);
  });
});

describe('crbro_inspect index (S14)', () => {
  it('leaves default quality fields out of the index rows', async () => {
    const id = body(await call('crbro_learn', { topic: 'Lince', type: 'fact', content: 'El lince vive en Doñana.' })).neuron_id;
    const idx = body(await call('crbro_inspect', { view: 'neuron', neuron: id }));
    for (const e of idx.entries) {
      expect(e.verification).toBeUndefined();
      expect(e.freshness).toBeUndefined();
      expect(e.temporal).toBeUndefined();
    }
  });
});
