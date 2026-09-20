// ─── The backup: what it keeps, what it refuses to carry ─────────
//
// Born from an audit of a real brain: 1,200 neurons and 97 sessions on a single
// disk, and the only "backups" folder held config files. The properties that
// matter are the ones a person would only discover on the worst day:
// the quarantine must NOT travel (it holds credentials forgotten on purpose),
// rotation must never eat the file it just wrote, and a restore must never
// land on top of a live brain.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrainPaths } from '../src/engine/brain.js';
import {
  createBackup, listBackups, readBackup, restoreBackup, autoBackupIfDue, resolveBackupDir,
} from '../src/engine/backup.js';

let root: string;
let brainDir: string;
let backupDir: string;

async function put(rel: string, content: string) {
  const f = path.join(brainDir, rel);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, content, 'utf8');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-backup-'));
  brainDir = path.join(root, 'brain');
  backupDir = path.join(root, 'backups');
  await put('manifest.json', '{"version":"1.0.0"}');
  await put('cortex/project_a.json', JSON.stringify({ id: 'project_a', facts: ['la ñ y el café ☕ sobreviven'] }));
  await put('cortex/project_b.json', '{"id":"project_b"}');
  await put('hippocampus/session_2026-09-20.json', '{"summary":"hoy"}');
  await put('synapses/s1.json', '{}');
  // Everything below must stay out.
  await put('.quarantine/forgotten.json', '{"secret":"sk-live-must-not-travel"}');
  await put('.device-token', 'machine-bound');
  await put('.license-cache.json', '{}');
  await put('.daemon/abc123.json', '{"token":"daemon-token-must-not-travel"}');
  await put('.search/chunks.index.json', '{"huge":true}');
  await put('.semantic/models/m.onnx', 'binary');
  await put('shared/equipo/.git/config', '[core]');
  await put('shared/equipo/notes/n1.json', '{"note":1}');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createBackup', () => {
  it('keeps the knowledge and counts it', async () => {
    const r = await createBackup(new BrainPaths(brainDir), { dir: backupDir });
    expect(r.counts.neurons).toBe(2);
    expect(r.counts.sessions).toBe(1);
    expect(r.counts.synapses).toBe(1);
    const b = await readBackup(r.path);
    expect(Object.keys(b.files)).toContain('cortex/project_a.json');
    expect(Object.keys(b.files)).toContain('shared/equipo/notes/n1.json');
    expect(b.files['cortex/project_a.json']).toContain('la ñ y el café ☕ sobreviven');
  });

  it('leaves out the quarantine, machine secrets, the index, the model and .git', async () => {
    const r = await createBackup(new BrainPaths(brainDir), { dir: backupDir });
    const names = Object.keys((await readBackup(r.path)).files);
    for (const banned of ['.quarantine', '.device-token', '.license-cache.json', '.search', '.semantic', '.git', '.daemon']) {
      expect(names.filter(n => n.split('/').includes(banned)), `${banned} leaked into the backup`).toEqual([]);
    }
    expect(JSON.stringify(await readBackup(r.path))).not.toContain('sk-live-must-not-travel');
    expect(JSON.stringify(await readBackup(r.path))).not.toContain('daemon-token-must-not-travel');
  });

  it('refuses to write an empty backup that would rotate a real one out', async () => {
    const empty = path.join(root, 'empty');
    await fs.mkdir(empty, { recursive: true });
    await expect(createBackup(new BrainPaths(empty), { dir: backupDir })).rejects.toThrow(/Nothing to back up/);
    expect(await listBackups(backupDir)).toEqual([]);
  });

  it('rotates: keeps the newest N and never the file it just wrote', async () => {
    const paths = new BrainPaths(brainDir);
    const t0 = Date.parse('2026-09-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      await createBackup(paths, { dir: backupDir, keep: 3, now: new Date(t0 + i * 86_400_000) });
    }
    const left = await listBackups(backupDir);
    expect(left.map(b => b.file)).toEqual([
      'brain-20260905-000000.json.gz', 'brain-20260904-000000.json.gz', 'brain-20260903-000000.json.gz',
    ]);
  });

  it('rotation ignores files it did not name', async () => {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, 'keys.dpapi.bak-20260909'), 'not ours');
    const paths = new BrainPaths(brainDir);
    for (let i = 0; i < 3; i++) {
      await createBackup(paths, { dir: backupDir, keep: 1, now: new Date(Date.parse('2026-09-01T00:00:00Z') + i * 1000) });
    }
    expect(await fs.readFile(path.join(backupDir, 'keys.dpapi.bak-20260909'), 'utf8')).toBe('not ours');
    expect(await listBackups(backupDir)).toHaveLength(1);
  });
});

