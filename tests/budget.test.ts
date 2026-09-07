// ─── Nothing leaves bigger than a client can carry ───────────────
//
// From the field, not from theory: on a 1,145-neuron brain a single
// crbro_inspect view=neuron came back at ~132,000 tokens, crbro_boot at
// ~20,000, and the client — which caps a tool result at 25,000 — wrote them
// to a file instead of reading them. 264 dumps of one neuron, 154 of boot.
//
// These tests pin the two halves of the fix: results fit, and whatever was
// cut is declared with the call that fetches it. A silent trim would be
// worse than the bug, because the model would carry on as if it had read
// everything.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fitToBudget, DEFAULT_BUDGET_CHARS } from '../src/utils/budget.js';

describe('fitToBudget', () => {
  it('leaves a small payload untouched, object identity included', () => {
    const small = { a: 'x', list: [1, 2, 3] };
    expect(fitToBudget(small)).toBe(small);
  });

  it('shortens a long text and says how much was left behind', () => {
    const out: any = fitToBudget({ summary: 'y'.repeat(50_000) }, { budget: 5_000, stringCap: 400 });
    expect(out.summary.length).toBeLessThan(600);
    expect(out.summary).toContain('more characters');
    expect(out.truncated.texts_shortened.summary).toEqual({ returned: 400, total: 50_000 });
    expect(out.truncated.original_chars).toBeGreaterThan(out.truncated.returned_chars);
  });

  it('drops array entries only after shortening texts, and reports the totals', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, body: 'z'.repeat(300) }));
    const out: any = fitToBudget({ total: 400, rows }, { budget: 4_000, stringCap: 100 });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4_000 + 900); // + the report itself
    expect(out.rows.length).toBeLessThan(400);
    expect(out.truncated.entries_dropped.rows.total).toBe(400);
    expect(out.truncated.entries_dropped.rows.returned).toBe(out.rows.length);
  });

  it('never empties a list completely', () => {
    const rows = Array.from({ length: 50 }, () => ({ body: 'q'.repeat(5_000) }));
    const out: any = fitToBudget({ rows }, { budget: 500, stringCap: 200 });
    expect(out.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps protected keys whole however big they are', () => {
    const protocolo = 'P'.repeat(30_000);
    const out: any = fitToBudget(
      { protocol_enforcement: protocolo, sessions: Array.from({ length: 90 }, () => ({ s: 'w'.repeat(900) })) },
      { budget: 6_000, stringCap: 300, keep: ['protocol_enforcement'] },
    );
    expect(out.protocol_enforcement).toBe(protocolo);
    expect(out.protocol_enforcement).not.toContain('more characters');
  });

  it('carries the caller instruction on how to get the rest', () => {
    const out: any = fitToBudget({ big: 'b'.repeat(80_000) }, { budget: 1_000, howToGetMore: 'call X with limit' });
    expect(out.truncated.how_to_get_more).toBe('call X with limit');
    expect(out.truncated.reason).toContain('Nothing was deleted');
  });
});

let root: string;
let client: Client;
const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<any>;
const body = (r: any) => JSON.parse(r.content[0].text);
// The client cap is 25,000 tokens and the payload travels twice (text and
// structuredContent), so the JSON itself has to stay well under that.
const chars = (r: any) =>
  (r.content || []).map((c: any) => c.text || '').join('').length +
  (r.structuredContent ? JSON.stringify(r.structuredContent).length : 0);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-budget-'));
  process.env.CRBRO_PATH = root;
  process.env.CRBRO_SEMANTIC = '0';
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: 'budget-test', version: '1.0.0' });
  await client.connect(ct);
  await call('crbro_boot');

  // A neuron far past what one result can carry: 120 facts of 3,000 chars.
  await call('crbro_learn', { topic: 'Gordo', type: 'fact', content: 'primero '.repeat(400) });
  for (let i = 0; i < 119; i++) {
    await call('crbro_learn', { neuron_id: 'project_gordo', type: 'fact', content: 'hecho ' + i + ' ' + 'x'.repeat(3_000) });
  }
}, 180_000);

afterAll(async () => {
  await client?.close();
  delete process.env.CRBRO_PATH;
  await fs.rm(root, { recursive: true, force: true });
});

