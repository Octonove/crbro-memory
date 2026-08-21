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

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** How long a lock may be held before we assume its owner died. */
const STALE_MS = 10_000;
/** How long to keep trying before giving up. */
const TIMEOUT_MS = 15_000;
/** Wait between attempts. Grows a little to avoid a stampede. */
const RETRY_MIN_MS = 8;
const RETRY_MAX_MS = 60;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function lockPath(target: string): string {
  return `${target}.lock`;
}

/**
 * Take the lock for a file. Returns a release function.
 *
 * `wx` fails if the file already exists, and that failure is the whole
 * mechanism: exactly one caller can create it.
 */
async function acquire(target: string): Promise<() => Promise<void>> {
  const lock = lockPath(target);
  await fs.mkdir(path.dirname(lock), { recursive: true });

  const deadline = Date.now() + TIMEOUT_MS;
  let wait = RETRY_MIN_MS;

  for (;;) {
    try {
      const fh = await fs.open(lock, 'wx');
      await fh.writeFile(`${process.pid} ${new Date().toISOString()}`, 'utf-8');
      await fh.close();
      return async () => {
        try {
          await fs.unlink(lock);
        } catch {
          // Already gone: released twice, or cleaned up as stale. Harmless.
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw err;

      // Someone holds it. If they have held it far too long, they are gone.
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          await fs.unlink(lock).catch(() => { /* someone else got there first */ });
          continue;
        }
      } catch {
        continue; // Vanished between the failure and the stat: try again.
      }

      if (Date.now() > deadline) {
        // Never block a write forever. Losing the lock is bad; hanging the
        // assistant is worse, and the stale sweep above makes this rare.
        return async () => { /* nothing to release */ };
      }

      await sleep(wait);
      wait = Math.min(Math.round(wait * 1.4), RETRY_MAX_MS);
    }
  }
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
        const st = await fs.stat(p);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          await fs.unlink(p);
          swept++;
        }
      } catch { /* gone already */ }
    }
  } catch { /* no such directory */ }
  return swept;
}
