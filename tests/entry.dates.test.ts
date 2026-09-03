// ─── Dated errors, debts, patterns and preferences (1.13) ─────────
//
// Until 1.13 these were bare strings with no date, so recall answered
// matched_added: "" for every error and "prefer the more recent" could not
// apply to the one ledger where it matters most. The date lives in a sidecar
// keyed by content hash: the arrays, the ops format and old brains are
// untouched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';
import { applyOps } from '../src/sync/materialize.js';
import { entryId, type Op } from '../src/sync/ops.js';
import { readJSON } from '../src/utils/fs.js';
import type { Neuron } from '../src/types/index.js';

let root: string;
let brain: Brain;
let cortex: Cortex;
let engine: SearchEngine;

const ERROR = 'Usé node --check sobre un módulo ES y dio OK falso; la comprobación real es importarlo.';
const DEBT = 'DEFERRED: proteger los PDF. CEILING: cualquiera los descarga. REVISIT WHEN: funcione el alta.';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-dates-'));
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

describe('learn stamps the entry', () => {
  it('error, debt, pattern and preference get a date in entry_dates', async () => {
    const r = await cortex.learn('Despliegues', 'error', ERROR);
    await cortex.learn('Despliegues', 'debt', DEBT);
    await cortex.learn('Despliegues', 'pattern', 'Probar siempre importando el módulo.');
    await cortex.learn('Despliegues', 'preference', 'Prefiero mensajes de commit en español.');

    const n = (await readJSON<Neuron>(brain.paths.neuron(r.neuron!.id)))!;
    for (const text of [ERROR, DEBT, 'Probar siempre importando el módulo.', 'Prefiero mensajes de commit en español.']) {
      const fecha = n.entry_dates?.[entryId(text)];
      expect(fecha, text.slice(0, 30)).toBeTruthy();
      expect(new Date(fecha!).getFullYear()).toBeGreaterThan(2020);
    }
  });

  it('recall returns that date as matched_added', async () => {
    await cortex.learn('Despliegues', 'error', ERROR);
    const hits = await engine.search('node --check módulo ES');
    expect(hits[0].matched_kind).toBe('error');
    expect(hits[0].matched_added).not.toBe('');
  });

  it('forget takes the date with the entry', async () => {
    const r = await cortex.learn('Despliegues', 'error', ERROR);
    await cortex.learn('Despliegues', 'debt', DEBT);
    await cortex.forget('Despliegues', [ERROR]);

    const n = (await readJSON<Neuron>(brain.paths.neuron(r.neuron!.id)))!;
    expect(n.errors).toEqual([]);
    expect(n.entry_dates?.[entryId(ERROR)]).toBeUndefined();
    expect(n.entry_dates?.[entryId(DEBT)]).toBeTruthy();
  });

  it('a brain written before 1.13 is still valid: entries without a date simply have none', async () => {
    const r = await cortex.learn('Despliegues', 'fact', 'Un hecho cualquiera para crear la neurona.');
    const p = brain.paths.neuron(r.neuron!.id);
    const n = (await readJSON<Neuron>(p))!;
    delete n.entry_dates;
    n.errors = [ERROR];
    await fs.writeFile(p, JSON.stringify(n));
    await engine.indexNeuron(n);

    const hits = await engine.search('node --check módulo ES');
    expect(hits[0].matched_kind).toBe('error');
    expect(hits[0].matched_added).toBe('');
  });
});

describe('dates travel through the team log', () => {
  const base = (): Op => ({ v: 1, op: 'neuron', nid: 'project_x', by: 'ana', at: '2026-01-01T00:00:00.000Z', name: 'X', ntype: 'project', domain: 'general' });

  it('an error op brings its date, and the earliest of two wins', () => {
    const ops: Op[] = [
      base(),
      { v: 1, op: 'error', nid: 'project_x', by: 'bruno', at: '2026-03-02T00:00:00.000Z', text: ERROR },
      { v: 1, op: 'error', nid: 'project_x', by: 'ana', at: '2026-02-01T00:00:00.000Z', text: ERROR },
    ];
    const { neuron } = applyOps(null, ops, { id: 'project_x' });
    expect(neuron.errors).toEqual([ERROR]);
    expect(neuron.entry_dates?.[entryId(ERROR)]).toBe('2026-02-01T00:00:00.000Z');
  });

  it('a purge removes the date too, and the sidecar stays sorted', () => {
    const ops: Op[] = [
      base(),
      { v: 1, op: 'debt', nid: 'project_x', by: 'ana', at: '2026-02-01T00:00:00.000Z', text: DEBT },
      { v: 1, op: 'error', nid: 'project_x', by: 'ana', at: '2026-02-01T00:00:00.000Z', text: ERROR },
      { v: 1, op: 'purge', nid: 'project_x', by: 'ana', at: '2026-02-03T00:00:00.000Z', pkind: 'error', key: entryId(ERROR) },
    ];
    const { neuron } = applyOps(null, ops, { id: 'project_x' });
    expect(neuron.errors).toEqual([]);
    expect(neuron.debts).toEqual([DEBT]);
    expect(Object.keys(neuron.entry_dates || {})).toEqual([entryId(DEBT)]);
  });
});
