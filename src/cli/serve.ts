// ─── crbro-memory serve --http ───────────────────────────────────
//
// The MCP server over Streamable HTTP (the SDK's own transport), for clients
// that cannot spawn a process. The engine runs in this process exactly like
// a classic stdio server; each MCP session gets its own McpServer over the
// shared engines, the way the daemon serves its clients.
//
// What protects it:
//   · a bearer token on every request, compared in constant time, never
//     logged, read from CRBRO_HTTP_TOKEN or the OS keychain;
//   · loopback by default; another interface needs --allow-remote, and the
//     command then says plainly there is no TLS and no OAuth;
//   · the Host header must be one this server was started for (DNS
//     rebinding), and a browser Origin is refused unless allowed;
//   · one path (/mcp), bounded bodies, bounded sessions, idle sessions
//     closed, internal errors never echoed.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { waitForStop, parseArgs, randomToken, tokenMatches, bearerOf, hostAllowed, isLoopbackHost, BASE_SECURITY_HEADERS } from './common.js';

export const TOKEN_NAME = 'CRBRO_HTTP_TOKEN';
const MIN_TOKEN_CHARS = 32;
const PATH_RE = /^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+){0,4}$/;

export const SERVE_HELP = `
  crbro-memory serve --http [--port 8787] [--host 127.0.0.1] [--allow-remote] [--new-token] [--allow-secrets]

  Serve the memory over MCP Streamable HTTP at http://<host>:<port>/mcp, for
  clients that connect to a URL instead of starting a process.

    --http             Required: the transport (stdio is the default command).
    --port <n>         Default 8787.
    --host <addr>      Default 127.0.0.1 (this machine only).
    --allow-remote     Needed for any address that is not loopback. There is
                       NO TLS (put a reverse proxy or a tunnel in front) and
                       NO OAuth (claude.ai web and mobile custom connectors
                       require OAuth, which this server does not offer).
    --allowed-host <h> Extra Host header to accept, e.g. the public name a
                       tunnel or proxy forwards (repeatable).
    --path <p>         The one path served (default /mcp).
    --new-token        Create a new random token in the OS keychain as
                       ${TOKEN_NAME} (never printed), then serve with it.
    --allow-secrets    Also serve crbro_secret. Left out by default: with it,
                       anyone holding the token reads every keychain secret.

  Every request needs "Authorization: Bearer <token>". The token comes from
  the ${TOKEN_NAME} environment variable, else from the keychain:
    crbro-memory secret get ${TOKEN_NAME}
  Ctrl+C stops it and flushes the search index.
`;

/** Printed whenever the server listens beyond loopback. */
export const REMOTE_WARNING = [
  '  ⚠️  Reachable beyond this machine. There is NO TLS: the token and the memory travel in clear text',
  '     unless a reverse proxy or a tunnel with HTTPS sits in front. There is NO OAuth: claude.ai web and',
  '     mobile custom connectors require OAuth, which this server does not offer.',
].join('\n');

export interface HttpServerOptions {
  token: string;
  port?: number;
  host?: string;
  /** Listen on a named pipe / Unix socket instead of host:port (tests). Host headers then come from allowedHosts only. */
  socketPath?: string;
  /** The one path served. Default /mcp. */
  path?: string;
  /** Extra Host header values to accept besides <host>:<port> (and the loopback names on loopback). */
  allowedHosts?: string[];
  /** Origins a browser may call from. None by default. */
  allowedOrigins?: string[];
  /** Builds the McpServer for one session. Default: createServer over shared engines. */
  makeServer?: () => McpServer | Promise<McpServer>;
  /** Called on stop, after every session closed (the engines flush here). */
  onStop?: () => Promise<void>;
  maxBodyBytes?: number;
  maxSessions?: number;
  sessionIdleMs?: number;
  log?: (line: string) => void;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  host: string;
  sessions(): number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...BASE_SECURITY_HEADERS,
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

/** A JSON-RPC error body, the shape MCP clients expect from the transport. */
const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

async function readJsonBody(req: http.IncomingMessage, max: number): Promise<unknown> {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > max) throw new HttpError(413, 'request body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
}

/**
 * Hand one request to the SDK transport and write its answer. The body was
 * already read and bounded by us, so it travels as parsedBody. A JSON answer
 * is buffered and sent with a Content-Length; only an event stream (the GET
 * notification channel) is streamed.
 */
async function relay(transport: WebStandardStreamableHTTPServerTransport, req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k.startsWith(':')) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const request = new Request(`http://localhost${req.url || '/'}`, { method: req.method, headers, signal: abort.signal });
  const response = await transport.handleRequest(request, body === undefined ? undefined : { parsedBody: body });
  const out: Record<string, string> = {};
  response.headers.forEach((v, k) => { out[k] = v; });
  if (!response.body) {
    res.writeHead(response.status, out);
    res.end();
    return;
  }
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    res.writeHead(response.status, out);
    res.flushHeaders();
    const reader = response.body.getReader();
    res.on('close', () => { reader.cancel().catch(() => undefined); });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch { /* the client went away */ }
    res.end();
    return;
  }
  const buf = Buffer.from(await response.arrayBuffer());
  out['content-length'] = String(buf.length);
  res.writeHead(response.status, out);
  res.end(buf);
}

