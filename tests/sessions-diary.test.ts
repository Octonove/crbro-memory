// ─── The diary, refuted ───────────────────────────────────────────
//
// What two refutation passes found in 2.2 before it shipped, pinned here so
// it stays fixed: a deleted day kept answering from the index; a day log that
// repeated the user's typo switched off the slack that finds the fact spelled
// right; several phrasings ranked the days differently depending on their
// order; a domain-scoped recall lost the diary in silence; three days shown
// never said how many matched; the empty-results hint told the reader to
// rephrase a question the diary had just answered; one log by id took a
// relative path as its id; and a day written by another process stayed out
// of the index until maintenance.

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
const ids = (r: any) => (r.sessions_matched ?? []).map((s: any) => s.session_id);

// A log as an older version, or another process, would leave it on disk.
const escribirDia = (date: string, summary: string) =>
  fs.writeFile(path.join(root, 'hippocampus', `session_${date}.json`), JSON.stringify({
    session_id: `session_${date}`, date, duration_estimate: 'unknown', topics_touched: [], summary,
    key_facts_added: 0, decisions_made: 0, new_neurons_created: 0, synapses_updated: 0,
  }));

async function conectar(): Promise<Client> {
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  const c = new Client({ name: 'diary-test', version: '1.0.0' });
  await c.connect(ct);
  await c.callTool({ name: 'crbro_boot', arguments: {} });
  return c;
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-diary-'));
  process.env.CRBRO_PATH = root;
  process.env.CRBRO_SEMANTIC = '0';
  client = await conectar();
  await call('crbro_learn', { topic: 'Kubernetes', type: 'fact', content: 'El panel de Glama usa Kubernetes con el operador Strimzi.' });
});

afterAll(async () => {
  await client?.close();
  delete process.env.CRBRO_PATH;
  await fs.rm(root, { recursive: true, force: true });
});

describe('a fact still wins', () => {
  it('a typo the diary repeats verbatim still finds the fact spelled right', async () => {
    await call('crbro_consolidate', { summary: 'Roberto escribió Strimzy con y griega en el chat y nadie lo corrigió.' });
    const r = body(await call('crbro_recall', { query: 'Strimzy' }));
    expect(r.results.length).toBeGreaterThanOrEqual(1);
    expect(r.results[0].matching_content).toContain('Strimzi');
    expect(r.sessions_matched).toHaveLength(1);
  });
});

describe('days on disk', () => {
  it('are indexed by maintenance, and several phrasings rank the same in any order', async () => {
    await escribirDia('2021-03-03', 'Reunión con Bruno sobre el tejón y la alpaca del cliente.');
    await escribirDia('2021-03-04', 'El tejón apareció otra vez en el jardín.');
    for (const d of ['2019-01-01', '2019-01-02', '2019-01-03', '2019-01-04']) await escribirDia(d, `Día ${d}: afinamos la ocarina del taller.`);
    await call('crbro_maintenance', { dry_run: false });
    const a = body(await call('crbro_recall', { query: 'tejón', queries: ['alpaca Bruno'] }));
    const b = body(await call('crbro_recall', { query: 'alpaca Bruno', queries: ['tejón'] }));
    expect(ids(a)[0]).toBe('session_2021-03-03');            // the day both phrasings point at
    expect(ids(b)).toEqual(ids(a));
    expect(b.sessions_matched.map((s: any) => s.confidence)).toEqual(a.sessions_matched.map((s: any) => s.confidence));
  });

  it('three days shown say how many matched, and the hint points at the day', async () => {
    const r = body(await call('crbro_recall', { query: 'ocarina' }));
    expect(r.total_results).toBe(0);
    expect(r.sessions_matched).toHaveLength(3);
    expect(r.sessions_total).toBe(4);
    expect(r.hint).toContain('1 more day');
    expect(r.hint).toContain('No stored fact matched');
    expect(r.hint).not.toContain('Nothing matched');
  });

  it('a domain-scoped recall still lists the days', async () => {
    const r = body(await call('crbro_recall', { query: 'ocarina', domain: 'proyectos-web' }));
    expect(r.sessions_matched).toHaveLength(3);
  });

  it('one log reads by id with or without the prefix, never by a path', async () => {
    const corto = body(await call('crbro_inspect', { view: 'sessions', session: '2021-03-04' }));
    expect(corto.session).toBe('session_2021-03-04');
    expect(corto.sessions[0].summary).toContain('jardín');
    const status = body(await call('crbro_inspect', { view: 'status' }));
    expect(corto.total).toBe(status.total_sessions);          // the brain's total, not "one"
    const ruta = await call('crbro_inspect', { view: 'sessions', session: '../manifest' });
    expect(ruta.isError).toBe(true);
  });

  it('a forgotten day leaves the index too, on disk as well', async () => {
    expect(ids(body(await call('crbro_recall', { query: 'alpaca' })))).toEqual(['session_2021-03-03']);
    const f = body(await call('crbro_forget', { session: '2021-03-03' }));
    expect(f.removed).toBe(true);
    expect(ids(body(await call('crbro_recall', { query: 'alpaca' })))).toEqual([]);
    const indice = await fs.readFile(path.join(root, '.search', 'chunks.index.json'), 'utf8');
    expect(indice).not.toContain('alpaca');
    const mal = body(await call('crbro_forget', { session: '../manifest' }));
    expect(mal.removed).toBe(false);
  });

  it('a day written by another process is picked up on the next boot', async () => {
    await escribirDia('2018-05-05', 'El cliente trajo un bombardino roto.');
    // Written after the last flush by more than the one second of slack.
    const luego = new Date(Date.now() + 5_000);
    await fs.utimes(path.join(root, 'hippocampus', 'session_2018-05-05.json'), luego, luego);
    await client.close();
    client = await conectar();
    expect(ids(body(await call('crbro_recall', { query: 'bombardino' })))).toEqual(['session_2018-05-05']);
  });
});
