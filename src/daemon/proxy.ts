// ─── The proxy: what a client actually launches in daemon mode ────
//
// An MCP client starts `crbro-memory` and speaks JSON-RPC on stdio, as it
// always has. In daemon mode that process loads no index and no model: it
// finds the daemon (or starts it), proves who it is, and from then on copies
// lines — client to daemon, daemon to client. It reads each line only to keep
// three things it needs on the worst day:
//
//   · the client's `initialize`, so that if the daemon dies the handshake can
//     be replayed against its replacement without the client ever knowing;
//   · which requests are in flight, so each gets an error instead of a
//     silence that would hang the conversation until a timeout;
//   · nothing else.
//
// And if no daemon can be had at all, the backend is a server inside this
// process — CRBRO exactly as it was before 2.5. The daemon is an optimisation;
// the memory is not allowed to depend on it.

import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { LineReader, LoopbackTransport } from './lines.js';
import { DAEMON_PROTOCOL, buildId, readState, newNonce, proof, sameProof, type DaemonState } from './endpoint.js';

const CONNECT_TIMEOUT_MS = 1_500;
const HANDSHAKE_TIMEOUT_MS = 4_000;
const SPAWN_WAIT_MS = 12_000;
const POLL_MS = 200;
/** Daemon connections lost inside this window before the proxy stops trusting daemons for the rest of its life. */
const FLAP_WINDOW_MS = 60_000;
const FLAP_LIMIT = 3;

export interface Backend {
  kind: 'daemon' | 'local';
  send(line: string): void;
  close(): Promise<void>;
}
type BackendEvents = { onLine: (line: string) => void; onClose: () => void };

export interface ProxyOptions {
  input: Readable;
  output: Writable;
  brainRoot: string;
  build?: string;
  /** Start a daemon. Production spawns a detached process; tests start one in-process, or refuse. */
  spawnDaemon?: (() => void | Promise<void>) | null;
  spawnWaitMs?: number;
  log?: (line: string) => void;
}

export interface ProxyHandle {
  /** Resolves when the client closed its end and the backend has been released. */
  closed: Promise<void>;
  backendKind(): 'daemon' | 'local' | 'none';
  reconnects(): number;
}

/** Connect to the daemon of this brain and build, and get through the handshake. Null on any failure. */
export async function connectDaemon(brainRoot: string, build: string = buildId()): Promise<{ socket: net.Socket; reader: (on: (line: string) => void) => void; state: DaemonState } | null> {
  const state = await readState(brainRoot, build);
  if (!state) return null;

  const socket = await new Promise<net.Socket | null>(resolve => {
    const s = net.connect(state.endpoint);
    const t = setTimeout(() => { s.destroy(); resolve(null); }, CONNECT_TIMEOUT_MS);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', () => { clearTimeout(t); resolve(null); });
  });
  if (!socket) return null;
  socket.setNoDelay(true);

  let sink: (line: string) => void = () => undefined;
  const lines = new LineReader(line => sink(line), () => socket.destroy());
  socket.on('data', chunk => lines.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
  socket.on('error', () => undefined);

  const next = () => new Promise<any | null>(resolve => {
    const t = setTimeout(() => resolve(null), HANDSHAKE_TIMEOUT_MS);
    const done = (v: any | null) => { clearTimeout(t); socket.off('close', onClose); resolve(v); };
    const onClose = () => done(null);
    socket.once('close', onClose);
    sink = line => { sink = () => undefined; try { done(JSON.parse(line)); } catch { done(null); } };
  });
  const fail = () => { socket.destroy(); return null; };

  const nonce = newNonce();
  socket.write(`${JSON.stringify({ crbro: 'hello', protocol: DAEMON_PROTOCOL, nonce })}\n`);
  const hello = await next();
  // The daemon proves itself FIRST: a process that merely took the pipe's name learns nothing from us.
  if (!hello || hello.crbro !== 'hello' || !sameProof(String(hello.proof || ''), proof(state.token, 'daemon', nonce))) return fail();
  socket.write(`${JSON.stringify({ crbro: 'auth', proof: proof(state.token, 'client', String(hello.nonce || '')) })}\n`);
  const ready = await next();
  if (!ready || ready.crbro !== 'ready') return fail();

  return { socket, reader: on => { sink = on; }, state };
}

/** One control exchange: `status` or `stop`. Null when there is no daemon to talk to. */
export async function controlDaemon(brainRoot: string, op: 'status' | 'stop', build?: string): Promise<any | null> {
  const c = await connectDaemon(brainRoot, build);
  if (!c) return null;
  return new Promise(resolve => {
    const t = setTimeout(() => { c.socket.destroy(); resolve(null); }, HANDSHAKE_TIMEOUT_MS);
    c.reader(line => { clearTimeout(t); try { resolve(JSON.parse(line)); } catch { resolve(null); } c.socket.end(); });
    c.socket.write(`${JSON.stringify({ crbro: 'control', op })}\n`);
  });
}

/** The production way to start a daemon: detached, silent, surviving this process. */
export function spawnDetachedDaemon(brainRoot: string): void {
  const entry = path.join(__dirname, '..', 'index.js');
  const child = spawn(process.execPath, [entry, '--daemon'], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, CRBRO_PATH: brainRoot, CRBRO_DAEMON: '' },
  });
  child.on('error', () => undefined);
  child.unref();
}