/** Host header values for a listener on host:port. */
export function allowedHostHeaders(host: string, port: number, extra: string[] = []): string[] {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const list = new Set([`${h}:${port}`.toLowerCase()]);
  if (isLoopbackHost(host)) for (const l of ['127.0.0.1', 'localhost', '[::1]']) list.add(`${l}:${port}`);
  for (const e of extra) list.add(e.toLowerCase());
  return [...list];
}

export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  if (!opts.token || opts.token.length < MIN_TOKEN_CHARS) throw new Error(`the token must be at least ${MIN_TOKEN_CHARS} characters`);
  const host = opts.host ?? '127.0.0.1';
  const mcpPath = opts.path ?? '/mcp';
  if (!PATH_RE.test(mcpPath)) throw new Error('the path must look like /mcp');
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const maxSessions = opts.maxSessions ?? 32;
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const log = opts.log ?? (() => undefined);
  const makeServer = opts.makeServer ?? (await defaultServerFactory()).make;
  const allowedOrigins = new Set((opts.allowedOrigins ?? []).map(o => o.toLowerCase()));

  interface Session { transport: WebStandardStreamableHTTPServerTransport; server: McpServer; lastSeen: number }
  const sessions = new Map<string, Session>();
  let allowed: string[] = [];
  let failures = 0;

  const closeSession = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try { await s.transport.close(); } catch { /* already closed */ }
    try { await s.server.close(); } catch { /* already closed */ }
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > idleMs) void closeSession(id);
  }, Math.min(idleMs, 60_000));
  sweep.unref();

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // 1. Host: before anything else, so a rebound name learns nothing.
    if (!hostAllowed(req.headers.host, allowed)) throw new HttpError(421, 'Host not allowed');
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== mcpPath) throw new HttpError(404, 'not found');
    const method = req.method || 'GET';
    if (method === 'OPTIONS') throw new HttpError(405, 'method not allowed', { Allow: 'GET, POST, DELETE' });
    if (!['GET', 'POST', 'DELETE'].includes(method)) throw new HttpError(405, 'method not allowed', { Allow: 'GET, POST, DELETE' });
    // 2. Browsers: no CORS, and a foreign Origin is refused outright.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(String(origin).toLowerCase())) throw new HttpError(403, 'Origin not allowed');
    // 3. The token.
    if (!tokenMatches(bearerOf(req.headers.authorization), opts.token)) {
      failures++;
      throw new HttpError(401, 'missing or invalid bearer token', { 'WWW-Authenticate': 'Bearer realm="crbro"' });
    }
    // 4. The session.
    const sid = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    const body = method === 'POST' ? await readJsonBody(req, maxBody) : undefined;
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw new HttpError(404, 'unknown or expired session');
      s.lastSeen = Date.now();
      await relay(s.transport, req, res, body);
      return;
    }
    if (method !== 'POST' || !isInitializeRequest(body)) {
      throw new HttpError(400, 'no session: start with an initialize request');
    }
    if (sessions.size >= maxSessions) throw new HttpError(503, 'too many open sessions', { 'Retry-After': '30' });
    const server = await makeServer();
    let created: Session | null = null;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // One JSON answer per request, sent whole with a Content-Length: nothing
      // CRBRO does streams, and a plain response survives reverse proxies and
      // the HTTP-inspecting antivirus that mangled chunked ones on the
      // reference machine. The GET stream for notifications stays available.
      enableJsonResponse: true,
      maxRequestBodySize: maxBody,
      onsessioninitialized: (id) => {
        created = { transport, server, lastSeen: Date.now() };
        sessions.set(id, created);
      },
      onsessionclosed: (id) => { void closeSession(id); },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.get(id)?.transport === transport) sessions.delete(id);
    };
    await server.connect(transport);
    await relay(transport, req, res, body);
    if (!created) { try { await transport.close(); await server.close(); } catch { /* never initialized */ } }
  };

  const httpServer = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) res.setHeader(k, v);
    handle(req, res).catch(err => {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) {
        sendJson(res, err.status, rpcError(-32000, err.message), err.headers);
      } else {
        // Never echo an internal error: it can quote paths or brain text.
        log(`internal error on ${req.method} ${(req.url || '').split('?')[0]}: ${err instanceof Error ? err.name : 'error'}`);
        sendJson(res, 500, rpcError(-32603, 'internal error'));
      }
    });
  });
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 60_000;
  httpServer.maxHeadersCount = 64;
  httpServer.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    const ready = () => { httpServer.off('error', reject); resolve(); };
    if (opts.socketPath) httpServer.listen(opts.socketPath, ready); else httpServer.listen(opts.port ?? 8787, host, ready);
  });
  const port = opts.socketPath ? 0 : (httpServer.address() as AddressInfo).port;
  allowed = opts.socketPath ? (opts.allowedHosts ?? []).map(h => h.toLowerCase()) : allowedHostHeaders(host, port, opts.allowedHosts);
  const shown = host.includes(':') ? `[${host}]` : host;

  let closing: Promise<void> | null = null;
  return {
    url: opts.socketPath ? `http://localhost${mcpPath}` : `http://${shown}:${port}${mcpPath}`,
    port, host,
    sessions: () => sessions.size,
    close: () => closing ??= (async () => {
      clearInterval(sweep);
      await Promise.all([...sessions.keys()].map(closeSession));
      await new Promise<void>(resolve => { httpServer.close(() => resolve()); httpServer.closeAllConnections?.(); });
      if (failures) log(`${failures} request(s) were refused for a missing or wrong token`);
      if (opts.onStop) await opts.onStop();
    })(),
  };
}

