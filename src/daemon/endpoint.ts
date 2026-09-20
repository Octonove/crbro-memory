// ─── Where the daemon lives, and how a client proves who it is ────
//
// One brain, one build, one endpoint. The name is derived, never configured:
// every client of the same brain running the same build computes the same
// pipe (Windows) or socket (elsewhere) and therefore finds the same daemon —
// and a client on ANOTHER build computes a different one and gets its own,
// so "the process keeps the version it started with" stays true and an
// upgrade never has to kill anything: the old daemon drains and exits idle.
//
// Trust is a shared secret on disk. The daemon writes a random token to
// <brain>/.daemon/<id>.json, readable by the owner only; a client reads it
// and both sides prove knowledge of it with an HMAC over a fresh nonce.
// That covers the two ways a local socket goes wrong: another user of the
// machine connecting to it, and another process squatting the name first
// and collecting what clients send.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs, statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DAEMON_PROTOCOL = 1;
const DAEMON_DIR = '.daemon';
const ENABLED_FLAG = 'enabled';

export interface DaemonState {
  protocol: number;
  pid: number;
  version: string;
  build: string;
  endpoint: string;
  token: string;
  started: string;
  brain: string;
}

export function packageVersion(): string {
  try {
    const here = __dirname;   // CommonJS output: dist/daemon, or src/daemon under the test runner
    for (const up of ['..', path.join('..', '..')]) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(here, up, 'package.json'), 'utf8'));
        if (pkg?.name === 'crbro-memory' && pkg.version) return String(pkg.version);
      } catch { /* try the next level */ }
    }
  } catch { /* fall through */ }
  return '0.0.0';
}

/**
 * Version plus the build's own timestamp. The version alone would let a
 * developer's half-built dist serve the clients that launched the published
 * package; the timestamp alone would not survive a reinstall of the same
 * release on another path. Together: you are served by the code you launched.
 */
export function buildId(): string {
  let stamp = '0';
  try {
    const here = __dirname;   // CommonJS output: dist/daemon, or src/daemon under the test runner
    for (const f of ['../server.js', '../server.ts']) {
      try { stamp = Math.floor(statSync(path.join(here, f)).mtimeMs).toString(36); break; } catch { /* next */ }
    }
  } catch { /* keep 0 */ }
  return `${packageVersion()}-${stamp}`;
}

export function daemonDir(brainRoot: string): string {
  return path.join(brainRoot, DAEMON_DIR);
}

function endpointKey(brainRoot: string, build: string): string {
  const root = path.resolve(brainRoot);
  const canon = process.platform === 'win32' ? root.toLowerCase() : root;
  return createHash('sha256').update(`${canon}|${build}`).digest('hex').slice(0, 16);
}

/** The pipe or socket path for this brain and build. */
export function endpointFor(brainRoot: string, build: string = buildId()): string {
  const key = endpointKey(brainRoot, build);
  if (process.platform === 'win32') return `\\\\.\\pipe\\crbro-${key}`;
  const inBrain = path.join(daemonDir(brainRoot), `${key}.sock`);
  // sun_path is ~104 bytes on macOS and 108 on Linux: a deep brain path falls back to tmp —
  // into a folder of this user's own, because tmp itself is everybody's.
  return Buffer.byteLength(inBrain) < 100 ? inBrain : path.join(privateTmpDir(), `${key}.sock`);
}

/** <tmp>/crbro-<uid>: where the socket goes when the brain path is too long for one. */
export function privateTmpDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  return path.join(os.tmpdir(), `crbro-${uid}`);
}

/**
 * Make the socket's folder and make sure it is ours alone. In the brain that
 * is a given; in tmp somebody else may have made `crbro-<our uid>` first, as a
 * folder they own or as a link to one — and a socket placed there is theirs.
 */
export async function secureSocketDir(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dir = path.dirname(endpoint);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(dir);
  const mine = typeof process.getuid !== 'function' || st.uid === process.getuid();
  if (!st.isDirectory() || st.isSymbolicLink() || !mine || (st.mode & 0o077) !== 0) {
    if (mine && st.isDirectory() && !st.isSymbolicLink()) { await fs.chmod(dir, 0o700); return; }
    throw new Error(`DAEMON_ENDPOINT_BLOCKED: ${dir} is not a private folder of this user`);
  }
}

export function stateFile(brainRoot: string, build: string = buildId()): string {
  return path.join(daemonDir(brainRoot), `${endpointKey(brainRoot, build)}.json`);
}

/**
 * What a daemon would do differently from the client asking for it. One
 * process serves every client, but each client was configured on its own —
 * CRBRO_BACKUP_DIR pointing at a synced folder in one, CRBRO_SEMANTIC=0 in
 * another — and whose settings win must not depend on who happened to start
 * first. A client whose fingerprint differs from the daemon's serves itself,
 * exactly as it did before daemons: its settings keep meaning what they said.
 */
export function configFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const v = (k: string) => (env[k] || '').trim();
  const semantic = ['0', 'off', 'false', 'no'].includes(v('CRBRO_SEMANTIC').toLowerCase()) ? 'off'
    : ['1', 'on', 'true', 'yes', 'force'].includes(v('CRBRO_SEMANTIC').toLowerCase()) ? 'on' : 'auto';
  const parts = [
    semantic, v('CRBRO_SEMANTIC_MODEL'), v('CRBRO_SEMANTIC_DTYPE'), v('CRBRO_SEMANTIC_HOME'), v('CRBRO_SEMANTIC_FLOOR'),
    v('CRBRO_RECENCY'), v('CRBRO_SYNONYMS'), v('CRBRO_AUTOBACKUP') === '0' ? 'nobackup' : '', v('CRBRO_BACKUP_DIR'),
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 12);
}

