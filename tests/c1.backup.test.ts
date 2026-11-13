// ─── 2.11: backups that cannot eat themselves ────────────────────
//
// Reproduced on a copy of a real brain (2.10.0): `backup --keep siete` took
// the folder from 2 copies to 0 — NaN reached slice() and every file went,
// the one just written included. A copy dated in the future (a clock set
// ahead once) blocked automatic copies and got the good ones rotated first.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { BrainPaths } from '../src/engine/brain.js';
import {
  createBackup, listBackups, readBackup, autoBackupIfDue, retainedBackups, validateKeep, type BackupInfo,
} from '../src/engine/backup.js';

let root: string;
let brainDir: string;
let backupDir: string;

async function put(rel: string, content: string) {
  const f = path.join(brainDir, rel);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, content, 'utf8');
}

const names = async () => (await fs.readdir(backupDir).catch(() => [] as string[])).filter(n => n.startsWith('brain-')).sort();

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-c1-backup-'));
  brainDir = path.join(root, 'brain');
  backupDir = path.join(root, 'backups');
  await put('manifest.json', '{"version":"1.0.0"}');
  await put('cortex/project_a.json', JSON.stringify({ id: 'project_a', facts: [] }));
  await put('hippocampus/session_2026-09-20.json', '{"summary":"hoy"}');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('--keep is a whole number of at least 1', () => {
  it('refuses "siete", 0, -1, 1.5 and NaN and leaves every copy where it was', async () => {
    const paths = new BrainPaths(brainDir);
    await createBackup(paths, { dir: backupDir, now: new Date('2026-11-01T10:00:00Z') });
    await createBackup(paths, { dir: backupDir, now: new Date('2026-11-02T10:00:00Z') });
    expect(await names()).toHaveLength(2);
    for (const bad of ['siete', 0, -1, 1.5, Number('siete')]) {
      await expect(createBackup(paths, { dir: backupDir, keep: bad as number })).rejects.toThrow(/--keep must be a whole number/);
    }
    expect(await names()).toHaveLength(2);
    expect(validateKeep(3)).toBe(3);
  });

  it('the CLI refuses `backup --keep siete` with exit 1 and deletes nothing', async () => {
    const paths = new BrainPaths(brainDir);
    await createBackup(paths, { dir: backupDir, now: new Date('2026-11-01T10:00:00Z') });
    await createBackup(paths, { dir: backupDir, now: new Date('2026-11-02T10:00:00Z') });
    const env = { ...process.env, CRBRO_PATH: brainDir, CRBRO_BACKUP_DIR: backupDir, HOME: root, USERPROFILE: root,
      CRBRO_KEYS_DIR: path.join(root, 'keys'), CRBRO_MOD: '0', CRBRO_AUTOBACKUP: '0' };
    for (const argv of [['--keep', 'siete'], ['--keep', '--dir', backupDir], ['--keep']]) {
      const r = await new Promise<{ code: number; out: string }>(resolve => execFile(process.execPath,
        [path.resolve('bin/crbro.mjs'), 'backup', ...argv], { env, timeout: 30_000, windowsHide: true },
        (err, stdout, stderr) => resolve({ code: err ? Number((err as NodeJS.ErrnoException).code) || 1 : 0, out: stdout + stderr })));
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/--keep must be a whole number/);
    }
    expect(await names()).toHaveLength(2);
  }, 60_000);
});

describe('rotation', () => {
  it('never rotates the copy it just wrote, even with keep 1', async () => {
    const paths = new BrainPaths(brainDir);
    await createBackup(paths, { dir: backupDir, now: new Date('2026-11-01T10:00:00Z') });
    const r = await createBackup(paths, { dir: backupDir, keep: 1, now: new Date('2026-11-02T10:00:00Z'), retention: { daily: 1, weekly: 0, monthly: 0 } });
    expect(r.verified).toBe(true);
    expect(await names()).toEqual([r.file]);
  });

  it('a future-dated copy does not count as the newest: automatic copies go on and the good ones stay', async () => {
    const paths = new BrainPaths(brainDir);
    const now = new Date('2026-11-13T10:00:00Z');
    await createBackup(paths, { dir: backupDir, now: new Date('2026-11-10T10:00:00Z') });
    await createBackup(paths, { dir: backupDir, now: new Date('2026-11-11T10:00:00Z') });
    // Written once by a clock set years ahead: name and file date both in 2099.
    const f = await createBackup(paths, { dir: backupDir, now: new Date('2099-01-01T00:00:00Z') });
    await fs.utimes(f.path, new Date('2099-01-01T00:00:00Z'), new Date('2099-01-01T00:00:00Z'));
    const listed = await listBackups(backupDir, now);
    const futura = listed.find(b => b.file.startsWith('brain-2099'))!;
    expect(futura.future_dated).toBe(true);
    expect(listed[0].file.startsWith('brain-2099')).toBe(false);

    const auto = await autoBackupIfDue(paths, { dir: backupDir, now, env: {} });
    expect(auto.made).toBe(true);
    const despues = await names();
    expect(despues).toContain('brain-20261110-100000.json.gz');
    expect(despues).toContain('brain-20261111-100000.json.gz');
    expect(despues).toContain(auto.file);
  });

  it('is tiered: daily, weekly and monthly copies reach months back', async () => {
    const paths = new BrainPaths(brainDir);
    const inicio = Date.parse('2026-04-01T09:00:00Z');
    let ultima = '';
    for (let d = 0; d < 200; d += 1) {
      const r = await createBackup(paths, { dir: backupDir, now: new Date(inicio + d * 86_400_000) });
      ultima = r.file;
    }
    const quedan = await names();
    expect(quedan).toContain(ultima);
    // 7 newest days + about 4 weekly + about 6 monthly, overlapping.
    expect(quedan.length).toBeGreaterThanOrEqual(13);
    expect(quedan.length).toBeLessThanOrEqual(17);
    // Something from five months before the newest survives.
    expect(quedan.some(n => n.startsWith('brain-202605'))).toBe(true);
  }, 120_000);

  it('a burst of manual copies on one day does not push the earlier days out', async () => {
    const all: BackupInfo[] = [];
    for (let d = 0; d < 7; d++) all.push({ file: `d${d}`, path: '', size_bytes: 1, created: new Date(Date.parse('2026-11-01T08:00:00Z') + d * 86_400_000).toISOString() });
    for (let h = 0; h < 5; h++) all.push({ file: `hoy${h}`, path: '', size_bytes: 1, created: `2026-11-08T1${h}:00:00.000Z` });
    all.sort((a, b) => (a.created < b.created ? 1 : -1));
    const keep = retainedBackups(all);
    for (let d = 0; d < 7; d++) expect(keep.has(`d${d}`)).toBe(true);
  });
});

describe('a corrupt neuron is copied as it is and named', () => {
  it('backs up a truncated neuron byte for byte and lists it in unreadable', async () => {
    await put('cortex/project_rota.json', '{"id":"project_rota","facts":[{"text":"cortado');
    const r = await createBackup(new BrainPaths(brainDir), { dir: backupDir });
    expect(r.unreadable).toEqual(['cortex/project_rota.json']);
    const b = await readBackup(r.path);
    expect(b.files['cortex/project_rota.json']).toContain('cortado');
  });
});
