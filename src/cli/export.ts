// ─── crbro-memory export ─────────────────────────────────────────
//
// The brain as something the owner can open without CRBRO: an Obsidian-ready
// Markdown vault, or one JSON file that `import` reads back. Read-only from
// the brain folder (safe while a daemon or a client runs: nothing is locked,
// nothing is written there), every text passes through the same redaction
// learn applies, and the output can never land inside the brain.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { resolveBrainDir, BrainPaths } from '../engine/brain.js';
import { redact } from '../engine/secrets.js';
import { entryId } from '../sync/ops.js';
import { factId } from '../utils/hash.js';
import { RUNNING_VERSION } from '../version.js';
import type { Neuron, Synapse, SessionLog, ActiveContext, PendingTask, Verification } from '../types/index.js';
import { parseArgs, realpathNearest, isInside, safeFileName } from './common.js';
import { frontmatterBlock, entryMarker, ENTRY_END, ENTRY_WHY, defuseMarkers } from './markdown.js';

export const EXPORT_FORMAT = 'crbro-export';
export const EXPORT_FORMAT_VERSION = 1;
export const VAULT_MARKER = '.crbro-export.json';

export const EXPORT_HELP = `
  crbro-memory export [--out <dir>] [--format md|json] [--include-retired]

  Write the brain to a folder you can read without CRBRO. Read-only: the brain
  is never written, so it is safe while a client or the daemon is running.

    --out <dir>          Where to write. Must be new or empty, and outside the
                         brain folder. Default: ./crbro-export-<date>-<time>
    --format md|json     md (default): an Obsidian-compatible vault, one note per
                         neuron with YAML frontmatter, entries grouped by kind,
                         synapses as [[wiki links]], one index note per domain,
                         the day logs and the open items.
                         json: crbro-export.json, a faithful dump that
                         \`crbro-memory import\` reads back.
    --include-retired    Also export superseded and retracted entries (marked).

  Credentials are redacted exactly as crbro_learn does before anything is
  written. The brain is the one crbro_* tools use: CRBRO_PATH, else ~/.crbro.
`;

// ─── Reading ─────────────────────────────────────────────────────

export interface BrainSnapshot {
  neurons: Array<Neuron & { archived?: boolean }>;
  synapses: Synapse[];
  sessions: SessionLog[];
  context: ActiveContext | null;
  /** Files that would not parse, by relative path. Reported, never fatal. */
  unreadable: string[];
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw.replace(/^﻿/, '')) as T;
}

async function readDir<T>(dir: string, root: string, unreadable: string[]): Promise<T[]> {
  let names: string[] = [];
  try { names = (await fs.readdir(dir)).filter(n => n.endsWith('.json')).sort(); } catch { return []; }
  const out: T[] = [];
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const st = await fs.lstat(file);
      if (!st.isFile()) continue;
      const v = await readJsonFile<T>(file);
      if (v && typeof v === 'object') out.push(v); else unreadable.push(path.relative(root, file));
    } catch {
      unreadable.push(path.relative(root, file));
    }
  }
  return out;
}

const looksLikeNeuron = (n: any): n is Neuron => n && typeof n.id === 'string' && typeof n.name === 'string';

/** Read the brain folder. Nothing is created, locked or written. */
export async function readBrain(root: string): Promise<BrainSnapshot> {
  const paths = new BrainPaths(root);
  const unreadable: string[] = [];
  const live = (await readDir<any>(paths.cortex, root, unreadable)).filter(looksLikeNeuron);
  const archived = (await readDir<any>(paths.archives, root, unreadable)).filter(looksLikeNeuron)
    .map(n => ({ ...n, archived: true }));
  const synapses = (await readDir<any>(paths.synapses, root, unreadable))
    .filter(s => Array.isArray(s?.nodes) && s.nodes.length === 2);
  const sessions = (await readDir<any>(paths.hippocampus, root, unreadable))
    .filter(s => typeof s?.session_id === 'string')
    .sort((a, b) => String(b.date || b.session_id).localeCompare(String(a.date || a.session_id)));
  let context: ActiveContext | null = null;
  try { context = await readJsonFile<ActiveContext>(paths.activeContext()); } catch { /* none yet */ }
  return { neurons: [...live, ...archived], synapses, sessions, context, unreadable };
}

// ─── Redaction ───────────────────────────────────────────────────

