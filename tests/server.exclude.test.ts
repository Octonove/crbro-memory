// ─── createServer({ excludeTools }) (2.11) ───────────────────────
//
// serve --http leaves crbro_secret out unless --allow-secrets: a bearer token
// must not be a key to every keychain secret. The exclusion has to hold for
// what a client sees (tools/list) and for what it can call.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let root: string;

async function connect(options?: { excludeTools?: string[] }): Promise<Client> {
  const { createServer } = await import('../src/server.js');
  const server = createServer(undefined, options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'exclude-test', version: '1' });
  await client.connect(b);
  return client;
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-exclude-'));
  process.env.CRBRO_PATH = root;
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createServer excludeTools', () => {
  it('serves all 15 tools by default', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toContain('crbro_secret');
    expect(tools).toHaveLength(15);
    await client.close();
  });

  it('leaves an excluded tool out of tools/list and refuses a call to it', async () => {
    const client = await connect({ excludeTools: ['crbro_secret'] });
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).not.toContain('crbro_secret');
    expect(tools).toHaveLength(14);
    const r: any = await client.callTool({ name: 'crbro_secret', arguments: { action: 'list' } }).catch((e: Error) => ({ thrown: e.message }));
    expect(r.thrown || (r.isError ? 'error' : '')).toBeTruthy();
    await client.close();
  });
});
