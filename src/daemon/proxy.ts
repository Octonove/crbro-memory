// ─── The proxy: what a client actually launches in daemon mode ────
//
// An MCP client starts `crbro-memory` and speaks JSON-RPC on stdio, as it
// always has. In daemon mode that process loads no index and no model: it
// finds the daemon (or starts it), proves who it is, and from then on copies
// lines — client to daemon, daemon to client. It reads each line only to keep
// what it needs on the worst day:
//
//   · `initialize`, `ping` and `tools/list` it answers itself, at once: their
//     answers are fixed per build (surface.ts) and a client must not wait for
//     a daemon to be found or started to learn them;
//   · the client's `initialize`, which it replays — under an id of its own,
//     answer swallowed — on every backend it attaches to, the first included;
//   · which requests are in flight, so each gets an error instead of a
//     silence that would hang the conversation until a timeout;
//   · nothing else.
//
// And if no daemon can be had in time, the backend is a server inside this
// process — CRBRO exactly as it was before 2.5. The daemon is an optimisation;
// the memory is not allowed to depend on it. Nor is that fallback for life:
// the proxy keeps looking, quietly, and moves back to a daemon once one
// answers and nothing is running here.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { LineReader, LoopbackTransport, NOT_STARTED, idFromHead, MAX_LINE_BYTES } from './lines.js';
import {
  DAEMON_PROTOCOL, buildId, readState, newNonce, proof, sameProof, configFingerprint, blockedSince, type DaemonState,
} from './endpoint.js';
import type { McpSurface } from './surface.js';

const CONNECT_TIMEOUT_MS = 1_500;
const HANDSHAKE_TIMEOUT_MS = 4_000;
/** The whole budget for a daemon (finding it, starting it, its handshake) before serving in-process. Every attempt fits inside it. */
const SPAWN_WAIT_MS = 12_000;
const POLL_MS = 200;
/** Daemon connections lost inside this window before the proxy stops trying daemons for a while. */
const FLAP_WINDOW_MS = 60_000;
const FLAP_LIMIT = 3;
/** How long "a while" is, the first time; it doubles on each new burst, up to the cap. Never for ever. */
const FLAP_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
/** Serving in-process: how often to look for a daemon again (doubling between the two). */
const PROBE_MIN_MS = 2_000;
const PROBE_MAX_MS = 60_000;
const PROBE_BUDGET_MS = 3_000;
/** A daemon that refused calls because it is stopping, and then did not go: how long before we stop waiting for it. */
const STOPPING_GRACE_MS = 15_000;
/** After the client closes its end: how long calls already accepted may take to finish before we leave anyway. */
const DRAIN_TIMEOUT_MS = 30_000;

const LOST_MESSAGE = 'CRBRO restarted while this call was running, before answering it. The call may or may not have taken effect: check (crbro_recall or crbro_inspect) before repeating a write.';

export interface Backend {
  kind: 'daemon' | 'local';
  send(line: string): void;
  close(): Promise<void>;
}
type BackendEvents = { onLine: (line: string) => void; onClose: () => void };
type Id = string | number;

export interface ProxyOptions {
  input: Readable;
  output: Writable;
  brainRoot: string;
  build?: string;
  /** Start a daemon. Production spawns a detached process; tests start one in-process, or refuse. */
  spawnDaemon?: (() => void | Promise<void>) | null;
  /** The whole budget for getting a daemon before serving in-process (default 12 s). */
  spawnWaitMs?: number;
  /** Is daemon mode still on? Asked again at every (re)connection, so `crbro daemon off` sticks. Default: yes. */
  isEnabled?: () => boolean;
  /** The in-process server. Tests replace it to see what happens when even that cannot start. */
  local?: (ev: BackendEvents, resumed: boolean) => Promise<Backend>;
  /**
   * The answers fixed per build (surface.ts). Undefined: found here (the
   * snapshot beside the code, or the real server asked in this process).
   * Null: none — every request goes to the backend, as before 2.11.
   */
  surface?: McpSurface | null;
  drainTimeoutMs?: number;
  /** Serving in-process, how often to look for a daemon again: first delay and cap (default 2 s → 60 s). */
  probeMs?: { min: number; max: number };
  /** After a burst of lost daemons, how long to stay in-process before trying again (default 60 s, doubling). */
  flapCooldownMs?: number;
  log?: (line: string) => void;
  /** CRBRO_STARTUP_TRACE (trace.ts), passed in so this module stays light. */
  trace?: (phase: string, detail?: string, once?: boolean) => void;
}

