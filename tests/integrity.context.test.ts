import { beforeEach, afterEach, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Prefrontal } from '../src/engine/prefrontal.js';
import { Hippocampus } from '../src/engine/hippocampus.js';

let root: string;
let brain: Brain;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-integrity-'));
  brain = new Brain(root);
  await brain.initialize();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });

it('conserva todos los pendientes aceptados por conversaciones simultáneas', async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) =>
    new Prefrontal(brain).updateContext({ add_pending: `Entrega ficticia ${i}` })));
  const ctx = await new Prefrontal(brain).getContext();
  expect(new Set(ctx.pending_tasks.map(t => typeof t === 'string' ? t : t.text)).size).toBe(12);
});

it('actualizar la última sesión no elimina un pendiente paralelo', async () => {
  await Promise.all([
    new Prefrontal(brain).updateContext({ add_pending: 'Revisar propuesta ficticia' }),
    new Prefrontal(brain).setLastSession('session_2026-10-18'),
  ]);
  const ctx = await new Prefrontal(brain).getContext();
  expect(ctx.pending_tasks).toHaveLength(1);
  expect(ctx.last_session).toBe('session_2026-10-18');
});

it('consolidaciones paralelas conservan cada resumen y sus contadores', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    new Hippocampus(brain).logSession({ summary: `Resumen ficticio ${i}`, topics_touched: [`tema_${i}`], key_facts_added: 1 })));
  const log = await new Hippocampus(brain).getToday();
  expect(log?.summary.split('\n---\n')).toHaveLength(8);
  expect(log?.topics_touched).toHaveLength(8);
  expect(log?.key_facts_added).toBe(8);
  expect((await brain.getManifest()).total_sessions).toBe(1);
});
