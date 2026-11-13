// ─── The daemon: one process owns the brain ──────────────────────
//
// Until 2.5 every client started its own CRBRO: Claude Code one, Claude
// Desktop another, Codex a third. Each loaded its own copy of the search
// index (~40 MB) and of the embedding model (~13 s, ~0.5 GB), each kept that
// index in memory and wrote it over the others' when it closed — so a line
// saved in one chat could be invisible in the next — and nothing stopped two
// different builds from writing the same brain at once. All of it measured
// on a real machine, not imagined.
//
// The daemon is the same server, once: the engines are built one time and
// every connection gets its own McpServer over them. Clients reach it through
// a byte-for-byte proxy (proxy.ts), so nothing about MCP changes for them.
//
// What it must never do is make the memory less available than it was. So:
// it is opt-in; a client that cannot reach it serves itself in-process,
// exactly as before; and a daemon that dies mid-conversation is replaced
// under the client's feet. Losing the daemon costs speed, never the memory.

import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createEngines, createServer, type Engines } from '../server.js';
import { sessionScope, newTally } from '../engine/cortex.js';
import { LineReader, SocketServerTransport } from './lines.js';
import { connectDaemon } from './proxy.js';
import {
  DAEMON_PROTOCOL, buildId, packageVersion, endpointFor, daemonDir, newToken, newNonce,
  proof, sameProof, writeState, removeState, configFingerprint, secureSocketDir,
  acquireStartLock, markBlocked, clearBlocked, pruneDaemonDir, type DaemonState,
} from './endpoint.js';
import { resolveBrainDir } from '../engine/brain.js';
import { trace, traceStart } from './trace.js';

/** Until a connection has proved itself. After that a quiet connection costs nothing and is never cut for being quiet. */
const HANDSHAKE_TIMEOUT_MS = 5_000;
/** With nobody arriving, the index warms up this long after listening; the first handshake through starts it sooner. */
const WARMUP_DELAY_MS = 1_000;
/** Stopping: how long calls already running may take to finish before their connections are cut anyway. */
const STOP_DRAIN_MS = 10_000;
/** A conversation that comes back after its backend was lost: how long its first message may wait for the index to catch up with the disk. */
const RESUME_REFRESH_MS = 3_000;
const DEFAULT_IDLE_MIN = 20;
/** setTimeout takes a 32-bit delay: past this it fires at once, and a daemon asked to wait a month exited in a millisecond. */
const MAX_TIMER_MS = 2_147_000_000;
const LOG_MAX_BYTES = 512 * 1024;
/** Refusals written per minute. A local process knocking in a loop must not be able to fill the disk through our log. */
const REFUSALS_PER_MINUTE = 20;
/** How long a starter that found the endpoint busy waits for its holder to prove it is a daemon of this brain. */
const PEER_PROOF_WAIT_MS = 2_500;

export interface DaemonHandle {
  endpoint: string;
  state: DaemonState;
  /** MCP conversations being served — not sockets: a status probe is not a conversation. */
  connections(): number;
  /** Flush, remove the state file, close every client. Resolves when done. */
  stop(reason?: string): Promise<void>;
  /** Resolves when the daemon has stopped, for whatever reason. */
  stopped: Promise<string>;
}

export interface DaemonOptions {
  /** Minutes with no conversation before it exits. 0 = never. Default 20, or CRBRO_DAEMON_IDLE_MIN. */
  idleMinutes?: number;
  /** Tests inject their own; production builds them here. */
  engines?: Engines;
  build?: string;
  log?: (line: string) => void;
}

export function idleDelayMs(opt?: number, env: NodeJS.ProcessEnv = process.env): number {
  let minutes = opt;
  if (minutes === undefined) {
    const v = Number(env.CRBRO_DAEMON_IDLE_MIN);
    minutes = Number.isFinite(v) && v >= 0 ? v : DEFAULT_IDLE_MIN;
  }
  return Math.min(Math.max(0, minutes) * 60_000, MAX_TIMER_MS);
}

