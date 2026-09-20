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
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { LineReader, LoopbackTransport } from './lines.js';
import {
  DAEMON_PROTOCOL, buildId, readState, newNonce, proof, sameProof, configFingerprint, blockedSince, type DaemonState,
} from './endpoint.js';

const CONNECT_TIMEOUT_MS = 1_500;
const HANDSHAKE_TIMEOUT_MS = 4_000;
const SPAWN_WAIT_MS = 12_000;
const POLL_MS = 200;
/** Daemon connections lost inside this window before the proxy stops trusting daemons for the rest of its life. */
const FLAP_WINDOW_MS = 60_000;
const FLAP_LIMIT = 3;
/** After the client closes its end: how long calls already accepted may take to finish before we leave anyway. */
const DRAIN_TIMEOUT_MS = 30_000;

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
  /** Is daemon mode still on? Asked again at every (re)connection, so `crbro daemon off` sticks. Default: yes. */
  isEnabled?: () => boolean;
  /** The in-process server. Tests replace it to see what happens when even that cannot start. */
  local?: (ev: BackendEvents, resumed: boolean) => Promise<Backend>;
  drainTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface ProxyHandle {
  /** Resolves when the client closed its end and everything it had asked for was answered; rejects if no backend could be had at all. */
  closed: Promise<void>;
  backendKind(): 'daemon' | 'local' | 'none';
  reconnects(): number;
}

export interface DaemonLink {
  socket: net.Socket;
  reader: (on: (line: string) => void) => void;
  state: DaemonState;
  hello: any;
}

/**
 * Connect to the daemon of this brain and build, and get through the
 * handshake. Null on any failure; 'config-mismatch' when the daemon is
 * genuine but was started with settings that are not this client's.
 */
export async function connectDaemon(
  brainRoot: string,
  build: string = buildId(),
  options: { checkConfig?: boolean; resumed?: boolean } = {},
): Promise<DaemonLink | 'config-mismatch' | null> {
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
  // Its nonce is what our proof is bound to: one we could be talked into reusing is no nonce at all.
  if (typeof hello.nonce !== 'string' || !/^[0-9a-f]{32,128}$/.test(hello.nonce) || hello.nonce === nonce) return fail();
  if (options.checkConfig !== false && typeof hello.config === 'string' && hello.config !== configFingerprint()) {
    socket.destroy();
    return 'config-mismatch';
  }
  socket.write(`${JSON.stringify({ crbro: 'auth', proof: proof(state.token, 'client', hello.nonce), ...(options.resumed ? { resumed: true } : {}) })}\n`);
  const ready = await next();
  if (!ready || ready.crbro !== 'ready') return fail();

  return { socket, reader: on => { sink = on; }, state, hello };
}

/** One control exchange: `status` or `stop`. Null when there is no daemon to talk to. */
export async function controlDaemon(brainRoot: string, op: 'status' | 'stop', build?: string): Promise<any | null> {
  const c = await connectDaemon(brainRoot, build, { checkConfig: false });
  if (!c || c === 'config-mismatch') return null;
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
    // Not the client's working directory: on Windows a process pins its cwd,
    // and the project the client was opened in could not be renamed or
    // deleted for as long as the daemon lived.
    cwd: os.homedir(),
    env: { ...process.env, CRBRO_PATH: brainRoot, CRBRO_DAEMON: '' },
  });
  child.on('error', () => undefined);
  child.unref();
}

/** 'unusable': a daemon exists but is not for us, or cannot be had — do not wait for one, and do not ask again. */
async function daemonBackend(o: ProxyOptions, ev: BackendEvents, resumed: boolean): Promise<Backend | 'unusable' | null> {
  const build = o.build ?? buildId();
  let c = await connectDaemon(o.brainRoot, build, { resumed });
  if (!c && o.spawnDaemon) {
    const since = Date.now() - 1_000;
    try { await o.spawnDaemon(); } catch (err) { o.log?.(`could not start a daemon: ${(err as Error).message}`); }
    const until = Date.now() + (o.spawnWaitMs ?? SPAWN_WAIT_MS);
    while (!c && Date.now() < until) {
      await new Promise(r => setTimeout(r, POLL_MS));
      c = await connectDaemon(o.brainRoot, build, { resumed });
      if (!c) {
        const why = await blockedSince(o.brainRoot, build, since);
        if (why) { o.log?.(`the daemon could not take its endpoint (${why}): serving from this process`); return 'unusable'; }
      }
    }
  }
  if (c === 'config-mismatch') {
    o.log?.('a daemon is running with other settings than this client\'s (CRBRO_SEMANTIC, CRBRO_BACKUP_DIR…): serving from this process so they keep their meaning');
    return 'unusable';
  }
  if (!c) return null;
  const { socket, reader } = c;
  let closing = false;
  reader(ev.onLine);
  socket.on('close', () => { if (!closing) ev.onClose(); });
  return {
    kind: 'daemon',
    send: line => { if (!socket.destroyed) socket.write(`${line}\n`); },
    // Wait for the pipe to really close: the caller exits the process next, and
    // an exit right after end() can cut the last write on a Windows pipe.
    close: () => new Promise<void>(resolve => {
      closing = true;
      if (socket.destroyed) return resolve();
      socket.once('close', () => resolve());
      socket.end();
      setTimeout(() => { socket.destroy(); resolve(); }, 2_000).unref();
    }),
  };
}

