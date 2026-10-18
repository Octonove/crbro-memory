import { beforeAll, afterAll, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
let root: string; let a: Client; let b: Client;
const call = async (c: Client, name: string, args: any = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r.structuredContent || JSON.parse(r.content[0].text);
};
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-project-mcp-'));
  process.env.CRBRO_PATH = root;
  const { createServer, createEngines } = await import('../src/server.js');
  const engines = createEngines();
  const connect = async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createServer(engines); await server.connect(st);
    const client = new Client({ name: 'fixture', version: '0.0.0' }); await client.connect(ct); return client;
  };
  a = await connect(); b = await connect();
  await call(a, 'crbro_boot');
  await call(a, 'crbro_learn', { topic: 'Alpha', type: 'fact', content: 'El despliegue usa puerto 8443.' });
  await call(a, 'crbro_learn', { topic: 'Beta', type: 'fact', content: 'El despliegue usa puerto 9443.' });
}, 30_000);
afterAll(async () => {
  await a?.close(); await b?.close(); delete process.env.CRBRO_PATH;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

it('dos clientes comparten cerebro pero no su proyecto activo', async () => {
  const aa = await call(a, 'crbro_boot', { project: 'C:/clientes/alpha/web', project_neurons: ['project_alpha'] });
  const bb = await call(b, 'crbro_boot', { project: 'C:/clientes/beta/web', project_neurons: ['project_beta'] });
  expect(aa.project_context.id).not.toBe(bb.project_context.id);
  await call(a, 'crbro_context', { add_pending: 'Entrega de Alpha', due: '2026-12-01', done_when: 'Aceptación escrita' });
  await call(b, 'crbro_context', { add_pending: 'Entrega de Beta' });
  const ca = await call(a, 'crbro_context'); const cb = await call(b, 'crbro_context');
  expect(ca.pending_tasks.map((t: any) => t.text)).toEqual(['Entrega de Alpha']);
  expect(cb.pending_tasks.map((t: any) => t.text)).toEqual(['Entrega de Beta']);
  const ra = await call(a, 'crbro_recall', { query: 'despliegue puerto', scope: 'project' });
  expect(ra.results.map((r: any) => r.neuron_id)).toEqual(['project_alpha']);
  const rb = await call(b, 'crbro_recall', { query: 'despliegue puerto', scope: 'project' });
  expect(rb.results.map((r: any) => r.neuron_id)).toEqual(['project_beta']);
  const all = await call(a, 'crbro_recall', { query: 'despliegue puerto', scope: 'all' });
  expect(all.results.map((r: any) => r.neuron_id).sort()).toEqual(['project_alpha', 'project_beta']);
});

it('separa relevancia, verificación y los registros históricos de un dato actual', async () => {
  const learned = await call(a, 'crbro_learn', { topic: 'Archivo', type: 'fact', content: 'El servidor juniper utilizaba el puerto 7777.', temporal: 'historical' });
  const r = await call(a, 'crbro_recall', { query: 'juniper puerto', intent: 'current', scope: 'all' });
  expect(r.results.map((x: any) => x.neuron_id)).not.toContain(learned.neuron_id);
  expect(r.historical_matches[0]).toMatchObject({ neuron_id: learned.neuron_id, temporal: 'historical', verification: { method: 'none' } });
  expect(r.historical_matches[0].relevance.meaning).toBe('search_match_not_truth');
  const history = await call(a, 'crbro_recall', { query: 'juniper puerto', intent: 'history', scope: 'all' });
  expect(history.results[0].neuron_id).toBe(learned.neuron_id);
});

it('registra fuente explícita sin convertir una repetición en comprobación', async () => {
  const content = 'La conexión osprey utiliza el puerto 8222.';
  const learned = await call(a, 'crbro_learn', { topic: 'Osprey', type: 'fact', content, reference: { kind: 'file', value: 'config/app.json', field: 'port' } });
  await call(a, 'crbro_learn', { topic: 'Osprey', type: 'fact', content });
  let r = await call(a, 'crbro_recall', { query: 'osprey puerto', scope: 'all' });
  expect(r.results[0].verification.method).toBe('none');
  await call(a, 'crbro_revise', { neuron: learned.neuron_id, facts: [content], status: 'verified', evidence: { method: 'source', reference: { kind: 'file', value: 'config/app.json', field: 'port' } } });
  r = await call(a, 'crbro_recall', { query: 'osprey puerto', scope: 'all' });
  expect(r.results[0]).toMatchObject({ verification: { method: 'source', reference: { value: 'config/app.json' } }, provenance: { origin: 'local' } });
  const detail = await call(a, 'crbro_inspect', { view: 'neuron', neuron: learned.neuron_id, entries: [content] });
  expect(detail.neuron.entries[0]).toMatchObject({ verification: { method: 'source' }, reference: { value: 'config/app.json' } });
  const index = await call(a, 'crbro_inspect', { view: 'neuron', neuron: learned.neuron_id });
  expect(index.neuron.entries[0].verification.method).toBe('source');
});