/** Redact every string value, recursively. Keys are left alone. Counts the markers placed. */
export function deepRedact<T>(value: T, counter: { n: number }): T {
  if (typeof value === 'string') {
    const r = redact(value);
    counter.n += r.found.length;
    return r.text as unknown as T;
  }
  if (Array.isArray(value)) return value.map(v => deepRedact(v, counter)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepRedact(v, counter);
    return out as T;
  }
  return value;
}

const SIDECARS = ['entry_dates', 'entry_status', 'entry_source', 'entry_verified', 'entry_verification'] as const;

/**
 * Redact one neuron and keep it coherent: an entry whose text changed gets a
 * new content id, so its sidecar keys (dates, retirement, verification…) move
 * with it, and a fact's own id is recomputed.
 */
export function redactNeuron(n: Neuron, counter: { n: number }): Neuron {
  const out = deepRedact(n, counter);
  const rekey = (before: string[] | undefined, after: string[] | undefined) => {
    (before || []).forEach((t, i) => {
      const t2 = after?.[i];
      if (t2 === undefined || t2 === t) return;
      const from = entryId(t), to = entryId(t2);
      for (const s of SIDECARS) {
        const map = (out as any)[s] as Record<string, unknown> | undefined;
        if (map && from in map) { map[to] = map[from]; delete map[from]; }
      }
    });
  };
  rekey(n.patterns, out.patterns);
  rekey(n.preferences, out.preferences);
  rekey(n.errors, out.errors);
  rekey(n.debts, out.debts);
  rekey((n.decisions || []).map(d => d.text), (out.decisions || []).map(d => d.text));
  (n.facts || []).forEach((f, i) => {
    const g = out.facts?.[i];
    if (g && g.text !== f.text) g.id = factId(g.text);
  });
  return out;
}

// ─── Entries, one shape for every kind ───────────────────────────

export type EntryKind = 'fact' | 'decision' | 'pattern' | 'preference' | 'error' | 'debt' | 'map';
export const ENTRY_KINDS: EntryKind[] = ['fact', 'decision', 'pattern', 'preference', 'error', 'debt', 'map'];

export interface ExportEntry {
  kind: EntryKind;
  id: string;
  text: string;
  date: string;
  status: 'active' | 'superseded' | 'retracted';
  verified?: string;
  verification?: Verification;
  keywords?: string[];
  rationale?: string;
  confidence?: number;
  shelf_life?: string;
  temporal?: string;
  reference?: { kind: string; value: string; field?: string; project?: string };
  origin?: string;
  revision_note?: string;
}

/** Every entry of a neuron, active first by kind, with the metadata that sits in its sidecars. */
export function entriesOf(n: Neuron, includeRetired: boolean): ExportEntry[] {
  const out: ExportEntry[] = [];
  for (const f of n.facts || []) {
    const status = (f.status || 'active') as ExportEntry['status'];
    if (status !== 'active' && !includeRetired) continue;
    out.push({
      kind: 'fact', id: f.id || factId(f.text), text: f.text, date: f.added || '', status,
      ...(f.verified ? { verified: f.verified } : {}),
      ...(f.verification ? { verification: f.verification } : {}),
      ...(f.keys?.length ? { keywords: f.keys } : {}),
      ...(typeof f.confidence === 'number' ? { confidence: f.confidence } : {}),
      ...(f.shelf_life ? { shelf_life: f.shelf_life } : {}),
      ...(f.temporal ? { temporal: f.temporal } : {}),
      ...(f.reference ? { reference: f.reference } : {}),
      ...(f.source && f.source !== 'session' && f.source !== 'manual' && !/^session_/.test(f.source) ? { origin: f.source } : {}),
      ...(f.revision_note ? { revision_note: f.revision_note } : {}),
    });
  }
  const side = (kind: EntryKind, text: string, date: string, extra: Partial<ExportEntry> = {}) => {
    const id = entryId(text);
    const ret = n.entry_status?.[id];
    if (ret && !includeRetired) return;
    out.push({
      kind, id, text, date: date || n.entry_dates?.[id] || '',
      status: ret ? ret.status : 'active',
      ...(n.entry_verified?.[id] ? { verified: n.entry_verified[id] } : {}),
      ...(n.entry_verification?.[id] ? { verification: n.entry_verification[id] } : {}),
      ...(n.entry_source?.[id] ? { origin: n.entry_source[id] } : {}),
      ...(ret?.note ? { revision_note: ret.note } : {}),
      ...extra,
    });
  };
  for (const d of n.decisions || []) side('decision', d.text, d.date || '', d.rationale ? { rationale: d.rationale } : {});
  for (const t of n.patterns || []) side('pattern', t, '');
  for (const t of n.preferences || []) side('preference', t, '');
  for (const t of n.errors || []) side('error', t, '');
  for (const t of n.debts || []) side('debt', t, '');
  if (n.map?.text) out.push({ kind: 'map', id: 'map', text: n.map.text, date: n.map.updated || '', status: 'active' });
  return out;
}

