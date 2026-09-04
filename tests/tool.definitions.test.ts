// ─── The 15 tool definitions, as a client sees them (2.0) ────────
//
// Glama scored Behavioral Transparency 2/5 on four tools because nothing in
// the definition said whether they read or write. Now every tool carries a
// title and MCP annotations, and the read tools with a stable shape declare
// an outputSchema honoured with structuredContent. This test speaks real
// MCP to the server over an in-memory transport, so what it checks is what
// a client gets — not what the source intends.
//
// 2.0 folded the nine read/list tools into crbro_inspect (view=...), the
// session log into crbro_consolidate and crbro_sync into crbro_space
// action=sync. Boot serves the old names as retired_tools so a model that
// learned the 1.x surface can find its way.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let root: string;
let client: Client;
let tools: any[];

const READ_ONLY = ['crbro_inspect', 'crbro_recall', 'crbro_audit'];
const DESTRUCTIVE = ['crbro_maintenance', 'crbro_map', 'crbro_secret', 'crbro_forget', 'crbro_connect', 'crbro_context'];
const STRUCTURED = ['crbro_inspect', 'crbro_recall', 'crbro_audit'];
const RETIRED = [
  'crbro_status', 'crbro_neuron', 'crbro_neurons', 'crbro_hot_topics', 'crbro_connections',
  'crbro_sessions', 'crbro_global_map', 'crbro_session_log', 'crbro_sync',
];

const body = (r: any) => JSON.parse(r.content[0].text);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-tools-'));
  // The brain root is read when brain.ts loads, so the env must be set
  // before the server module is imported — never the user's real brain.
  process.env.CRBRO_PATH = root;
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(ct);
  tools = (await client.listTools()).tools;
  // A fresh root has no brain yet: boot creates it, as every session does.
  await client.callTool({ name: 'crbro_boot', arguments: {} });
});

afterAll(async () => {
  await client.close();
  delete process.env.CRBRO_PATH;
  await fs.rm(root, { recursive: true, force: true });
});

describe('tools/list', () => {
  it('registers exactly 15 tools, each with a title and annotations', () => {
    expect(tools.length).toBe(15);
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.annotations, t.name).toBeTruthy();
      expect(typeof t.annotations.readOnlyHint, t.name).toBe('boolean');
      expect(typeof t.annotations.destructiveHint, t.name).toBe('boolean');
    }
  });

  it('registers none of the retired names', () => {
    const names = tools.map(t => t.name);
    for (const old of RETIRED) expect(names, old).not.toContain(old);
  });

  it('marks the readers read-only and the writers not', () => {
    const ro = tools.filter(t => t.annotations.readOnlyHint).map(t => t.name).sort();
    expect(ro).toEqual([...READ_ONLY].sort());
  });

  it('marks what can destroy as destructive', () => {
    const d = tools.filter(t => t.annotations.destructiveHint).map(t => t.name).sort();
    expect(d).toEqual([...DESTRUCTIVE].sort());
    // A read-only tool can never be destructive.
    for (const t of tools) if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint).toBe(false);
  });

  it('declares an outputSchema on the stable-shaped readers', () => {
    const s = tools.filter(t => t.outputSchema).map(t => t.name).sort();
    expect(s).toEqual([...STRUCTURED].sort());
  });

  it('keeps every description under 1,000 characters', () => {
    for (const t of tools) expect(t.description.length, t.name).toBeLessThan(1000);
  });

  it('never mentions a retired tool name in a description or parameter text', () => {
    for (const t of tools) {
      const text = t.description + ' ' + JSON.stringify(t.inputSchema ?? {});
      for (const old of RETIRED) {
        expect(text, `${t.name} mentions ${old}`).not.toMatch(new RegExp(old + '\\b'));
      }
    }
  });

  it('tells the model when to use each tool instead of its neighbour', () => {
    // The pairs a model confuses most: the three lifecycle verbs, the two
    // readers, and session close versus the working context. Each side must
    // name the other so the choice is made from the definition alone.
    const desc = (n: string) => tools.find(t => t.name === n)!.description as string;
    const NEIGHBOURS: Record<string, string[]> = {
      crbro_learn: ['crbro_revise', 'crbro_forget'],
      crbro_revise: ['crbro_learn', 'crbro_forget'],
      crbro_forget: ['crbro_revise'],
      crbro_inspect: ['crbro_recall'],
      crbro_recall: ['crbro_inspect'],
      crbro_consolidate: ['crbro_context'],
      crbro_context: ['crbro_consolidate'],
      crbro_boot: ['crbro_consolidate'],
      crbro_map: ['crbro_inspect'],
      crbro_space: ['crbro_share'],
      crbro_share: ['crbro_space'],
    };
    for (const [tool, others] of Object.entries(NEIGHBOURS)) {
      for (const other of others) expect(desc(tool), `${tool} should name ${other}`).toContain(other);
    }
    // And the first sentence says whether the tool reads or writes.
    for (const t of tools) {
      const first = (t.description as string).split(/(?<=[.!?])\s/)[0].toLowerCase();
      expect(first, `${t.name}: "${first}"`).toMatch(/\b(read|reads|read-only|write|writes)\b/);
    }
  });
});