// ─── Two small files that keep start-up honest ───────────────────

/** Written by a daemon that found its endpoint held by something that is not a CRBRO daemon of this brain. */
export function blockedFile(brainRoot: string, build: string = buildId()): string {
  return path.join(daemonDir(brainRoot), `${endpointKey(brainRoot, build)}.blocked`);
}

export async function markBlocked(brainRoot: string, build: string, reason: string): Promise<void> {
  try {
    await fs.mkdir(daemonDir(brainRoot), { recursive: true, mode: 0o700 });
    await fs.writeFile(blockedFile(brainRoot, build), JSON.stringify({ pid: process.pid, at: Date.now(), reason }));
  } catch { /* the marker is a courtesy to the proxy's patience */ }
}

/** A marker newer than `since` (ms): the daemon we just asked for could not be had, and waiting will not change it. */
export async function blockedSince(brainRoot: string, build: string, since: number): Promise<string | null> {
  try {
    const m = JSON.parse(await fs.readFile(blockedFile(brainRoot, build), 'utf8'));
    return typeof m?.at === 'number' && m.at >= since ? String(m.reason || 'blocked') : null;
  } catch {
    return null;
  }
}

export async function clearBlocked(brainRoot: string, build: string): Promise<void> {
  await fs.rm(blockedFile(brainRoot, build), { force: true }).catch(() => undefined);
}

const START_LOCK_STALE_MS = 10_000;

/**
 * One daemon at a time through the dangerous part of starting: finding the
 * endpoint busy, deciding the holder is dead, unlinking its socket, listening.
 * Two starters doing that interleaved can each delete the other's live socket.
 * The lock names its holder, so a starter that was killed does not hold it forever.
 */
export async function acquireStartLock(brainRoot: string, build: string): Promise<(() => Promise<void>) | null> {
  const file = path.join(daemonDir(brainRoot), `${endpointKey(brainRoot, build)}.lock`);
  await fs.mkdir(daemonDir(brainRoot), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await fs.open(file, 'wx', 0o600);
      await h.writeFile(String(process.pid));
      await h.close();
      return async () => { await fs.rm(file, { force: true }).catch(() => undefined); };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const st = await fs.stat(file);
        const pid = Number((await fs.readFile(file, 'utf8')).trim());
        let alive = true;
        try { if (pid > 0) process.kill(pid, 0); else alive = false; } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; }
        stale = !alive || Date.now() - st.mtimeMs > START_LOCK_STALE_MS;
      } catch { stale = true; }
      if (!stale) return null;
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }
  return null;
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export async function writeState(brainRoot: string, state: DaemonState): Promise<void> {
  const dir = daemonDir(brainRoot);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = stateFile(brainRoot, state.build);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function readState(brainRoot: string, build: string = buildId()): Promise<DaemonState | null> {
  try {
    const s = JSON.parse(await fs.readFile(stateFile(brainRoot, build), 'utf8')) as DaemonState;
    return s && s.protocol === DAEMON_PROTOCOL && typeof s.token === 'string' && s.token.length >= 32 ? s : null;
  } catch {
    return null;
  }
}

export async function removeState(brainRoot: string, build: string, pid: number): Promise<void> {
  // Only our own: a newer daemon of the same build may have replaced the file already.
  const s = await readState(brainRoot, build);
  if (s && s.pid !== pid) return;
  await fs.rm(stateFile(brainRoot, build), { force: true }).catch(() => undefined);
}

/** Every daemon that left a state file for this brain, whatever its build. */
export async function listStates(brainRoot: string): Promise<DaemonState[]> {
  const out: DaemonState[] = [];
  try {
    for (const f of await fs.readdir(daemonDir(brainRoot))) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(await fs.readFile(path.join(daemonDir(brainRoot), f), 'utf8')) as DaemonState;
        if (s?.protocol === DAEMON_PROTOCOL && s.endpoint) out.push(s);
      } catch { /* a half-written file is not a daemon */ }
    }
  } catch { /* no folder, no daemons */ }
  return out;
}

export function proof(token: string, role: 'daemon' | 'client', nonce: string): string {
  return createHmac('sha256', token).update(`${role}:${nonce}`).digest('hex');
}

export function sameProof(a: string, b: string): boolean {
  const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

// ─── On or off ───────────────────────────────────────────────────
//
// A flag in the brain, not an environment variable: the environment would
// have to be set in every client's config, and the point is that every client
// of this brain switches together. CRBRO_DAEMON=1 / =0 still wins for one
// process — for a test, or to keep one client out.

export function daemonEnabled(brainRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['CRBRO_DAEMON'] || '').trim();
  if (v === '1') return true;
  if (v === '0') return false;
  try { statSync(path.join(daemonDir(brainRoot), ENABLED_FLAG)); return true; } catch { return false; }
}

export async function setDaemonEnabled(brainRoot: string, on: boolean): Promise<void> {
  const flag = path.join(daemonDir(brainRoot), ENABLED_FLAG);
  if (on) {
    await fs.mkdir(daemonDir(brainRoot), { recursive: true, mode: 0o700 });
    await fs.writeFile(flag, `${new Date().toISOString()}\n`);
  } else {
    await fs.rm(flag, { force: true });
  }
}
