// ─── A neuron reference is never a path ──────────────────────────
//
// crbro_inspect, learn, connect… resolve a reference as an id first, and the
// id became a file name as given: "../../x" read (and could write) JSON files
// outside the brain. serve --http puts these tools on the network, so the
// reference is checked where it turns into a path.
import { it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BrainPaths } from '../src/engine/brain.js';

let tmp: string;
let client: Client;
const saved = process.env.CRBRO_PATH;
const call = async (name: string, args: any = {}) => client.callTool({ name, arguments: args }) as Promise<any>;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-g-ids-'));
  process.env.CRBRO_PATH = path.join(tmp, 'brain');
  await fs.writeFile(path.join(tmp, 'outside.json'), JSON.stringify({ id: 'x', name: 'OUTSIDE', facts: [], decisions: [], patterns: [], preferences: [], connections: [], tags: [] }));
  const { createServer, createEngines } = await import('../src/server.js');
  const server = createServer(createEngines());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  await call('crbro_boot');
});

afterAll(async () => {
  await client?.close();
  if (saved === undefined) delete process.env.CRBRO_PATH; else process.env.CRBRO_PATH = saved;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

it('a relative path is not an id: nothing outside the brain is read or written', async () => {
  const r = await call('crbro_inspect', { view: 'neuron', neuron: '../../outside' });
  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).not.toContain('OUTSIDE');
  const before = await fs.readFile(path.join(tmp, 'outside.json'), 'utf8');
  await call('crbro_learn', { neuron_id: '../../outside', type: 'fact', content: 'x' });
  await call('crbro_learn', { topic: 'Safe', neuron_id: '../../outside', type: 'fact', content: 'Lands in the brain.' });
  expect(await fs.readFile(path.join(tmp, 'outside.json'), 'utf8')).toBe(before);
  expect(() => new BrainPaths(tmp).neuron('../x')).toThrow(/Invalid id/);
  expect(() => new BrainPaths(tmp).synapse('a\\b')).toThrow(/Invalid id/);
});

it('a name with a slash still resolves by name', async () => {
  const l = await call('crbro_learn', { topic: 'CI/CD', type: 'fact', content: 'Deploys go through GitHub Actions.' });
  expect(l.isError).toBeFalsy();
  const r = await call('crbro_inspect', { view: 'neuron', neuron: 'CI/CD' });
  expect(r.isError).toBeFalsy();
  expect(JSON.parse(r.content[0].text).name).toBe('CI/CD');
});
