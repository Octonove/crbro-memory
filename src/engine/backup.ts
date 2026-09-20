// ─── Brain backup ────────────────────────────────────────────────
// One gzipped JSON file per backup, with rotation.
//
// Why a single file and not a copied directory: it is written with
// tmp + rename, so a backup either exists whole or does not exist; a copied
// tree interrupted half-way looks like a backup and is not one. It is also
// what a person can drag to a synced folder without thinking.
//
// What is deliberately LEFT OUT, and why each one matters:
//   .quarantine    holds what crbro_forget removed — including credentials
//                  that were forgotten on purpose. A backup that copied it
//                  would carry them to wherever the backup is synced.
//   .device-token, .license-cache.json   machine-bound secrets.
//   .search        the index; `crbro reindex` rebuilds it.
//   .semantic      ~500 MB of runtime + model; `crbro semantic install`.
//   shared/*/.git  the space's remote already has it.
// Keys never live inside the brain (they are in the OS keychain), so a backup
// holds knowledge and no secrets.
//
// A backup on the same disk protects against a bad write, a bad merge or a
// wrong `forget`. It does NOT protect against the disk dying: point
// CRBRO_BACKUP_DIR at a folder something else already syncs.

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { promisify } from 'util';
import { BrainPaths } from './brain.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const BACKUP_FORMAT = 1;
export const DEFAULT_KEEP = 7;
/** consolidate makes one on its own when the newest is older than this. */
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SKIP_TOP = new Set(['.quarantine', '.search', '.semantic', '.device-token', '.license-cache.json', '.locks', '.daemon']);
const SKIP_ANYWHERE = new Set(['.git', 'node_modules']);
const PREFIX = 'brain-';
const SUFFIX = '.json.gz';

export interface BackupBundle {
  format: number;
  created: string;
  brain_path: string;
  counts: { files: number; neurons: number; sessions: number; synapses: number; bytes: number };
  /** POSIX-style relative path → file content. */
  files: Record<string, string>;
}

export interface BackupInfo {
  file: string;
  path: string;
  created: string;
  size_bytes: number;
}

export interface BackupResult extends BackupInfo {
  counts: BackupBundle['counts'];
  rotated_out: string[];
  dir: string;
}

/**
 * Where backups go: a sibling of the brain they belong to — `~/.crbro` →
 * `~/.crbro-backups/brain`.
 *
 * Outside the brain, so deleting the brain does not delete its backups. And
 * derived from the brain's own path rather than fixed under the home folder,
 * because rotation keeps the newest N of whatever is in the folder: two brains
 * (CRBRO_PATH, or a test's temporary one) sharing a folder would rotate each
 * other's backups out.
 */
export function resolveBackupDir(
  brainRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  const raw = (env['CRBRO_BACKUP_DIR'] || '').trim();
  if (raw && !/[%$]\{?\w/.test(raw)) {
    return path.isAbsolute(raw) ? raw : path.join(home, raw);
  }
  const root = path.resolve(brainRoot);
  return path.join(path.dirname(root), `${path.basename(root)}-backups`, 'brain');
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

async function walk(root: string, rel: string, out: Record<string, string>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_ANYWHERE.has(e.name)) continue;
    if (!rel && SKIP_TOP.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walk(root, childRel, out);
    } else if (e.isFile()) {
      // A file that vanishes between readdir and readFile was being replaced by
      // an atomic write; the next backup picks it up. Never fail the whole run.
      try {
        out[childRel] = await fs.readFile(path.join(root, childRel), 'utf8');
      } catch { /* replaced mid-walk */ }
    }
  }
}

export async function listBackups(dir: string): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found: BackupInfo[] = [];
  for (const n of names) {
    if (!n.startsWith(PREFIX) || !n.endsWith(SUFFIX)) continue;
    try {
      const st = await fs.stat(path.join(dir, n));
      const m = n.slice(PREFIX.length, -SUFFIX.length).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
      const created = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : st.mtime.toISOString();
      found.push({ file: n, path: path.join(dir, n), created, size_bytes: st.size });
    } catch { /* gone */ }
  }
  return found.sort((a, b) => (a.file < b.file ? 1 : -1)); // newest first
}