describe('restoreBackup', () => {
  it('round-trips byte for byte into an empty directory', async () => {
    const r = await createBackup(new BrainPaths(brainDir), { dir: backupDir });
    const into = path.join(root, 'restored');
    const out = await restoreBackup(r.path, into);
    expect(out.files).toBe(r.counts.files);
    expect(await fs.readFile(path.join(into, 'cortex', 'project_a.json'), 'utf8'))
      .toBe(await fs.readFile(path.join(brainDir, 'cortex', 'project_a.json'), 'utf8'));
  });

  it('refuses a directory that already holds something', async () => {
    const r = await createBackup(new BrainPaths(brainDir), { dir: backupDir });
    await expect(restoreBackup(r.path, brainDir)).rejects.toThrow(/non-empty/);
  });

  it('refuses a bundle whose paths climb out of the target', async () => {
    const zlib = await import('node:zlib');
    const evil = path.join(root, 'evil.json.gz');
    await fs.writeFile(evil, zlib.gzipSync(JSON.stringify({ format: 1, created: '', brain_path: '', counts: {}, files: { '../../escaped.txt': 'x' } })));
    await expect(restoreBackup(evil, path.join(root, 'target'))).rejects.toThrow(/Unsafe path/);
  });
});

describe('autoBackupIfDue', () => {
  const paths = () => new BrainPaths(brainDir);

  it('makes the first one, then waits a day', async () => {
    const t = new Date('2026-09-20T10:00:00Z');
    expect((await autoBackupIfDue(paths(), { dir: backupDir, now: t, env: {} })).made).toBe(true);
    const again = await autoBackupIfDue(paths(), { dir: backupDir, now: new Date(t.getTime() + 3_600_000), env: {} });
    expect(again.made).toBe(false);
    expect(again.reason).toMatch(/recent/);
    const nextDay = await autoBackupIfDue(paths(), { dir: backupDir, now: new Date(t.getTime() + 25 * 3_600_000), env: {} });
    expect(nextDay.made).toBe(true);
  });

  it('can be turned off, and a failure never throws into consolidate', async () => {
    expect((await autoBackupIfDue(paths(), { dir: backupDir, env: { CRBRO_AUTOBACKUP: '0' } })).made).toBe(false);
    const broken = await autoBackupIfDue(new BrainPaths(path.join(root, 'nope')), { dir: backupDir, env: {} });
    expect(broken.made).toBe(false);
    expect(broken.reason).toMatch(/failed/);
  });
});

describe('resolveBackupDir', () => {
  const HOME = path.resolve(process.platform === 'win32' ? 'C:/Users/prueba' : '/home/prueba');

  const BRAIN = path.join(HOME, '.crbro');

  it('lives outside the brain by default, so deleting ~/.crbro does not delete its backups', () => {
    const dir = resolveBackupDir(BRAIN, {}, HOME);
    expect(dir).toBe(path.join(HOME, '.crbro-backups', 'brain'));
    expect(dir.startsWith(BRAIN + path.sep)).toBe(false);
  });

  it('follows the brain it belongs to, so two brains never rotate each other out', () => {
    const work = resolveBackupDir(path.join(HOME, 'cerebros', 'trabajo'), {}, HOME);
    expect(work).toBe(path.join(HOME, 'cerebros', 'trabajo-backups', 'brain'));
    expect(work).not.toBe(resolveBackupDir(BRAIN, {}, HOME));
  });

  it('honours CRBRO_BACKUP_DIR and ignores an unexpanded placeholder', () => {
    const abs = path.join(HOME, 'Drive', 'crbro');
    expect(resolveBackupDir(BRAIN, { CRBRO_BACKUP_DIR: abs }, HOME)).toBe(abs);
    expect(resolveBackupDir(BRAIN, { CRBRO_BACKUP_DIR: '${user_config.backup}' }, HOME)).toBe(path.join(HOME, '.crbro-backups', 'brain'));
  });
});