describe('the server never emits a result a client would refuse', () => {
  it('a huge neuron in full comes back inside the budget, and says it was shortened', async () => {
    const r = await call('crbro_inspect', { view: 'neuron', neuron: 'project_gordo', detail: 'full' });
    expect(chars(r)).toBeLessThan(2 * (DEFAULT_BUDGET_CHARS + 2_000));
    const payload = body(r);
    expect(payload.truncated).toBeDefined();
    expect(payload.truncated.how_to_get_more).toContain('limit');
  });

  it('the default view of a huge neuron is an index: small, complete, with ids', async () => {
    const r = await call('crbro_inspect', { view: 'neuron', neuron: 'project_gordo' });
    const idx = body(r);
    expect(idx.truncated).toBeUndefined();
    expect(idx.counts.fact).toBe(120);
    expect(idx.entries.length).toBe(25);                       // default page
    expect(idx.entries_pagination).toMatchObject({ total: 120, returned: 25, has_more: true, hidden_retired: 0 });
    for (const e of idx.entries) {
      expect(e.id).toMatch(/^[0-9a-f]+$/);
      expect(e.kind).toBe('fact');
      expect(e.preview.length).toBeLessThanOrEqual(170);
      expect(e.chars).toBeGreaterThan(3_000);
    }
    expect(idx.how_to_read).toContain('entries=');
  });

  it('entries=[id] returns exactly those entries in full, and names what it could not find', async () => {
    const idx = body(await call('crbro_inspect', { view: 'neuron', neuron: 'project_gordo', limit: 2 }));
    const [a, b] = idx.entries;
    const r = body(await call('crbro_inspect', { view: 'neuron', neuron: 'project_gordo', entries: [a.id, b.id, 'no_existe'] }));
    expect(r.returned).toBe(2);
    expect(r.entries.map((e: any) => e.id)).toEqual([a.id, b.id]);
    expect(r.entries[0].text.length).toBe(a.chars);
    expect(r.not_found).toEqual(['no_existe']);
  });

  it('a recall hit carries entry_id, and that id opens the entry', async () => {
    const hit = body(await call('crbro_recall', { query: 'primero', limit: 3 }));
    const top = hit.results.find((x: any) => x.neuron_id === 'project_gordo');
    expect(top.entry_id).toMatch(/^[0-9a-f]+$/);
    // The hit is 3,200 characters, so recall hands back its opening, declared,
    // and the id fetches the whole thing.
    expect(top.content_truncated).toBe(true);
    expect(top.content_chars).toBeGreaterThan(1_200);
    const r = body(await call('crbro_inspect', { view: 'neuron', neuron: 'project_gordo', entries: [top.entry_id] }));
    expect(r.returned).toBe(1);
    expect(r.entries[0].text.length).toBe(top.content_chars);
    expect(r.entries[0].text.startsWith(top.matching_content.replace(/…$/, ''))).toBe(true);
  });

  it('boot stays inside the budget with the protocol block intact', async () => {
    for (let i = 0; i < 3; i++) {
      await call('crbro_consolidate', { summary: `sesión ${i}: ` + 'resumen larguísimo '.repeat(3_000) });
    }
    const r = await call('crbro_boot');
    expect(chars(r)).toBeLessThan(DEFAULT_BUDGET_CHARS + 3_000);
    const boot = body(r);
    if (boot.protocol_enforcement) expect(boot.protocol_enforcement).not.toContain('more characters');
  });

  it('view=neurons reports the real total, not the size of the page', async () => {
    for (let i = 0; i < 12; i++) await call('crbro_learn', { topic: `Tema ${i}`, type: 'fact', content: `contenido ${i}` });
    const r = body(await call('crbro_inspect', { view: 'neurons', limit: 3 }));
    expect(r.neurons.length).toBe(3);
    expect(r.returned).toBe(3);
    expect(r.total).toBeGreaterThan(3);
    expect(r.has_more).toBe(true);
  });
});

describe('crbro_learn accepts what its own description recommends', () => {
  it('topic is no longer required on the wire', async () => {
    const tools = (await client.listTools()).tools;
    const learn = tools.find(t => t.name === 'crbro_learn')!;
    const required = (learn.inputSchema as any).required ?? [];
    expect(required).toContain('type');
    expect(required).toContain('content');
    expect(required).not.toContain('topic');
  });

  it('neuron_id alone stores the fact on that neuron', async () => {
    const first = body(await call('crbro_learn', { topic: 'Solo Id', type: 'fact', content: 'el primero' }));
    const id = first.neuron_id;
    const second = body(await call('crbro_learn', { neuron_id: id, type: 'fact', content: 'el segundo, sin topic' }));
    expect(second.neuron_id).toBe(id);
    const neuron = body(await call('crbro_inspect', { view: 'neuron', neuron: id, detail: 'full' }));
    const texts = (neuron.facts || []).map((f: any) => f.text).join(' ');
    expect(texts).toContain('el segundo, sin topic');
  });

  it('with neither topic nor neuron_id it says what to pass', async () => {
    const r = await call('crbro_learn', { type: 'fact', content: 'huérfano' });
    expect(r.isError).toBe(true);
    const text = r.content[0].text;
    expect(text).toContain('topic');
    expect(text).toContain('neuron_id');
  });

  it('a neuron_id that does not exist is refused, not written somewhere else', async () => {
    const r = await call('crbro_learn', { neuron_id: 'project_no_existe', type: 'fact', content: 'no debe guardarse' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('crbro_recall');
    const found = body(await call('crbro_recall', { query: 'no debe guardarse' }));
    expect(found.total_results).toBe(0);
  });

  it('a blank topic does not create a nameless neuron', async () => {
    const r = await call('crbro_learn', { topic: '   ', type: 'fact', content: 'con topic en blanco' });
    expect(r.isError).toBe(true);
  });
});