/** The neuron with its retired entries (and their sidecar keys) taken out. */
export function withoutRetired(n: Neuron): Neuron {
  const retired = new Set(Object.keys(n.entry_status || {}));
  const keep = (t: string) => !retired.has(entryId(t));
  const out: Neuron = {
    ...n,
    facts: (n.facts || []).filter(f => !f.status || f.status === 'active'),
    decisions: (n.decisions || []).filter(d => keep(d.text)),
    patterns: (n.patterns || []).filter(keep),
    preferences: (n.preferences || []).filter(keep),
    ...(n.errors ? { errors: n.errors.filter(keep) } : {}),
    ...(n.debts ? { debts: n.debts.filter(keep) } : {}),
  };
  for (const s of SIDECARS) {
    const map = (n as any)[s] as Record<string, unknown> | undefined;
    if (!map) continue;
    const kept = Object.fromEntries(Object.entries(map).filter(([k]) => !retired.has(k)));
    (out as any)[s] = kept;
  }
  delete out.entry_status;
  return out;
}

// ─── Building the export ─────────────────────────────────────────

export interface ExportData {
  format: typeof EXPORT_FORMAT;
  format_version: number;
  exported_at: string;
  crbro_version: string;
  include_retired: boolean;
  redactions: number;
  counts: { neurons: number; archived: number; entries: number; synapses: number; sessions: number; open_items: number };
  neurons: Array<Neuron & { archived?: boolean }>;
  synapses: Synapse[];
  sessions: SessionLog[];
  context: ActiveContext | null;
}

export function buildExport(snap: BrainSnapshot, includeRetired: boolean, nowIso = new Date().toISOString()): ExportData {
  const counter = { n: 0 };
  const neurons = snap.neurons
    .map(n => redactNeuron(includeRetired ? n : withoutRetired(n), counter) as Neuron & { archived?: boolean })
    .sort((a, b) => a.id.localeCompare(b.id));
  const synapses = deepRedact(snap.synapses, counter);
  const sessions = deepRedact(snap.sessions, counter);
  const context = deepRedact(snap.context, counter);
  const entries = neurons.reduce((s, n) => s + entriesOf(n, includeRetired).length, 0);
  const openItems = (context?.pending_tasks || []).length;
  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: nowIso,
    crbro_version: RUNNING_VERSION,
    include_retired: includeRetired,
    redactions: counter.n,
    counts: {
      neurons: neurons.length, archived: neurons.filter(n => n.archived).length, entries,
      synapses: synapses.length, sessions: sessions.length, open_items: openItems,
    },
    neurons, synapses, sessions, context,
  };
}

// ─── Markdown vault ──────────────────────────────────────────────

const KIND_TITLES: Record<EntryKind, string> = {
  map: 'Map', error: 'Errors', debt: 'Debts', preference: 'Preferences',
  pattern: 'Patterns', decision: 'Decisions', fact: 'Facts',
};
const SECTION_ORDER: EntryKind[] = ['map', 'error', 'debt', 'preference', 'pattern', 'decision', 'fact'];

