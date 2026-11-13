// ─── Brain backup ────────────────────────────────────────────────
// One gzipped JSON file per backup, with rotation.
//
// 2.11: --keep is validated (a whole number ≥ 1), each new copy is read back
// before anything is rotated, the copy just written is never rotated, a
// future-dated copy no longer counts as the newest, retention is tiered
// (newest N + one per day for N days + per ISO week for 4 weeks + per month
// for 6 months), and with CRBRO_ENCRYPT_AT_REST=1 copies are sealed
// (`.json.gz.enc`, see atrest.ts).
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
import { stripBOM } from '../utils/fs.js';

const gzip = promisify(zlib.gzip);
/** Loaded on first use: doctor and listing never need the keychain. */
const atRest = () => import('./atrest.js');
const gunzip = promisify(zlib.gunzip);

export const BACKUP_FORMAT = 1;
export const DEFAULT_KEEP = 7;
/** consolidate makes one on its own when the newest is older than this. */
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// checkpoints/ (2.7): the compaction checkpoints hold literal user requests,
// the task list, the folder and the remote. They expire after seven days and
// are rebuilt by the next compaction; a backup, often kept in a synced folder,
// would keep them forever.
const SKIP_TOP = new Set(['.quarantine', '.search', '.semantic', '.device-token', '.license-cache.json', '.locks', '.daemon', 'checkpoints']);
const SKIP_ANYWHERE = new Set(['.git', 'node_modules']);
const PREFIX = 'brain-';
const SUFFIX = '.json.gz';
/** A copy sealed with the at-rest key (CRBRO_ENCRYPT_AT_REST=1). */
const SUFFIX_ENC = '.json.gz.enc';
/** A copy whose name is further ahead of the clock than this is future-dated. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

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
  /** Sealed with the at-rest key (2.11). */
  encrypted?: boolean;
  /** The name carried a date more than a day ahead of the clock: `created` comes from the file's mtime instead. */
  future_dated?: boolean;
}

export interface BackupResult extends BackupInfo {
  counts: BackupBundle['counts'];
  rotated_out: string[];
  dir: string;
  /** The copy was read back and its file count matched before anything was rotated. */
  verified: boolean;
  /** Neuron files copied byte for byte that do not parse: kept (they may be all that is left), and named here. */
  unreadable: string[];
  retention: Retention;
}

/**
 * Tiered retention (2.11): the newest `keep` copies, plus the newest copy of
 * each of the last `daily` days, `weekly` ISO weeks and `monthly` months that
 * have one. One copy a day keeps about 17 files reaching six months back; a
 * burst of manual copies on one day no longer pushes the older days out.
 */
export interface Retention {
  keep: number;
  daily: number;
  weekly: number;
  monthly: number;
}

export const DEFAULT_RETENTION: Retention = { keep: DEFAULT_KEEP, daily: 7, weekly: 4, monthly: 6 };

/** An integer ≥ 1, or an error that says so. `backup --keep siete` used to mean "delete every copy". */
export function validateKeep(keep: unknown): number {
  if (typeof keep === 'number' && Number.isInteger(keep) && keep >= 1) return keep;
  throw new Error(`--keep must be a whole number of at least 1 (got ${JSON.stringify(keep)}). Nothing was written or rotated.`);
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
    // Process coordination is not knowledge. Restoring a captured .guard
    // would block every writer; an in-flight atomic temporary is incomplete.
    if (e.name.endsWith('.lock') || e.name.endsWith('.lock.guard') || /\.json\.[^/]+\.tmp$/.test(e.name)) continue;
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

function isBackupName(n: string): boolean {
  return n.startsWith(PREFIX) && (n.endsWith(SUFFIX) || n.endsWith(SUFFIX_ENC));
}

export async function listBackups(dir: string, now: Date = new Date()): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found: BackupInfo[] = [];
  const limite = now.getTime() + FUTURE_TOLERANCE_MS;
  for (const n of names) {
    if (!isBackupName(n)) continue;
    try {
      const st = await fs.stat(path.join(dir, n));
      const m = n.slice(PREFIX.length).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
      let created = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : st.mtime.toISOString();
      // A clock set ahead once must not make that copy "the newest" for
      // months: it blocked every automatic copy and got the good ones rotated
      // out first. Its name is not evidence; the file's own date is.
      let future = false;
      if (!Number.isFinite(Date.parse(created)) || Date.parse(created) > limite) {
        future = true;
        // A file date ahead too: it sorts as the oldest copy, never the newest.
        created = new Date(st.mtimeMs <= limite ? st.mtimeMs : 0).toISOString();
      }
      found.push({
        file: n, path: path.join(dir, n), created, size_bytes: st.size,
        ...(n.endsWith(SUFFIX_ENC) ? { encrypted: true } : {}),
        ...(future ? { future_dated: true } : {}),
      });
    } catch { /* gone */ }
  }
  return found.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.file < b.file ? 1 : -1)); // newest first
}