/** CRBRO as it was before daemons: the whole server, in this process. */
async function localBackend(ev: BackendEvents, resumed: boolean): Promise<Backend> {
  const { createEngines, createServer } = await import('../server.js');
  const { sessionScope, newTally } = await import('../engine/cortex.js');
  const engines = createEngines();
  const transport = new LoopbackTransport(ev.onLine);
  await createServer(engines).connect(transport);
  // After a lost daemon this server starts with an empty tally that the
  // conversation's earlier writes are not in: mark it, so consolidate says so.
  const scope = resumed ? { tally: newTally(), resumed: true } : null;
  return {
    kind: 'local',
    send: line => (scope ? sessionScope.run(scope, () => transport.receive(line)) : transport.receive(line)),
    close: async () => {
      await new Promise(r => setImmediate(r));   // let a notification that was just delivered run
      try { await engines.searchEngine.flush(); } catch { /* derived data */ }
    },
  };
}

export function runProxy(o: ProxyOptions): ProxyHandle {
  const log = o.log ?? (() => undefined);
  const isEnabled = o.isEnabled ?? (() => true);
  const makeLocal = o.local ?? localBackend;
  let backend: Backend | null = null;
  let connecting = true;
  let inputEnded = false;   // the client closed its end: no more requests, but what it asked for is still owed
  let ended = false;        // we are done: nothing more is written, nothing more is started
  let reconnects = 0;
  let trustDaemons = true;
  const losses: number[] = [];

  let initialize: any | null = null;
  let initialized: string | null = null;
  const inflight = new Set<string | number>();
  const waiting: string[] = [];          // client lines held while there is no usable backend
  let replayId: string | null = null;    // id of the initialize we are replaying, while its answer is pending
  let replays = 0;
  let drainTimer: NodeJS.Timeout | null = null;

  let resolveClosed!: () => void;
  let rejectClosed!: (e: Error) => void;
  const closed = new Promise<void>((res, rej) => { resolveClosed = res; rejectClosed = rej; });

  const toClient = (line: string) => { if (!ended) o.output.write(`${line}\n`); };

  /** Leave — but only once every call the client made has been answered and written out. */
  const maybeFinish = () => {
    if (ended || !inputEnded || connecting || waiting.length > 0 || inflight.size > 0) return;
    void shutdown();
  };
  const shutdown = async () => {
    if (ended) return;
    if (drainTimer) clearTimeout(drainTimer);
    try { await backend?.close(); } catch { /* leaving anyway */ }
    // stdout on a Windows pipe is asynchronous: the caller exits the process
    // next, and the last answer must be out of our hands before it does.
    await new Promise<void>(resolve => { try { o.output.write('', () => resolve()); } catch { resolve(); } });
    ended = true;
    resolveClosed();
  };

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
    maybeFinish();
  };

  const drain = () => {
    while (backend && !connecting && waiting.length) backend.send(waiting.shift()!);
    maybeFinish();
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

  /** No backend of any kind could be had. Say so on every call that is owed an answer, and stop — as the classic server does when it cannot start. */
  const fatal = (err: Error) => {
    if (ended) return;
    log(`no backend could be started: ${err.message}`);
    const ids = new Set<string | number>(inflight);
    for (const l of waiting) { try { const q = JSON.parse(l); if (q?.method !== undefined && q.id !== undefined && q.id !== null) ids.add(q.id); } catch { /* not a request */ } }
    for (const id of ids) toClient(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `CRBRO could not start: ${err.message}` } }));
    inflight.clear();
    waiting.length = 0;
    ended = true;
    rejectClosed(err);
  };

  async function acquire(first: boolean): Promise<void> {
    connecting = true;
    backend = null;
    let b: Backend | null = null;
    // Asked every time, not once at launch: `crbro daemon off` removes the
    // flag and stops the daemon, and a proxy that only knew how to respawn one
    // undid it within 200 ms.
    if (trustDaemons && isEnabled()) {
      const d = await daemonBackend(o, events, !first);
      if (d === 'unusable') trustDaemons = false;
      else b = d;
    }
    if (!b) {
      if (trustDaemons && isEnabled()) log('no daemon reachable: serving from this process');
      b = await makeLocal(events, !first);
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
    backend = null;
    // The client has gone and is owed nothing more: a replacement would serve nobody.
    if (inputEnded && waiting.length === 0 && inflight.size === 0) { connecting = false; void shutdown(); return; }
    try { await acquire(false); } catch (err) { fatal(err as Error); }
  }

  const reader = new LineReader(fromClient, () => undefined);
  o.input.on('data', (chunk: Buffer | string) => reader.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
  const onInputEnd = () => {
    if (inputEnded) return;
    inputEnded = true;
    // A client that sends its last crbro_learn and closes stdin at once is
    // still owed that write and its answer — the classic server gives both.
    drainTimer = setTimeout(() => { log('gave up waiting for the last answers'); void shutdown(); }, o.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
    drainTimer.unref();
    maybeFinish();
  };
  o.input.on('end', onInputEnd);
  o.input.on('close', onInputEnd);

  void acquire(true).catch(err => fatal(err as Error));

  return { closed, backendKind: () => (backend ? backend.kind : 'none'), reconnects: () => reconnects };
}
