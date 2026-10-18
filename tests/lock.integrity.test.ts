import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { withLock, withLockSync, sweepStaleLocks } from '../src/utils/lock.js';

let dir: string;
let target: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-lock-integrity-'));
  target = path.join(dir, 'data.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

async function ownerRecord(owner: string, age = 60_000) {
  await fs.writeFile(`${target}.lock`, owner);
  const date = new Date(Date.now() - age);
  await fs.utimes(`${target}.lock`, date, date);
}

// Advance only the deadline clock; filesystem timestamps and real IO stay real.
function expireDeadline() {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 20_000));
}

describe('lock integrity', () => {
  it('fails closed on timeout without running the callback', async () => {
    await ownerRecord(`${process.pid} live`, -3_600_000);
    expireDeadline();
    let entered = false;
    await expect(withLock(target, async () => { entered = true; })).rejects.toThrow(/lock|timed out/i);
    expect(entered).toBe(false);
    expect(await fs.readFile(`${target}.lock`, 'utf8')).toBe(`${process.pid} live`);
  });

  it('does not steal an old lock from a live owner', async () => {
    await ownerRecord(`${process.pid} live`);
    expireDeadline();
    let entered = false;
    await expect(withLock(target, async () => { entered = true; })).rejects.toThrow();
    expect(entered).toBe(false);
    expect(await fs.readFile(`${target}.lock`, 'utf8')).toBe(`${process.pid} live`);
  });

  it('maintenance keeps old live locks', async () => {
    await ownerRecord(`${process.pid} live`);
    expect(await sweepStaleLocks(dir)).toBe(0);
    expect(await fs.readFile(`${target}.lock`, 'utf8')).toBe(`${process.pid} live`);
  });

  it('maintenance keeps an owner whose liveness cannot be established', async () => {
    await ownerRecord(`${process.pid} unknown`);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    expect(await sweepStaleLocks(dir)).toBe(0);
    expect(await fs.readFile(`${target}.lock`, 'utf8')).toBe(`${process.pid} unknown`);
  });

  it('keeps malformed locks instead of guessing that their owner died', async () => {
    await ownerRecord('incomplete owner');
    expect(await sweepStaleLocks(dir)).toBe(0);
    expireDeadline();
    await expect(withLock(target, async () => 'unsafe')).rejects.toThrow();
  });

  it('release leaves a replacement owned by another acquisition intact', async () => {
    await withLock(target, async () => {
      await fs.unlink(`${target}.lock`);
      await fs.writeFile(`${target}.lock`, `${process.pid} replacement`);
    });
    expect(await fs.readFile(`${target}.lock`, 'utf8')).toBe(`${process.pid} replacement`);
  });

  it('reclaims a confirmed dead owner once even when maintenance races', async () => {
    const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    expect(child.status).toBe(0);
    await ownerRecord(`${child.pid} dead`);
    const counts = await Promise.all([sweepStaleLocks(dir), sweepStaleLocks(dir)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await withLock(target, async () => 'safe')).toBe('safe');
  });

  it('keeps mutual exclusion for racing writers and releases after exceptions', async () => {
    await fs.writeFile(target, '0');
    await Promise.all(Array.from({ length: 8 }, () => withLock(target, async () => {
      const n = Number(await fs.readFile(target, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 2));
      await fs.writeFile(target, String(n + 1));
    })));
    expect(await fs.readFile(target, 'utf8')).toBe('8');
    await expect(withLock(target, async () => { throw new Error('fixture'); })).rejects.toThrow('fixture');
    expect(await withLock(target, async () => 'released')).toBe('released');
    expect(await fs.readdir(dir)).toEqual(['data.json']);
  });

  it('synchronous callers fail closed on a live lock too', async () => {
    await ownerRecord(`${process.pid} live`);
    expireDeadline();
    let entered = false;
    expect(() => withLockSync(target, () => { entered = true; })).toThrow(/lock|timed out/i);
    expect(entered).toBe(false);
  });

  it('recovers a dead owner during acquisition without needing maintenance', async () => {
    const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    expect(child.status).toBe(0);
    await ownerRecord(`${child.pid} dead`);
    expect(withLockSync(target, () => 'recovered')).toBe('recovered');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('an abandoned guard blocks both acquisition and cleanup rather than risking a race', async () => {
    const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    expect(child.status).toBe(0);
    await ownerRecord(`${child.pid} dead`);
    await fs.writeFile(`${target}.lock.guard`, '');
    expireDeadline();
    expect(await sweepStaleLocks(dir)).toBe(0);
    await expect(withLock(target, async () => 'unsafe')).rejects.toThrow();
    expect(() => withLockSync(target, () => 'unsafe')).toThrow();
    expect(await fs.readFile(`${target}.lock`, 'utf8')).toBe(`${child.pid} dead`);
  });
});