const isoWeek = (d: Date): string => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dia = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dia);
  const inicio = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((t.getTime() - inicio.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`;
};

/** Which copies a retention policy keeps, by file name. Pure. `all` is newest first. */
export function retainedBackups(all: BackupInfo[], policy: Retention = DEFAULT_RETENTION): Set<string> {
  const keep = new Set<string>();
  for (const b of all.slice(0, policy.keep)) keep.add(b.file);
  const tier = (key: (d: Date) => string, n: number) => {
    const vistos = new Set<string>();
    for (const b of all) {
      const k = key(new Date(b.created));
      if (vistos.has(k)) continue;
      if (vistos.size >= n) break;
      vistos.add(k);
      keep.add(b.file);   // newest of that bucket: `all` is newest first
    }
  };
  tier(d => d.toISOString().slice(0, 10), policy.daily);
  tier(isoWeek, policy.weekly);
  tier(d => d.toISOString().slice(0, 7), policy.monthly);
  return keep;
}

export async function createBackup(
  paths: BrainPaths,
  opts: { dir?: string; keep?: number; now?: Date; retention?: Partial<Retention>; env?: NodeJS.ProcessEnv } = {}
): Promise<BackupResult> {
  const dir = opts.dir || resolveBackupDir(paths.root);
  const keep = opts.keep === undefined ? DEFAULT_KEEP : validateKeep(opts.keep);
  const retention: Retention = { ...DEFAULT_RETENTION, daily: keep, ...opts.retention, keep };
  const when = opts.now || new Date();
  const env = opts.env || process.env;

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
  // A neuron that does not parse is copied as it is — its bytes may be all
  // that is left of it — and named, so nobody restores it believing it fine.
  const unreadable: string[] = [];
  for (const k of keys) {
    if (!k.startsWith('cortex/') || !k.endsWith('.json')) continue;
    try { JSON.parse(stripBOM(files[k])); } catch { unreadable.push(k); }
  }

  const gz = await gzip(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 6 });
  // Sealed when encryption at rest is on; throws before writing anything when
  // it is on and the key is missing — never a clear copy instead.
  const { maybeSeal } = await atRest();
  const { data: packed, sealed } = maybeSeal(gz, env);

  await fs.mkdir(dir, { recursive: true });
  const name = `${PREFIX}${stamp(when)}${sealed ? SUFFIX_ENC : SUFFIX}`;
  const target = path.join(dir, name);
  const tmp = `${target}.tmp-${process.pid}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(packed);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);

  // Read it back before trusting it. A copy cut short by a crash or a full
  // disk used to be followed straight away by the rotation of the oldest GOOD
  // one. A copy that does not read back is removed (it would otherwise count
  // as the newest) and nothing is rotated.
  try {
    const back = await readBackup(target);
    if (Object.keys(back.files).length !== bundle.counts.files) {
      throw new Error(`holds ${Object.keys(back.files).length} files, expected ${bundle.counts.files}`);
    }
  } catch (err) {
    await fs.unlink(target).catch(() => {});
    throw new Error(`The new backup did not read back (${(err as Error).message}); it was removed and nothing was rotated.`);
  }

  // Rotation only ever removes files this module named, never the one just
  // written, and only after that one has been read back.
  const all = await listBackups(dir, when);
  const guardar = retainedBackups(all, retention);
  guardar.add(name);
  const rotated: string[] = [];
  for (const old of all) {
    if (guardar.has(old.file)) continue;
    try { await fs.unlink(old.path); rotated.push(old.file); } catch { /* keep going */ }
  }

  return {
    file: name, path: target, created: bundle.created, size_bytes: packed.length, counts: bundle.counts, rotated_out: rotated, dir,
    verified: true, unreadable, retention, ...(sealed ? { encrypted: true } : {}),
  };
}

export async function readBackup(file: string): Promise<BackupBundle> {
  const bytes = await fs.readFile(file);
  const raw = (await atRest()).unseal(bytes);
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
    // A future-dated copy is listed by its file date, so it cannot hold
    // automatic copies off until the clock catches up with its name.
    const newest = (await listBackups(dir, now))[0];
    if (newest && now.getTime() - Date.parse(newest.created) < AUTO_BACKUP_INTERVAL_MS) {
      return { made: false, reason: 'recent backup exists', file: newest.file };
    }
    const r = await createBackup(paths, { dir, now, env });
    return { made: true, reason: newest ? 'older than 24h' : 'first backup', file: r.file };
  } catch (err: unknown) {
    return { made: false, reason: `failed: ${(err as Error).message}` };
  }
}
