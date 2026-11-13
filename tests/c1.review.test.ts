// ─── 2.11: review in batches, and a hygiene report ──────────────
//
// stale_sample showed 10 of what the brain itself says will be ~1,350 stale
// entries, and crbro_revise works one neuron at a time. Now crbro_maintenance
// pages through all of them (stale_list) and verifies or retires many at once
// (stale_review). The dry run also carries a read-only hygiene report: a
// suggested partition for giant neurons, merge candidates, missing summaries.
// And the text detector stops calling Spanish counts versions and prices.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { detectShelf } from '../src/engine/shelf.js';

let root: string;
let client: Client;
const body = (r: any) => JSON.parse(r.content[0].text);
const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<any>;
const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

async function writeNeuron(n: Record<string, unknown> & { id: string }) {
  await fs.writeFile(path.join(root, 'cortex', `${n.id}.json`), JSON.stringify({
    name: n.id, domain: 'general', type: 'project', created: old(300), last_accessed: old(1), access_count: 1, heat: 0.5,
    summary: '', facts: [], decisions: [], patterns: [], preferences: [], connections: [], tags: [], errors: [], debts: [], entry_dates: {},
    ...n,
  }, null, 2));
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-c1-review-'));
  process.env.CRBRO_PATH = root;
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: 'c1-review', version: '0.0.0' });
  await client.connect(ct);
  await call('crbro_boot');
  // An old brain: no staleness grace left for these volatile facts.
  const man = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  man.created = old(400); man.staleness_since = old(400);
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(man));
  const facts = (pref: string, n: number) => Array.from({ length: n }, (_, i) => ({
    text: `${pref} ${i}: el servidor escucha en el puerto ${8000 + i}.`, confidence: 1, added: old(200), source: 'session',
    id: `${pref}${String(i).padStart(11, '0')}`, status: 'active', shelf_life: 'volatile',
  }));
  await writeNeuron({ id: 'project_uno', facts: facts('a', 30) });
  await writeNeuron({ id: 'project_dos', facts: facts('b', 25), decisions: [{ text: 'Usar el puerto 9000 para todo.', date: old(200), rationale: '' }] });
  // Hygiene material.
  const temas = ['facturacion', 'despliegue', 'clientes'];
  await writeNeuron({ id: 'project_gigante', last_accessed: old(1), facts: Array.from({ length: 90 }, (_, i) => ({
    text: `Nota ${i} sobre ${temas[i % 3]} del proyecto gigante con detalle numero ${i}.`, confidence: 1, added: old(1),
    source: 'session', id: `g${String(i).padStart(11, '0')}`, status: 'active', shelf_life: 'durable',
  })) });
  await writeNeuron({ id: 'project_project_doble', facts: [{ text: 'Creada por un topic con forma de id.', confidence: 1, added: old(1), source: 'session', id: 'd00000000000', status: 'active', shelf_life: 'durable' }] });
  await writeNeuron({ id: 'project_doble', facts: [{ text: 'La buena.', confidence: 1, added: old(1), source: 'session', id: 'e00000000000', status: 'active', shelf_life: 'durable' }] });
  await call('crbro_maintenance', { repair: true });
}, 60_000);

afterAll(async () => {
  await client.close();
  delete process.env.CRBRO_PATH;
  await fs.rm(root, { recursive: true, force: true });
});

describe('stale_list pages through every stale entry', () => {
  it('beyond the sample of ten, with stable paging', async () => {
    const dry = body(await call('crbro_maintenance', { dry_run: true }));
    expect(dry.stale_entries).toBeGreaterThanOrEqual(55);
    expect(dry.stale_sample).toHaveLength(10);
    const vistos: string[] = [];
    let offset = 0;
    for (;;) {
      const p = body(await call('crbro_maintenance', { stale_list: { offset, limit: 20 } })).stale_list;
      expect(p.total).toBe(dry.stale_entries);
      vistos.push(...p.entries.map((e: any) => `${e.neuron_id}|${e.entry_id}`));
      if (!p.has_more) break;
      offset += p.returned;
    }
    expect(new Set(vistos).size).toBe(dry.stale_entries);
    const uno = body(await call('crbro_maintenance', { stale_list: { neuron_id: 'project_dos' } })).stale_list;
    expect(uno.entries.every((e: any) => e.neuron_id === 'project_dos')).toBe(true);
  });
});

