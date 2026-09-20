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
import {
  DAEMON_PROTOCOL, buildId, packageVersion, endpointFor, daemonDir, newToken, newNonce,
  proof, sameProof, writeState, removeState, type DaemonState,
} from './endpoint.js';

const HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_MIN = 20;
const LOG_MAX_BYTES = 512 * 1024;

export interface DaemonHandle {
  endpoint: string;
  state: DaemonState;
  connections(): number;
  /** Flush, remove the state file, close every client. Resolves when done. */
  stop(reason?: string): Promise<void>;
  /** Resolves when the daemon has stopped, for whatever reason. */
  stopped: Promise<string>;
}

export interface DaemonOptions {
  /** Minutes with no client before it exits. 0 = never. Default 20, or CRBRO_DAEMON_IDLE_MIN. */
  idleMinutes?: number;
  /** Tests inject their own; production builds them here. */
  engines?: Engines;
  build?: string;
  log?: (line: string) => void;
}

function idleMinutes(opt?: number): number {
  if (opt !== undefined) return opt;
  const v = Number(process.env.CRBRO_DAEMON_IDLE_MIN);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_IDLE_MIN;
}

async function fileLogger(brainRoot: string): Promise<(line: string) => void> {
  const file = path.join(daemonDir(brainRoot), 'daemon.log');
  await fs.mkdir(daemonDir(brainRoot), { recursive: true, mode: 0o700 });
  try {
    if ((await fs.stat(file)).size > LOG_MAX_BYTES) await fs.rename(file, `${file}.1`);
  } catch { /* no log yet */ }
  return (line: string) => {
    void fs.appendFile(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`).catch(() => undefined);
  };
}

/** Is somebody already answering there? Distinguishes a live daemon from a socket file a crash left behind. */
function probe(endpoint: string): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect(endpoint);
    const done = (alive: boolean) => { s.destroy(); resolve(alive); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1500).unref();
  });
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const engines = options.engines ?? createEngines();
  const brainRoot = engines.brain.paths.root;
  const build = options.build ?? buildId();
  const endpoint = endpointFor(brainRoot, build);
  const log = options.log ?? await fileLogger(brainRoot);
  const token = newToken();
  const idleMs = idleMinutes(options.idleMinutes) * 60_000;

  await fs.mkdir(daemonDir(brainRoot), { recursive: true, mode: 0o700 });

  const clients = new Set<{ socket: net.Socket; server: McpServer | null }>();
  let idleTimer: NodeJS.Timeout | null = null;
  let stopping: Promise<void> | null = null;
  let resolveStopped!: (reason: string) => void;
  const stopped = new Promise<string>(r => { resolveStopped = r; });

  /** MCP clients, not sockets: a status probe or a half-done handshake is not a conversation. */
  const conversations = () => [...clients].filter(c => c.server !== null).length;

  const armIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (idleMs > 0 && clients.size === 0) {
      idleTimer = setTimeout(() => { void stop('idle'); }, idleMs);
      idleTimer.unref();
    }
  };

  const listener = net.createServer({ allowHalfOpen: false }, socket => { void accept(socket); });

  async function accept(socket: net.Socket): Promise<void> {
    const entry: { socket: net.Socket; server: McpServer | null } = { socket, server: null };
    clients.add(entry);
    armIdle();
    socket.setNoDelay(true);

    let stage: 'hello' | 'auth' | 'first' | 'mcp' | 'dead' = 'hello';
    let nonce = '';
    let transport: SocketServerTransport | null = null;
    const kill = (why: string) => {
      if (stage === 'dead') return;
      stage = 'dead';
      log(`connection refused: ${why}`);
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
        if (m?.crbro !== 'hello' || m.protocol !== DAEMON_PROTOCOL || typeof m.nonce !== 'string' || m.nonce.length < 16) {
          return kill('bad hello');
        }
        nonce = newNonce();
        say({ crbro: 'hello', protocol: DAEMON_PROTOCOL, version: packageVersion(), build, pid: process.pid, proof: proof(token, 'daemon', m.nonce), nonce });
        stage = 'auth';
        return;
      }
      if (stage === 'auth') {
        if (m?.crbro !== 'auth' || !sameProof(String(m.proof || ''), proof(token, 'client', nonce))) return kill('bad proof');
        clearTimeout(timer);
        say({ crbro: 'ready' });
        stage = 'first';
        return;
      }
      // stage === 'first': a control message, or the first MCP message.
      if (m?.crbro === 'control') {
        if (m.op === 'status') {
          say({ crbro: 'status', pid: process.pid, version: packageVersion(), build, brain: brainRoot, endpoint,
            connections: conversations(), uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1048576),
            semantic_vectors: engines.searchEngine.semanticCount(), idle_minutes: idleMs / 60_000 });
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
      const scope = { tally: newTally() };
      transport = new SocketServerTransport(socket, fn => sessionScope.run(scope, fn));
      const server = createServer(engines);
      entry.server = server;
      stage = 'mcp';
      transport.receive(line);   // queued: an `initialized` arriving in the same chunk must not overtake `initialize`
      server.connect(transport).then(() => transport!.open()).catch(err => kill(`server.connect failed: ${(err as Error).message}`));
    }, () => kill('line too long'));

    socket.on('data', chunk => reader.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
    socket.on('error', () => { /* 'close' follows */ });
    socket.on('close', () => {
      clearTimeout(timer);
      clients.delete(entry);
      if (entry.server) void entry.server.close().catch(() => undefined);
      armIdle();
    });
  }

  // ── Listen. One daemon per endpoint: losing the race is not an error. ──
  const listen = () => new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(endpoint, () => { listener.off('error', reject); resolve(); });
  });
  try {
    await listen();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    if (await probe(endpoint)) throw new Error('DAEMON_ALREADY_RUNNING');
    // A socket file nobody answers: a crash left it. Windows pipes vanish with their process.
    if (process.platform !== 'win32') await fs.rm(endpoint, { force: true });
    await listen();
  }
  if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600).catch(() => undefined);

  const state: DaemonState = {
    protocol: DAEMON_PROTOCOL, pid: process.pid, version: packageVersion(), build, endpoint, token,
    started: new Date().toISOString(), brain: brainRoot,
  };
  await writeState(brainRoot, state);
  log(`listening on ${endpoint} · ${state.version} (${build}) · brain ${brainRoot} · idle exit ${idleMs / 60_000} min`);

  // The index and the model warm up now, off anybody's critical path: the
  // first client to boot finds them ready, the second never waits at all.
  void engines.searchEngine.init().catch(err => log(`index warm-up failed: ${(err as Error).message}`));

  listener.on('error', err => log(`listener error: ${err.message}`));
  armIdle();

  function stop(reason = 'stop'): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      log(`stopping: ${reason} · ${clients.size} client(s)`);
      if (idleTimer) clearTimeout(idleTimer);
      // The state file goes first: a client that arrives now must not find a token for a door that is closing.
      await removeState(brainRoot, build, process.pid);
      await new Promise<void>(resolve => { listener.close(() => resolve()); for (const c of clients) c.socket.destroy(); });
      try { await engines.searchEngine.flush(); } catch (err) { log(`flush failed: ${(err as Error).message}`); }
      if (process.platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => undefined);
      resolveStopped(reason);
    })();
    return stopping;
  }

  return { endpoint, state, connections: conversations, stop, stopped };
}

/** `node dist/index.js --daemon`: run until idle, asked to stop, or signalled. */
export async function runDaemon(): Promise<void> {
  let handle: DaemonHandle;
  try {
    handle = await startDaemon();
  } catch (err) {
    // Somebody else won the race to be the daemon: exactly what should happen.
    if ((err as Error).message === 'DAEMON_ALREADY_RUNNING') process.exit(0);
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
