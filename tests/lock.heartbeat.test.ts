// 2.11 locks (G14): a reused PID no longer keeps a dead async lock alive, a
// transient EPERM on release is retried, and a timeout says who holds it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) };
});

const { withLock, sweepStaleLocks } = await import('../src/utils/lock.js');

let dir: string;
let target: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-lock-hb-'));
  target = path.join(dir, 'data.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

async function record(owner: string, ageMs: number) {
  await fs.writeFile(`${target}.lock`, owner);
  const d = new Date(Date.now() - ageMs);
  await fs.utimes(`${target}.lock`, d, d);
}

describe('heartbeat', () => {
  it('an async holder marks its record and keeps it fresh', async () => {
    await withLock(target, async () => {
      const rec = await fs.readFile(`${target}.lock`, 'utf8');
      expect(rec).toMatch(new RegExp(`^${process.pid} \\S+ \\S+ hb$`));
    });
  });

  it('a heartbeat lock silent for minutes is reclaimed even though its PID is alive (PID reuse)', async () => {
    // process.pid is alive: the 2.10 rule would wait for ever.
    await record(`${process.pid} 00000000-0000-0000-0000-000000000000 2026-11-13T00:00:00.000Z hb`, 10 * 60_000);
    expect(await withLock(target, async () => 'reclaimed')).toBe('reclaimed');
  });

  it('an unmarked record with a live PID is still never stolen', async () => {
    await record(`${process.pid} 00000000-0000-0000-0000-000000000000 2026-11-13T00:00:00.000Z`, 10 * 60_000);
    expect(await sweepStaleLocks(dir)).toBe(0);
    expect(await fs.readFile(`${target}.lock`, 'utf8')).toMatch(/Z$/);
  });
});

describe('release and timeouts', () => {
  it('a transient EPERM on release is retried instead of failing after the work', async () => {
    const real = (await vi.importActual<typeof import('node:fs')>('node:fs')).unlinkSync;
    let fallos = 2;
    vi.mocked(fsSync.unlinkSync).mockImplementation(p => {
      if (String(p).endsWith('.lock') && fallos-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return real(p);
    });
    expect(await withLock(target, async () => 'done')).toBe('done');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('the timeout message names the holder and the way out', async () => {
    await record(`${process.pid} live`, 0);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 20_000));
    await expect(withLock(target, async () => 'x')).rejects.toThrow(new RegExp(`held by PID ${process.pid}.*delete`));
  });

  it('maintenance clears a guard left by a crash long ago, never a fresh one', async () => {
    await fs.writeFile(`${target}.lock.guard`, '');
    expect(await sweepStaleLocks(dir)).toBe(0);
    const old = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(`${target}.lock.guard`, old, old);
    expect(await sweepStaleLocks(dir)).toBe(1);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