describe('stale_review acts on many at once', () => {
  it('verifies facts and decisions across neurons in one call', async () => {
    const p = body(await call('crbro_maintenance', { stale_list: { limit: 200 } })).stale_list;
    const dos = p.entries.filter((e: any) => e.neuron_id === 'project_dos');
    const uno = p.entries.filter((e: any) => e.neuron_id === 'project_uno').slice(0, 10);
    const lote = [...dos, ...uno].map((e: any) => ({ neuron_id: e.neuron_id, entry_id: e.entry_id }));
    const r = body(await call('crbro_maintenance', { stale_review: { action: 'verify', entries: lote } }));
    expect(r.unmatched).toEqual([]);
    expect(r.done_count).toBe(lote.length);
    const despues = body(await call('crbro_maintenance', { stale_list: { limit: 200 } })).stale_list;
    expect(despues.total).toBe(p.total - lote.length);
  });

  it('retires many, and refuses with dry_run', async () => {
    const p = body(await call('crbro_maintenance', { stale_list: { neuron_id: 'project_uno', limit: 5 } })).stale_list;
    const lote = p.entries.map((e: any) => ({ neuron_id: e.neuron_id, entry_id: e.entry_id }));
    const no = await call('crbro_maintenance', { dry_run: true, stale_review: { action: 'retracted', entries: lote } });
    expect(no.isError).toBe(true);
    const r = body(await call('crbro_maintenance', { stale_review: { action: 'retracted', entries: lote, note: 'el servidor ya no existe' } }));
    expect(r.done).toHaveLength(5);
    const again = body(await call('crbro_maintenance', { stale_review: { action: 'retracted', entries: lote } }));
    expect(again.unmatched).toHaveLength(5);
    const bad = body(await call('crbro_maintenance', { stale_review: { action: 'verify', entries: [{ neuron_id: 'project_nada', entry_id: 'x' }] } }));
    expect(bad.unmatched[0].why).toMatch(/no such neuron/);
  });
});

describe('hygiene report in the dry run', () => {
  it('suggests a partition for the giant, merges for doubled prefixes and one-liners, and names missing summaries', async () => {
    const dry = body(await call('crbro_maintenance', { dry_run: true }));
    const parte = dry.split_partitions.find((p: any) => p.neuron_id === 'project_gigante');
    expect(parte).toBeTruthy();
    expect(parte.parts.length).toBeGreaterThanOrEqual(2);
    expect(parte.parts.reduce((a: number, p: any) => a + p.entries, 0) + parte.rest).toBe(90);
    expect(dry.merge_candidates.doubled_prefix).toEqual([{ neuron_id: 'project_project_doble', meant: 'project_doble', meant_exists: true }]);
    expect(dry.merge_candidates.single_entry.map((s: any) => s.neuron_id)).toEqual(expect.arrayContaining(['project_doble', 'project_project_doble']));
    expect(dry.summary_missing.neurons.map((n: any) => n.neuron_id)).toContain('project_gigante');
    // Report only: a real run carries none of it.
    const real = body(await call('crbro_maintenance', {}));
    expect(real.split_partitions).toBeUndefined();
    expect(real.merge_candidates).toBeUndefined();
  });
});

describe('the text detector reads Spanish (H14)', () => {
  it('thousands with dots, counts per month and the name Max are not volatile', () => {
    expect(detectShelf('La web tiene 1.200.000 visitas al año.').reason).not.toBe('version');
    expect(detectShelf('Hay 3 informes mensuales para el cliente.').shelf).not.toBe('volatile');
    expect(detectShelf('Hay 4 informes al mes para el cliente.').shelf).not.toBe('volatile');
    expect(detectShelf('Max Planck nacio en 1858.').shelf).not.toBe('volatile');
  });

  it('still catches what it should', () => {
    expect(detectShelf('Instalada la 2.8.0 en produccion.').reason).toBe('version');
    expect(detectShelf('El hosting cuesta 29 al mes.').reason).toBe('price');
    expect(detectShelf('Cobramos 49 euros mensuales.').reason).toBe('price');
    expect(detectShelf('El max de conexiones es 200.').shelf).toBe('volatile');
  });
});