async function fileLogger(brainRoot: string): Promise<(line: string) => void> {
  const file = path.join(daemonDir(brainRoot), 'daemon.log');
  await fs.mkdir(daemonDir(brainRoot), { recursive: true, mode: 0o700 });
  let written = 0;
  try { written = (await fs.stat(file)).size; } catch { /* no log yet */ }
  let queue: Promise<void> = Promise.resolve();
  return (line: string) => {
    const text = `${new Date().toISOString()} [${process.pid}] ${line.replace(/[\r\n]+/g, ' ')}\n`;
    queue = queue.then(async () => {
      if (written > LOG_MAX_BYTES) { await fs.rename(file, `${file}.1`).catch(() => undefined); written = 0; }
      await fs.appendFile(file, text);
      written += Buffer.byteLength(text);
    }).catch(() => undefined);
  };
}

/**
 * Is somebody answering there? 'dead' only when the system says nobody is
 * (refused, or no such file): a timeout is a busy process, not an absent one,
 * and reading it as absent is how a starter deletes a live daemon's socket.
 */
function probe(endpoint: string): Promise<'alive' | 'dead' | 'unknown'> {
  return new Promise(resolve => {
    const s = net.connect(endpoint);
    const done = (v: 'alive' | 'dead' | 'unknown') => { s.destroy(); resolve(v); };
    s.once('connect', () => done('alive'));
    s.once('error', err => {
      const code = (err as NodeJS.ErrnoException).code;
      done(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'dead' : 'unknown');
    });
    setTimeout(() => done('unknown'), 1500).unref();
  });
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const engines = options.engines ?? createEngines();
  const brainRoot = engines.brain.paths.root;
  const build = options.build ?? buildId();
  const endpoint = endpointFor(brainRoot, build);
  const log = options.log ?? await fileLogger(brainRoot);
  const token = newToken();
  const idleMs = idleDelayMs(options.idleMinutes);
  const config = configFingerprint();
  // Read once. package.json on disk can change under a running daemon (npx refreshes its cache in place),
  // and a daemon that reported the NEW version while running the OLD code was seen doing exactly that.
  const version = packageVersion();

  await fs.mkdir(daemonDir(brainRoot), { recursive: true, mode: 0o700 });

  type Entry = { socket: net.Socket; server: McpServer | null; transport: SocketServerTransport | null };
  const clients = new Set<Entry>();
  const conversations = () => [...clients].filter(c => c.server !== null).length;
  let idleTimer: NodeJS.Timeout | null = null;
  let stopping: Promise<void> | null = null;
  let resolveStopped!: (reason: string) => void;
  const stopped = new Promise<string>(r => { resolveStopped = r; });
  let ownSocket: { dev: number; ino: number } | null = null;

  // Only conversations move the idle clock. A socket that never proves itself
  // — a status probe, a scanner, another user's process knocking — can neither
  // keep the daemon alive nor push its exit further away.
  const armIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (idleMs > 0 && conversations() === 0 && !stopping) {
      idleTimer = setTimeout(() => { if (conversations() === 0) void stop('idle'); else armIdle(); }, idleMs);
      idleTimer.unref();
    }
  };

  let refusals = 0;
  let refusalWindow = Date.now();
  const logRefusal = (why: string) => {
    const now = Date.now();
    if (now - refusalWindow > 60_000) {
      if (refusals > REFUSALS_PER_MINUTE) log(`… and ${refusals - REFUSALS_PER_MINUTE} more refusals in that minute`);
      refusals = 0;
      refusalWindow = now;
    }
    if (++refusals <= REFUSALS_PER_MINUTE) log(`connection refused: ${why}`);
  };

  // ── The index warms up off every handshake's path (A7) ──
  // Loading it parses tens of MB synchronously, and a handshake that arrives
  // meanwhile waits for the parse. So it starts only when no handshake is under
  // way: as soon as the first one is through, or a moment after listening if
  // nobody comes.
  let handshakes = 0;
  let warmDue = false;
  let warmStarted = false;
  let warmDone = false;
  const warmUp = () => {
    if (!warmDue || warmStarted || handshakes > 0 || stopping) return;
    warmStarted = true;
    trace('index warm-up started');
    // The index and the model warm up now, off anybody's critical path: the
    // first client to boot finds them ready, the second never waits at all.
    void engines.searchEngine.init()
      .then(() => { warmDone = true; trace('engine ready', 'index loaded', true); })
      .catch(err => log(`index warm-up failed: ${(err as Error).message}`));
  };

  const listener = net.createServer({ allowHalfOpen: false }, socket => { accept(socket); });

  function accept(socket: net.Socket): void {
    const entry: Entry = { socket, server: null, transport: null };
    clients.add(entry);
    socket.setNoDelay(true);

    let stage: 'hello' | 'auth' | 'first' | 'mcp' | 'dead' = 'hello';
    let nonce = '';
    let resumed = false;
    let transport: SocketServerTransport | null = null;
    handshakes++;
    let counted = true;
    const handshakeOver = () => {
      if (!counted) return;
      counted = false;
      handshakes--;
      warmUp();
    };
    const kill = (why: string) => {
      if (stage === 'dead') return;
      stage = 'dead';
      handshakeOver();
      logRefusal(why);
      socket.destroy();
    };
    // Only until the connection proves itself (stage 'auth' passed): a proxy
    // whose client took 17 s to send initialize was cut every 5 s, three times,
    // and then served itself in-process for good. The verdict waits one turn of
    // the loop, so bytes that arrived while the loop was busy are read before
    // "too slow" is believed.
    const timer = setTimeout(() => setImmediate(() => {
      if (stage === 'hello' || stage === 'auth') kill('handshake timeout');
    }), HANDSHAKE_TIMEOUT_MS);
    timer.unref();
    const say = (o: unknown) => { if (!socket.destroyed) socket.write(`${JSON.stringify(o)}\n`); };

    const reader = new LineReader(line => {
      if (stage === 'mcp') { transport!.receive(line); return; }
      if (stage === 'dead') return;
      let m: any;
      try { m = JSON.parse(line); } catch { return kill('not JSON before the handshake'); }

      if (stage === 'hello') {
        if (m?.crbro !== 'hello' || m.protocol !== DAEMON_PROTOCOL || typeof m.nonce !== 'string' || !/^[0-9a-f]{32,128}$/.test(m.nonce)) {
          return kill('bad hello');
        }
        nonce = newNonce();
        say({ crbro: 'hello', protocol: DAEMON_PROTOCOL, version, build, pid: process.pid, config, proof: proof(token, 'daemon', m.nonce), nonce });
        stage = 'auth';
        return;
      }
      if (stage === 'auth') {
        if (m?.crbro !== 'auth' || !sameProof(String(m.proof || ''), proof(token, 'client', nonce))) return kill('bad proof');
        resumed = m.resumed === true;
        clearTimeout(timer);
        say({ crbro: 'ready' });
        stage = 'first';
        warmDue = true;
        handshakeOver();
        trace('first client authenticated', '', true);
        return;
      }
      // stage === 'first': a control message, or the first MCP message.
      if (m?.crbro === 'control') {
        clearTimeout(timer);
        if (m.op === 'status') {
          say({ crbro: 'status', pid: process.pid, version, build, brain: brainRoot, endpoint, config,
            connections: conversations(), uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1048576),
            semantic_vectors: engines.searchEngine.semanticCount(), idle_minutes: Math.round(idleMs / 6_000) / 10 });
          socket.end();
        } else if (m.op === 'stop') {
          say({ crbro: 'stopping' });
          socket.end();
          void stop('asked to stop');
        } else {
          kill('unknown control op');
        }
        return;
      }
      // An MCP client. Its own server over the shared engines, and its own
      // session scope: what this conversation writes is this conversation's.
      // `resumed`: the proxy lost a backend mid-conversation and this one
      // starts with an empty tally that the conversation's earlier writes are
      // not in — consolidate says so instead of reporting zeros as the truth.
      clearTimeout(timer);
      const scope = { tally: newTally(), resumed };
      transport = new SocketServerTransport(socket, fn => sessionScope.run(scope, fn));
      const server = createServer(engines);
      entry.server = server;
      entry.transport = transport;
      stage = 'mcp';
      armIdle();
      transport.receive(line);   // queued: an `initialized` arriving in the same chunk must not overtake `initialize`
      // A resumed conversation was served elsewhere meanwhile (an in-process
      // fallback, a daemon that died): what it wrote there is on disk, maybe not
      // in this index. Catch up before its first message — briefly, and only
      // when the index is loaded (a load still under way reads the disk anyway).
      const catchUp = resumed && warmDone
        ? Promise.race([engines.searchEngine.refresh().catch(() => undefined), new Promise(r => setTimeout(r, RESUME_REFRESH_MS))])
        : null;
      server.connect(transport)
        .then(() => catchUp)
        .then(() => transport!.open())
        .catch(err => kill(`server.connect failed: ${(err as Error).message}`));
    }, () => kill('line too long'));

    socket.on('data', chunk => reader.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
    socket.on('error', () => { /* 'close' follows */ });
    socket.on('close', () => {
      clearTimeout(timer);
      handshakeOver();
      const wasConversation = entry.server !== null;
      clients.delete(entry);
      if (entry.server) void entry.server.close().catch(() => undefined);
      if (wasConversation) armIdle();
    });
  }

  // ── Listen. One daemon per endpoint: losing the race is not an error. ──
  const listen = () => new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    listener.once('error', onError);
    listener.listen(endpoint, () => { listener.off('error', onError); resolve(); });
  });
  const blocked = async (reason: string): Promise<never> => {
    log(`cannot own ${endpoint}: ${reason}`);
    await markBlocked(brainRoot, build, reason);
    throw new Error(`DAEMON_ENDPOINT_BLOCKED: ${reason}`);
  };

  let state!: DaemonState;
  const release = await acquireStartLock(brainRoot, build);
  // Somebody else is inside the same few lines right now: let them win.
  if (!release) throw new Error('DAEMON_ALREADY_RUNNING');
  try {
    try { await secureSocketDir(endpoint); } catch (err) { await blocked((err as Error).message); }
    try {
      await listen();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      const holder = await probe(endpoint);
      if (holder !== 'dead') {
        // Somebody answers. A daemon of this brain can prove it — give it the
        // moment it may need between listening and writing its state file.
        const until = Date.now() + PEER_PROOF_WAIT_MS;
        let proven = false;
        while (!proven && Date.now() < until) {
          const link = await connectDaemon(brainRoot, build, { checkConfig: false });
          if (link && link !== 'config-mismatch') { link.socket.destroy(); proven = true; break; }
          await new Promise(r => setTimeout(r, 200));
        }
        if (proven) throw new Error('DAEMON_ALREADY_RUNNING');
        await blocked('the endpoint is held by a process that does not prove it is a CRBRO daemon of this brain');
      }
      // Nobody answers and the name is taken: a socket file a crash left behind.
      try {
        if (process.platform !== 'win32') await fs.rm(endpoint, { force: true });
        await listen();
      } catch (again) {
        if ((again as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error('DAEMON_ALREADY_RUNNING');
        await blocked(`could not take over a dead endpoint: ${(again as Error).message}`);
      }
    }
    if (process.platform !== 'win32') {
      await fs.chmod(endpoint, 0o600).catch(() => undefined);
      try { const st = await fs.stat(endpoint); ownSocket = { dev: st.dev, ino: st.ino }; } catch { /* not a file we can name */ }
    }
    await clearBlocked(brainRoot, build);
    state = {
      protocol: DAEMON_PROTOCOL, pid: process.pid, version, build, endpoint, token,
      started: new Date().toISOString(), brain: brainRoot,
    };
    try {
      await writeState(brainRoot, state);
    } catch (err) {
      // Without its descriptor nobody can reach this daemon. Say so where it
      // will be read — the log, and the marker the waiting proxy checks — and
      // give the endpoint back, instead of leaving the proxy 12 s of silence.
      listener.close();
      await blocked(`could not write its descriptor: ${(err as Error).message}`);
    }
  } finally {
    await release();
  }
  log(`listening on ${endpoint} · ${state.version} (${build}) · brain ${brainRoot} · config ${config} · idle exit ${Math.round(idleMs / 60_000)} min`);
  trace('daemon listening', build, true);

  const warmTimer = setTimeout(() => { warmDue = true; warmUp(); }, WARMUP_DELAY_MS);
  warmTimer.unref();

  // What dead daemons left behind: descriptors nobody answers for, temporaries, stale locks.
  void pruneDaemonDir(brainRoot, { keep: build })
    .then(r => { if (r.removed.length) log(`removed from .daemon: ${r.removed.join(', ')}`); })
    .catch(() => undefined);

  listener.on('error', err => log(`listener error: ${err.message}`));
  armIdle();

  function stop(reason = 'stop'): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      log(`stopping: ${reason} · ${conversations()} conversation(s)`);
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(warmTimer);
      // The state file goes first: a client that arrives now must not find a token for a door that is closing.
      await removeState(brainRoot, build, process.pid);
      const listenerClosed = new Promise<void>(resolve => listener.close(() => resolve()));
      // Connections that are not conversations owe nobody anything.
      for (const c of clients) if (!c.transport) c.socket.destroy();
      // Calls already running finish (a crbro_learn writes neuron, synapses and
      // manifest: cutting it between them is a half-made write). New calls are
      // refused as never started, and the proxy sends them to whoever is next.
      const running = [...clients].reduce((n, c) => n + (c.transport?.inFlight() ?? 0), 0);
      if (running > 0) log(`stopping: waiting for ${running} call(s) to finish`);
      let drainTimer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        Promise.all([...clients].map(c => c.transport?.drain() ?? Promise.resolve())).then(() => 'drained'),
        new Promise<string>(r => { drainTimer = setTimeout(() => r('timeout'), STOP_DRAIN_MS); }),
      ]);
      clearTimeout(drainTimer);
      if (outcome === 'timeout') log(`stopping: calls still running after ${STOP_DRAIN_MS / 1000} s were cut`);
      for (const c of clients) c.socket.destroy();
      await listenerClosed;
      try { await engines.searchEngine.flush(); } catch (err) { log(`flush failed: ${(err as Error).message}`); }
      // Unlink only the socket we made. By now a replacement may be listening
      // on the same path, and removing ITS file would strand it: alive,
      // serving, and unreachable.
      if (ownSocket) {
        try {
          const st = await fs.stat(endpoint);
          if (st.dev === ownSocket.dev && st.ino === ownSocket.ino) await fs.rm(endpoint, { force: true });
        } catch { /* already gone */ }
      }
      resolveStopped(reason);
    })();
    return stopping;
  }

  return { endpoint, state, connections: conversations, stop, stopped };
}

