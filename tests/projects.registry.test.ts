import { beforeEach, afterEach, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { ProjectRegistry } from '../src/engine/projects.js';

let root: string;
let registry: ProjectRegistry;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-project-registry-'));
  const brain = new Brain(root); await brain.initialize();
  registry = new ProjectRegistry(brain);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });

it('dos carpetas del mismo nombre no comparten identidad por accidente', async () => {
  const a = await registry.bind('C:/clientes/ana/web', { neurons: ['project_ana'] });
  const b = await registry.bind('C:/clientes/bruno/web', { neurons: ['project_bruno'] });
  expect(a.id).not.toBe(b.id);
  expect((await registry.find('c:\\clientes\\ana\\web\\'))?.neurons).toEqual(['project_ana']);
});

it('un remoto y sus carpetas declaradas conservan identidad entre sesiones', async () => {
  const a = await registry.bind('https://github.com/example/studio.git', {
    aliases: ['C:/trabajo/studio', '/home/persona/studio'], neurons: ['project_studio'],
  });
  expect((await registry.find('git@github.com:example/studio.git'))?.id).toBe(a.id);
  expect((await registry.find('/home/persona/studio'))?.id).toBe(a.id);
  const reopened = new ProjectRegistry(new Brain(root));
  expect((await reopened.find('C:/trabajo/studio'))?.neurons).toEqual(['project_studio']);
});

it('rechaza reasignar un alias que pertenece a otro proyecto', async () => {
  await registry.bind('alpha', { aliases: ['C:/alpha'] });
  await expect(registry.bind('beta', { aliases: ['C:/alpha'] })).rejects.toThrow(/alias/i);
  expect((await registry.find('C:/alpha'))?.aliases).toContain('alpha');
});

it('conserva registros concurrentes y rechaza referencias con credenciales', async () => {
  await Promise.all(['alpha', 'beta'].map(x => registry.bind(x, {})));
  expect(await registry.find('alpha')).not.toBeNull();
  expect(await registry.find('beta')).not.toBeNull();
  await expect(registry.bind('https://person:fake-password@example.com/repo', {})).rejects.toThrow(/credential/i);
});

it('los ids y alias comparten un único espacio de nombres', async () => {
  await registry.bind('C:/alpha', { id: 'alpha' });
  await expect(registry.bind('C:/beta', { id: 'beta', aliases: ['alpha'] })).rejects.toThrow(/alias/i);
  await registry.bind('C:/gamma', { id: 'gamma', aliases: ['future-id'] });
  await expect(registry.bind('C:/delta', { id: 'future-id' })).rejects.toThrow(/alias/i);
  expect((await registry.find('alpha'))?.id).toBe('alpha');
  expect(await registry.find('C:/beta')).toBeNull();
});
