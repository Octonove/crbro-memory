// ─── What maintenance notices, and how a neuron is split (2.5) ───
//
// Two reports that never write — entries whose own deadline has passed, and
// neurons that outgrew a single read — and the one operation the second
// report needs to be worth anything: moving entries to another neuron with
// their dates intact. learn + forget could always "split" a neuron, at the
// cost of every moved entry being reborn today.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let holder: string;
let root: string;
let client: Client;
const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<any>;
const body = (r: any) => JSON.parse(r.content[0].text);
const neuronFile = (id: string) => path.join(root, 'cortex', `${id}.json`);
const readNeuron = async (id: string) => JSON.parse(await fs.readFile(neuronFile(id), 'utf8'));

const PROMISE = 'El plan gratuito de la caché no optimiza hasta el 2026-03-15; después hay que decidir si se paga.';
const HISTORY = 'La migración se hizo el 2026-01-05 y quedó estable.';
const FUTURE = 'La renovación del dominio vence el 2031-06-01.';
const AMBIGUOUS = 'Revisar el contrato el 04/03/2026 con el cliente.';

beforeAll(async () => {
  holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-review-'));
  root = path.join(holder, 'brain');
  await fs.mkdir(root, { recursive: true });
  process.env.CRBRO_PATH = root;
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: 'review-test', version: '1.0.0' });
  await client.connect(ct);
  await call('crbro_boot');
}, 120_000);

afterAll(async () => {
  await client?.close();
  delete process.env.CRBRO_PATH;
  await fs.rm(holder, { recursive: true, force: true });
});

describe('expired entries', () => {
  let id: string;

  beforeAll(async () => {
    const r = body(await call('crbro_learn', { topic: 'Caché de la web', type: 'fact', content: PROMISE }));
    id = r.neuron_id;
    await call('crbro_learn', { neuron_id: id, type: 'fact', content: HISTORY });
    await call('crbro_learn', { neuron_id: id, type: 'fact', content: FUTURE });
    await call('crbro_learn', { neuron_id: id, type: 'fact', content: AMBIGUOUS });
    await call('crbro_learn', { neuron_id: id, type: 'debt', content: 'DEFERRED: pasar a PHP 8.2. REVISIT WHEN: 2026-02-20, tras la campaña.' });
    // Written in January 2026, all of them.
    const n = await readNeuron(id);
    for (const f of n.facts) f.added = '2026-01-10T09:00:00.000Z';
    for (const k of Object.keys(n.entry_dates)) n.entry_dates[k] = '2026-01-10T09:00:00.000Z';
    await fs.writeFile(neuronFile(id), JSON.stringify(n, null, 2));
  });

  it('flags what looked forward to a day that has passed, oldest first, and nothing else', async () => {
    const r = body(await call('crbro_maintenance', { dry_run: true }));
    expect(r.expired_entries).toBe(2);
    expect(r.expired_sample.map((e: any) => [e.kind, e.due])).toEqual([['debt', '2026-02-20'], ['fact', '2026-03-15']]);
    expect(r.expired_sample[1]).toMatchObject({ neuron_id: id, added: '2026-01-10' });
    expect(r.expired_sample[1].entry_id).toMatch(/^[0-9a-f]+$/);
    expect(r.notes.join(' ')).toMatch(/crbro_revise/);
  });

  it('stops flagging an entry once it is retired', async () => {
    await call('crbro_revise', { neuron: id, facts: [PROMISE], note: 'se pasó a otra caché' });
    const r = body(await call('crbro_maintenance', { dry_run: true }));
    expect(r.expired_entries).toBe(1);
    expect(r.expired_sample[0].kind).toBe('debt');
  });

  it('never writes: the file is the same after the report', async () => {
    const before = await fs.readFile(neuronFile(id), 'utf8');
    await call('crbro_maintenance', { dry_run: true });
    expect(await fs.readFile(neuronFile(id), 'utf8')).toBe(before);
  });
});