export async function createBackup(
  paths: BrainPaths,
  opts: { dir?: string; keep?: number; now?: Date } = {}
): Promise<BackupResult> {
  const dir = opts.dir || resolveBackupDir(paths.root);
  const keep = Math.max(1, opts.keep ?? DEFAULT_KEEP);
  const when = opts.now || new Date();

  const files: Record<string, string> = {};
  await walk(paths.root, '', files);
  const keys = Object.keys(files);
  const under = (p: string) => keys.filter(k => k.startsWith(p + '/')).length;
  const bundle: BackupBundle = {
    format: BACKUP_FORMAT,
    created: when.toISOString(),
    brain_path: paths.root,
    counts: {
      files: keys.length,
      neurons: under('cortex'),
      sessions: under('hippocampus'),
      synapses: under('synapses'),
      bytes: keys.reduce((a, k) => a + Buffer.byteLength(files[k], 'utf8'), 0),
    },
    files,
  };
  if (bundle.counts.neurons === 0 && bundle.counts.sessions === 0) {
    // An empty bundle would rotate a real backup out. Refuse instead.
    throw new Error(`Nothing to back up at ${paths.root}: no neurons and no sessions found.`);
  }

  await fs.mkdir(dir, { recursive: true });
  const name = `${PREFIX}${stamp(when)}${SUFFIX}`;
  const target = path.join(dir, name);
  const tmp = `${target}.tmp-${process.pid}`;
  const packed = await gzip(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 6 });
  await fs.writeFile(tmp, packed);
  await fs.rename(tmp, target);

  // Rotation only ever removes files this module named, and only after the new
  // one is safely on disk.
  const all = await listBackups(dir);
  const rotated: string[] = [];
  for (const old of all.slice(keep)) {
    try { await fs.unlink(old.path); rotated.push(old.file); } catch { /* keep going */ }
  }

  return { file: name, path: target, created: bundle.created, size_bytes: packed.length, counts: bundle.counts, rotated_out: rotated, dir };
}

export async function readBackup(file: string): Promise<BackupBundle> {
  const raw = await fs.readFile(file);
  const bundle = JSON.parse((await gunzip(raw)).toString('utf8')) as BackupBundle;
  if (!bundle || typeof bundle !== 'object' || !bundle.files || typeof bundle.files !== 'object') {
    throw new Error('Not a CRBRO backup: no files section.');
  }
  if (bundle.format > BACKUP_FORMAT) {
    throw new Error(`Backup format ${bundle.format} is newer than this CRBRO understands (${BACKUP_FORMAT}). Update crbro-memory first.`);
  }
  return bundle;
}

/**
 * Unpack a backup into a directory that must not already hold a brain.
 * Never writes over a live brain: swapping directories is a decision a person
 * makes with both of them in front of them.
 */
export async function restoreBackup(file: string, into: string): Promise<{ into: string; files: number }> {
  const bundle = await readBackup(file);
  try {
    const existing = await fs.readdir(into);
    if (existing.length > 0) throw new Error(`Refusing to restore into a non-empty directory: ${into}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let n = 0;
  for (const [rel, content] of Object.entries(bundle.files)) {
    // A crafted bundle must not escape the target directory.
    const dest = path.resolve(into, rel);
    if (!dest.startsWith(path.resolve(into) + path.sep)) throw new Error(`Unsafe path in backup: ${rel}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf8');
    n++;
  }
  return { into, files: n };
}

/** Called by consolidate: a backup nobody has to remember to make. Never throws. */
export async function autoBackupIfDue(
  paths: BrainPaths,
  opts: { dir?: string; now?: Date; env?: NodeJS.ProcessEnv } = {}
): Promise<{ made: boolean; reason: string; file?: string }> {
  const env = opts.env || process.env;
  if ((env['CRBRO_AUTOBACKUP'] || '').trim() === '0') return { made: false, reason: 'disabled (CRBRO_AUTOBACKUP=0)' };
  try {
    const dir = opts.dir || resolveBackupDir(paths.root, env);
    const now = opts.now || new Date();
    const newest = (await listBackups(dir))[0];
    if (newest && now.getTime() - Date.parse(newest.created) < AUTO_BACKUP_INTERVAL_MS) {
      return { made: false, reason: 'recent backup exists', file: newest.file };
    }
    const r = await createBackup(paths, { dir, now });
    return { made: true, reason: newest ? 'older than 24h' : 'first backup', file: r.file };
  } catch (err: unknown) {
    return { made: false, reason: `failed: ${(err as Error).message}` };
  }
}