export interface ProxyHandle {
  /** Resolves when the client closed its end and everything it had asked for was answered; rejects if no backend could be had at all. */
  closed: Promise<void>;
  backendKind(): 'daemon' | 'local' | 'none';
  reconnects(): number;
  /** Times this proxy moved from its in-process server back to a daemon. */
  switches(): number;
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
 * `deadline` (epoch ms) bounds the whole attempt: no step waits past it.
 */
export async function connectDaemon(
  brainRoot: string,
  build: string = buildId(),
  options: { checkConfig?: boolean; resumed?: boolean; deadline?: number } = {},
): Promise<DaemonLink | 'config-mismatch' | null> {
  const left = () => (options.deadline === undefined ? Infinity : options.deadline - Date.now());
  if (left() <= 0) return null;
  const state = await readState(brainRoot, build);
  if (!state) return null;

  const socket = await new Promise<net.Socket | null>(resolve => {
    const s = net.connect(state.endpoint);
    const t = setTimeout(() => { s.destroy(); resolve(null); }, Math.max(1, Math.min(CONNECT_TIMEOUT_MS, left())));
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
    let settled = false;
    const done = (v: any | null) => { if (settled) return; settled = true; clearTimeout(t); socket.off('close', onClose); resolve(v); };
    // An answer that arrived while this loop was busy is read before the timeout is believed.
    const t = setTimeout(() => setImmediate(() => done(null)), Math.max(1, Math.min(HANDSHAKE_TIMEOUT_MS, left())));
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

interface DaemonAttempt {
  brainRoot: string;
  build: string;
  resumed: boolean;
  /** Epoch ms: nothing in this attempt waits past it. */
  deadline: number;
  spawn?: (() => void | Promise<void>) | null;
  log: (line: string) => void;
  trace: (phase: string, detail?: string, once?: boolean) => void;
  /** A background probe: a daemon with other settings is not news the second time. */
  quiet?: boolean;
}

function linkBackend(c: DaemonLink, ev: BackendEvents): Backend {
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

/** 'unusable': a daemon exists but is not for us, or cannot be had — do not wait for one. */
async function daemonBackend(a: DaemonAttempt, ev: BackendEvents): Promise<Backend | 'unusable' | null> {
  let c = await connectDaemon(a.brainRoot, a.build, { resumed: a.resumed, deadline: a.deadline });
  if (!c && a.spawn) {
    const since = Date.now() - 1_000;
    try { await a.spawn(); } catch (err) { a.log(`could not start a daemon: ${(err as Error).message}`); }
    a.trace('daemon launched', '', true);
    while (!c && Date.now() < a.deadline) {
      await new Promise(r => setTimeout(r, Math.max(1, Math.min(POLL_MS, a.deadline - Date.now()))));
      c = await connectDaemon(a.brainRoot, a.build, { resumed: a.resumed, deadline: a.deadline });
      if (!c) {
        const why = await blockedSince(a.brainRoot, a.build, since);
        if (why) { a.log(`the daemon could not start (${why}): serving from this process`); return 'unusable'; }
      }
    }
  }
  if (c === 'config-mismatch') {
    if (!a.quiet) a.log('a daemon is running with other settings than this client\'s (CRBRO_SEMANTIC, CRBRO_BACKUP_DIR…): serving from this process so they keep their meaning');
    return 'unusable';
  }
  if (!c) return null;
  return linkBackend(c, ev);
}

/** CRBRO as it was before daemons: the whole server, in this process. */
async function localBackend(ev: BackendEvents, resumed: boolean): Promise<Backend> {
  const { createEngines, createServer } = await import('../server.js');
  const { sessionScope, newTally } = await import('../engine/cortex.js');
  const engines = createEngines();
  const transport = new LoopbackTransport(ev.onLine);
  const server = createServer(engines);
  await server.connect(transport);
  // After a lost daemon this server starts with an empty tally that the
  // conversation's earlier writes are not in: mark it, so consolidate says so.
  const scope = resumed ? { tally: newTally(), resumed: true } : null;
  return {
    kind: 'local',
    send: line => (scope ? sessionScope.run(scope, () => transport.receive(line)) : transport.receive(line)),
    close: async () => {
      await new Promise(r => setImmediate(r));   // let a notification that was just delivered run
      try { await engines.searchEngine.flush(); } catch { /* derived data */ }
      try { await server.close(); } catch { /* leaving anyway */ }
    },
  };
}

const isRequest = (m: any): boolean => !!m && typeof m.method === 'string' && m.id !== undefined && m.id !== null;
const requestIdOf = (line: string): Id | null => {
  try { const q = JSON.parse(line); return isRequest(q) ? q.id : null; } catch { return null; }
};

export function runProxy(o: ProxyOptions): ProxyHandle {
  const log = o.log ?? (() => undefined);
  const trace = o.trace ?? (() => undefined);
  const isEnabled = o.isEnabled ?? (() => true);
  const makeLocal = o.local ?? localBackend;
  // Once, here: a proxy that recomputed it at every reconnection could pick up
  // a newer release unpacked in place and launch a daemon of code it never ran.
  const build = o.build ?? buildId();
  const budgetMs = o.spawnWaitMs ?? SPAWN_WAIT_MS;
  const probeMin = o.probeMs?.min ?? PROBE_MIN_MS;
  const probeMax = o.probeMs?.max ?? PROBE_MAX_MS;

  // ── The backend, and where it is in its own handshake ──
  let backend: Backend | null = null;
  let gen = 0;               // every backend attempt gets a number; only the active one is listened to
  let activeGen = -1;
  let pendingGen = -1;       // a daemon link held while moving over to it
  let pending: Backend | null = null;
  let phase: 'none' | 'handshaking' | 'ready' | 'stopping' = 'none';
  let backendInitDone = false;
  let acquiring = true;
  let switching = false;
  let inputEnded = false;    // the client closed its end: no more requests, but what it asked for is still owed
  let ended = false;         // we are done: nothing more is written, nothing more is started
  let reconnects = 0;
  let switches = 0;
  let distrustUntil = 0;
  let cooldownMs = o.flapCooldownMs ?? FLAP_COOLDOWN_MS;
  const losses: number[] = [];

  // ── What the client said that we must remember ──
  let surface: McpSurface | null | undefined = o.surface;
  const early: string[] = [];             // lines that arrived before we knew whether we have a surface
  let clientInit: any | null = null;
  let initAnswered = false;               // the client has its answer to initialize (ours, or a backend's)
  let clientInitialized: string | null = null;
  const inflight = new Map<Id, string>(); // sent to the backend, unanswered: id → the line, should it need sending again
  const waiting: string[] = [];           // client lines held while there is no ready backend
  const toolCalls = new Set<Id>();
  let replayId: string | null = null;
  let replays = 0;
  let requeueAt = 0;                      // where the next call a stopping daemon never started goes back in line
  let drainTimer: NodeJS.Timeout | null = null;
  let probeTimer: NodeJS.Timeout | null = null;
  let probeDelay = probeMin;
  let stoppingTimer: NodeJS.Timeout | null = null;
  let idleWaiters: Array<() => void> = [];

  let resolveClosed!: () => void;
  let rejectClosed!: (e: Error) => void;
  const closed = new Promise<void>((res, rej) => { resolveClosed = res; rejectClosed = rej; });

  const toClient = (line: string) => { if (!ended) o.output.write(`${line}\n`); };
  const ready = () => backend !== null && phase === 'ready' && !switching;
  const owed = () => inflight.size > 0 || waiting.some(l => requestIdOf(l) !== null) || early.some(l => requestIdOf(l) !== null);
  const daemonsWanted = () => isEnabled() && Date.now() >= distrustUntil;

  /** Leave — but only once every call the client made has been answered and written out. */
  const maybeFinish = () => {
    if (ended || !inputEnded || owed()) return;
    void shutdown();
  };
  const shutdown = async () => {
    if (ended) return;
    ended = true;
    for (const t of [drainTimer, probeTimer, stoppingTimer]) if (t) clearTimeout(t);
    try { await backend?.close(); } catch { /* leaving anyway */ }
    try { await pending?.close(); } catch { /* leaving anyway */ }
    // stdout on a Windows pipe is asynchronous: the caller exits the process
    // next, and the last answer must be out of our hands before it does.
    await new Promise<void>(resolve => { try { o.output.write('', () => resolve()); } catch { resolve(); } });
    resolveClosed();
  };

  const settleIdle = () => {
    if (inflight.size > 0 || phase === 'handshaking') return;
    const w = idleWaiters;
    idleWaiters = [];
    for (const f of w) f();
  };
  const whenIdle = () => new Promise<void>(resolve => {
    if (inflight.size === 0 && phase !== 'handshaking') resolve(); else idleWaiters.push(resolve);
  });

  const forward = (line: string) => {
    const id = requestIdOf(line);
    if (id !== null) inflight.set(id, line);
    backend!.send(line);
  };

  const drain = () => {
    while (ready() && waiting.length) forward(waiting.shift()!);
    maybeFinish();
  };

  /** Bring the backend up to where the client is: the client's initialize (ours to answer, its answer swallowed), then initialized. */
  const handshake = () => {
    if (!backend || backendInitDone || phase === 'handshaking') return;
    if (!clientInit || !initAnswered) {
      // Nothing to replay yet; or the client's own initialize is still queued and is about to reach this backend itself.
      phase = 'ready';
      drain();
      return;
    }
    phase = 'handshaking';
    replayId = `crbro-replay-${++replays}`;
    backend.send(JSON.stringify({ ...clientInit, id: replayId }));
  };

  const fromBackend = (line: string) => {
    let m: any = null;
    try { m = JSON.parse(line); } catch { /* not ours to judge: pass it on */ }
    if (m && replayId !== null && m.id === replayId && m.method === undefined) {
      // The backend answered the handshake we made for the client. The client
      // already has its answer; this one stops here.
      replayId = null;
      backendInitDone = true;
      if (m.error) log(`the backend refused the replayed initialize: ${m.error?.message ?? 'no reason'}`);
      if (clientInitialized && backend) backend.send(clientInitialized);
      phase = 'ready';
      trace('backend ready', backend?.kind ?? '', true);
      settleIdle();
      drain();
      return;
    }
    if (m && m.method === undefined && m.id !== undefined && m.id !== null) {
      if (m.error?.data?.crbro === NOT_STARTED && inflight.has(m.id)) {
        // The daemon is stopping and never ran this call: it goes to whoever serves next, first in line.
        waiting.splice(requeueAt++, 0, inflight.get(m.id)!);
        inflight.delete(m.id);
        stopping();
        settleIdle();
        return;
      }
      inflight.delete(m.id);
      if (!initAnswered && clientInit && m.id === clientInit.id) {
        initAnswered = true;
        backendInitDone = true;
        trace('initialize answered', `by the ${backend?.kind ?? 'backend'}`, true);
      }
      if (toolCalls.delete(m.id)) trace('first tool result', backend?.kind ?? '', true);
      settleIdle();
    }
    toClient(line);
    maybeFinish();
  };

  /** The daemon said it is stopping: hold new lines until it is gone, and do not wait for it for ever. */
  const stopping = () => {
    if (phase === 'stopping') return;
    phase = 'stopping';
    const g = activeGen;
    stoppingTimer = setTimeout(() => {
      stoppingTimer = null;
      if (activeGen !== g || ended) return;
      log('the daemon said it was stopping and did not go: leaving it');
      const b = backend;
      void lost();
      void b?.close().catch(() => undefined);
    }, STOPPING_GRACE_MS);
    stoppingTimer.unref();
  };

  const handleClient = (line: string) => {
    let m: any = null;
    try { m = JSON.parse(line); } catch { /* the backend will answer the parse error */ }
    if (m && surface) {
      const { answerFromSurface } = surfaceApi!;
      const a = answerFromSurface(surface, m);
      if (a) {
        toClient(JSON.stringify(a));
        if (m.method === 'initialize') {
          clientInit = m;
          initAnswered = true;
          trace('initialize answered', 'by the proxy', true);
          if (backend && phase === 'ready' && !backendInitDone) handshake();
        }
        maybeFinish();
        return;
      }
    }
    if (isRequest(m) && m.method === 'initialize') { clientInit = m; initAnswered = false; }
    if (m && m.method === 'notifications/initialized' && m.id === undefined) {
      clientInitialized = line;
      // Ours to send, right after the replayed initialize: never ahead of it.
      if (initAnswered && !backendInitDone) return;
    }
    if (isRequest(m) && m.method === 'tools/call') toolCalls.add(m.id);
    if (ready()) forward(line);
    else waiting.push(line);
  };

  let surfaceApi: typeof import('./surface.js') | null = null;
  const fromClient = (line: string) => {
    if (surface === undefined || (surface && !surfaceApi)) { early.push(line); return; }
    handleClient(line);
  };

  const eventsFor = (g: number): BackendEvents => ({
    onLine: line => { if (g === activeGen) fromBackend(line); },
    onClose: () => {
      if (g === activeGen) void lost();
      else if (g === pendingGen) { pendingGen = -1; pending = null; }
    },
  });

  /** No backend of any kind could be had. Say so on every call that is owed an answer, and stop — as the classic server does when it cannot start. */
  const fatal = (err: Error) => {
    if (ended) return;
    log(`no backend could be started: ${err.message}`);
    const ids = new Set<Id>(inflight.keys());
    for (const l of [...waiting, ...early]) { const id = requestIdOf(l); if (id !== null) ids.add(id); }
    for (const id of ids) toClient(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `CRBRO could not start: ${err.message}` } }));
    inflight.clear();
    waiting.length = 0;
    early.length = 0;
    ended = true;
    for (const t of [drainTimer, probeTimer, stoppingTimer]) if (t) clearTimeout(t);
    rejectClosed(err);
  };

  const activate = (b: Backend, g: number) => {
    backend = b;
    activeGen = g;
    phase = 'none';
    requeueAt = 0;
    backendInitDone = false;
    trace(b.kind === 'daemon' ? 'backend connected' : 'in-process fallback', b.kind === 'local' ? 'engine ready' : '', true);
    if (b.kind === 'local') scheduleProbe(); else probeDelay = probeMin;
    handshake();
  };

  async function acquire(first: boolean): Promise<void> {
    acquiring = true;
    backend = null;
    activeGen = -1;
    phase = 'none';
    let b: Backend | null = null;
    const g = ++gen;
    // Asked every time, not once at launch: `crbro daemon off` removes the
    // flag and stops the daemon, and a proxy that only knew how to respawn one
    // undid it within 200 ms.
    if (daemonsWanted()) {
      const d = await daemonBackend({
        brainRoot: o.brainRoot, build, resumed: !first, deadline: Date.now() + budgetMs,
        spawn: o.spawnDaemon, log, trace,
      }, eventsFor(g));
      if (d === 'unusable') distrust(FLAP_COOLDOWN_MS);
      else if (d) b = d;
      else log('no daemon reachable: serving from this process');
    }
    if (!b) b = await makeLocal(eventsFor(g), !first);
    acquiring = false;
    if (ended) { await b.close(); return; }
    activate(b, g);
  }

  const distrust = (ms: number) => { distrustUntil = Math.max(distrustUntil, Date.now() + ms); };

  async function lost(): Promise<void> {
    if (ended) return;
    if (stoppingTimer) { clearTimeout(stoppingTimer); stoppingTimer = null; }
    reconnects++;
    const now = Date.now();
    losses.push(now);
    while (losses.length && now - losses[0] > FLAP_WINDOW_MS) losses.shift();
    if (losses.length >= FLAP_LIMIT) {
      // A daemon that keeps dying is not worth the client's time for a while — a while, not for ever.
      distrust(cooldownMs);
      log(`daemon lost ${losses.length} times in a minute: serving in-process for ${Math.round(cooldownMs / 1000)} s, then looking again`);
      cooldownMs = Math.min(cooldownMs * 2, MAX_COOLDOWN_MS);
      losses.length = 0;
    }
    // Whatever was waiting for an answer will not get one from a dead process,
    // and nobody can say whether it ran: say exactly that. What never left this
    // proxy (still queued) is not in that position and goes to the next backend.
    for (const id of [...inflight.keys()]) {
      toolCalls.delete(id);
      toClient(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: LOST_MESSAGE } }));
    }
    inflight.clear();
    replayId = null;
    backend = null;
    activeGen = -1;
    phase = 'none';
    backendInitDone = false;
    settleIdle();
    // The client has gone and is owed nothing more: a replacement would serve nobody.
    if (inputEnded && !owed()) { void shutdown(); return; }
    try { await acquire(false); } catch (err) { fatal(err as Error); }
  }

  // ── Serving in-process: keep looking for a daemon, and move back to one ──
  function scheduleProbe(): void {
    if (probeTimer || ended) return;
    probeTimer = setTimeout(() => { probeTimer = null; void probe(); }, probeDelay);
    probeTimer.unref();
    probeDelay = Math.min(probeDelay * 2, probeMax);
  }

  async function probe(): Promise<void> {
    if (ended || !backend || backend.kind !== 'local' || switching) return;
    if (!daemonsWanted()) { scheduleProbe(); return; }
    const g = ++gen;
    pendingGen = g;
    const d = await daemonBackend({
      brainRoot: o.brainRoot, build, resumed: true, deadline: Date.now() + PROBE_BUDGET_MS,
      spawn: null, log, trace, quiet: true,
    }, eventsFor(g)).catch(() => null);
    if (!d || d === 'unusable' || pendingGen !== g || ended || !backend || backend.kind !== 'local') {
      if (pendingGen === g) pendingGen = -1;
      if (d && d !== 'unusable') await d.close();
      if (d === 'unusable') distrust(FLAP_COOLDOWN_MS);
      scheduleProbe();
      return;
    }
    pending = d;
    await switchTo(d, g);
  }

  /**
   * Move the conversation from this process's server to the daemon. Only when
   * nothing is running here (new lines wait meanwhile), and the in-process
   * index is flushed BEFORE the daemon serves: the daemon catches up with
   * what this process wrote (it refreshes from disk for a resumed
   * connection), and its own later save is a superset, never overwritten by
   * ours. The daemon's tally of this conversation starts empty, as after a
   * lost daemon: consolidate says so (`resumed`).
   */
  async function switchTo(d: Backend, g: number): Promise<void> {
    switching = true;
    await whenIdle();
    const old = backend;
    const stillThere = () => pendingGen === g && !ended;
    if (!stillThere() || !old) {
      switching = false;
      if (pendingGen === g) { pendingGen = -1; pending = null; }
      await d.close().catch(() => undefined);
      if (!ended) { drain(); scheduleProbe(); }
      return;
    }
    activeGen = -1;          // nothing is in flight: nothing more is owed by the old server
    await old.close().catch(() => undefined);
    const linkAlive = pendingGen === g;
    pendingGen = -1;
    pending = null;
    switching = false;
    backend = null;
    if (ended) { await d.close().catch(() => undefined); return; }
    if (!linkAlive) {
      // The daemon went away while we flushed: back to the start, as after any lost backend.
      try { await acquire(false); } catch (err) { fatal(err as Error); }
      return;
    }
    switches++;
    log('a daemon answers again: this conversation moved back to it from the in-process server');
    trace('moved back to the daemon');
    activate(d, g);
  }

  const reader = new LineReader(fromClient, head => {
    const id = idFromHead(head);
    log(`refused a message larger than ${MAX_LINE_BYTES / 1048576} MB${id !== null ? ` (id ${JSON.stringify(id)})` : ''}`);
    toClient(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message: `Invalid Request: a message larger than ${MAX_LINE_BYTES / 1048576} MB was not read.` } }));
  });
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

  // ── The surface: given, or found now; lines that came meanwhile are handled in order ──
  void (async () => {
    try {
      surfaceApi = await import('./surface.js');
      if (surface === undefined) surface = await surfaceApi.getSurface(build);
    } catch {
      if (surface === undefined) surface = null;
    }
    if (!surfaceApi) surface = null;
    for (const line of early.splice(0)) handleClient(line);
    maybeFinish();
  })();

  void acquire(true).catch(err => fatal(err as Error));

  return {
    closed,
    backendKind: () => (backend ? backend.kind : 'none'),
    reconnects: () => reconnects,
    switches: () => switches,
  };
}
