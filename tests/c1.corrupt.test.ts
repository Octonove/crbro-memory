// ─── 2.11: one bad neuron file is isolated, not fatal ────────────
//
// Reproduced on a copy of a real brain (2.10.0): a neuron with truncated JSON,
// or saved with a UTF-8 byte-order mark (Windows PowerShell 5.1 writes one),
// broke recall when it was touched and always broke inspect view=neurons,
// maintenance and consolidate — and without consolidate there is no daily
// backup. Now a BOM is simply accepted, and a file that really does not parse
// is skipped by every reader, listed with its path and where a good copy is,
// and refused by every writer with the same information.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readJSON, CorruptJSONError } from '../src/utils/fs.js';
import { Brain } from '../src/engine/brain.js';
import { Cortex, UnreadableNeuronError } from '../src/engine/cortex.js';
import { createBackup } from '../src/engine/backup.js';

let root: string;
let client: Client;
const body = (r: any) => JSON.parse(r.content[0].text);
const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<any>;

const TRUNCADA = 'project_truncada';
const CON_BOM = 'project_con_bom';

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-c1-corrupt-'));
  process.env.CRBRO_PATH = root;
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: 'c1-corrupt', version: '0.0.0' });
  await client.connect(ct);
  await call('crbro_boot');

  for (const [topic, text] of [
    ['Truncada', 'El servidor de la tienda escucha en el puerto 8443 de produccion.'],
    ['Con Bom', 'La factura electronica se envia por correo cada lunes a contabilidad.'],
    ['Sana', 'El panel de control vive en panel.example.test y lo sirve nginx.'],
  ]) {
    const r = await call('crbro_learn', { topic, type: 'fact', content: text, keywords: ['prueba'] });
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
  }
  // A whole copy in quarantine, so the recovery hint has something to name.
  const n = JSON.parse(await fs.readFile(path.join(root, 'cortex', `${TRUNCADA}.json`), 'utf8'));
  await fs.mkdir(path.join(root, '.quarantine'), { recursive: true });
  await fs.writeFile(path.join(root, '.quarantine', `${TRUNCADA}.2026-11-01T10-00-00-000Z.json`), JSON.stringify(n));
  // Then: one truncated mid-write, one re-saved with a BOM.
  const lleno = await fs.readFile(path.join(root, 'cortex', `${TRUNCADA}.json`), 'utf8');
  await fs.writeFile(path.join(root, 'cortex', `${TRUNCADA}.json`), lleno.slice(0, Math.floor(lleno.length / 2)));
  const bom = await fs.readFile(path.join(root, 'cortex', `${CON_BOM}.json`), 'utf8');
  await fs.writeFile(path.join(root, 'cortex', `${CON_BOM}.json`), '﻿' + bom, 'utf8');
}, 60_000);

afterAll(async () => {
  await client.close();
  delete process.env.CRBRO_PATH;
  await fs.rm(root, { recursive: true, force: true });
});

describe('a BOM is not corruption', () => {
  it('readJSON strips it', async () => {
    const n = await readJSON<{ id: string }>(path.join(root, 'cortex', `${CON_BOM}.json`));
    expect(n!.id).toBe(CON_BOM);
  });

  it('the neuron reads, lists and can be written', async () => {
    const r = await call('crbro_inspect', { view: 'neuron', neuron: CON_BOM });
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
    const w = await call('crbro_learn', { neuron_id: CON_BOM, type: 'fact', content: 'Tambien se archiva en PDF.', keywords: ['pdf'] });
    expect(w.isError, w.content?.[0]?.text).toBeFalsy();
  });
});

describe('a truncated neuron is skipped, named and never written', () => {
  it('readJSON throws a CorruptJSONError naming the file', async () => {
    await expect(readJSON(path.join(root, 'cortex', `${TRUNCADA}.json`))).rejects.toBeInstanceOf(CorruptJSONError);
  });

  it('recall still answers, from the other neurons', async () => {
    const r = await call('crbro_recall', { query: 'panel de control nginx' });
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
    expect(r.structuredContent.results.map((x: any) => x.neuron_id)).toContain('project_sana');
    const r2 = await call('crbro_recall', { query: 'servidor tienda puerto 8443' });
    expect(r2.isError, r2.content?.[0]?.text).toBeFalsy();
  });

  it('inspect view=neurons lists the rest and names the bad file with a recovery hint', async () => {
    const r = await call('crbro_inspect', { view: 'neurons' });
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
    const v = r.structuredContent.neurons;
    expect(v.neurons.map((n: any) => n.id)).toEqual(expect.arrayContaining(['project_sana', CON_BOM]));
    expect(v.unreadable).toHaveLength(1);
    expect(v.unreadable[0].id).toBe(TRUNCADA);
    expect(v.unreadable[0].path).toContain(`${TRUNCADA}.json`);
    expect(v.unreadable[0].recovery).toMatch(/quarantine/);
  });

  it('inspect view=neuron says it exists but cannot be read', async () => {
    const r = await call('crbro_inspect', { view: 'neuron', neuron: TRUNCADA });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/cannot be read/);
  });

  it('maintenance, dry run and real, finishes and reports it', async () => {
    for (const dry_run of [true, false]) {
      const r = await call('crbro_maintenance', { dry_run });
      expect(r.isError, r.content?.[0]?.text).toBeFalsy();
      const rep = body(r);
      expect(rep.unreadable_neurons.map((u: any) => u.id)).toEqual([TRUNCADA]);
      expect(rep.unreadable_neurons[0].recovery).toMatch(/quarantine|backup/);
      expect(rep.integrity_issues).toContain(`Corrupted neuron file: ${TRUNCADA}`);
    }
  });

  it('consolidate finishes', async () => {
    const r = await call('crbro_consolidate', { summary: 'Sesion de prueba con una neurona rota.' });
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
    expect(body(r).session_logged).toBe(true);
  });

  it('a write to it is refused with the file and where a copy is; the bytes stay as they were', async () => {
    const antes = await fs.readFile(path.join(root, 'cortex', `${TRUNCADA}.json`), 'utf8');
    const w = await call('crbro_learn', { neuron_id: TRUNCADA, type: 'fact', content: 'Esto no debe escribirse encima.' });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toMatch(/cannot be read/);
    expect(w.content[0].text).toMatch(/quarantine/);
    const t = await call('crbro_learn', { topic: 'Truncada', type: 'fact', content: 'Ni por nombre.' });
    expect(t.isError).toBe(true);
    expect(await fs.readFile(path.join(root, 'cortex', `${TRUNCADA}.json`), 'utf8')).toBe(antes);
  });

  it('the engine exposes it: peek is null, unreadable() names it, forget refuses', async () => {
    const brain = new Brain(root);
    const cortex = new Cortex(brain);
    expect(await cortex.peek(TRUNCADA)).toBeNull();
    const u = await cortex.unreadable();
    expect(u.map(x => x.id)).toEqual([TRUNCADA]);
    expect((await cortex.list()).map(n => n.id)).not.toContain(TRUNCADA);
    await expect(cortex.forget(TRUNCADA, ['x'])).rejects.toBeInstanceOf(UnreadableNeuronError);
    expect((await cortex.unreadable({ scan: true })).map(x => x.id)).toEqual([TRUNCADA]);
  });

  it('backup goes through and names it', async () => {
    const r = await createBackup(new Brain(root).paths, { dir: path.join(root, '..', `${path.basename(root)}-bk`) });
    expect(r.unreadable).toEqual([`cortex/${TRUNCADA}.json`]);
    await fs.rm(path.join(root, '..', `${path.basename(root)}-bk`), { recursive: true, force: true });
  });
});
