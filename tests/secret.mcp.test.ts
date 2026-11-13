// crbro_secret through MCP (2.11): no arbitrary environment, overwrite and
// remove need a confirmation, and the answer says where a value came from.
// Temporary brain and temporary CRBRO_KEYS_DIR only; fake values only.
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { detectBackend } from '../src/engine/keychain.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const hasStore = detectBackend().backend !== null;
let root: string; let keys: string; let c: Client;
const raw = async (args: any) => (await c.callTool({ name: 'crbro_secret', arguments: args })) as any;
const call = async (args: any) => {
  const r = await raw(args);
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-secret-mcp-'));
  keys = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-secret-mcp-keys-'));
  process.env.CRBRO_PATH = root;
  process.env.CRBRO_KEYS_DIR = keys;
  const { createServer, createEngines } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(createEngines()); await server.connect(st);
  c = new Client({ name: 'fixture', version: '0.0.0' }); await c.connect(ct);
}, 60_000);
afterAll(async () => {
  await c?.close();
  delete process.env.CRBRO_PATH; delete process.env.CRBRO_KEYS_DIR;
  delete process.env.FIXTURE_PLAIN_ENV; delete process.env.CRBRO_SECRET_FIXTURE_PREFIXED;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  await fs.rm(keys, { recursive: true, force: true, maxRetries: 3 });
});

describe('crbro_secret get (G3/S5)', () => {
  it('does not hand out the server environment', async () => {
    process.env.FIXTURE_PLAIN_ENV = 'fake-plain-env-value';
    const r = await raw({ action: 'get', name: 'FIXTURE_PLAIN_ENV' });
    expect(JSON.stringify(r)).not.toContain('fake-plain-env-value');
  });

  it('rejects a name that is not SCREAMING_SNAKE_CASE (USERNAME-style lookups of other shapes)', async () => {
    const r = await raw({ action: 'get', name: 'Path' });
    expect(r.isError).toBe(true);
  });

  it('honours CRBRO_SECRET_<NAME> and says so', async () => {
    process.env.CRBRO_SECRET_FIXTURE_PREFIXED = 'fake-prefixed';
    const r = await call({ action: 'get', name: 'FIXTURE_PREFIXED' });
    expect(r).toMatchObject({ found: true, value: 'fake-prefixed', source: 'env' });
  });
});

describe.runIf(hasStore)('crbro_secret overwrite and remove need confirmation (G6)', () => {
  it('a new name is stored at once', async () => {
    const r = await call({ action: 'set', name: 'FIXTURE_MCP', value: 'fake-one' });
    expect(r.stored).toBe('FIXTURE_MCP');
  });

  it('the same value again needs nothing', async () => {
    const r = await call({ action: 'set', name: 'FIXTURE_MCP', value: 'fake-one' });
    expect(r.stored).toBe('FIXTURE_MCP');
  });

  it('a different value is refused until confirmed, and a wrong token changes nothing', async () => {
    const first = await call({ action: 'set', name: 'FIXTURE_MCP', value: 'fake-two' });
    expect(first).toMatchObject({ needs_confirmation: true, stored: null });
    expect((await call({ action: 'get', name: 'FIXTURE_MCP' })).value).toBe('fake-one');
    const wrong = await call({ action: 'set', name: 'FIXTURE_MCP', value: 'fake-two', confirm: 'nope' });
    expect(wrong.needs_confirmation).toBe(true);
    // A token for one value does not overwrite with another.
    const other = await call({ action: 'set', name: 'FIXTURE_MCP', value: 'fake-three', confirm: first.confirm_token });
    expect(other.needs_confirmation).toBe(true);
    const ok = await call({ action: 'set', name: 'FIXTURE_MCP', value: 'fake-two', confirm: first.confirm_token });
    expect(ok).toMatchObject({ stored: 'FIXTURE_MCP', overwritten: true });
    expect((await call({ action: 'get', name: 'FIXTURE_MCP' }))).toMatchObject({ value: 'fake-two', source: 'keychain' });
  });

  it('remove is a dry run first, then removes with the token', async () => {
    const dry = await call({ action: 'remove', name: 'FIXTURE_MCP' });
    expect(dry).toMatchObject({ removed: false, needs_confirmation: true });
    expect((await call({ action: 'get', name: 'FIXTURE_MCP' })).found).toBe(true);
    const done = await call({ action: 'remove', name: 'FIXTURE_MCP', confirm: dry.confirm_token });
    expect(done.removed).toBe(true);
    expect((await call({ action: 'get', name: 'FIXTURE_MCP' })).found).toBe(false);
    // The token is spent: the store changed.
    const again = await call({ action: 'remove', name: 'FIXTURE_MCP', confirm: dry.confirm_token });
    expect(again.removed).toBe(false);
  });

  it('a missing store is an error with recovery hints, not an empty list', async () => {
    await call({ action: 'set', name: 'FIXTURE_LOST', value: 'fake-lost' });
    await fs.unlink(path.join(keys, 'keys.dpapi')).catch(() => {});
    if (os.platform() !== 'win32') return;
    const r = await raw({ action: 'list' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/missing/);
  });
});
