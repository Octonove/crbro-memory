// ─── Implicit synapses at consolidate (1.13) ─────────────────────
//
// (Topic names here are deliberately dissimilar: findByName merges near-misses
// such as "Proyecto A" / "Proyecto B" into one neuron, by design.)
// The reference brain had 14 synapses for 1,145 neurons: only crbro_connect
// created them and nobody calls it. Neurons written in the same session are
// related by that alone, so consolidate links them — weak, temporal, never
// overwriting a context someone wrote by hand.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { Synapses } from '../src/engine/synapses.js';
import { HeatEngine } from '../src/engine/heat.js';
import { Hippocampus } from '../src/engine/hippocampus.js';
import { Prefrontal } from '../src/engine/prefrontal.js';
import { SearchEngine } from '../src/search/index.js';
import { Maintenance } from '../src/engine/maintenance.js';

let root: string;
let brain: Brain;
let cortex: Cortex;
let synapses: Synapses;
let maintenance: Maintenance;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-syn-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
  synapses = new Synapses(brain);
  const engine = new SearchEngine(brain);
  await engine.init();
  cortex.setIndexer(n => engine.indexNeuron(n));
  maintenance = new Maintenance(
    brain, cortex, synapses, new HeatEngine(brain), new Hippocampus(brain), new Prefrontal(brain), engine,
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('consolidate links what the session wrote', () => {
  it('two neurons written in one session get a weak temporal synapse', async () => {
    const a = await cortex.learn('Cloud Run', 'fact', 'A usa Cloud Run.');
    const b = await cortex.learn('Firebase Auth', 'fact', 'B usa Firebase.');

    const r = await maintenance.consolidate('sesión de prueba');
    expect(r.synapses_updated).toBe(1);
    expect(r.total_synapses).toBe(1);

    const s = await synapses.get(a.neuron!.id, b.neuron!.id);
    expect(s).toBeTruthy();
    expect(s!.strength).toBe(0.3);
    expect(s!.type).toBe('temporal');
  });

  it('one neuron alone links to nothing', async () => {
    await cortex.learn('Cloud Run', 'fact', 'A usa Cloud Run.');
    const r = await maintenance.consolidate('solo uno');
    expect(r.synapses_updated).toBe(0);
    expect(r.total_synapses).toBe(0);
  });

  it('the next session strengthens it and keeps a hand-written context', async () => {
    const a = await cortex.learn('Cloud Run', 'fact', 'A usa Cloud Run.');
    const b = await cortex.learn('Firebase Auth', 'fact', 'B usa Firebase.');
    await synapses.connect(a.neuron!.id, b.neuron!.id, 'dependency', 'A llama a la API de B');
    await maintenance.consolidate('primera');

    await cortex.learn('Cloud Run', 'fact', 'A desplegó ayer.');
    await cortex.learn('Firebase Auth', 'fact', 'B rotó sus claves.');
    const r = await maintenance.consolidate('segunda');
    expect(r.synapses_updated).toBe(1);

    const s = (await synapses.get(a.neuron!.id, b.neuron!.id))!;
    expect(s.type).toBe('dependency');               // creation type is kept
    expect(s.context).toBe('A llama a la API de B'); // never overwritten
    expect(s.strength).toBeCloseTo(0.7, 5);          // 0.5 + 0.1 + 0.1
  });

  it('caps at six topics — fifteen pairs, not everything to everything', async () => {
    for (let i = 0; i < 9; i++) await cortex.learn(`Tema ${i}`, 'fact', `Nota ${i}.`);
    const r = await maintenance.consolidate('muchos');
    expect(r.synapses_updated).toBe(15);
    expect(r.total_synapses).toBe(15);
  });
});
