// ─── A correction must actually correct ──────────────────────────
//
// Found live on the reference brain (23-08-2026): crbro_revise wrote
// status: "superseded" to the neuron, answered "They no longer appear in
// recall", and the retired fact came back as the FIRST recall result —
// outscoring the fact that corrected it, because the wrong version was
// longer and matched more terms.
//
// Root cause: removeNeuronChunks() asked Orama to find a neuron's chunks
// with `where` on a plain string field and an empty term. When that query
// returns nothing, the old chunks stay in the index forever; insertNeuronChunks
// then re-inserts under the same ids, the duplicates are swallowed, and the
// "reindex" is a no-op that reports success. The same hole reaches
// crbro_forget: text deleted for being sensitive stayed searchable.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';
import { readJSON, writeJSON } from '../src/utils/fs.js';
import type { Neuron } from '../src/types/index.js';

let root: string;
let brain: Brain;
let cortex: Cortex;
let engine: SearchEngine;

const WRONG =
  'La paginación del listado de facturas está desactivada y no fue cosa nuestra: ' +
  'la plantilla del widget la perdió en una actualización del constructor.';
const RIGHT =
  'La paginación del listado de facturas la desactivamos nosotros a propósito ' +
  'cuando montamos la caché del grid.';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-rev-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
  engine = new SearchEngine(brain);
  await engine.init();
  // Wired exactly as server.ts wires it.
  cortex.setIndexer(n => engine.indexNeuron(n));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function factIdOf(neuronId: string, text: string): Promise<string> {
  const n = await readJSON<Neuron>(brain.paths.neuron(neuronId));
  const f = n!.facts.find(x => x.text === text);
  expect(f, `fact not found in ${neuronId}: ${text.slice(0, 40)}`).toBeTruthy();
  return f!.id!;
}

describe('revise reaches recall', () => {
  it('a revised fact stops appearing in search, same process', async () => {
    const r = await cortex.learn('Facturación', 'fact', WRONG);
    await cortex.learn('Facturación', 'fact', RIGHT);
    const id = await factIdOf(r.neuron!.id, WRONG);

    const res = await cortex.revise('Facturación', [id]);
    expect(res.revised).toBe(1);

    const hits = await engine.search('paginación listado facturas desactivada');
    const texts = hits.map(h => h.matching_content);
    expect(texts.join('\n')).not.toContain('no fue cosa nuestra');
    // The correction is still findable.
    expect(texts.join('\n')).toContain('a propósito');
  });

  it('a revised fact stops appearing after the index is loaded from disk', async () => {
    const r = await cortex.learn('Facturación', 'fact', WRONG);
    await cortex.learn('Facturación', 'fact', RIGHT);
    await engine.persist();

    // Fresh process: engine loads the saved index instead of rebuilding.
    const engine2 = new SearchEngine(brain);
    await engine2.init();
    cortex.setIndexer(n => engine2.indexNeuron(n));

    const id = await factIdOf(r.neuron!.id, WRONG);
    const res = await cortex.revise('Facturación', [id]);
    expect(res.revised).toBe(1);

    const hits = await engine2.search('paginación listado facturas desactivada');
    expect(hits.map(h => h.matching_content).join('\n')).not.toContain('no fue cosa nuestra');
  });

  it('forget removes the text from the index too', async () => {
    await cortex.learn('Claves', 'fact', 'El token de despliegue vive en la bóveda bajo DEPLOY_TOKEN.');
    let hits = await engine.search('token despliegue bóveda');
    expect(hits.length).toBeGreaterThan(0);

    const res = await cortex.forget('Claves', ['El token de despliegue vive en la bóveda bajo DEPLOY_TOKEN.']);
    expect(res.removed).toBe(1);

    hits = await engine.search('token despliegue bóveda');
    expect(hits.map(h => h.matching_content).join('\n')).not.toContain('DEPLOY_TOKEN');
  });

  it('a poisoned index does not serve a retired fact (hydration guard)', async () => {
    // Simulate the brains already damaged in the wild: the neuron says
    // superseded, the index still carries the chunk. No reindex happens.
    const r = await cortex.learn('Facturación', 'fact', WRONG);
    cortex.setIndexer(null); // the revise below must NOT heal the index
    const id = await factIdOf(r.neuron!.id, WRONG);
    await cortex.revise('Facturación', [id]);

    const hits = await engine.search('paginación listado facturas desactivada');
    expect(hits.map(h => h.matching_content).join('\n')).not.toContain('no fue cosa nuestra');
  });

  it('search filtered by domain returns only that domain', async () => {
    await cortex.learn('Cocina', 'fact', 'El horno de leña alcanza cuatrocientos grados en veinte minutos.', { domain: 'hosteleria' });
    await cortex.learn('Hornos industriales', 'fact', 'El horno de convección se revisa cada seis meses.', { domain: 'maquinaria' });

    const hits = await engine.search('horno', { domain: 'hosteleria' });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.domain).toBe('hosteleria');
  });
});

describe('supersedes that matches nothing must say so', () => {
  it('learn reports the unmatched supersedes targets', async () => {
    await cortex.learn('Facturación', 'fact', WRONG);
    const r = await cortex.learn('Facturación', 'fact', RIGHT, {
      supersedes: ['/prompts-list/ — un texto que no coincide con ningún hecho'],
    });
    expect(r.superseded).toBe(0);
    expect(r.supersedes_unmatched).toEqual([
      '/prompts-list/ — un texto que no coincide con ningún hecho',
    ]);
  });

  it('learn keeps quiet when every supersedes target matched', async () => {
    const first = await cortex.learn('Facturación', 'fact', WRONG);
    const id = await factIdOf(first.neuron!.id, WRONG);
    const r = await cortex.learn('Facturación', 'fact', RIGHT, { supersedes: [id] });
    expect(r.superseded).toBe(1);
    expect(r.supersedes_unmatched).toEqual([]);
  });
});
