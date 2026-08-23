// ─── The memory diet: warn on near-duplicates, never merge ───────
//
// Measured on the reference brain: its heaviest neuron held 293 facts with
// 1,407 near-duplicate pairs — session summaries retelling the same thing
// with variations, each as loud as the others on recall. The engine now
// warns the writer at save time. Warn-only: blind similarity is how
// "sprint_2" and "sprint_3" become one thing, so nothing is ever merged or
// refused automatically.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';

let root: string;
let cortex: Cortex;

const V1 =
  'La paginacion del listado de facturas quedo configurada a 24 elementos por pagina ' +
  'con numeros centrados y la cache del grid desactivada tras el cambio de julio.';
const V2 =
  'La paginacion del listado de facturas quedo configurada a 24 elementos por pagina ' +
  'con numeros centrados y la cache del grid desactivada tras el cambio de agosto.';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-diet-'));
  const brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('near-duplicate warning', () => {
  it('warns, names the older fact, and stores the new one anyway', async () => {
    const r1 = await cortex.learn('Facturacion', 'fact', V1);
    const r2 = await cortex.learn('Facturacion', 'fact', V2);

    expect(r2.near_duplicates.length).toBe(1);
    expect(r2.near_duplicates[0].id).toBe(r1.neuron!.facts[0].id);
    expect(r2.near_duplicates[0].similarity).toBeGreaterThanOrEqual(0.8);
    // Stored anyway — the brain never refuses knowledge.
    expect(r2.neuron!.facts.map(f => f.text)).toContain(V2);
  });

  it('stays quiet for unrelated facts and for exact duplicates', async () => {
    await cortex.learn('Facturacion', 'fact', V1);
    const distinto = await cortex.learn('Facturacion', 'fact',
      'El proveedor de correo cambia a Brevo el mes que viene por el limite de envios diarios.');
    expect(distinto.near_duplicates).toEqual([]);

    const exacto = await cortex.learn('Facturacion', 'fact', V1);
    expect(exacto.near_duplicates).toEqual([]);   // exact-dup path: skipped, no noise
  });

  it('stays quiet below the minimum length — shorts are for the exact check', async () => {
    await cortex.learn('Facturacion', 'fact', 'El cron corre a las 5.');
    const r = await cortex.learn('Facturacion', 'fact', 'El cron corre a las 6.');
    expect(r.near_duplicates).toEqual([]);
  });

  it('does not warn about a fact the same call just retired via supersedes', async () => {
    const r1 = await cortex.learn('Facturacion', 'fact', V1);
    const id = r1.neuron!.facts[0].id!;
    const r2 = await cortex.learn('Facturacion', 'fact', V2, { supersedes: [id] });
    expect(r2.superseded).toBe(1);
    expect(r2.near_duplicates).toEqual([]);   // the old telling is already retired
  });
});
