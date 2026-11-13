// ─── What the server says before it does anything ────────────────
//
// `initialize`, `ping` and `tools/list` have the same answer for every
// conversation of one build: who the server is, what it can do, how it is
// meant to be used and which tools it has. A proxy that waited for a backend
// to say so kept the client in silence while it found, started or gave up on
// the daemon — past 12 s in the worst case, beyond Codex's 10 s start-up
// limit. So the proxy answers them itself, at once.
//
// The answers are never written by hand. They are taken from the real server
// (createServer, with engines that are built but never started): at build
// time into dist/mcp-surface.json, or in this process when that file is
// missing or belongs to another build. tests/daemon.startup.test.ts holds the
// proxy's answers against the real server's.

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const SURFACE_FILE = 'mcp-surface.json';

export interface McpSurface {
  /** The build these answers belong to (endpoint.ts buildId()). */
  build: string;
  /** The protocol versions the server's SDK accepts, and the one it offers otherwise. */
  latest: string;
  supported: string[];
  /** initialize's result, minus protocolVersion (that one is negotiated per client). */
  initialize: { capabilities: Record<string, unknown>; serverInfo: Record<string, unknown>; instructions?: string };
  /** tools/list's result. */
  tools: { tools: unknown[] } & Record<string, unknown>;
}

function isSurface(v: any): v is McpSurface {
  return !!v && typeof v.build === 'string' && typeof v.latest === 'string' && Array.isArray(v.supported)
    && v.supported.every((x: unknown) => typeof x === 'string')
    && !!v.initialize && typeof v.initialize.capabilities === 'object' && typeof v.initialize.serverInfo === 'object'
    && !!v.tools && Array.isArray(v.tools.tools);
}

/** The snapshot next to the compiled code, if it is this build's. */
export function loadSurface(build: string, dir: string = path.join(__dirname, '..')): McpSurface | null {
  try {
    const s = JSON.parse(readFileSync(path.join(dir, SURFACE_FILE), 'utf8'));
    return isSurface(s) && s.build === build ? s : null;
  } catch {
    return null;
  }
}

/**
 * Ask a real server, in this process. Its engines are constructed (that reads
 * nothing) and never started: no brain is opened, no index loaded.
 */
export async function computeSurface(build: string): Promise<McpSurface> {
  const { createServer, createEngines } = await import('../server.js');
  const { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } = await import('@modelcontextprotocol/sdk/types.js');
  const { LoopbackTransport } = await import('./lines.js');
  const answers = new Map<string, any>();
  const transport = new LoopbackTransport(line => { const m = JSON.parse(line); if (m.id !== undefined) answers.set(String(m.id), m); });
  const server = createServer(createEngines());
  await server.connect(transport);
  transport.receive(JSON.stringify({
    jsonrpc: '2.0', id: 'surface-init', method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'crbro-surface', version: '0' } },
  }));
  transport.receive(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  transport.receive(JSON.stringify({ jsonrpc: '2.0', id: 'surface-tools', method: 'tools/list', params: {} }));
  const until = Date.now() + 10_000;
  while ((!answers.has('surface-init') || !answers.has('surface-tools')) && Date.now() < until) {
    await new Promise(r => setImmediate(r));
  }
  await server.close().catch(() => undefined);
  const init = answers.get('surface-init')?.result;
  const tools = answers.get('surface-tools')?.result;
  if (!init || !tools) throw new Error('the server did not describe itself');
  const { protocolVersion: _negotiated, ...initialize } = init;
  return { build, latest: LATEST_PROTOCOL_VERSION, supported: [...SUPPORTED_PROTOCOL_VERSIONS], initialize, tools };
}

const computed = new Map<string, Promise<McpSurface | null>>();

/** The snapshot if there is one for this build, else the real server asked here (once per process). Null if neither can be had. */
export async function getSurface(build: string): Promise<McpSurface | null> {
  const s = loadSurface(build);
  if (s) return s;
  let p = computed.get(build);
  if (!p) {
    p = computeSurface(build).catch(() => null);
    computed.set(build, p);
  }
  return p;
}

/** Only an initialize the server itself would accept is answered here; anything else goes to it and gets its own answer. */
function wellFormedInitialize(m: any): boolean {
  const p = m?.params;
  return !!p && typeof p === 'object' && typeof p.protocolVersion === 'string'
    && !!p.capabilities && typeof p.capabilities === 'object'
    && !!p.clientInfo && typeof p.clientInfo === 'object' && typeof p.clientInfo.name === 'string' && typeof p.clientInfo.version === 'string';
}

/**
 * The answer the server would give to this request, or null when it is not
 * one of the requests whose answer is fixed per build. The protocol version
 * is negotiated exactly as the SDK does: the client's if supported, else the
 * latest.
 */
export function answerFromSurface(s: McpSurface, m: any): Record<string, unknown> | null {
  if (!m || m.jsonrpc !== '2.0' || m.id === undefined || m.id === null || typeof m.method !== 'string') return null;
  if (m.method === 'initialize') {
    if (!wellFormedInitialize(m)) return null;
    const protocolVersion = s.supported.includes(m.params.protocolVersion) ? m.params.protocolVersion : s.latest;
    return { jsonrpc: '2.0', id: m.id, result: { protocolVersion, ...s.initialize } };
  }
  if (m.method === 'ping') return { jsonrpc: '2.0', id: m.id, result: {} };
  if (m.method === 'tools/list') return { jsonrpc: '2.0', id: m.id, result: s.tools };
  return null;
}
