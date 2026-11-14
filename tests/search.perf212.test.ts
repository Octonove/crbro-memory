// ─── Search CPU and write cadence (2.12) ─────────────────────────
//
// Profiled on a copy of a real 563-neuron brain with the semantic layer on,
// a recall spent a third of its CPU hashing every entry of a neuron to find
// the one a part of a long entry came from, and the index was serialised
// (~0.4 s with the event loop held) 5 s after every change. These pin both.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { entryTextById, SearchEngine } from '../src/search/index.js';
import { Brain } from '../src/engine/brain.js';
import { entryId } from '../src/sync/ops.js';
import { factId } from '../src/utils/hash.js';

const neuron = (over: Record<string, unknown> = {}) => ({
  id: 'project_x', name: 'X', domain: 'general', type: 'project', created: '2026-01-01', last_accessed: '2026-01-01',
  access_count: 0, heat: 0, summary: '', facts: [], decisions: [], patterns: [], preferences: [], errors: [], debts: [],
  connections: [], tags: [], ...over,
}) as any;

describe('entryTextById (one id → text table per neuron)', () => {
  it('finds each kind by the id the index stores, and nothing for an unknown id or kind', () => {
    const n = neuron({
      facts: [{ text: 'Un hecho.', id: factId('Un hecho.'), confidence: 1, added: '2026-01-01', source: 't' }],
      decisions: [{ text: 'Usar Postgres', rationale: 'Joins', id: entryId('Usar Postgres'), date: '2026-01-01' }],
      patterns: ['Un patrón'], preferences: ['Una preferencia'], errors: ['Un error'], debts: ['Una deuda'],
      map: { text: 'El mapa', updated: '2026-01-01' },
    });
    expect(entryTextById(n, 'fact', factId('Un hecho.'))).toBe('Un hecho.');
    expect(entryTextById(n, 'decision', entryId('Usar Postgres'))).toBe('Usar Postgres — Joins');
    expect(entryTextById(n, 'pattern', entryId('Un patrón'))).toBe('Un patrón');
    expect(entryTextById(n, 'preference', entryId('Una preferencia'))).toBe('Una preferencia');
    expect(entryTextById(n, 'error', entryId('Un error'))).toBe('Un error');
    expect(entryTextById(n, 'debt', entryId('Una deuda'))).toBe('Una deuda');
    expect(entryTextById(n, 'map', 'x')).toBe('El mapa');
    expect(entryTextById(n, 'fact', 'deadbeef0000')).toBeNull();
    expect(entryTextById(n, 'header', 'x')).toBeNull();
  });

  it('skips a retired fact and, with two entries of one id, the first one wins (as find() did)', () => {
    const t = 'Mismo texto.';
    const n = neuron({
      facts: [
        { text: 'Retirado.', id: factId('Retirado.'), confidence: 1, added: '2026-01-01', source: 't', status: 'superseded' },
        { text: t, id: 'aaaaaaaaaaaa', confidence: 1, added: '2026-01-01', source: 't' },
        { text: `${t} (otra copia)`, id: 'aaaaaaaaaaaa', confidence: 1, added: '2026-01-02', source: 't' },
      ],
    });
    expect(entryTextById(n, 'fact', factId('Retirado.'))).toBeNull();
    expect(entryTextById(n, 'fact', 'aaaaaaaaaaaa')).toBe(t);
  });

  it('the table of a neuron object is built once: a second lookup does not hash again', () => {
    const n = neuron({ patterns: Array.from({ length: 300 }, (_, i) => `Patrón número ${i}`) });
    const id = entryId('Patrón número 150');
    expect(entryTextById(n, 'pattern', id)).toBe('Patrón número 150');
    // Replace the array with one that would throw if it were walked again.
    n.patterns = new Proxy([], { get() { throw new Error('walked again'); } });
    expect(entryTextById(n, 'pattern', id)).toBe('Patrón número 150');
  });
});

describe('index write cadence', () => {
  let root: string;
  afterEach(async () => { vi.restoreAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }); });

  async function engine() {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-cadence-'));
    const brain = new Brain(root);
    await brain.initialize();
    return new SearchEngine(brain);
  }
  const delays = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map(c => Number(c[1]));

  it('waits for 30 s of quiet before writing, not 5 s', async () => {
    const e = await engine();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    (e as any).markDirty();
    expect(delays(spy).pop()).toBe(30_000);
    (e as any).persistTimer && clearTimeout((e as any).persistTimer);
  });

  it('but never later than 5 minutes after the first unsaved change', async () => {
    const e = await engine();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    (e as any).dirty = true;
    (e as any).dirtySince = Date.now() - 4 * 60_000 - 50_000;   // 4 min 50 s ago
    (e as any).markDirty();
    const d = delays(spy).pop()!;
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(10_500);
    (e as any).dirtySince = Date.now() - 6 * 60_000;            // long overdue: now
    (e as any).markDirty();
    expect(delays(spy).pop()).toBe(0);
    (e as any).persistTimer && clearTimeout((e as any).persistTimer);
  });
});
