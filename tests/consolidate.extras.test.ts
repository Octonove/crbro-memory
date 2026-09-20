// ─── What consolidate does on the way out (2.5) ──────────────────
//
// Two things nobody was going to remember to do by hand:
//   · back the brain up once a day, next to the brain it belongs to;
//   · point at the large neurons this session touched that still have no
//     summary — the field existed since 1.0 and was empty in 1,199 of 1,200.
// Both ride on the one call every session already makes.

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

beforeAll(async () => {
  // The brain sits inside a holder folder so the sibling backup folder is
  // removed with it.
  holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-extras-'));
  root = path.join(holder, 'brain');
  await fs.mkdir(root, { recursive: true });
  process.env.CRBRO_PATH = root;
  process.env.CRBRO_AUTOBACKUP = '1';
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: 'extras-test', version: '1.0.0' });
  await client.connect(ct);
  await call('crbro_boot');
});

afterAll(async () => {
  await client?.close();
  delete process.env.CRBRO_PATH;
  process.env.CRBRO_AUTOBACKUP = '0';
  await fs.rm(holder, { recursive: true, force: true });
});

describe('the daily backup', () => {
  it('the first consolidate of the day makes one, beside the brain and not inside it', async () => {
    await call('crbro_learn', { topic: 'Proyecto Pequeño', type: 'fact', content: 'Un hecho cualquiera para que haya algo que copiar.' });
    const r = body(await call('crbro_consolidate', { summary: 'Primera sesión.' }));
    expect(r.backup?.made).toBe(true);
    expect(r.backup.file).toMatch(/^brain-\d{8}-\d{6}\.json\.gz$/);
    expect(r.backup.dir).toBe(path.join(holder, 'brain-backups', 'brain'));
    expect(r.backup.dir.startsWith(root + path.sep)).toBe(false);
    await expect(fs.stat(path.join(r.backup.dir, r.backup.file))).resolves.toBeTruthy();
  });

  it('the second one the same day stays quiet', async () => {
    const r = body(await call('crbro_consolidate', { summary: 'Segunda sesión del mismo día.' }));
    expect(r.backup).toBeUndefined();
    expect((await fs.readdir(path.join(holder, 'brain-backups', 'brain'))).length).toBe(1);
  });
});

describe('the summary nudge', () => {
  it('stays quiet for a small neuron', async () => {
    const r = body(await call('crbro_consolidate', { summary: 'Nada grande hoy.' }));
    expect(r.missing_summaries).toBeUndefined();
  });

  it('names a large neuron touched this session that has no summary', async () => {
    for (let i = 0; i < 26; i++) {
      await call('crbro_learn', { topic: 'Proyecto Gigante', type: 'fact', content: `Hecho número ${i} sobre el despliegue del proyecto gigante en la región ${i}.` });
    }
    const r = body(await call('crbro_consolidate', { summary: 'Mucho trabajo en el gigante.' }));
    expect(r.missing_summaries).toHaveLength(1);
    expect(r.missing_summaries[0].entries).toBeGreaterThanOrEqual(26);
    expect(r.missing_summaries_hint).toMatch(/crbro_revise/);
  });

  it('goes quiet once the summary is written', async () => {
    const gigante = body(await call('crbro_recall', { query: 'proyecto gigante despliegue' })).results[0].neuron_id;
    await call('crbro_revise', { neuron: gigante, summary: 'El proyecto grande de la suite de pruebas: despliegues por región.' });
    await call('crbro_learn', { neuron_id: gigante, type: 'fact', content: 'Un hecho más, ya con resumen escrito.' });
    const r = body(await call('crbro_consolidate', { summary: 'Resumen puesto.' }));
    expect(r.missing_summaries).toBeUndefined();
  });
});
