// ─── The 23 tool definitions, as a client sees them (1.13) ────────
//
// Glama scored Behavioral Transparency 2/5 on four tools because nothing in
// the definition said whether they read or write. Now every tool carries a
// title and MCP annotations, and the read tools with a stable shape declare
// an outputSchema honoured with structuredContent. This test speaks real
// MCP to the server over an in-memory transport, so what it checks is what
// a client gets — not what the source intends.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let root: string;
let client: Client;
let tools: any[];

const READ_ONLY = [
  'crbro_status', 'crbro_neuron', 'crbro_neurons', 'crbro_recall', 'crbro_connections',
  'crbro_sessions', 'crbro_hot_topics', 'crbro_global_map', 'crbro_audit',
];
const DESTRUCTIVE = ['crbro_maintenance', 'crbro_map', 'crbro_secret', 'crbro_forget'];
const STRUCTURED = [
  'crbro_status', 'crbro_neurons', 'crbro_recall', 'crbro_connections',
  'crbro_sessions', 'crbro_hot_topics', 'crbro_audit',
];

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-tools-'));
  // The brain root is read when brain.ts loads, so the env must be set
  // before the server module is imported — never the user's real brain.
  process.env.CRBRO_PATH = root;
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(ct);
  tools = (await client.listTools()).tools;
  // A fresh root has no brain yet: boot creates it, as every session does.
  await client.callTool({ name: 'crbro_boot', arguments: {} });
});

afterAll(async () => {
  await client.close();
  delete process.env.CRBRO_PATH;
  await fs.rm(root, { recursive: true, force: true });
});

describe('tools/list', () => {
  it('registers exactly 23 tools, each with a title and annotations', () => {
    expect(tools.length).toBe(23);
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.annotations, t.name).toBeTruthy();
      expect(typeof t.annotations.readOnlyHint, t.name).toBe('boolean');
      expect(typeof t.annotations.destructiveHint, t.name).toBe('boolean');
    }
  });

  it('marks the readers read-only and the writers not', () => {
    const ro = tools.filter(t => t.annotations.readOnlyHint).map(t => t.name).sort();
    expect(ro).toEqual([...READ_ONLY].sort());
  });

  it('marks what can destroy as destructive', () => {
    const d = tools.filter(t => t.annotations.destructiveHint).map(t => t.name).sort();
    expect(d).toEqual([...DESTRUCTIVE].sort());
    // A read-only tool can never be destructive.
    for (const t of tools) if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint).toBe(false);
  });

  it('declares an outputSchema on the stable-shaped readers', () => {
    const s = tools.filter(t => t.outputSchema).map(t => t.name).sort();
    expect(s).toEqual([...STRUCTURED].sort());
  });

  it('keeps every description under 1,000 characters', () => {
    for (const t of tools) expect(t.description.length, t.name).toBeLessThan(1000);
  });
});

describe('tools/call', () => {
  it('crbro_status returns structuredContent matching its schema', async () => {
    const r: any = await client.callTool({ name: 'crbro_status', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.crbro_version).toBeTruthy();
    expect(typeof r.structuredContent.total_neurons).toBe('number');
  });

  it('crbro_boot hands over memory_discipline once', async () => {
    const r: any = await client.callTool({ name: 'crbro_boot', arguments: {} });
    const body = JSON.parse(r.content[0].text);
    expect(body.memory_discipline).toContain('crbro_recall');
    expect(body.memory_discipline).toContain('crbro_consolidate');
  });

  it('crbro_recall returns structuredContent with confidence on each result', async () => {
    await client.callTool({ name: 'crbro_learn', arguments: {
      topic: 'Hosting', type: 'fact', content: 'El VPS de Hetzner corre Ubuntu 22.04 con RunCloud.',
    } });
    const r: any = await client.callTool({ name: 'crbro_recall', arguments: { query: 'VPS Hetzner Ubuntu' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.total_results).toBe(1);
    expect(r.structuredContent.results[0].confidence).toBe('strong');
  });
});
