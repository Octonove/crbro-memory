import { beforeEach, afterEach, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';

let root: string; let engine: SearchEngine;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-project-recall-'));
  const b = new Brain(root); await b.initialize();
  const c = new Cortex(b); engine = new SearchEngine(b); await engine.init();
  c.setIndexer(n => engine.indexNeuron(n));
  await c.learn('Alpha', 'fact', 'El despliegue usa puerto 8443.', { neuronId: 'project_alpha' });
  await c.learn('Beta', 'fact', 'El despliegue usa puerto 9443.', { neuronId: 'project_beta' });
  await c.learn('General', 'preference', 'Antes de un despliegue verificar el puerto.', { neuronId: 'tech_general' });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });

it('filtra antes del límite sin perder preferencias globales', async () => {
  const rows = await engine.search('despliegue puerto', { neuronIds: ['project_beta'], includeGlobal: true, limit: 10 });
  expect(rows.map(r => r.neuron_id).sort()).toEqual(['project_beta', 'project_general']);
  const strict = await engine.search('despliegue puerto', { neuronIds: ['project_beta'], limit: 1 });
  expect(strict.map(r => r.neuron_id)).toEqual(['project_beta']);
});

it('prioriza el proyecto sin ocultar resultados transversales', async () => {
  const rows = await engine.searchMany(['despliegue puerto', 'puerto despliegue'], { preferNeurons: ['project_alpha'], limit: 3 });
  expect(rows[0].neuron_id).toBe('project_alpha');
  expect(rows.map(r => r.neuron_id)).toContain('project_beta');
});

it('un ámbito explícito excluye diarios completos de otros proyectos', async () => {
  await engine.indexSession({ session_id: 'session_2026-10-18', date: '2026-10-18', summary: 'El despliegue de Beta usa puerto 9443.' });
  const out = await engine.searchMany(['despliegue puerto'], { neuronIds: ['project_alpha'], includeGlobal: false });
  expect(out.map(r => r.neuron_id)).toEqual(['project_alpha']);
  const withSessions = await engine.searchManyWithStats(['despliegue puerto'], { neuronIds: ['project_alpha'] });
  expect(withSessions.sessions).toEqual([]);
  expect(withSessions.sessions_total).toBe(0);
});

it('global no convierte todos los hechos tech en hechos del proyecto actual', async () => {
  const file = path.join(root, 'cortex', 'project_beta.json');
  const n = JSON.parse(await fs.readFile(file, 'utf8'));
  n.id = 'tech_beta_infrastructure';
  n.patterns = ['Antes del despliegue comprobar puerto de Beta.'];
  await fs.writeFile(path.join(root, 'cortex', n.id + '.json'), JSON.stringify(n));
  await engine.indexNeuron(n);
  const rows = await engine.search('despliegue puerto', { neuronIds: ['project_alpha'], includeGlobal: true, globalExcludedNeurons: [n.id], limit: 10 });
  expect(rows.map(r => r.neuron_id).sort()).toEqual(['project_alpha', 'project_general']);
  const factsOnly = await engine.search('despliegue puerto', { neuronIds: ['project_alpha'], includeGlobal: true, kinds: ['fact'] });
  expect(factsOnly.map(r => r.neuron_id)).toEqual(['project_alpha']);
});
