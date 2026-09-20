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
  // sun_path is ~104 bytes on macOS and 108 on Linux: a deep brain path falls back to tmp.
  return Buffer.byteLength(inBrain) < 100 ? inBrain : path.join(os.tmpdir(), `crbro-${key}.sock`);
}

export function stateFile(brainRoot: string, build: string = buildId()): string {
  return path.join(daemonDir(brainRoot), `${endpointKey(brainRoot, build)}.json`);
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
