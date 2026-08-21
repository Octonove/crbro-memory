// ─── Acceptance: retrieval must not punish large neurons ─────────
//
// This reproduces the failure that motivated the chunk-level index. On a real
// brain, facts saved into the biggest neuron became unfindable: BM25 divides
// by document length, the whole neuron was one document, and a 90-character
// scrap outranked 342,302 characters of actual knowledge.
//
// The last test is the important one. It encodes "the more you save about a
// topic, the less findable it becomes" as a regression guard: if anyone
// reintroduces whole-neuron documents or a fixed candidate pool, it fails.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';

const QUERY = 'cluster de workflows pilar satelites fichas ocultar_de_lista';

const TARGET =
  'El cluster de workflows tiene un pilar y varios satelites; las fichas usan ' +
  'el flag ocultar_de_lista para no aparecer en el listado publico.';

// Short neurons that each contain one word of the query. These are what used
// to win: ~90 characters against ~1,200.
const NOISE = [
  'pilas y baterias de repuesto en el almacen',
  'fichas de producto de la tienda online',
  'cluster de kubernetes en gcp para el backend',
  'satelites de comunicaciones y cobertura rural',
  'workflows de facturacion mensual con la gestoria',
  'ocultar el menu lateral en pantallas de movil',
];

let root: string;
let brain: Brain;
let cortex: Cortex;
let engine: SearchEngine;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-acc-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);

  // The valuable neuron: many long facts, with the target buried in the middle.
  for (let i = 0; i < 200; i++) {
    const text =
      i === 97
        ? TARGET
        : `Nota ${i} sobre la suite de plugins. ${'contenido de relleno '.repeat(60)}`;
    await cortex.learn('Acme Platform', 'fact', text);
  }

  // 200 short neurons carrying single query words.
  for (let i = 0; i < 200; i++) {
    await cortex.learn(`Tema ${i}`, 'fact', `${NOISE[i % NOISE.length]} (nota ${i})`);
  }

  engine = new SearchEngine(brain);
  await engine.rebuild();
}, 120_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('recall: a big neuron beats short scraps', () => {
  it('ranks the neuron that actually holds the answer first', async () => {
    const results = await engine.search(QUERY);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].neuron_id).toBe('project_acme_platform');
  });

  it('returns the fact that matched, not the neuron summary', async () => {
    const results = await engine.search(QUERY);
    expect(results[0].matching_content).toContain('ocultar_de_lista');

    // The old implementation returned `summary || facts.slice(0,200)`, and on a
    // real brain 1,182 of 1,183 summaries were empty — so it always returned
    // the oldest fact, whatever the query was.
    const neuron = await cortex.peek('project_acme_platform');
    expect(results[0].matching_content).not.toBe(neuron!.summary);
    expect(results[0].matched_kind).toBe('fact');
    expect(results[0].matched_added).toBeTruthy();
  });

  it('still finds a neuron by its name', async () => {
    const results = await engine.search('Acme Platform');
    expect(results[0].neuron_id).toBe('project_acme_platform');
  });

  it('does not rank a neuron lower for holding more knowledge', async () => {
    for (let i = 0; i < 200; i++) {
      await cortex.learn('Acme Platform', 'fact', `extra padding ${i} ${'x '.repeat(300)}`);
    }
    await engine.rebuild();

    const results = await engine.search(QUERY);
    expect(results[0].neuron_id).toBe('project_acme_platform');
  }, 120_000);

  it('hides a fact once it has been superseded', async () => {
    const before = await engine.search(QUERY);
    expect(before[0].matching_content).toContain('ocultar_de_lista');

    await cortex.revise('project_acme_platform', [TARGET], {
      status: 'superseded',
      note: 'las fichas ya no usan ese flag',
    });
    await engine.rebuild();

    const after = await engine.search(QUERY);
    const stillThere = after.some(r => r.matching_content.includes('ocultar_de_lista'));
    expect(stillThere).toBe(false);
  }, 120_000);
});