const day = (iso?: string) => (iso && iso.length >= 10 ? iso.slice(0, 10) : iso || '');
/** Text for a wiki link alias: no brackets or pipes, one line. */
const alias = (s: string) => String(s).replace(/[\[\]|#^]/g, ' ').replace(/\s+/g, ' ').trim() || 'untitled';

function verificationLabel(e: ExportEntry): string {
  if (e.verification) {
    const ref = e.verification.reference ? ` (${e.verification.reference.kind}: ${e.verification.reference.value})` : '';
    return `verified: ${e.verification.method} ${day(e.verification.at)}${ref}`;
  }
  if (e.verified) return `verified: ${day(e.verified)}`;
  return 'unverified';
}

function metaLine(e: ExportEntry): string {
  const parts = [`\`${e.kind}\``];
  if (e.kind !== 'map') parts.push(`id \`${e.id}\``);
  parts.push(e.date ? day(e.date) : 'undated');
  parts.push(e.status === 'active' ? 'active' : `**${e.status}**${e.revision_note ? ` (${e.revision_note.replace(/\s+/g, ' ')})` : ''}`);
  if (e.kind !== 'map') parts.push(verificationLabel(e));
  if (e.keywords?.length) parts.push(`keywords: ${e.keywords.join(', ')}`);
  if (e.shelf_life) parts.push(`shelf life: ${e.shelf_life}`);
  if (e.temporal) parts.push(e.temporal);
  if (e.origin) parts.push(`origin: ${e.origin}`);
  return parts.join(' · ');
}

export interface VaultFile { rel: string; content: string }

/** Every file of the vault, relative to its root. Pure: nothing is written here. */
export function renderVault(data: ExportData): VaultFile[] {
  const files: VaultFile[] = [];
  const used = new Set<string>();
  const unique = (base: string) => {
    let name = base, i = 2;
    while (used.has(name.toLowerCase())) name = `${base}_${i++}`;
    used.add(name.toLowerCase());
    return name;
  };
  const noteOf = new Map<string, string>();
  for (const n of data.neurons) noteOf.set(n.id, unique(safeFileName(n.id, 'neuron')));
  const domainNote = new Map<string, string>();
  for (const d of [...new Set(data.neurons.map(n => n.domain || 'general'))].sort()) {
    domainNote.set(d, unique(`index_${safeFileName(d, 'general')}`));
  }
  const nameOf = new Map(data.neurons.map(n => [n.id, n.name] as const));
  const link = (id: string) => (noteOf.has(id) ? `[[${noteOf.get(id)}|${alias(nameOf.get(id) || id)}]]` : `\`${id}\``);

  // Synapses by neuron.
  const links = new Map<string, Array<{ other: string; s: Synapse }>>();
  for (const s of data.synapses) {
    const [a, b] = s.nodes;
    (links.get(a) || links.set(a, []).get(a)!).push({ other: b, s });
    (links.get(b) || links.set(b, []).get(b)!).push({ other: a, s });
  }

  for (const n of data.neurons) {
    const entries = entriesOf(n, data.include_retired);
    const dates = entries.map(e => e.date).filter(Boolean).sort();
    const updated = [n.last_accessed, dates[dates.length - 1]].filter(Boolean).sort().pop();
    const fm = frontmatterBlock({
      crbro_export: EXPORT_FORMAT_VERSION,
      id: n.id, name: n.name, type: n.type, domain: n.domain || 'general',
      tags: n.tags || [], heat: typeof n.heat === 'number' ? Math.round(n.heat * 1000) / 1000 : 0,
      created: n.created || '', updated: updated || '',
      ...(n.archived ? { archived: true } : {}),
      entries: entries.length,
    });
    const lines: string[] = [fm, '', `# ${n.name}`, ''];
    if (n.summary?.trim()) { for (const l of n.summary.trim().split(/\r?\n/)) lines.push(`> ${l}`); lines.push(''); }
    const dn = domainNote.get(n.domain || 'general')!;
    lines.push(`Domain: [[${dn}|${alias(n.domain || 'general')}]] · type \`${n.type}\` · heat ${(n.heat ?? 0).toFixed(2)}${n.archived ? ' · **archived**' : ''}`, '');
    for (const kind of SECTION_ORDER) {
      const group = entries.filter(e => e.kind === kind)
        .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || String(b.date).localeCompare(String(a.date)));
      if (!group.length) continue;
      lines.push(`## ${KIND_TITLES[kind]}`, '');
      for (const e of group) {
        lines.push(entryMarker({ kind: e.kind, id: e.id, status: e.status, ...(e.keywords?.length ? { keywords: e.keywords } : {}) }));
        lines.push(metaLine(e), '');
        lines.push(defuseMarkers(e.text.trim()));
        if (e.rationale?.trim()) lines.push('', ENTRY_WHY, `**Why:** ${defuseMarkers(e.rationale.trim())}`);
        lines.push(ENTRY_END, '');
      }
    }
    const mine = (links.get(n.id) || []).sort((a, b) => b.s.strength - a.s.strength);
    if (mine.length) {
      lines.push('## Synapses', '');
      for (const { other, s } of mine) {
        lines.push(`- ${link(other)} — ${s.type} · strength ${Number(s.strength ?? 0).toFixed(2)}${s.context ? ` · ${s.context.replace(/\s+/g, ' ')}` : ''}`);
      }
      lines.push('');
    }
    files.push({ rel: `neurons/${noteOf.get(n.id)}.md`, content: lines.join('\n') });
  }

  // One index note per domain.
  for (const [d, note] of domainNote) {
    const members = data.neurons.filter(n => (n.domain || 'general') === d).sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0));
    const lines = [frontmatterBlock({ crbro_export: EXPORT_FORMAT_VERSION, domain_index: d, neurons: members.length }), '',
      `# Domain: ${d}`, '', `${members.length} neuron(s), hottest first.`, ''];
    for (const n of members) {
      lines.push(`- ${link(n.id)} — \`${n.type}\` · heat ${(n.heat ?? 0).toFixed(2)} · ${entriesOf(n, data.include_retired).length} entries${n.archived ? ' · archived' : ''}`);
    }
    files.push({ rel: `domains/${note}.md`, content: lines.join('\n') + '\n' });
  }

  // Day logs.
  for (const s of data.sessions) {
    const name = unique(safeFileName(s.session_id, 'session'));
    const lines = [frontmatterBlock({
      crbro_export: EXPORT_FORMAT_VERSION, session_id: s.session_id, date: s.date || '',
      topics: s.topics_touched || [],
    }), '', `# ${s.session_id}`, ''];
    if (s.summary?.trim()) lines.push(s.summary.trim(), '');
    if (s.topics_touched?.length) lines.push(`Topics: ${s.topics_touched.map(link).join(', ')}`, '');
    files.push({ rel: `sessions/${name}.md`, content: lines.join('\n') });
  }

  // Open items.
  const open = (data.context?.pending_tasks || []).map(t => (typeof t === 'string' ? { id: '', text: t, added: '' } as PendingTask : t));
  const closed = data.context?.recently_closed || [];
  const ol = [frontmatterBlock({ crbro_export: EXPORT_FORMAT_VERSION, open_items: open.length }), '', '# Open items', ''];
  if (!open.length) ol.push('_None._', '');
  for (const t of open) {
    ol.push(`- [ ] ${t.text.replace(/\s*\n\s*/g, ' ')}${t.id ? ` · \`${t.id}\`` : ''}${t.added ? ` · added ${day(t.added)}` : ''}${t.due ? ` · due ${t.due}` : ''}${t.project ? ` · project ${t.project}` : ''}`);
  }
  if (closed.length) {
    ol.push('', '## Recently closed', '');
    for (const t of closed) ol.push(`- [x] ${t.text.replace(/\s*\n\s*/g, ' ')}${t.closed ? ` · closed ${day(t.closed)}` : ''}`);
  }
  files.push({ rel: 'open-items.md', content: ol.join('\n') + '\n' });

  // The front page.
  const c = data.counts;
  const home = [
    frontmatterBlock({ crbro_export: EXPORT_FORMAT_VERSION, exported_at: data.exported_at, crbro_version: data.crbro_version }), '',
    '# CRBRO memory', '',
    `Exported ${day(data.exported_at)} by crbro-memory ${data.crbro_version}: ${c.neurons} neurons (${c.archived} archived), ` +
      `${c.entries} entries, ${c.synapses} synapses, ${c.sessions} day logs, ${c.open_items} open items.` +
      (data.include_retired ? ' Retired entries included and marked.' : ' Retired entries left out.'),
    '',
    data.redactions ? `${data.redactions} credential(s) were replaced with a [REDACTED: …] marker on the way out.` : 'No credential was found to redact.',
    '',
    'This folder is a copy. Editing it does not change the brain: to bring changes back, use `crbro-memory import <this folder>`.',
    '', '## Domains', '',
    ...[...domainNote].map(([d, note]) => `- [[${note}|${alias(d)}]]`),
    '', '## Elsewhere', '', '- [[open-items|Open items]]',
    ...(data.sessions.length ? ['', '## Latest day logs', '', ...files.filter(f => f.rel.startsWith('sessions/')).slice(0, 10)
      .map(f => `- [[${path.posix.basename(f.rel, '.md')}]]`)] : []),
    '',
  ];
  files.push({ rel: 'README.md', content: home.join('\n') });
  return files;
}

// ─── Writing ─────────────────────────────────────────────────────

/** Refuse an output folder inside the brain, or one that already holds anything. */
export async function checkOutDir(out: string, brainRoot: string): Promise<string | null> {
  const realOut = await realpathNearest(out);
  const realBrain = await realpathNearest(brainRoot);
  if (isInside(realOut, realBrain)) {
    return `refusing to write inside the brain folder (${realBrain}). Pick a folder outside it with --out.`;
  }
  try {
    const st = await fs.stat(out);
    if (!st.isDirectory()) return `${out} exists and is not a folder.`;
    const inside = await fs.readdir(out);
    if (inside.length) return `${out} is not empty. Export into a new or empty folder.`;
  } catch { /* does not exist: created */ }
  return null;
}

async function writeNew(root: string, rel: string, content: string): Promise<void> {
  const file = path.join(root, ...rel.split('/'));
  // Belt and braces: every relative path is built from safeFileName, but the
  // final check is on the resolved path.
  if (!isInside(file, root) || path.resolve(file) === path.resolve(root)) throw new Error(`unsafe output path: ${rel}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
}

