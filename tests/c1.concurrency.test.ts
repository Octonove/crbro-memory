// ─── 2.11: links and deletions under the same lock as everything ─
//
// 2.10 rewrote BOTH neurons of every synapse it created or removed with a
// plain read + write, outside the lock every other writer takes: a learn
// landing on a neuron while consolidate linked it lost its fact, silently
// (read in synapses.ts 290-306). And a write that resolved a neuron just
// before another process deleted it wrote the old copy back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { Synapses } from '../src/engine/synapses.js';

let root: string;
let brain: Brain;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-c1-conc-'));
  brain = new Brain(root);
  await brain.initialize();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('connect and learn on the same neuron', () => {
  it('keeps every fact and every connection', async () => {
    const a = new Cortex(brain);
    const b = new Cortex(brain);
    const syn = new Synapses(brain);
    await a.learn('Centro', 'fact', 'El centro existe.');
    const otros: string[] = [];
    for (let i = 0; i < 12; i++) otros.push((await b.learn(`Vecino ${String.fromCharCode(97 + i)}x${i}`, 'fact', `Vecino ${i}.`)).neuron!.id);

    const aprender = (async () => {
      for (let i = 0; i < 30; i++) await a.learn('Centro', 'fact', `Hecho concurrente numero ${i}.`);
    })();
    const enlazar = (async () => {
      for (const o of otros) await syn.connect('project_centro', o, 'temporal', 'misma sesion', { initialStrength: 0.3 });
    })();
    await Promise.all([aprender, enlazar]);

    const n = await a.peek('project_centro');
    expect(n!.facts.filter(f => f.text.startsWith('Hecho concurrente')).length).toBe(30);
    expect(new Set(n!.connections)).toEqual(new Set(otros));
  }, 60_000);

  it('a disconnect racing a learn loses neither', async () => {
    const c = new Cortex(brain);
    const syn = new Synapses(brain);
    await c.learn('Uno', 'fact', 'Uno.');
    await c.learn('Dos Distinto', 'fact', 'Dos.');
    await syn.connect('project_uno', 'project_dos_distinto', 'dependency');
    await Promise.all([
      (async () => { for (let i = 0; i < 15; i++) await c.learn('Uno', 'fact', `Mas ${i}.`); })(),
      syn.disconnect('project_uno', 'project_dos_distinto'),
    ]);
    const n = await c.peek('project_uno');
    expect(n!.facts.length).toBe(16);
    expect(n!.connections).toEqual([]);
  }, 60_000);

  it('linking to a neuron deleted meanwhile does not bring it back', async () => {
    const c = new Cortex(brain);
    const syn = new Synapses(brain);
    await c.learn('Queda', 'fact', 'Queda.');
    await c.learn('Se Va', 'fact', 'Se va.');
    await fs.rm(brain.paths.neuron('project_se_va'));
    await syn.connect('project_queda', 'project_se_va', 'temporal');
    expect(await c.peek('project_se_va')).toBeNull();
  });
});

describe('a write never resurrects a neuron deleted meanwhile', () => {
  it('learn: deleted between resolution and the lock → error, file stays gone', async () => {
    const c = new Cortex(brain);
    await c.learn('Efimera', 'fact', 'Existia.');
    const original = c.resolveTopic.bind(c);
    vi.spyOn(c, 'resolveTopic').mockImplementation(async (name, opts) => {
      const r = await original(name, opts);
      if (r) await fs.rm(brain.paths.neuron(r.id));   // another process forgets it now
      return r;
    });
    await expect(c.learn('Efimera', 'fact', 'Llega tarde.')).rejects.toThrow(/deleted while this write was in progress/);
    expect(await c.peek('project_efimera')).toBeNull();
  });

  it('revise and setMap: deleted meanwhile → nothing written', async () => {
    const c = new Cortex(brain);
    await c.learn('Efimera Dos', 'fact', 'Un hecho viejo.');
    const anyC = c as unknown as { resolveForWrite: (ref: string) => Promise<unknown> };
    const original = anyC.resolveForWrite.bind(c);
    vi.spyOn(anyC, 'resolveForWrite').mockImplementation(async (ref: string) => {
      const n = await original(ref);
      await fs.rm(brain.paths.neuron('project_efimera_dos'), { force: true });
      return n;
    });
    const r = await c.revise('project_efimera_dos', ['Un hecho viejo.']);
    expect(r.revised).toBe(0);
    expect(await c.peek('project_efimera_dos')).toBeNull();
    await c.learn('Efimera Dos', 'fact', 'Vuelve a existir.');
    await expect(c.setMap('project_efimera_dos', 'MAPA')).rejects.toThrow(/deleted while/);
    expect(await c.peek('project_efimera_dos')).toBeNull();
  });
});