async function daemonBackend(o: ProxyOptions, ev: BackendEvents, mayStart: boolean): Promise<Backend | null> {
  const build = o.build ?? buildId();
  let c = await connectDaemon(o.brainRoot, build);
  if (!c && mayStart && o.spawnDaemon) {
    try { await o.spawnDaemon(); } catch (err) { o.log?.(`could not start a daemon: ${(err as Error).message}`); }
    const until = Date.now() + (o.spawnWaitMs ?? SPAWN_WAIT_MS);
    while (!c && Date.now() < until) {
      await new Promise(r => setTimeout(r, POLL_MS));
      c = await connectDaemon(o.brainRoot, build);
    }
  }
  if (!c) return null;
  const { socket, reader } = c;
  let closing = false;
  reader(ev.onLine);
  socket.on('close', () => { if (!closing) ev.onClose(); });
  return {
    kind: 'daemon',
    send: line => { if (!socket.destroyed) socket.write(`${line}\n`); },
    close: async () => { closing = true; socket.end(); },
  };
}

/** CRBRO as it was before daemons: the whole server, in this process. */
async function localBackend(ev: BackendEvents): Promise<Backend> {
  const { createEngines, createServer } = await import('../server.js');
  const engines = createEngines();
  const transport = new LoopbackTransport(ev.onLine);
  await createServer(engines).connect(transport);
  return {
    kind: 'local',
    send: line => transport.receive(line),
    close: async () => { try { await engines.searchEngine.flush(); } catch { /* derived data */ } },
  };
}

export function runProxy(o: ProxyOptions): ProxyHandle {
  const log = o.log ?? (() => undefined);
  let backend: Backend | null = null;
  let connecting = true;
  let ended = false;
  let reconnects = 0;
  let trustDaemons = true;
  const losses: number[] = [];

  let initialize: any | null = null;
  let initialized: string | null = null;
  const inflight = new Set<string | number>();
  const waiting: string[] = [];          // client lines held while there is no usable backend
  let replayId: string | null = null;    // id of the initialize we are replaying, while its answer is pending
  let replays = 0;

  let resolveClosed!: () => void;
  const closed = new Promise<void>(r => { resolveClosed = r; });

  const toClient = (line: string) => { if (!ended) o.output.write(`${line}\n`); };

  const fromBackend = (line: string) => {
    let m: any = null;
    try { m = JSON.parse(line); } catch { /* not ours to judge: pass it on */ }
    if (m && replayId !== null && m.id === replayId && m.method === undefined) {
      // The replacement answered the replayed handshake. The client already
      // has the original answer; this one stops here.
      replayId = null;
      if (initialized && backend) backend.send(initialized);
      connecting = false;
      drain();
      return;
    }
    if (m && m.id !== undefined && m.id !== null && m.method === undefined) inflight.delete(m.id);
    toClient(line);
  };

  const drain = () => {
    while (backend && !connecting && waiting.length) backend.send(waiting.shift()!);
  };

  const fromClient = (line: string) => {
    let m: any = null;
    try { m = JSON.parse(line); } catch { /* the backend will answer the parse error */ }
    if (m?.method === 'initialize') initialize = m;
    else if (m?.method === 'notifications/initialized') initialized = line;
    if (m && m.method !== undefined && m.id !== undefined && m.id !== null) inflight.add(m.id);
    if (backend && !connecting) backend.send(line);
    else waiting.push(line);
  };

  const events: BackendEvents = {
    onLine: fromBackend,
    onClose: () => { void lost(); },
  };

  async function acquire(first: boolean): Promise<void> {
    connecting = true;
    backend = null;
    let b: Backend | null = null;
    if (trustDaemons) b = await daemonBackend(o, events, true);
    if (!b) {
      if (trustDaemons) log('no daemon reachable: serving from this process');
      b = await localBackend(events);
    }
    if (ended) { await b.close(); return; }
    backend = b;
    if (!first && initialize) {
      // Same request the client once sent, under an id of our own.
      replayId = `crbro-replay-${++replays}`;
      b.send(JSON.stringify({ ...initialize, id: replayId }));
      return;   // `connecting` stays true until the replayed handshake is answered
    }
    connecting = false;
    drain();
  }

  async function lost(): Promise<void> {
    if (ended) return;
    reconnects++;
    const now = Date.now();
    losses.push(now);
    while (losses.length && now - losses[0] > FLAP_WINDOW_MS) losses.shift();
    if (losses.length >= FLAP_LIMIT) { trustDaemons = false; log('daemon lost three times in a minute: staying in-process'); }
    // Whatever was waiting for an answer will not get one from a dead process.
    // What never left this proxy is not in that position: it is still queued,
    // and answering it here too would hand the client two replies to one id.
    const queued = new Set<string | number>();
    for (const line of waiting) { try { const q = JSON.parse(line); if (q?.id !== undefined && q.id !== null) queued.add(q.id); } catch { /* not a request */ } }
    for (const id of [...inflight]) {
      if (queued.has(id)) continue;
      inflight.delete(id);
      toClient(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'CRBRO restarted while this call was running. Nothing was lost on disk; call it again.' } }));
    }
    replayId = null;
    try { await acquire(false); } catch (err) { log(`could not recover a backend: ${(err as Error).message}`); }
  }

  const reader = new LineReader(fromClient, () => undefined);
  o.input.on('data', (chunk: Buffer | string) => reader.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
  const finish = async () => {
    if (ended) return;
    ended = true;
    try { await backend?.close(); } catch { /* leaving anyway */ }
    resolveClosed();
  };
  o.input.on('end', () => { void finish(); });
  o.input.on('close', () => { void finish(); });

  void acquire(true).catch(err => log(`proxy could not start a backend: ${(err as Error).message}`));

  return { closed, backendKind: () => (backend ? backend.kind : 'none'), reconnects: () => reconnects };
}
