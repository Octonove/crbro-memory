import { beforeEach, afterEach, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Prefrontal } from '../src/engine/prefrontal.js';

let root: string; let pf: Prefrontal;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-project-context-'));
  const b = new Brain(root); await b.initialize(); pf = new Prefrontal(b);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });

it('el mismo pendiente en dos proyectos tiene identidad y cierre independientes', async () => {
  const a = await pf.updateContext({ project: 'alpha', add_pending: 'Enviar propuesta', due: '2026-12-01', done_when: 'Cliente confirma recepción' });
  const b = await pf.updateContext({ project: 'beta', add_pending: 'Enviar propuesta' });
  expect(a.pending_tasks[0].id).not.toBe(b.pending_tasks[0].id);
  expect(a.pending_tasks[0]).toMatchObject({ project: 'alpha', due: '2026-12-01', status: 'open', done_when: 'Cliente confirma recepción' });
  await pf.updateContext({ project: 'alpha', resolve_pending: 'Enviar propuesta' });
  expect((await pf.getContext('alpha')).pending_tasks).toHaveLength(0);
  expect((await pf.getContext('beta')).pending_tasks).toHaveLength(1);
  expect((await pf.getContext('alpha')).recently_closed?.[0].status).toBe('done');
});

it('limpiar un proyecto conserva los otros y los pendientes globales', async () => {
  await pf.updateContext({ add_pending: 'Pendiente global' });
  await pf.updateContext({ project: 'alpha', add_pending: 'Pendiente alpha', set_topics: ['project_alpha'] });
  await pf.updateContext({ project: 'beta', add_pending: 'Pendiente beta', set_topics: ['project_beta'] });
  await pf.updateContext({ project: 'alpha', clear: true });
  expect((await pf.getContext()).pending_tasks).toHaveLength(2);
  expect((await pf.getContext('beta')).active_topics).toEqual(['project_beta']);
});

it('rechaza fechas inexistentes y no modifica el contexto', async () => {
  await expect(pf.updateContext({ project: 'alpha', add_pending: 'Algo', due: '2026-02-31' })).rejects.toThrow(/date/i);
  expect((await pf.getContext()).pending_tasks).toHaveLength(0);
});
