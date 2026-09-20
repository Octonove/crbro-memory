// ─── Recency as a tiebreak, and narrowing recall (2.5) ───────────
//
// Until 2.5 no date touched the ranking: two tellings of one thing competed
// as equals, and which one spoke for the neuron was an accident of file
// order. The fix is deliberately small — a few percent — and these tests pin
// both halves: the newer telling wins a tie, and it never wins anything else.

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine, recencyOf } from '../src/search/index.js';
import { readJSON, writeJSON } from '../src/utils/fs.js';
import type { Neuron } from '../src/types/index.js';

const DAY = 86_400_000;

describe('recencyOf', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  it('is 1 today, a half at 120 days, and 0 without a date', () => {
    expect(recencyOf('2026-09-20T12:00:00Z', now)).toBe(1);
    expect(recencyOf(new Date(now - 120 * DAY).toISOString(), now)).toBeCloseTo(0.5, 5);
    expect(recencyOf(new Date(now - 365 * DAY).toISOString(), now)).toBeCloseTo(0.2474, 3);
    expect(recencyOf('', now)).toBe(0);
    expect(recencyOf(undefined, now)).toBe(0);
    expect(recencyOf('no es una fecha', now)).toBe(0);
  });
  it('takes a day-precision date from the backfill, and never rewards the future', () => {
    expect(recencyOf('2026-09-20', now)).toBeGreaterThan(0.99);
    expect(recencyOf('2027-01-01', now)).toBe(1);
  });
});