/**
 * One set of engines for the process, one McpServer per session — the
 * daemon's arrangement. crbro_secret is left out unless asked for: a token
 * holder would otherwise read every keychain secret over the network.
 */
async function defaultServerFactory(allowSecrets = false): Promise<{ make: () => McpServer; flush: () => Promise<void> }> {
  const { createEngines, createServer } = await import('../server.js');
  const engines = createEngines();
  void engines.searchEngine.init().catch(() => undefined);
  const options = allowSecrets ? {} : { excludeTools: ['crbro_secret'] };
  return { make: () => createServer(engines, options), flush: () => engines.searchEngine.flush() };
}

// ─── Token ───────────────────────────────────────────────────────

export interface TokenSource { token: string | null; from: 'env' | 'keychain' | null; problem?: string }

export async function resolveToken(env: NodeJS.ProcessEnv = process.env): Promise<TokenSource> {
  const fromEnv = (env[TOKEN_NAME] || '').trim();
  if (fromEnv) return { token: fromEnv, from: 'env' };
  try {
    const kc = await import('../engine/keychain.js');
    const v = kc.getSecret(TOKEN_NAME);
    return v ? { token: v.trim(), from: 'keychain' } : { token: null, from: null };
  } catch (err) {
    return { token: null, from: null, problem: `the keychain could not be read (${err instanceof Error ? err.message : 'unavailable'})` };
  }
}

export async function createToken(): Promise<void> {
  const kc = await import('../engine/keychain.js');
  kc.setSecret(TOKEN_NAME, randomToken(), 'crbro-memory serve --http bearer token');
}

// ─── CLI ─────────────────────────────────────────────────────────

