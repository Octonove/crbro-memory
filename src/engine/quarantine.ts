// ─── Quarantine: the copy kept before anything is removed ────────
//
// Every destructive path (forget, forget entire, merge_into, compact, a day
// log forgotten) writes here first, so a removal can be undone. Until 2.11 it
// grew without limit and in clear: 824 files and 5.3 MB on the reference
// brain, a whole 1 MB neuron copied for every batch of a split, including the
// credentials somebody forgot on purpose. Now:
//
//  - forgetting SOME entries keeps those entries and what restore needs to
//    put them back (dates, retirements, provenance, checks), not the neuron;
//  - copies older than CRBRO_QUARANTINE_DAYS (default 180; 0 keeps them
//    forever) are pruned by consolidate and maintenance, which say how many;
//  - with CRBRO_ENCRYPT_AT_REST=1 new copies are sealed (atrest.ts).
//
// File names: `<id>.<stamp>.json` (a whole neuron or log, the 2.x format a
// previous version can still restore), `<id>.<stamp>.entries.json` (some
// entries), each with `.enc` appended when sealed. The stamp sorts lexically,
// so the name alone orders the copies of one id.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { maybeSeal, unseal } from './atrest.js';
import { stripBOM, now } from '../utils/fs.js';
import type { Neuron, Fact, Decision, EntryRetirement, Verification } from '../types/index.js';

export const DEFAULT_QUARANTINE_DAYS = 180;

/** What a forget of some entries keeps: the entries, and what restore needs. */
export interface QuarantineEntries {
  quarantine_format: 2;
  kind: 'entries';
  neuron_id: string;
  name: string;
  type: Neuron['type'];
  domain: string;
  taken_at: string;
  facts: Fact[];
  decisions: Decision[];
  patterns: string[];
  preferences: string[];
  errors: string[];
  debts: string[];
  map?: Neuron['map'];
  entry_dates?: Record<string, string>;
  entry_status?: Record<string, EntryRetirement>;
  entry_source?: Record<string, string>;
  entry_verified?: Record<string, string>;
  entry_verification?: Record<string, Verification>;
}

export interface QuarantineCopy {
  /** File name without directory. */
  file: string;
  /** Name without `.json` / `.json.enc`: what restore's `file` option takes. */
  base: string;
  id: string;
  kind: 'whole' | 'entries';
  sealed: boolean;
  /** ISO time from the stamp, or the file's mtime when the name carries none. */
  taken: string;
}

/** Retention in days from the environment; 0 means forever. Bad values fall back to the default. */
export function quarantineDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['CRBRO_QUARANTINE_DAYS'] || '').trim();
  if (!raw) return DEFAULT_QUARANTINE_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_QUARANTINE_DAYS;
}

export function stampNow(): string {
  return now().replace(/[:.]/g, '-');
}

/** "2026-11-13T10-20-30-123Z" → ISO, or null. */
function stampToIso(stamp: string): string | null {
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

function parseName(file: string): { base: string; id: string; stamp: string; kind: 'whole' | 'entries'; sealed: boolean } | null {
  const sealed = file.endsWith('.json.enc');
  if (!sealed && !file.endsWith('.json')) return null;
  const base = file.slice(0, file.length - (sealed ? '.json.enc'.length : '.json'.length));
  const entries = base.endsWith('.entries');
  const core = entries ? base.slice(0, -'.entries'.length) : base;
  const m = core.match(/^(.*)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/);
  if (!m) return { base, id: core, stamp: '', kind: entries ? 'entries' : 'whole', sealed };
  return { base, id: m[1], stamp: m[2], kind: entries ? 'entries' : 'whole', sealed };
}

/** Write one copy; sealed when the switch is on. Throws rather than write in clear without a key. */
export async function writeQuarantine(dir: string, id: string, data: unknown, kind: 'whole' | 'entries' = 'whole'): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const { data: bytes, sealed } = maybeSeal(Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
  const name = `${id}.${stampNow()}${kind === 'entries' ? '.entries' : ''}.json${sealed ? '.enc' : ''}`;
  const target = path.join(dir, name);
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, bytes);
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  return target;
}

