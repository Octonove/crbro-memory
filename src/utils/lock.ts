// ─── CRBRO File Locking ──────────────────────────────────────────
//
// Why this exists, measured on the real thing: two processes each storing 40
// facts into the same neuron asked for 80 and kept 42. Neither reported an
// error. Every write path reads the whole neuron, changes it in memory and
// writes it back, so whoever saves last silently erases whatever the other one
// did in between. With CRBRO registered at user level — which the README
// recommends — two editors open at once is the normal case, not an edge case.
//
// An advisory lock file is enough here. All writers are CRBRO itself, the
// critical section is a few milliseconds, and the alternative (an OS-level
// lock) behaves differently on every platform and cannot be made to wait
// politely on Windows.

import { promises as fs, openSync, closeSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Minimum age before checking whether a lock's owner died. Age alone is never proof. */
const STALE_MS = 10_000;
/** How long to keep trying before giving up. */
const TIMEOUT_MS = 15_000;
/** Wait between attempts. Grows a little to avoid a stampede. */
const RETRY_MIN_MS = 8;
const RETRY_MAX_MS = 60;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function lockPath(target: string): string {
  return `${target}.lock`;
}

function contended(err: unknown): boolean {
  return ['EEXIST', 'EPERM', 'EBUSY'].includes((err as NodeJS.ErrnoException)?.code ?? '');
}

/**
 * Serialize the short filesystem operations, including reaping and release.
 * Checking a token then unlinking without this guard is a TOCTOU race: another
 * reaper could remove the old lock and a writer acquire its replacement.
 * No await or user code runs here. A guard left by a crash is deliberately NOT
 * stolen: callers time out, requiring offline cleanup rather than risking data.
 */
function guarded<T>(lock: string, fn: () => T): { value: T } | undefined {
  const guard = `${lock}.guard`;
  let fd: number;
  try {
    fd = openSync(guard, 'wx', 0o600);
  } catch (err) {
    if (contended(err)) return undefined;
    throw err;
  }
  try {
    return { value: fn() };
  } finally {
    closeSync(fd);
    unlinkSync(guard);
  }
}

// Called only under the guard. Legacy records start with the PID too.
function reapDead(lock: string): boolean {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= STALE_MS) return false;
    const match = /^(\d+)\s/.exec(readFileSync(lock, 'utf8'));
    const pid = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      // EPERM and unknown failures do not establish that a process is dead.
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
    unlinkSync(lock);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function tryAcquire(lock: string, owner: string): boolean {
  return guarded(lock, () => {
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (err) {
      if (!contended(err)) throw err;
      reapDead(lock);
      return false;
    }
    try {
      writeFileSync(fd, owner, 'utf8');
    } catch (err) {
      closeSync(fd);
      unlinkSync(lock);
      throw err;
    }
    closeSync(fd);
    return true;
  })?.value ?? false;
}

function tryRelease(lock: string, owner: string): boolean {
  return guarded(lock, () => {
    try {
      if (readFileSync(lock, 'utf8') === owner) unlinkSync(lock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return true;
  })?.value ?? false;
}

function checkDeadline(deadline: number, lock: string): void {
  if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock: ${lock}`);
}

async function waitFor(attempt: () => boolean, lock: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let wait = RETRY_MIN_MS;
  while (!attempt()) {
    checkDeadline(deadline, lock);
    await sleep(wait);
    wait = Math.min(Math.round(wait * 1.4), RETRY_MAX_MS);
  }
}

function waitForSync(attempt: () => boolean, lock: string): void {
  const deadline = Date.now() + TIMEOUT_MS;
  let wait = RETRY_MIN_MS;
  while (!attempt()) {
    checkDeadline(deadline, lock);
    Atomics.wait(sleeper, 0, 0, wait);
    wait = Math.min(Math.round(wait * 1.4), RETRY_MAX_MS);
  }
}

async function acquire(target: string): Promise<() => Promise<void>> {
  const lock = lockPath(target);
  mkdirSync(path.dirname(lock), { recursive: true });
  const owner = `${process.pid} ${randomUUID()} ${new Date().toISOString()}`;
  await waitFor(() => tryAcquire(lock, owner), lock);
  return () => waitFor(() => tryRelease(lock, owner), lock);
}

/**
 * Run `fn` while holding the lock for `target`.
 * The lock is always released, including when `fn` throws.
 */
export async function withLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquire(target);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** Same cross-process protocol for synchronous APIs such as the DPAPI broker. */
export function withLockSync<T>(target: string, fn: () => T): T {
  const lock = lockPath(target);
  mkdirSync(path.dirname(lock), { recursive: true });
  const owner = `${process.pid} ${randomUUID()} ${new Date().toISOString()}`;
  waitForSync(() => tryAcquire(lock, owner), lock);
  try {
    return fn();
  } finally {
    waitForSync(() => tryRelease(lock, owner), lock);
  }
}

/**
 * Remove lock files left behind by a process that died mid-write.
 * Returns how many were swept. Called from maintenance.
 */
export async function sweepStaleLocks(dir: string): Promise<number> {
  let swept = 0;
  try {
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.lock')) continue;
      const p = path.join(dir, f);
      try {
        if (guarded(p, () => reapDead(p))?.value) swept++;
      } catch { /* inaccessible or gone already: leave it alone */ }
    }
  } catch { /* no such directory */ }
  return swept;
}
