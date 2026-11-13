// ─── crbro-memory serve --http ───────────────────────────────────
//
// Real HTTP, the SDK's own client, temp brains and a temp keychain folder.
// Every server started here is closed.
//
// Two listeners over the same engines. The guards are tested on a TCP
// loopback port. Full MCP sessions run over a named pipe / Unix socket: an
// HTTP-inspecting antivirus on the reference machine (Avast Web Shield)
// rewrites any loopback exchange it recognises as MCP — the /mcp path or the
// mcp-session-id / mcp-protocol-version headers — dropping Content-Length and
// announcing a chunked body it does not send, which no client can parse. The
// pipe carries the same HTTP through the same handler, out of its reach.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer, main as serveMain, TOKEN_NAME, REMOTE_WARNING, allowedHostHeaders, type RunningHttpServer } from '../src/cli/serve.js';
import { randomToken } from '../src/cli/common.js';
import { detectBackend, getSecret } from '../src/engine/keychain.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let tmp: string;
let srv: RunningHttpServer;
let pipeSrv: RunningHttpServer;
const P = '/rpc';                 // the same antivirus also rewrites any /mcp path
const PIPE_HOST = 'crbro.test';
const pipePath = process.platform === 'win32'
  ? `\\\\.\\pipe\\crbro-serve-test-${process.pid}-${Date.now()}`
  : path.join(os.tmpdir(), `crbro-serve-${process.pid}-${Date.now()}.sock`);
const token = randomToken();
const saved = { path: process.env.CRBRO_PATH, keys: process.env.CRBRO_KEYS_DIR, tok: process.env[TOKEN_NAME] };

interface RawOpts { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; pipe?: boolean }
function raw(port: number, opts: RawOpts = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      ...(opts.pipe ? { socketPath: pipePath } : { host: '127.0.0.1', port }),
      method: opts.method ?? 'POST', path: opts.path ?? P,
      headers: { Host: opts.pipe ? PIPE_HOST : `127.0.0.1:${port}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

/** fetch over the pipe, for the SDK client. Streams the body, honours abort. */
const pipeFetch = (async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  headers.host = PIPE_HOST;
  return new Promise<Response>((resolve, reject) => {
    const req = http.request({ socketPath: pipePath, path: url.pathname + url.search, method: init.method ?? 'GET', headers }, res => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
      const status = res.statusCode ?? 0;
      resolve(new Response(status === 204 || status === 304 ? null : (Readable.toWeb(res) as any), { status, headers: h }));
    });
    req.on('error', reject);
    init.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')));
    if (init.body) req.write(init.body);
    req.end();
  });
}) as typeof fetch;

const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });

async function connect(bearer: string): Promise<Client> {
  const client = new Client({ name: 'serve-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${PIPE_HOST}${P}`), {
    fetch: pipeFetch, requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  }));
  return client;
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-g-serve-'));
  process.env.CRBRO_PATH = path.join(tmp, 'brain');
  process.env.CRBRO_KEYS_DIR = path.join(tmp, 'keys');
  delete process.env[TOKEN_NAME];
  const { createServer, createEngines } = await import('../src/server.js');
  const engines = createEngines();
  srv = await startHttpServer({ token, port: 0, makeServer: () => createServer(engines), maxBodyBytes: 64 * 1024, path: P });
  pipeSrv = await startHttpServer({ token, socketPath: pipePath, allowedHosts: [PIPE_HOST], makeServer: () => createServer(engines), maxBodyBytes: 64 * 1024, path: P });
});

