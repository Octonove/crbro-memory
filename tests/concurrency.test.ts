// ─── Two writers, one brain ──────────────────────────────────────
//
// CRBRO is meant to be registered at user level, so two editors open at once
// is the normal case. Before the lock this lost data silently: two processes
// storing 40 facts each into one neuron asked for 80 and kept 42, with no
// error from either side. There was not a single concurrency test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { withLock, sweepStaleLocks } from '../src/utils/lock.js';
import { updateJSON } from '../src/utils/fs.js';

let root: string;
let brain: Brain;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-conc-'));
  brain = new Brain(root);
  await brain.initialize();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('concurrent writes do not clobber each other', () => {
  it('keeps every fact when two writers interleave', async () => {
    // Two Cortex instances against the same brain: the in-process equivalent
    // of Claude Code and Claude Desktop both writing.
    const a = new Cortex(brain);
    const b = new Cortex(brain);

    const escribir = async (c: Cortex, etiqueta: string) => {
      for (let i = 0; i < 25; i++) {
        await c.learn('Shared', 'fact', `${etiqueta} fact ${i}`);
      }
    };

    await Promise.all([escribir(a, 'A'), escribir(b, 'B')]);

    const n = await a.peek('project_shared');
    expect(n).not.toBeNull();
    expect(n!.facts.length).toBe(50);
    expect(n!.facts.filter(f => f.text.startsWith('A')).length).toBe(25);
    expect(n!.facts.filter(f => f.text.startsWith('B')).length).toBe(25);
  }, 60_000);

  it('serialises updateJSON on the same file', async () => {
    const p = path.join(root, 'contador.json');
    await fs.writeFile(p, JSON.stringify({ n: 0 }), 'utf-8');

    // Without the lock, read-modify-write from 20 racing callers loses most
    // of the increments.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        updateJSON<{ n: number }>(p, cur => ({ n: (cur?.n ?? 0) + 1 }))
      )
    );

    const final = JSON.parse(await fs.readFile(p, 'utf-8'));
    expect(final.n).toBe(20);
  }, 60_000);

  it('never leaves a lock file behind', async () => {
    const c = new Cortex(brain);
    await c.learn('Shared', 'fact', 'one');
    await c.learn('Shared', 'fact', 'two');

    const sobrantes = (await fs.readdir(brain.paths.cortex)).filter(f => f.endsWith('.lock'));
    expect(sobrantes).toEqual([]);
  }, 30_000);

  it('releases the lock even when the work throws', async () => {
    const p = path.join(root, 'x.json');
    await expect(withLock(p, async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    // If the lock had leaked, this would hang until the timeout.
    const ok = await withLock(p, async () => 'llegue');
    expect(ok).toBe('llegue');
  }, 30_000);

  it('breaks a lock abandoned by a dead process', async () => {
    const p = path.join(brain.paths.cortex, 'huerfano.json');
    const lock = `${p}.lock`;
    await fs.writeFile(lock, '9999 abandonado', 'utf-8');
    // Backdate it beyond the staleness window.
    const viejo = new Date(Date.now() - 60_000);
    await fs.utimes(lock, viejo, viejo);

    const swept = await sweepStaleLocks(brain.paths.cortex);
    expect(swept).toBe(1);

    // And a fresh writer gets through rather than waiting for the timeout.
    const t0 = Date.now();
    await withLock(p, async () => undefined);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 30_000);
});

describe('credentials never reach the disk', () => {
  it('redacts a token but keeps the sentence', async () => {
    const c = new Cortex(brain);
    const r = await c.learn(
      'Deploy',
      'fact',
      'El token de publicacion es npm_abcdefghijklmnopqrstuvwxyz0123456789 y caduca en enero.'
    );

    expect(r.redacted).toContain('npm token');
    const texto = r.neuron!.facts[0].text;
    expect(texto).not.toContain('npm_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(texto).toContain('[REDACTED: npm token]');
    expect(texto).toContain('caduca en enero');   // the knowledge survives
  }, 30_000);

  it('leaves ordinary prose alone', async () => {
    const c = new Cortex(brain);
    const texto = 'La politica de password es estricta y el articulo 7307 sale el 4 de septiembre.';
    const r = await c.learn('Notas', 'fact', texto);
    expect(r.redacted).toEqual([]);
    expect(r.neuron!.facts[0].text).toBe(texto);
  }, 30_000);

  it('finds what was stored before the filter existed, and can remove it', async () => {
    // A neuron written by an older version, with a key in it.
    const c = new Cortex(brain);
    await fs.writeFile(
      brain.paths.neuron('project_legacy'),
      JSON.stringify({
        id: 'project_legacy', name: 'Legacy', domain: 'general', type: 'project',
        created: '2026-01-01T00:00:00.000Z', last_accessed: '2026-01-01T00:00:00.000Z',
        access_count: 1, heat: 0.5, summary: '',
        facts: [
          { text: 'clave: AIzaSyC3xK9mP2qR7tV4wX1yZ8aB5cD6eF7gH8i', confidence: 1, added: '2026-01-01T00:00:00.000Z', source: 'session' },
          { text: 'Un hecho normal que hay que conservar.', confidence: 1, added: '2026-01-01T00:00:00.000Z', source: 'session' },
        ],
        decisions: [], patterns: [], preferences: [], connections: [], tags: [],
      }),
      'utf-8'
    );

    const hallazgos = await c.auditSecrets();
    const legacy = hallazgos.find(h => h.neuron_id === 'project_legacy');
    expect(legacy?.kinds).toContain('Google API key');

    const r = await c.forget('project_legacy', ['clave: AIzaSyC3xK9mP2qR7tV4wX1yZ8aB5cD6eF7gH8i']);
    expect(r.removed).toBe(1);
    expect(r.backup).toBeTruthy();

    const despues = await c.peek('project_legacy');
    expect(despues!.facts.length).toBe(1);
    expect(despues!.facts[0].text).toContain('hay que conservar');

    // The quarantine copy still holds the original, so a mistake is undoable.
    expect(await c.auditSecrets()).toEqual([]);
    const copia = await fs.readdir(brain.paths.quarantine);
    expect(copia.length).toBe(1);
  }, 30_000);
});