/** CLI entry: resolves with the exit code once the server is stopped. */
export async function main(argv: string[], deps: { onReady?: (s: RunningHttpServer) => void; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const a = parseArgs(argv, { http: 'boolean', port: 'number', host: 'string', 'allow-remote': 'boolean', 'new-token': 'boolean', 'allowed-host': 'list', path: 'string', 'allow-secrets': 'boolean' });
  if (a.flags.help) { console.log(SERVE_HELP); return 0; }
  if (!a.flags.http) a.errors.push('--http is required (the stdio server is plain `crbro-memory`)');
  const port = (a.flags.port as number | undefined) ?? 8787;
  if (port > 65535) a.errors.push('--port must be 0-65535 (0 = any free port)');
  const host = ((a.flags.host as string | undefined) ?? '127.0.0.1').trim();
  if (!host || /[\s/]/.test(host)) a.errors.push('--host must be an address');
  if (a.positionals.length) a.errors.push(`unexpected argument: ${a.positionals[0]}`);
  const mcpPath = (a.flags.path as string | undefined) ?? '/mcp';
  if (!PATH_RE.test(mcpPath)) a.errors.push('--path must look like /mcp');
  const extraHosts =(a.flags['allowed-host'] as string[] | undefined) ?? [];
  for (const h of extraHosts) if (!/^[A-Za-z0-9.\-[\]:]{1,255}$/.test(h)) a.errors.push(`--allowed-host ${h} is not a host[:port]`);
  if (a.errors.length) {
    console.error(`  ❌ ${a.errors.join('; ')}`);
    console.error('     Usage: crbro-memory serve --http [--port 8787] [--host 127.0.0.1] [--allow-remote] [--new-token]   (--help for more)');
    return 2;
  }
  const remote = !isLoopbackHost(host);
  if (remote && !a.flags['allow-remote']) {
    console.error(`  ❌ ${host} is not a loopback address. Serving the memory beyond this machine needs --allow-remote,`);
    console.error('     and you should read what that means first: crbro-memory serve --help');
    return 2;
  }

  if (a.flags['new-token']) {
    try {
      await createToken();
      console.log(`  🔐 New token stored in the OS keychain as ${TOKEN_NAME} (not printed).`);
      console.log(`     Read it to configure a client:  crbro-memory secret get ${TOKEN_NAME}`);
      if ((env[TOKEN_NAME] || '').trim()) console.log(`  ⚠️  ${TOKEN_NAME} is also set in the environment, and the environment wins: unset it to use the new token.`);
    } catch (err) {
      console.error(`  ❌ could not store a token: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  const src = await resolveToken(env);
  if (!src.token) {
    console.error(`  ❌ No token. ${src.problem ? `${src.problem[0].toUpperCase()}${src.problem.slice(1)}. ` : ''}Create one with:  crbro-memory serve --http --new-token`);
    console.error(`     or set ${TOKEN_NAME} in the environment (at least ${MIN_TOKEN_CHARS} characters).`);
    return 1;
  }
  if (src.token.length < MIN_TOKEN_CHARS) {
    console.error(`  ❌ The ${TOKEN_NAME} token is shorter than ${MIN_TOKEN_CHARS} characters. Make a new one: crbro-memory serve --http --new-token`);
    return 1;
  }

  let factory: Awaited<ReturnType<typeof defaultServerFactory>>;
  let running: RunningHttpServer;
  try {
    factory = await defaultServerFactory(a.flags['allow-secrets'] === true);
    running = await startHttpServer({
      token: src.token, port, host, path: mcpPath, allowedHosts: extraHosts, makeServer: factory.make,
      onStop: async () => { try { await factory.flush(); } catch { /* index is derived data */ } },
      log: line => console.error(`  [http] ${line}`),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ serve: ${/EADDRINUSE/.test(msg) ? `port ${port} is in use; pick another with --port` : msg}`);
    return 1;
  }
  console.log('');
  console.log(`  🧠 CRBRO MCP over Streamable HTTP: ${running.url}`);
  console.log(`     Auth: Authorization: Bearer <token> (token from ${src.from === 'env' ? `the ${TOKEN_NAME} environment variable` : `the keychain, ${TOKEN_NAME}`}).`);
  console.log(a.flags['allow-secrets'] === true
    ? '  ⚠️  crbro_secret is served (--allow-secrets): anyone with the token can read every keychain secret.'
    : '     crbro_secret is not served (keychain secrets stay off HTTP); --allow-secrets adds it.');
  if (remote) console.log(REMOTE_WARNING);
  try {
    const { daemonEnabled } = await import('../daemon/endpoint.js');
    const { resolveBrainDir } = await import('../engine/brain.js');
    if (daemonEnabled(resolveBrainDir())) {
      console.log('  ℹ️  The daemon is on for this brain. This server runs its own engine in this process, like a client');
      console.log('     with the daemon off: writes are safe (files are locked), but the two indexes refresh separately.');
    }
  } catch { /* informational only */ }
  console.log('     Ctrl+C to stop.');
  console.log('');
  deps.onReady?.(running);
  await waitForStop(deps.signal);
  await running.close();
  console.log('  HTTP server stopped.');
  return 0;
}
