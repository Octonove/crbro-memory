// ─── The diary is searchable, and never outranks a fact ──────────
//
// Session summaries carry the narrative — what was done, when, why a thing
// was left half-way — and until 2.2 none of it was reachable by content: a
// question like "what did we do about Glama on Thursday" had no answer
// unless someone had saved it as a fact. Now a session hit comes back in a
// list of its own, sessions_matched, with the paragraph that mentions it and
// the id that reads the whole day. What these tests pin: the hit exists, it
// is a separate list, a fact still wins the neuron list, consolidate indexes
// the day at once, a rebuild indexes the whole diary, and one log can be
// read whole by id.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let root: string;
let client: Client;
const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<any>;
const body = (r: any) => JSON.parse(r.content[0].text);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-sessions-'));
  process.env.CRBRO_PATH = root;
  process.env.CRBRO_SEMANTIC = '0';
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: 'sessions-test', version: '1.0.0' });
  await client.connect(ct);
  await call('crbro_boot');
  await call('crbro_learn', { topic: 'Glama', type: 'fact', content: 'Glama construye la imagen Docker de CRBRO con debian trixie.' });
});

afterAll(async () => {
  await client?.close();
  delete process.env.CRBRO_PATH;
  await fs.rm(root, { recursive: true, force: true });
});

describe('sessions_matched', () => {
  it('a word that lives only in a session summary is found, in its own list', async () => {
    const c = body(await call('crbro_consolidate', {
      summary: 'Hoy peleamos con el panel de Glama: el botón de Sync Server solo responde al clic por coordenadas.\n\nDespués publicamos la release y Roberto probó el instalador xilófono en su portátil.',
    }));
    const r = body(await call('crbro_recall', { query: 'xilófono' }));
    expect(r.total_results).toBe(0);                       // no neuron says it
    expect(r.sessions_matched).toHaveLength(1);
    const hit = r.sessions_matched[0];
    expect(hit.session_id).toBe(c.session_id);
    expect(hit.preview).toContain('xilófono');
    expect(hit.preview).not.toContain('coordenadas');       // the paragraph, not the whole day
    expect(hit.entry_id).toMatch(/^session_\d{4}-\d{2}-\d{2}#\d+$/);
    expect(r.hint).toContain('sessions_matched');
  });

  it('a fact still answers in results, the session only in sessions_matched', async () => {
    const r = body(await call('crbro_recall', { query: 'Glama' }));
    expect(r.results[0].neuron_id).toBe('project_glama');
    expect(r.results.some((x: any) => String(x.neuron_id).startsWith('session:'))).toBe(false);
    expect(r.sessions_matched.length).toBeGreaterThanOrEqual(1);
  });

  it('several phrasings fuse the session hits too', async () => {
    const r = body(await call('crbro_recall', { query: 'instalador', queries: ['portátil de Roberto'] }));
    expect(r.sessions_matched).toHaveLength(1);
  });

  it('one log can be read whole by id, and an unknown id says so', async () => {
    const r = body(await call('crbro_recall', { query: 'xilófono' }));
    const id = r.sessions_matched[0].session_id;
    const whole = body(await call('crbro_inspect', { view: 'sessions', session: id }));
    expect(whole.returned).toBe(1);
    expect(whole.sessions[0].session_id).toBe(id);
    expect(whole.sessions[0].summary).toContain('coordenadas');
    const missing = await call('crbro_inspect', { view: 'sessions', session: 'session_1999-01-01' });
    expect(missing.isError).toBe(true);
  });

  it('a rebuild indexes the whole diary, not only the day just logged', async () => {
    // Write a log straight to disk, as an older version would have left it.
    const viejo = {
      session_id: 'session_2020-02-02', date: '2020-02-02', duration_estimate: 'unknown',
      topics_touched: [], summary: 'Sesión antigua sobre el clavicémbalo del cliente.',
      key_facts_added: 0, decisions_made: 0, new_neurons_created: 0, synapses_updated: 0,
    };
    await fs.writeFile(path.join(root, 'hippocampus', 'session_2020-02-02.json'), JSON.stringify(viejo));
    const before = body(await call('crbro_recall', { query: 'clavicémbalo' }));
    expect(before.sessions_matched ?? []).toHaveLength(0);
    await call('crbro_maintenance', { dry_run: false });     // rebuilds the index
    const after = body(await call('crbro_recall', { query: 'clavicémbalo' }));
    expect(after.sessions_matched).toHaveLength(1);
    expect(after.sessions_matched[0].session_id).toBe('session_2020-02-02');
    expect(after.sessions_matched[0].date).toBe('2020-02-02');
  });
});
