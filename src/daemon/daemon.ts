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
  acquireStartLock, markBlocked, clearBlocked, type DaemonState,
} from './endpoint.js';

const HANDSHAKE_TIMEOUT_MS = 5_000;
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

  await fs.mkdir(daemonDir(brainRoot), { recursive: true, mode: 0o700 });

  type Entry = { socket: net.Socket; server: McpServer | null };
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

  const listener = net.createServer({ allowHalfOpen: false }, socket => { accept(socket); });

  function accept(socket: net.Socket): void {
    const entry: Entry = { socket, server: null };
    clients.add(entry);
    socket.setNoDelay(true);

    let stage: 'hello' | 'auth' | 'first' | 'mcp' | 'dead' = 'hello';
    let nonce = '';
    let resumed = false;
    let transport: SocketServerTransport | null = null;
    const kill = (why: string) => {
      if (stage === 'dead') return;
      stage = 'dead';
      logRefusal(why);
      socket.destroy();
    };
    const timer = setTimeout(() => { if (stage !== 'mcp') kill('handshake timeout'); }, HANDSHAKE_TIMEOUT_MS);
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
        say({ crbro: 'hello', protocol: DAEMON_PROTOCOL, version: packageVersion(), build, pid: process.pid, config, proof: proof(token, 'daemon', m.nonce), nonce });
        stage = 'auth';
        return;
      }
      if (stage === 'auth') {
        if (m?.crbro !== 'auth' || !sameProof(String(m.proof || ''), proof(token, 'client', nonce))) return kill('bad proof');
        resumed = m.resumed === true;
        say({ crbro: 'ready' });
        stage = 'first';
        return;
      }
      // stage === 'first': a control message, or the first MCP message.
      if (m?.crbro === 'control') {
        clearTimeout(timer);
        if (m.op === 'status') {
          say({ crbro: 'status', pid: process.pid, version: packageVersion(), build, brain: brainRoot, endpoint, config,
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
      stage = 'mcp';
      armIdle();
      transport.receive(line);   // queued: an `initialized` arriving in the same chunk must not overtake `initialize`
      server.connect(transport).then(() => transport!.open()).catch(err => kill(`server.connect failed: ${(err as Error).message}`));
    }, () => kill('line too long'));

    socket.on('data', chunk => reader.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
    socket.on('error', () => { /* 'close' follows */ });
    socket.on('close', () => {
      clearTimeout(timer);
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
      protocol: DAEMON_PROTOCOL, pid: process.pid, version: packageVersion(), build, endpoint, token,
      started: new Date().toISOString(), brain: brainRoot,
    };
    await writeState(brainRoot, state);
  } finally {
    await release();
  }
  log(`listening on ${endpoint} · ${state.version} (${build}) · brain ${brainRoot} · config ${config} · idle exit ${Math.round(idleMs / 60_000)} min`);

  // The index and the model warm up now, off anybody's critical path: the
  // first client to boot finds them ready, the second never waits at all.
  void engines.searchEngine.init().catch(err => log(`index warm-up failed: ${(err as Error).message}`));

  listener.on('error', err => log(`listener error: ${err.message}`));
  armIdle();

  function stop(reason = 'stop'): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      log(`stopping: ${reason} · ${conversations()} conversation(s)`);
      if (idleTimer) clearTimeout(idleTimer);
      // The state file goes first: a client that arrives now must not find a token for a door that is closing.
      await removeState(brainRoot, build, process.pid);
      await new Promise<void>(resolve => { listener.close(() => resolve()); for (const c of clients) c.socket.destroy(); });
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

  let handle: DaemonHandle;
  try {
    handle = await startDaemon();
  } catch (err) {
    const msg = (err as Error).message || '';
    // Somebody else won the race to be the daemon: exactly what should happen.
    if (msg === 'DAEMON_ALREADY_RUNNING') process.exit(0);
    if (msg.startsWith('DAEMON_ENDPOINT_BLOCKED')) process.exit(3);
    throw err;
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