describe('split candidates and move_to', () => {
  let id: string;

  beforeAll(async () => {
    const r = body(await call('crbro_learn', { topic: 'Proyecto Enorme', type: 'fact', content: 'Hecho base número 0 del proyecto.' }));
    id = r.neuron_id;
    for (let i = 1; i <= 30; i++) await call('crbro_learn', { neuron_id: id, type: 'fact', content: `Campaña de newsletter ${i}: asunto y métricas de apertura del envío ${i}.` });
    for (let i = 1; i <= 25; i++) await call('crbro_learn', { neuron_id: id, type: 'fact', content: `Despliegue ${i} en producción: versión y resultado del pipeline ${i}.` });
    for (let i = 1; i <= 26; i++) await call('crbro_learn', { neuron_id: id, type: 'fact', content: `Nota variada ${i} sin tema común, referencia ${i * 7}.` });
    await call('crbro_learn', { neuron_id: id, type: 'error', content: 'Newsletter enviada dos veces por relanzar el job; ahora el envío es idempotente.' });
  }, 120_000);

  it('names the neuron that outgrew one read and the words that gather its entries', async () => {
    const r = body(await call('crbro_maintenance', { dry_run: true }));
    const c = r.split_candidates.find((x: any) => x.neuron_id === id);
    expect(c.entries).toBe(83);
    // Three subtopics, one word each: "newsletter", "envio", "apertura"… gather
    // the same 31 entries, and naming them five times would be one group said
    // five ways.
    expect(c.groups.map((g: any) => g.entries)).toEqual([31, 26, 25]);
    const terms = c.groups.map((g: any) => g.term);
    expect(['newsletter', 'envio', 'asunto', 'apertura', 'metricas', 'campana']).toContain(terms[0]);
    expect(['despliegue', 'produccion', 'version', 'resultado', 'pipeline']).toContain(terms[2]);
    expect(terms).not.toContain('proyecto');          // the neuron's own name says nothing about a subtopic
    expect(r.notes.join(' ')).toMatch(/move_to/);
  });

  it('move_to carries the entries with their dates, creates the target and links the two', async () => {
    const idx = body(await call('crbro_inspect', { view: 'neuron', neuron: id, limit: 200 }));
    const news = idx.entries.filter((e: any) => /newsletter/i.test(e.preview));
    expect(news.length).toBe(31);
    // Age one of them so "dates kept" is a claim the test can fail.
    const n = await readNeuron(id);
    const viejo = n.facts.find((f: any) => /newsletter 1:/.test(f.text));
    viejo.added = '2026-02-02T08:00:00.000Z';
    await fs.writeFile(neuronFile(id), JSON.stringify(n, null, 2));

    const r = body(await call('crbro_revise', { neuron: id, move_to: 'Proyecto Enorme — Newsletter', facts: news.map((e: any) => e.id).concat(['no_existe']) }));
    expect(r).toMatchObject({ created: true, moved: 31, unmatched: ['no_existe'] });
    expect(r.backup).toBeTruthy();

    const destino = await readNeuron(r.moved_to);
    expect(destino.facts.length).toBe(30);
    expect(destino.errors.length).toBe(1);
    expect(destino.facts.find((f: any) => /newsletter 1:/.test(f.text)).added).toBe('2026-02-02T08:00:00.000Z');
    expect(Object.keys(destino.entry_dates).length).toBe(1);             // the error's stamp travelled
    expect(destino.domain).toBe((await readNeuron(id)).domain);

    const origen = await readNeuron(id);
    expect(origen.facts.length).toBe(52);
    expect(origen.errors).toEqual([]);
    expect(origen.connections).toContain(r.moved_to);
  });

  it('recall answers from the new neuron, and the old one no longer holds the line', async () => {
    const hit = body(await call('crbro_recall', { query: 'newsletter métricas apertura envío' })).results[0];
    expect(hit.name).toBe('Proyecto Enorme — Newsletter');
    const all = body(await call('crbro_recall', { query: 'newsletter métricas apertura envío', limit: 10 }));
    expect(all.results.filter((x: any) => x.neuron_id === id && /newsletter/i.test(x.matching_content))).toEqual([]);
  });

  it('refuses a move with nothing to move, and a move onto itself', async () => {
    const vacio = await call('crbro_revise', { neuron: id, move_to: 'Otro' });
    expect(vacio.isError).toBe(true);
    const mismo = await call('crbro_revise', { neuron: id, move_to: id, facts: ['Hecho base número 0 del proyecto.'] });
    expect(mismo.isError).toBe(true);
    expect((await readNeuron(id)).facts.length).toBe(52);
  });
});