/** `node dist/index.js --daemon`: run until idle, asked to stop, or signalled. */
export async function runDaemon(): Promise<void> {
  // A detached child inherits its parent's working directory, and on Windows a
  // process pins its cwd: the project folder a client was opened in could not
  // be renamed or deleted for as long as the daemon lived.
  try { process.chdir(path.parse(process.cwd()).root); } catch { /* stay where we are */ }

  const brainRoot = resolveBrainDir();
  traceStart(brainRoot, 'daemon');
  let handle: DaemonHandle;
  try {
    handle = await startDaemon();
  } catch (err) {
    const msg = (err as Error).message || '';
    // Somebody else won the race to be the daemon: exactly what should happen.
    if (msg === 'DAEMON_ALREADY_RUNNING') process.exit(0);
    if (msg.startsWith('DAEMON_ENDPOINT_BLOCKED')) process.exit(3);
    // Anything else: this process has no stderr anybody reads. Leave the
    // reason in daemon.log, and the marker that ends the proxy's wait at once.
    try {
      const log = await fileLogger(brainRoot);
      log(`could not start: ${(err as Error).stack || msg}`);
      await markBlocked(brainRoot, buildId(), `the daemon could not start: ${msg}`);
      await new Promise(r => setTimeout(r, 100));   // the log line is queued: let it land
    } catch { /* nothing more we can do */ }
    process.exit(1);
  }
  const bye = (reason: string) => { void handle.stop(reason).then(() => process.exit(0)); };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('uncaughtException', err => {
    void fileLogger(handle.state.brain).then(log => log(`uncaughtException: ${err.stack || err.message}`));
    bye('uncaughtException');
  });
  process.on('unhandledRejection', err => {
    void fileLogger(handle.state.brain).then(log => log(`unhandledRejection: ${(err as Error)?.stack || String(err)}`));
  });
  await handle.stopped;
  process.exit(0);
}
