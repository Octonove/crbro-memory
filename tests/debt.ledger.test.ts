// ─── The debt ledger: the graveyard of the unbuilt ───────────────
//
// An error is "did X wrong, fixed it so". A debt is its twin: "skipped X on
// purpose — here is the ceiling, revisit when Y". Deferrals used to live
// scattered in prose or nowhere; when their condition arrived nobody
// remembered, and dead ideas got re-proposed and re-discussed from scratch.
// Real examples from the reference brain: semantic search (deferred over a
// 472MB model), the grid cache plugin (disabled, revisit past 500 cards),
// unprotected PDFs (revisit when signup works).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';
import { Maintenance } from '../src/engine/maintenance.js';
import { Synapses } from '../src/engine/synapses.js';
import { HeatEngine } from '../src/engine/heat.js';
import { Hippocampus } from '../src/engine/hippocampus.js';
import { Prefrontal } from '../src/engine/prefrontal.js';
import { applyOps } from '../src/sync/materialize.js';
import { entryId } from '../src/sync/ops.js';
import type { Op } from '../src/sync/ops.js';

let root: string;
let brain: Brain;
let cortex: Cortex;
let engine: SearchEngine;

const DEUDA =
  'APLAZADO: proteger los PDFs de los lead magnets. TECHO: cualquiera los descarga ' +
  'sin registrarse. REVISAR CUANDO: el flujo de registro funcione.';
const SIN_DISPARADOR =
  'APLAZADO: migrar el formulario viejo a la API nueva, de momento se queda como está.';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-debt-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
  engine = new SearchEngine(brain);
  await engine.init();
  cortex.setIndexer(n => engine.indexNeuron(n));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('the debt ledger', () => {
  it('stores a debt, finds it by its trigger context, never duplicates', async () => {
    const r1 = await cortex.learn('SimplificaWeb', 'debt', DEUDA);
    expect(r1.neuron!.debts).toContain(DEUDA);
    const r2 = await cortex.learn('SimplificaWeb', 'debt', DEUDA);
    expect(r2.neuron!.debts!.filter(d => d === DEUDA)).toHaveLength(1);

    // The point of the ledger: a future conversation touching the trigger
    // context surfaces the deferral.
    const hits = await engine.search('flujo de registro lead magnets');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].matched_kind).toBe('debt');
    expect(hits[0].matching_content).toContain('REVISAR CUANDO');
  });

  it('forget removes a debt from neuron and index', async () => {
    await cortex.learn('SimplificaWeb', 'debt', DEUDA);
    const res = await cortex.forget('SimplificaWeb', [DEUDA]);
    expect(res.removed).toBe(1);
    const hits = await engine.search('proteger PDFs lead magnets');
    expect(hits.map(h => h.matching_content).join('\n')).not.toContain('APLAZADO');
  });

  it('maintenance flags the debts that never named a revisit condition', async () => {
    await cortex.learn('SimplificaWeb', 'debt', DEUDA);
    await cortex.learn('SimplificaWeb', 'debt', SIN_DISPARADOR);

    const maint = new Maintenance(brain, cortex, new Synapses(brain), new HeatEngine(brain), new Hippocampus(brain), new Prefrontal(brain), engine);
    const report = await maint.run(true);   // dry run cuenta igual
    expect(report.debts_total).toBe(2);
    expect(report.debts_without_trigger).toBe(1);
    expect(report.notes.join(' ')).toContain('REVISAR CUANDO');
  });
});

describe('debts travel through a space like errors', () => {
  const base = (nid: string) => ({ v: 1, nid, by: 'ana', at: '2026-08-24T10:00:00Z' });

  it('debt ops union without duplicates, whatever the order', () => {
    const nid = 'project_demo';
    const ops: Op[] = [
      { ...base(nid), op: 'debt', text: DEUDA } as Op,
      { ...base(nid), by: 'luis', op: 'debt', text: DEUDA } as Op,
      { ...base(nid), op: 'debt', text: SIN_DISPARADOR } as Op,
    ];
    const a = applyOps(null, ops).neuron;
    const b = applyOps(null, [...ops].reverse()).neuron;
    expect(a.debts).toHaveLength(2);
    expect(b.debts).toEqual(a.debts);
  });

  it('a purged debt never comes back, whatever the order', () => {
    const nid = 'project_demo';
    const anade: Op = { ...base(nid), op: 'debt', text: DEUDA } as Op;
    const purga = { ...base(nid), at: '2026-08-25T00:00:00Z', op: 'purge', pkind: 'debt',
                    key: entryId(DEUDA) } as unknown as Op;
    expect(applyOps(null, [anade, purga]).neuron.debts || []).toHaveLength(0);
    expect(applyOps(null, [purga, anade]).neuron.debts || []).toHaveLength(0);
  });
});

describe('a lone purge persists across a sync (1.11 review finding)', () => {
  it('applyOps reports entries_removed so the change-gate fires', async () => {
    const { applyOps } = await import('../src/sync/materialize.js');
    const { entryId } = await import('../src/sync/ops.js');
    const D = 'APLAZADO: algo. REVISAR CUANDO: llegue el momento.';
    // B ya tiene la deuda sincronizada.
    const base = applyOps(null, [{ v: 1, nid: 'project_x', by: 'ana', at: '2026-08-24T10:00:00Z', op: 'debt', text: D } as any]).neuron;
    // Llega SOLO la purga (A la olvidó). El report debe señalar el borrado.
    const { neuron, report } = applyOps(base, [
      { v: 1, nid: 'project_x', by: 'ana', at: '2026-08-25T00:00:00Z', op: 'debt', text: D } as any,
      { v: 1, nid: 'project_x', by: 'ana', at: '2026-08-25T00:00:01Z', op: 'purge', pkind: 'debt', key: entryId(D) } as any,
    ]);
    expect(neuron.debts || []).toHaveLength(0);
    expect((report as any).entries_removed).toBe(1);
  });
});