afterAll(async () => {
  await srv?.close();
  await pipeSrv?.close();
  for (const [k, v] of [['CRBRO_PATH', saved.path], ['CRBRO_KEYS_DIR', saved.keys], [TOKEN_NAME, saved.tok]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('the HTTP transport', () => {
  it('speaks MCP to an authenticated client: the 15 tools, learn then recall', async () => {
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}${P}`);
    const c = await connect(token);
    try {
      const tools = await c.listTools();
      expect(tools.tools).toHaveLength(15);
      await c.callTool({ name: 'crbro_boot', arguments: {} });
      const learned: any = await c.callTool({ name: 'crbro_learn', arguments: { topic: 'Remote', type: 'fact', content: 'The remote memory answers over HTTP.' } });
      expect(learned.isError).toBeFalsy();
      const r: any = await c.callTool({ name: 'crbro_recall', arguments: { query: 'remote memory HTTP' } });
      expect(JSON.stringify(r.structuredContent ?? r.content)).toContain('answers over HTTP');
      expect(pipeSrv.sessions()).toBe(1);
    } finally { await c.close(); }
  });

  it('refuses a missing or wrong token, without saying more than it must', async () => {
    const none = await raw(srv.port, { body: init });
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer realm="crbro"');
    expect((await raw(srv.port, { body: init, headers: { Authorization: `Bearer ${token.slice(1)}x` } })).status).toBe(401);
    expect((await raw(srv.port, { body: init, headers: { Authorization: `Basic ${token}` } })).status).toBe(401);
    await expect(connect(randomToken())).rejects.toThrow();
    expect(none.body).not.toContain(token);
  });

  it('refuses a foreign Host (DNS rebinding) and any browser Origin, before the token', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    expect((await raw(srv.port, { body: init, headers: { ...auth, Host: `evil.example:${srv.port}` } })).status).toBe(421);
    expect((await raw(srv.port, { body: init, headers: { Host: `rebound.example:${srv.port}` } })).status).toBe(421);
    expect((await raw(srv.port, { body: init, headers: { ...auth, Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await raw(0, { pipe: true, body: init, headers: { ...auth, Host: `127.0.0.1:${srv.port}` } })).status).toBe(421);
    const ok = await raw(srv.port, { body: init, headers: { ...auth, Host: `localhost:${srv.port}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-length']).toBe(String(Buffer.byteLength(ok.body)));
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    // A session opened and closed over the pipe (DELETE carries mcp-session-id).
    const opened = await raw(0, { pipe: true, body: init, headers: auth });
    expect(opened.status).toBe(200);
    const before = pipeSrv.sessions();
    const del = await raw(0, { pipe: true, method: 'DELETE', headers: { ...auth, 'mcp-session-id': String(opened.headers['mcp-session-id']), 'mcp-protocol-version': '2025-06-18' } });
    expect(del.status).toBe(200);
    expect(pipeSrv.sessions()).toBe(before - 1);
  });

  it('one path, bounded bodies, sessions required, internal errors never echoed', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    expect((await raw(srv.port, { path: '/', body: init, headers: auth })).status).toBe(404);
    expect((await raw(srv.port, { path: P + '/../etc', body: init, headers: auth })).status).toBe(404);
    expect((await raw(srv.port, { method: 'OPTIONS', headers: auth })).status).toBe(405);
    expect((await raw(srv.port, { method: 'PUT', body: init, headers: auth })).status).toBe(405);
    const big = await raw(srv.port, { body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }), headers: auth });
    expect(big.status).toBe(413);
    expect((await raw(srv.port, { body: '{not json', headers: auth })).status).toBe(400);
    const noSession = await raw(srv.port, { body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), headers: auth });
    expect(noSession.status).toBe(400);
    expect((await raw(0, { pipe: true, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), headers: { ...auth, 'mcp-session-id': 'nope' } })).status).toBe(404);
    expect((await raw(srv.port, { method: 'GET', headers: auth })).status).toBe(400);
  });

  it('a short token never starts a server', async () => {
    await expect(startHttpServer({ token: 'short', port: 0, makeServer: () => { throw new Error('unused'); } })).rejects.toThrow(/at least 32/);
  });
});