export interface ExportResult { out: string; files: number; data: ExportData; unreadable: string[] }

export async function runExport(opts: {
  brainRoot: string; out: string; format: 'md' | 'json'; includeRetired: boolean;
}): Promise<ExportResult> {
  try {
    const st = await fs.stat(opts.brainRoot);
    if (!st.isDirectory()) throw new Error();
  } catch {
    throw new Error(`no brain at ${opts.brainRoot} (set CRBRO_PATH, or run crbro-memory init).`);
  }
  const problem = await checkOutDir(opts.out, opts.brainRoot);
  if (problem) throw new Error(problem);
  const snap = await readBrain(opts.brainRoot);
  const data = buildExport(snap, opts.includeRetired);
  await fs.mkdir(opts.out, { recursive: true });
  if (opts.format === 'json') {
    await writeNew(opts.out, 'crbro-export.json', JSON.stringify(data, null, 2) + '\n');
    return { out: opts.out, files: 1, data, unreadable: snap.unreadable };
  }
  const files = renderVault(data);
  for (const f of files) await writeNew(opts.out, f.rel, f.content);
  await writeNew(opts.out, VAULT_MARKER, JSON.stringify({
    format: `${EXPORT_FORMAT}-md`, format_version: EXPORT_FORMAT_VERSION, exported_at: data.exported_at,
    crbro_version: data.crbro_version, include_retired: data.include_retired, counts: data.counts,
  }, null, 2) + '\n');
  return { out: opts.out, files: files.length + 1, data, unreadable: snap.unreadable };
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** CLI entry: returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, { out: 'string', format: 'string', 'include-retired': 'boolean' });
  if (a.flags.help) { console.log(EXPORT_HELP); return 0; }
  const format = (a.flags.format as string | undefined) ?? 'md';
  if (format !== 'md' && format !== 'json') a.errors.push('--format must be md or json');
  if (a.positionals.length) a.errors.push(`unexpected argument: ${a.positionals[0]}`);
  if (a.errors.length) {
    console.error(`  ❌ ${a.errors.join('; ')}`);
    console.error('     Usage: crbro-memory export [--out <dir>] [--format md|json] [--include-retired]   (--help for more)');
    return 2;
  }
  const brainRoot = resolveBrainDir();
  const out = path.resolve((a.flags.out as string | undefined) ?? `crbro-export-${stamp()}`);
  try {
    const r = await runExport({ brainRoot, out, format: format as 'md' | 'json', includeRetired: !!a.flags['include-retired'] });
    const c = r.data.counts;
    console.log('');
    console.log(`  ✅ Exported ${c.neurons} neurons, ${c.entries} entries, ${c.synapses} synapses, ${c.sessions} day logs, ${c.open_items} open items`);
    console.log(`     ${format === 'json' ? path.join(r.out, 'crbro-export.json') : `${r.out}  (${r.files} files — open the folder as an Obsidian vault)`}`);
    if (r.data.redactions) console.log(`     ${r.data.redactions} credential(s) redacted on the way out.`);
    if (r.unreadable.length) console.log(`  ⚠️  ${r.unreadable.length} file(s) could not be read and were left out: ${r.unreadable.slice(0, 5).join(', ')}${r.unreadable.length > 5 ? ', …' : ''}`);
    console.log('     The brain was only read. Nothing in it changed.');
    console.log('');
    return 0;
  } catch (err) {
    console.error(`  ❌ export: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