describe('the newer telling wins a tie — and only a tie', () => {
  let root: string;
  let brain: Brain;
  let cortex: Cortex;
  let engine: SearchEngine;

  // Same words, same length, one differing token the query does not use:
  // BM25 cannot tell them apart.
  const OLD = 'El servidor de staging expone la API interna en el puerto 8080.';
  const NEW = 'El servidor de staging expone la API interna en el puerto 9090.';
  const QUERY = 'servidor staging API puerto';

  async function redate(id: string, dates: Record<string, string>) {
    const p = brain.paths.neuron(id);
    const n = (await readJSON<Neuron>(p))!;
    for (const f of n.facts) if (dates[f.text] !== undefined) f.added = dates[f.text];
    await writeJSON(p, n);
    await engine.indexNeuron(n);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-recency-'));
    brain = new Brain(root);
    await brain.initialize();
    cortex = new Cortex(brain);
    engine = new SearchEngine(brain);
    await engine.init();
    cortex.setIndexer(n => engine.indexNeuron(n));
  });

  afterEach(async () => {
    delete process.env.CRBRO_RECENCY;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('inside one neuron, the newer of two equal tellings speaks for it', async () => {
    const r = await cortex.learn('Staging', 'fact', OLD);
    await cortex.learn('Staging', 'fact', NEW);
    const now = Date.now();
    await redate(r.neuron!.id, { [OLD]: new Date(now - 200 * DAY).toISOString(), [NEW]: new Date(now - 2 * DAY).toISOString() });

    const hit = (await engine.search(QUERY))[0];
    expect(hit.matching_content).toBe(NEW);
    expect(hit.also_matched?.[0].preview).toBe(OLD);

    // The same brain with the tiebreak off: the file order decides, and it is the old one.
    process.env.CRBRO_RECENCY = '0';
    expect((await engine.search(QUERY))[0].matching_content).toBe(OLD);
  });

  it('across neurons, the newer of two equal answers ranks first', async () => {
    const a = await cortex.learn('Staging viejo', 'fact', OLD);
    const b = await cortex.learn('Staging nuevo', 'fact', NEW);
    const now = Date.now();
    await redate(a.neuron!.id, { [OLD]: new Date(now - 300 * DAY).toISOString() });
    await redate(b.neuron!.id, { [NEW]: new Date(now - 1 * DAY).toISOString() });
    const hits = await engine.search('servidor expone API interna puerto');
    expect(hits.map(h => h.matching_content)).toEqual([NEW, OLD]);
  });

  it('an undated entry loses the tie to a dated one, however old', async () => {
    const r = await cortex.learn('Staging', 'fact', OLD);
    await cortex.learn('Staging', 'fact', NEW);
    await redate(r.neuron!.id, { [OLD]: '', [NEW]: new Date(Date.now() - 700 * DAY).toISOString() });
    expect((await engine.search(QUERY))[0].matching_content).toBe(NEW);
  });

  it('never beats a better match: relevance decides, recency only breaks ties', async () => {
    const BEST = 'La rotación de certificados TLS del balanceador se hace con certbot cada 60 días.';
    const FRESH = 'El balanceador se reinició ayer por mantenimiento.';
    const r = await cortex.learn('Infra', 'fact', BEST);
    await cortex.learn('Infra', 'fact', FRESH);
    await redate(r.neuron!.id, { [BEST]: new Date(Date.now() - 900 * DAY).toISOString(), [FRESH]: new Date().toISOString() });
    const hit = (await engine.search('rotación certificados TLS balanceador'))[0];
    expect(hit.matching_content).toBe(BEST);
  });

  it('lifts a score by four percent at most', async () => {
    const r = await cortex.learn('Staging', 'fact', NEW);
    await redate(r.neuron!.id, { [NEW]: new Date().toISOString() });
    const con = (await engine.search(QUERY))[0].relevance_score;
    process.env.CRBRO_RECENCY = '0';
    const sin = (await engine.search(QUERY))[0].relevance_score;
    expect(con).toBeGreaterThan(sin);
    expect(con / sin).toBeLessThanOrEqual(1.0401);
  });
});

describe('crbro_recall since / kind', () => {
  let holder: string;
  let root: string;
  let client: Client;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<any>;
  const body = (r: any) => JSON.parse(r.content[0].text);

  const FACT_OLD = 'El despliegue de la tienda se hace subiendo el zip por FTP a mano.';
  const FACT_NEW = 'El despliegue de la tienda se hace con un workflow de GitHub Actions.';
  const ERROR = 'Despliegue de la tienda roto por subir el zip sin compilar; ahora se compila antes.';
  const DECISION = 'El despliegue de la tienda pasa a ser automático';
  const PATTERN = 'Tras cada despliegue de la tienda se purga la caché del CDN.';

  beforeAll(async () => {
    holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-filters-'));
    root = path.join(holder, 'brain');
    await fs.mkdir(root, { recursive: true });
    process.env.CRBRO_PATH = root;
    const { createServer } = await import('../src/server.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer().connect(st);
    client = new Client({ name: 'filters-test', version: '1.0.0' });
    await client.connect(ct);
    await call('crbro_boot');

    const r = body(await call('crbro_learn', { topic: 'Tienda', type: 'fact', content: FACT_OLD }));
    const id = r.neuron_id;
    await call('crbro_learn', { neuron_id: id, type: 'fact', content: FACT_NEW });
    await call('crbro_learn', { neuron_id: id, type: 'error', content: ERROR });
    await call('crbro_learn', { neuron_id: id, type: 'decision', content: DECISION, rationale: 'demasiados errores a mano' });
    await call('crbro_learn', { neuron_id: id, type: 'pattern', content: PATTERN });

    // Age one fact and strip the pattern's date, as a pre-1.13 brain has it;
    // maintenance rebuilds the index from the files.
    const file = path.join(root, 'cortex', `${id}.json`);
    const n = JSON.parse(await fs.readFile(file, 'utf8'));
    n.created = '2026-01-10T09:00:00.000Z';
    for (const f of n.facts) if (f.text === FACT_OLD) f.added = '2026-02-01T09:00:00.000Z';
    n.entry_dates = {};
    await fs.writeFile(file, JSON.stringify(n, null, 2));
    await call('crbro_maintenance', {});
  });

  afterAll(async () => {
    await client?.close();
    delete process.env.CRBRO_PATH;
    await fs.rm(holder, { recursive: true, force: true });
  });

  const texts = (p: any) => [
    ...p.results.map((x: any) => x.matching_content),
    ...p.results.flatMap((x: any) => (x.also_matched || []).map((a: any) => a.preview)),
  ];

  it('kind narrows the answer to those entries and says so', async () => {
    const p = body(await call('crbro_recall', { query: 'despliegue tienda', kind: ['error'] }));
    expect(p.filters).toEqual({ kind: ['error'] });
    expect(p.results[0].matched_kind).toBe('error');
    expect(texts(p)).toEqual([ERROR]);
    expect(p.hint).toMatch(/Filtered/);
    expect(p.sessions_matched).toBeUndefined();
  });

  it('two kinds at once', async () => {
    const p = body(await call('crbro_recall', { query: 'despliegue tienda', kind: ['decision', 'pattern'] }));
    const kinds = [p.results[0].matched_kind, ...(p.results[0].also_matched || []).map((a: any) => a.kind)].sort();
    expect(kinds).toEqual(['decision', 'pattern']);
  });

  it('since keeps what is dated on or after the day, and counts what it could not judge', async () => {
    const p = body(await call('crbro_recall', { query: 'despliegue tienda', since: '2026-06-01' }));
    expect(p.filters).toEqual({ since: '2026-06-01' });
    const got = texts(p);
    expect(got).toContain(FACT_NEW);
    expect(got).not.toContain(FACT_OLD);
    // The error and the pattern lost their stamps above: left out, and declared.
    expect(got).not.toContain(PATTERN);
    expect(p.undated_skipped).toBe(2);
    expect(p.hint).toMatch(/no date/);
  });

  it('a span is resolved to a day and echoed', async () => {
    const p = body(await call('crbro_recall', { query: 'despliegue tienda', since: '2w' }));
    expect(p.filters.since).toBe(new Date(Date.now() - 14 * DAY).toISOString().slice(0, 10));
    expect(texts(p)).toContain(FACT_NEW);
  });

  it('a since that is neither is refused, not ignored', async () => {
    const r = await call('crbro_recall', { query: 'despliegue tienda', since: 'el mes pasado' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/neither a day/);
  });

  it('an empty filtered answer says to drop the filter before concluding', async () => {
    const p = body(await call('crbro_recall', { query: 'despliegue tienda', kind: ['debt'] }));
    expect(p.total_results).toBe(0);
    expect(p.hint).toMatch(/Drop since\/kind/);
  });

  it('without filters nothing changes shape', async () => {
    const p = body(await call('crbro_recall', { query: 'despliegue tienda' }));
    expect(p.filters).toBeUndefined();
    expect(p.undated_skipped).toBeUndefined();
    expect(p.hint).not.toMatch(/Filtered/);
  });
});