describe('the command', () => {
  const quiet = () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return {
      text: () => [...log.mock.calls, ...err.mock.calls].flat().join('\n'),
      restore: () => { log.mockRestore(); err.mockRestore(); },
    };
  };
  // Only where the keychain is a file in CRBRO_KEYS_DIR: elsewhere it is the
  // real OS store, which no test may read or write.
  const sandboxedKeychain = detectBackend().backend === 'windows-dpapi';

  it('flags: --http required, remote needs --allow-remote, short env token refused', async () => {
    const q = quiet();
    try {
      expect(await serveMain(['--help'])).toBe(0);
      expect(q.text()).toContain('NO OAuth');
      expect(await serveMain([])).toBe(2);
      expect(await serveMain(['--http', '--host', '0.0.0.0'], { env: { [TOKEN_NAME]: randomToken() } })).toBe(2);
      expect(q.text()).toContain('--allow-remote');
      expect(await serveMain(['--http', '--port', '0'], { env: { [TOKEN_NAME]: 'too-short' } })).toBe(1);
      expect(await serveMain(['--http', '--bogus'])).toBe(2);
    } finally { q.restore(); }
  });

  it('serves with the env token on loopback, and stops on signal', async () => {
    const q = quiet();
    const t = randomToken();
    const ac = new AbortController();
    let running: RunningHttpServer | null = null;
    try {
      const done = serveMain(['--http', '--port', '0', '--path', P], { env: { [TOKEN_NAME]: t }, signal: ac.signal, onReady: s => { running = s; } });
      await vi.waitFor(() => expect(running).not.toBeNull(), { timeout: 20_000 });
      const st = await raw(running!.port, { body: init, headers: { Authorization: `Bearer ${t}` } });
      expect(st.status).toBe(200);
      expect(JSON.parse(st.body).result.serverInfo.name).toBe('crbro-memory');
      ac.abort();
      expect(await done).toBe(0);
      expect(q.text()).not.toContain(t);
      await expect(raw(running!.port, { body: init })).rejects.toThrow();
    } finally { ac.abort(); q.restore(); }
  });

  it('beyond loopback: the warning names both gaps, and only the named hosts are accepted', async () => {
    // No test opens a socket on a real interface (it would reach the network
    // and, on Windows, raise a firewall prompt): the pieces are checked apart.
    expect(REMOTE_WARNING).toContain('NO TLS');
    expect(REMOTE_WARNING).toContain('NO OAuth');
    expect(REMOTE_WARNING).toMatch(/reverse proxy or a tunnel/);
    expect(allowedHostHeaders('0.0.0.0', 8787, ['mem.example.org'])).not.toContain('127.0.0.1:8787');
    // A loopback alias other than 127.0.0.1 is still loopback: no --allow-remote needed.
    const q = quiet();
    const ac = new AbortController();
    let running: RunningHttpServer | null = null;
    try {
      const done = serveMain(['--http', '--host', '127.0.0.1', '--port', '0', '--allowed-host', 'mem.example.org', '--path', P],
        { env: { [TOKEN_NAME]: randomToken() }, signal: ac.signal, onReady: s => { running = s; } });
      await vi.waitFor(() => expect(running).not.toBeNull(), { timeout: 20_000 });
      expect(q.text()).not.toContain('NO TLS');
      expect((await raw(running!.port, { body: init, headers: { Host: 'mem.example.org' } })).status).toBe(401);   // past the Host check
      ac.abort();
      expect(await done).toBe(0);
    } finally { ac.abort(); q.restore(); }
  });

  it.skipIf(!sandboxedKeychain)('without a token it says how to make one; --new-token stores one unseen and serves with it', async () => {
    const q = quiet();
    const ac = new AbortController();
    let running: RunningHttpServer | null = null;
    try {
      expect(await serveMain(['--http', '--port', '0'], { env: {} })).toBe(1);
      expect(q.text()).toContain('--new-token');
      const done = serveMain(['--http', '--new-token', '--port', '0', '--path', P], { env: {}, signal: ac.signal, onReady: s => { running = s; } });
      await vi.waitFor(() => expect(running).not.toBeNull(), { timeout: 30_000 });
      const stored = getSecret(TOKEN_NAME)!;
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      expect(q.text()).not.toContain(stored);
      expect(q.text()).toContain(`crbro-memory secret get ${TOKEN_NAME}`);
      expect((await raw(running!.port, { body: init, headers: { Authorization: `Bearer ${stored}` } })).status).toBe(200);
      ac.abort();
      expect(await done).toBe(0);
    } finally { ac.abort(); q.restore(); }
  });
});