export async function readQuarantine<T = unknown>(file: string): Promise<T | null> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(stripBOM(unseal(raw).toString('utf8'))) as T;
}

/** Copies in the folder, optionally of one id, newest first. */
export async function listQuarantine(dir: string, id?: string): Promise<QuarantineCopy[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: QuarantineCopy[] = [];
  for (const file of names) {
    if (file.endsWith('.tmp')) continue;
    const p = parseName(file);
    if (!p) continue;
    if (id !== undefined && p.id !== id) continue;
    let taken = p.stamp ? stampToIso(p.stamp) : null;
    if (!taken) {
      try { taken = (await fs.stat(path.join(dir, file))).mtime.toISOString(); } catch { continue; }
    }
    out.push({ file, base: p.base, id: p.id, kind: p.kind, sealed: p.sealed, taken });
  }
  return out.sort((a, b) => (a.taken < b.taken ? 1 : a.taken > b.taken ? -1 : a.file < b.file ? 1 : -1));
}

/**
 * Delete copies older than `days` (0 = keep forever). Returns what went, or
 * would go with dryRun. Only files this module names are ever touched.
 */
export async function pruneQuarantine(
  dir: string,
  opts: { days?: number; now?: Date; dryRun?: boolean } = {}
): Promise<{ pruned: number; bytes: number; files: string[]; days: number }> {
  const days = opts.days ?? quarantineDays();
  const res = { pruned: 0, bytes: 0, files: [] as string[], days };
  if (days <= 0) return res;
  const limite = (opts.now ?? new Date()).getTime() - days * 86_400_000;
  for (const c of await listQuarantine(dir)) {
    if (Date.parse(c.taken) >= limite) continue;
    const f = path.join(dir, c.file);
    try {
      const st = await fs.stat(f);
      if (!opts.dryRun) await fs.unlink(f);
      res.pruned++;
      res.bytes += st.size;
      res.files.push(c.file);
    } catch { /* gone meanwhile */ }
  }
  return res;
}

/** Files, bytes and the oldest copy: what status and doctor show. */
export async function quarantineStats(dir: string): Promise<{ files: number; bytes: number; oldest: string | null; sealed: number }> {
  const all = await listQuarantine(dir);
  let bytes = 0;
  for (const c of all) {
    try { bytes += (await fs.stat(path.join(dir, c.file))).size; } catch { /* gone */ }
  }
  return {
    files: all.length,
    bytes,
    oldest: all.length ? all[all.length - 1].taken : null,
    sealed: all.filter(c => c.sealed).length,
  };
}

/**
 * The neuron-shaped part of a partial copy, ready for unionNeuron: the
 * entries with their sidecars and the identity of the neuron they left.
 */
export function entriesAsNeuron(q: QuarantineEntries): Neuron {
  return {
    id: q.neuron_id,
    name: q.name,
    type: q.type,
    domain: q.domain,
    created: q.taken_at,
    last_accessed: q.taken_at,
    access_count: 0,
    heat: 0,
    summary: '',
    facts: q.facts || [],
    decisions: q.decisions || [],
    patterns: q.patterns || [],
    preferences: q.preferences || [],
    connections: [],
    tags: [],
    errors: q.errors || [],
    debts: q.debts || [],
    entry_dates: q.entry_dates || {},
    ...(q.entry_status ? { entry_status: q.entry_status } : {}),
    ...(q.entry_source ? { entry_source: q.entry_source } : {}),
    ...(q.entry_verified ? { entry_verified: q.entry_verified } : {}),
    ...(q.entry_verification ? { entry_verification: q.entry_verification } : {}),
    ...(q.map ? { map: q.map } : {}),
  } as Neuron;
}

export function isEntriesCopy(x: unknown): x is QuarantineEntries {
  return !!x && typeof x === 'object' && (x as QuarantineEntries).kind === 'entries' && (x as QuarantineEntries).quarantine_format === 2;
}