describe('tools/call', () => {
  it('crbro_inspect view=status returns structuredContent matching its schema', async () => {
    const r: any = await client.callTool({ name: 'crbro_inspect', arguments: { view: 'status' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.view).toBe('status');
    expect(r.structuredContent.status.crbro_version).toBeTruthy();
    expect(typeof r.structuredContent.status.total_neurons).toBe('number');
  });

  it('crbro_boot hands over memory_discipline once', async () => {
    const r: any = await client.callTool({ name: 'crbro_boot', arguments: {} });
    const b = body(r);
    expect(b.memory_discipline).toContain('crbro_recall');
    expect(b.memory_discipline).toContain('crbro_consolidate');
  });

  it('crbro_boot maps every retired name to its replacement', async () => {
    const r: any = await client.callTool({ name: 'crbro_boot', arguments: {} });
    const b = body(r);
    expect(b.retired_tools['crbro_status']).toBe('crbro_inspect view=status');
    for (const old of RETIRED) expect(b.retired_tools[old], old).toBeTruthy();
    expect(Array.isArray(b.recent_sessions)).toBe(true);
  });

  it('crbro_recall returns structuredContent with confidence on each result', async () => {
    await client.callTool({ name: 'crbro_learn', arguments: {
      topic: 'Hosting', type: 'fact', content: 'El VPS de Hetzner corre Ubuntu 22.04 con RunCloud.',
    } });
    const r: any = await client.callTool({ name: 'crbro_recall', arguments: { query: 'VPS Hetzner Ubuntu' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.total_results).toBe(1);
    expect(r.structuredContent.results[0].confidence).toBe('strong');
  });

  it('crbro_inspect view=neuron reads one neuron by id and writes nothing', async () => {
    const learned = body(await client.callTool({ name: 'crbro_learn', arguments: {
      topic: 'Hosting', type: 'decision', content: 'Los backups nocturnos van a Backblaze B2.',
    } }));
    const r: any = await client.callTool({ name: 'crbro_inspect', arguments: { view: 'neuron', neuron: learned.neuron_id } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.view).toBe('neuron');
    expect(r.structuredContent.neuron.id).toBe(learned.neuron_id);
    expect(r.structuredContent.neuron.facts_pagination.order).toBe('newest first');
    // readOnlyHint says this tool does not touch the brain, so it must not:
    // reading twice leaves access_count and last_accessed exactly as they were.
    expect(r.structuredContent.neuron.access_bumped).toBeUndefined();
    const again: any = await client.callTool({ name: 'crbro_inspect', arguments: { view: 'neuron', neuron: learned.neuron_id } });
    expect(again.structuredContent.neuron.access_count).toBe(r.structuredContent.neuron.access_count);
    expect(again.structuredContent.neuron.last_accessed).toBe(r.structuredContent.neuron.last_accessed);

    const missing: any = await client.callTool({ name: 'crbro_inspect', arguments: { view: 'neuron', neuron: 'no_such_neuron' } });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('crbro_inspect view=neurons');
  });

  it('crbro_inspect view=neurons, sessions and global_map answer with their own shapes', async () => {
    const n: any = await client.callTool({ name: 'crbro_inspect', arguments: { view: 'neurons', limit: 5 } });
    expect(n.isError).toBeFalsy();
    expect(n.structuredContent.neurons.total).toBeGreaterThan(0);
    expect(n.structuredContent.neurons.neurons[0].id).toBeTruthy();

    const s: any = await client.callTool({ name: 'crbro_inspect', arguments: { view: 'sessions' } });
    expect(s.isError).toBeFalsy();
    expect(Array.isArray(s.structuredContent.sessions.sessions)).toBe(true);

    const g: any = await client.callTool({ name: 'crbro_inspect', arguments: { view: 'global_map' } });
    expect(g.isError).toBeFalsy();
    expect(typeof g.structuredContent.global_map.total_clusters).toBe('number');
    expect(g.structuredContent.global_map.computed_at).toBeTruthy();
  });

  it('crbro_connect action=disconnect on an absent synapse reports removed:false without error', async () => {
    const a = body(await client.callTool({ name: 'crbro_learn', arguments: {
      topic: 'Hosting', type: 'fact', content: 'El dominio principal apunta al VPS por Cloudflare.',
    } })).neuron_id;
    const b = body(await client.callTool({ name: 'crbro_learn', arguments: {
      topic: 'Cloudflare', type: 'fact', content: 'Cloudflare hace de proxy y cache delante del VPS.',
    } })).neuron_id;
    const r: any = await client.callTool({ name: 'crbro_connect', arguments: { action: 'disconnect', from: a, to: b } });
    expect(r.isError).toBeFalsy();
    const out = body(r);
    expect(out.removed).toBe(false);
    expect(out.action).toBe('absent');

    const made = body(await client.callTool({ name: 'crbro_connect', arguments: { from: a, to: b, strength: 0.8 } }));
    expect(made.action).toBe('created');
    expect(made.strength).toBe(0.8);
    const gone = body(await client.callTool({ name: 'crbro_connect', arguments: { action: 'disconnect', from: a, to: b } }));
    expect(gone.removed).toBe(true);

    const bad: any = await client.callTool({ name: 'crbro_connect', arguments: { from: a, to: 'no_such_neuron' } });
    expect(bad.isError).toBe(true);
  });

  it('crbro_forget entire without confirm_token is a dry run that deletes nothing', async () => {
    const id = body(await client.callTool({ name: 'crbro_learn', arguments: {
      topic: 'Disposable', type: 'fact', content: 'Esta neurona existe solo para probar el borrado completo.',
    } })).neuron_id;
    const dry: any = await client.callTool({ name: 'crbro_forget', arguments: { neuron: id, entire: true } });
    expect(dry.isError).toBeFalsy();
    const d = body(dry);
    expect(d.dry_run).toBe(true);
    expect(d.confirm_token).toBeTruthy();
    expect(d.counts.facts).toBe(1);

    const still: any = await client.callTool({ name: 'crbro_inspect', arguments: { view: 'neuron', neuron: id } });
    expect(still.isError).toBeFalsy();

    const stale: any = await client.callTool({ name: 'crbro_forget', arguments: { neuron: id, entire: true, confirm_token: 'nope' } });
    expect(stale.isError).toBe(true);

    const done = body(await client.callTool({ name: 'crbro_forget', arguments: { neuron: id, entire: true, confirm_token: d.confirm_token } }));
    expect(done.removed).toBe('neuron');
    expect(done.backup).toBeTruthy();
    const gone: any = await client.callTool({ name: 'crbro_inspect', arguments: { view: 'neuron', neuron: id } });
    expect(gone.isError).toBe(true);

    const back = body(await client.callTool({ name: 'crbro_forget', arguments: { neuron: id, restore: true } }));
    expect(back.restored_from).toBeTruthy();
    expect(back.merged_into_existing).toBe(false);
  });

  it('crbro_forget refuses two modes at once', async () => {
    const r: any = await client.callTool({ name: 'crbro_forget', arguments: { neuron: 'hosting', entire: true, restore: true } });
    expect(r.isError).toBe(true);
  });

  it('crbro_revise status active brings a superseded fact back into recall', async () => {
    const text = 'OctoChat guarda los mensajes en PostgreSQL quince alojado en Supabase.';
    const id = body(await client.callTool({ name: 'crbro_learn', arguments: {
      topic: 'OctoChat DB', type: 'fact', content: text,
    } })).neuron_id;
    const q = { query: 'mensajes PostgreSQL quince Supabase' };
    // The neuron header (name, tags) can match on its own, so the assertion
    // is on the matched chunks, not on the row count.
    const matched = async () => {
      const r: any = await client.callTool({ name: 'crbro_recall', arguments: q });
      return r.structuredContent.results.map((x: any) => x.matching_content).join('\n');
    };
    expect(await matched()).toContain('PostgreSQL quince');

    const retired = body(await client.callTool({ name: 'crbro_revise', arguments: { neuron: id, facts: [text] } }));
    expect(retired.revised_facts).toBe(1);
    expect(await matched()).not.toContain('PostgreSQL quince');

    const again = body(await client.callTool({ name: 'crbro_revise', arguments: { neuron: id, facts: [text], status: 'active' } }));
    expect(again.revised_facts).toBe(1);
    expect(again.status).toBe('active');
    expect(await matched()).toContain('PostgreSQL quince');
  });

  it('crbro_revise retires entries and edits metadata in one call', async () => {
    const id = body(await client.callTool({ name: 'crbro_learn', arguments: {
      topic: 'OctoChat DB', type: 'decision', content: 'Usamos pgvector para embeddings en OctoChat.',
    } })).neuron_id;
    const r = body(await client.callTool({ name: 'crbro_revise', arguments: {
      neuron: id, entries: ['Usamos pgvector para embeddings en OctoChat.'], note: 'moved to a dedicated store', tags: ['db', 'octochat'],
    } }));
    expect(r.revised_entries).toBe(1);
    expect(r.changed).toContain('tags');

    const n: any = await client.callTool({ name: 'crbro_inspect', arguments: { view: 'neuron', neuron: id } });
    const status = n.structuredContent.neuron.entry_status;
    expect(Object.keys(status).length).toBe(1);
    expect(Object.values(status)[0]).toMatchObject({ status: 'superseded', note: 'moved to a dedicated store' });

    const dup = body(await client.callTool({ name: 'crbro_learn', arguments: {
      topic: 'OctoChat DB', type: 'decision', content: 'Usamos pgvector para embeddings en OctoChat.',
    } }));
    expect(dup.action).toBe('skipped_retired');

    const nothing: any = await client.callTool({ name: 'crbro_revise', arguments: { neuron: id } });
    expect(nothing.isError).toBe(true);
  });

  it('crbro_context with no arguments reads without writing', async () => {
    const r = body(await client.callTool({ name: 'crbro_context', arguments: {} }));
    expect(r.written).toBe(false);
    const w = body(await client.callTool({ name: 'crbro_context', arguments: { add_pending: 'Revisar el certificado TLS del VPS' } }));
    expect(w.written).toBe(true);
    const d = body(await client.callTool({ name: 'crbro_context', arguments: { discard_pending: 'certificado TLS' } }));
    expect(d.discarded.length).toBe(1);
    expect(JSON.stringify(d.recently_closed)).not.toContain('certificado TLS');
  });

  it('crbro_maintenance dry_run leaves prefrontal/global_map.json absent', async () => {
    const r: any = await client.callTool({ name: 'crbro_maintenance', arguments: { dry_run: true } });
    expect(r.isError).toBeFalsy();
    const b = body(r);
    expect(typeof b.repairable).toBe('number');
    expect(typeof b.archives_count).toBe('number');
    await expect(fs.access(path.join(root, 'prefrontal', 'global_map.json'))).rejects.toThrow();
  });

  it('crbro_space action=sync outside any space answers plainly', async () => {
    const r: any = await client.callTool({ name: 'crbro_space', arguments: { action: 'sync' } });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('not in any shared space');
  });

  it('crbro_consolidate logs the session and returns its id', async () => {
    const r = body(await client.callTool({ name: 'crbro_consolidate', arguments: { summary: 'Prueba de la superficie 2.0 de herramientas.' } }));
    expect(r.session_logged).toBe(true);
    expect(r.session_id).toMatch(/^session_/);
    expect(Array.isArray(r.redacted)).toBe(true);
    const boot = body(await client.callTool({ name: 'crbro_boot', arguments: {} }));
    expect(boot.last_session).toBe(r.session_id);
  });
});
