// ─── crbro-memory import ─────────────────────────────────────────
//
// Bring knowledge in from what already sits on the owner's machine: a
// CLAUDE.md / AGENTS.md, a Claude Code memory folder, or a CRBRO export (JSON
// or the Markdown vault, for round trips). Dry run by default.
//
// Writes go ONLY through MCP tool calls to a CRBRO server this command spawns
// over stdio — never into brain files — so a running daemon stays the single
// writer and learn's validation, redaction and de-duplication all apply.
// Idempotent: before anything is learned, the target neuron's index is read
// and every entry whose content id is already there (live or retired) is left
// alone, so a second run adds nothing and bumps no counter.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { redact } from '../engine/secrets.js';
import { entryId } from '../sync/ops.js';
import { factId } from '../utils/hash.js';
import { inferNeuronType } from '../utils/ids.js';
import type { Neuron, Synapse } from '../types/index.js';
import { parseArgs } from './common.js';
import { parseFrontmatter, splitInstructions, parseVaultEntries } from './markdown.js';
import { EXPORT_FORMAT, VAULT_MARKER, entriesOf } from './export.js';
import { spawnServer, type ToolCaller } from './mcpclient.js';

export const IMPORT_HELP = `
  crbro-memory import <path> [--apply] [--topic <name>] [--type fact|preference|pattern]

  Learn what a file or folder already says. DRY RUN by default: it shows what
  would be learned and into which neuron, and writes nothing. --apply writes.

  <path> can be:
    CLAUDE.md, AGENTS.md or any instructions Markdown
        The single H1 names the document; each H2 becomes a topic
        "<title> — <H2>" (deeper headings stay in their section and lead
        their entries); every bullet, paragraph, table or code block becomes
        one entry, stored as --type (default fact).
    A Claude Code memory folder (Markdown files with name / description /
    metadata.type frontmatter; MEMORY.md, the index, is skipped)
        Every file becomes one entry "<name>: <body>" in one topic,
        "<project> (Claude Code memory)", by type:
          user → preference · feedback → pattern · project → fact · reference → fact
        A body over 1,500 characters is split into its paragraphs.
    A CRBRO export: crbro-export.json, or a folder exported with --format md
        Neurons, entries of every kind (map, summary, tags, synapses) come
        back by name; retired entries are never re-learned.

    --apply            Write. Without it nothing changes.
    --topic <name>     Markdown sources: put everything into this one topic.
    --type <kind>      Markdown sources: fact (default), preference or pattern,
                       overriding the memory-type mapping.

  Writes go through a CRBRO server this command starts (the daemon, when it
  is on), with the same CRBRO_PATH. Importing the same thing twice adds nothing.
`;

// ─── The plan ────────────────────────────────────────────────────

export type LearnKind = 'fact' | 'decision' | 'pattern' | 'preference' | 'error' | 'debt';
const LEARN_KINDS = new Set<string>(['fact', 'decision', 'pattern', 'preference', 'error', 'debt']);

export interface PlannedEntry {
  kind: LearnKind | 'map';
  text: string;
  keywords?: string[];
  rationale?: string;
  confidence?: number;
  shelf_life?: string;
  temporal?: string;
  reference?: { kind: string; value: string; field?: string; project?: string };
}

export interface PlannedTopic {
  topic: string;
  /** The id this neuron had in the export, when it came from one. */
  exportId?: string;
  /** The type it had there; only 'protocol' is steered (see learnTopicOf). */
  type?: string;
  domain?: string;
  summary?: string;
  tags?: string[];
  entries: PlannedEntry[];
  source: string;
}

export interface ImportPlan {
  sourceKind: 'crbro-json' | 'crbro-md' | 'claude-memory' | 'markdown';
  path: string;
  topics: PlannedTopic[];
  synapses: Array<{ from: string; to: string; type: string; strength: number; context: string }>;
  /** Entries present in the source but retired there: never re-learned. */
  skippedRetired: number;
  warnings: string[];
}

export class ImportError extends Error {}

const MAX_MD_BYTES = 5 * 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024 * 1024;
const SYNAPSE_TYPES = new Set(['dependency', 'causal', 'temporal', 'conceptual', 'hierarchy', 'alternative']);
const SHELF = new Set(['volatile', 'normal', 'durable', 'permanent']);

async function readText(file: string, max: number): Promise<string> {
  const st = await fs.stat(file);
  if (st.size > max) throw new ImportError(`${file} is ${Math.round(st.size / 1048576)} MB, over the ${Math.round(max / 1048576)} MB this command reads.`);
  return (await fs.readFile(file, 'utf8')).replace(/^﻿/, '');
}

function cleanReference(r: any): PlannedEntry['reference'] | undefined {
  if (!r || typeof r !== 'object') return undefined;
  if (!['file', 'url', 'person'].includes(r.kind) || typeof r.value !== 'string' || !r.value || r.value.length > 2048) return undefined;
  return {
    kind: r.kind, value: r.value,
    ...(typeof r.field === 'string' && r.field.length <= 256 ? { field: r.field } : {}),
    ...(typeof r.project === 'string' && r.project.length <= 256 ? { project: r.project } : {}),
  };
}

/** A neuron of an export, as topics and entries. Retired entries are counted, not planned. */
function topicFromNeuron(n: Neuron, source: string): { topic: PlannedTopic; retired: number } {
  const all = entriesOf(n, true);
  const live = all.filter(e => e.status === 'active');
  return {
    retired: all.length - live.length,
    topic: {
      topic: n.name, exportId: n.id, type: n.type, domain: n.domain || undefined,
      summary: n.summary || undefined, tags: Array.isArray(n.tags) && n.tags.length ? n.tags : undefined,
      source,
      entries: live.map(e => ({
        kind: e.kind === 'map' ? 'map' : (e.kind as LearnKind),
        text: e.text,
        ...(e.keywords?.length ? { keywords: e.keywords } : {}),
        ...(e.rationale ? { rationale: e.rationale } : {}),
        ...(e.kind === 'fact' && typeof e.confidence === 'number' ? { confidence: e.confidence } : {}),
        ...(e.kind === 'fact' && e.shelf_life && SHELF.has(e.shelf_life) ? { shelf_life: e.shelf_life } : {}),
        ...(e.kind === 'fact' && (e.temporal === 'current' || e.temporal === 'historical') ? { temporal: e.temporal } : {}),
        ...(e.kind === 'fact' && cleanReference(e.reference) ? { reference: cleanReference(e.reference) } : {}),
      })),
    },
  };
}

function synapsesFrom(list: Array<Partial<Synapse>>): ImportPlan['synapses'] {
  const seen = new Set<string>();
  const out: ImportPlan['synapses'] = [];
  for (const s of list) {
    if (!Array.isArray(s.nodes) || s.nodes.length !== 2) continue;
    const [a, b] = s.nodes.map(String);
    if (!a || !b || a === b) continue;
    const key = [a, b].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      from: a, to: b,
      type: SYNAPSE_TYPES.has(String(s.type)) ? String(s.type) : 'conceptual',
      strength: typeof s.strength === 'number' && s.strength >= 0 && s.strength <= 1 ? s.strength : 0.5,
      context: typeof s.context === 'string' ? s.context : '',
    });
  }
  return out;
}

async function planFromJson(file: string): Promise<ImportPlan> {
  let data: any;
  try { data = JSON.parse(await readText(file, MAX_JSON_BYTES)); } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError(`${file} is not valid JSON.`);
  }
  if (data?.format !== EXPORT_FORMAT || !Array.isArray(data?.neurons)) {
    throw new ImportError(`${file} is not a CRBRO export (expected "format": "${EXPORT_FORMAT}").`);
  }
  const plan: ImportPlan = { sourceKind: 'crbro-json', path: file, topics: [], synapses: [], skippedRetired: 0, warnings: [] };
  for (const n of data.neurons) {
    if (!n || typeof n.id !== 'string' || typeof n.name !== 'string') { plan.warnings.push('a neuron without id or name was skipped'); continue; }
    const { topic, retired } = topicFromNeuron(n as Neuron, file);
    plan.skippedRetired += retired;
    if (topic.entries.length || topic.summary) plan.topics.push(topic);
  }
  plan.synapses = synapsesFrom(Array.isArray(data.synapses) ? data.synapses : []);
  return plan;
}

const SYNAPSE_LINE = /^- \[\[([^|\]]+)(?:\|[^\]]*)?\]\] — ([a-z]+) · strength ([\d.]+)(?: · (.*))?$/;

async function planFromVault(dir: string): Promise<ImportPlan> {
  const plan: ImportPlan = { sourceKind: 'crbro-md', path: dir, topics: [], synapses: [], skippedRetired: 0, warnings: [] };
  const neuronsDir = path.join(dir, 'neurons');
  let names: string[] = [];
  try { names = (await fs.readdir(neuronsDir)).filter(n => n.endsWith('.md')).sort(); } catch {
    throw new ImportError(`${dir} has no neurons/ folder: not a CRBRO Markdown export.`);
  }
  const noteToId = new Map<string, string>();
  const rawLinks: Array<{ fromId: string; note: string; type: string; strength: number; context: string }> = [];
  for (const name of names) {
    const file = path.join(neuronsDir, name);
    const fm = parseFrontmatter(await readText(file, MAX_MD_BYTES));
    if (!fm.present || fm.data.crbro_export === undefined || typeof fm.data.id !== 'string') {
      plan.warnings.push(`neurons/${name} is not an exported neuron note; skipped`);
      continue;
    }
    const id = fm.data.id;
    noteToId.set(path.basename(name, '.md'), id);
    const entries = parseVaultEntries(fm.body);
    const live = entries.filter(e => e.status === 'active');
    plan.skippedRetired += entries.length - live.length;
    // The summary is the quote block right under the title.
    const summaryLines: string[] = [];
    let afterTitle = false;
    for (const line of fm.body.replace(/\r\n?/g, '\n').split('\n')) {
      if (!afterTitle) { if (/^# /.test(line)) afterTitle = true; continue; }
      if (!line.trim() && !summaryLines.length) continue;
      if (line.startsWith('> ') || line === '>') { summaryLines.push(line.replace(/^> ?/, '')); continue; }
      break;
    }
    let inSynapses = false;
    for (const line of fm.body.replace(/\r\n?/g, '\n').split('\n')) {
      if (/^## /.test(line)) { inSynapses = line.trim() === '## Synapses'; continue; }
      if (!inSynapses) continue;
      const m = SYNAPSE_LINE.exec(line.trim());
      if (m) rawLinks.push({ fromId: id, note: m[1], type: m[2], strength: Number(m[3]), context: m[4] || '' });
    }
    const topic: PlannedTopic = {
      topic: typeof fm.data.name === 'string' && fm.data.name ? fm.data.name : id,
      exportId: id,
      type: typeof fm.data.type === 'string' ? fm.data.type : undefined,
      domain: typeof fm.data.domain === 'string' && fm.data.domain ? fm.data.domain : undefined,
      summary: summaryLines.join('\n').trim() || undefined,
      tags: Array.isArray(fm.data.tags) && fm.data.tags.length ? fm.data.tags.map(String) : undefined,
      source: file,
      entries: live.map(e => ({
        kind: (e.kind === 'map' ? 'map' : LEARN_KINDS.has(e.kind) ? e.kind : 'fact') as PlannedEntry['kind'],
        text: e.text,
        ...(e.keywords?.length ? { keywords: e.keywords } : {}),
        ...(e.rationale ? { rationale: e.rationale } : {}),
      })),
    };
    if (topic.entries.length || topic.summary) plan.topics.push(topic);
  }
  plan.synapses = synapsesFrom(rawLinks
    .filter(l => noteToId.has(l.note))
    .map(l => ({ nodes: [l.fromId, noteToId.get(l.note)!] as [string, string], type: l.type as any, strength: l.strength, context: l.context, id: '', co_access_count: 0, last_co_access: '' })));
  return plan;
}

/** user → preference · feedback → pattern · project, reference and anything else → fact. */
export function memoryKind(type: unknown): LearnKind {
  switch (String(type ?? '').toLowerCase()) {
    case 'user': return 'preference';
    case 'feedback': return 'pattern';
    default: return 'fact';
  }
}

/** The project a Claude Code memory folder belongs to: …/projects/<encoded cwd>/memory → its last path segment. */
export function memoryProjectName(dir: string): string {
  const abs = path.resolve(dir);
  const parent = path.basename(path.dirname(abs));
  if (path.basename(abs).toLowerCase() === 'memory' && path.basename(path.dirname(path.dirname(abs))).toLowerCase() === 'projects') {
    const parts = parent.split('-').filter(Boolean);
    return parts[parts.length - 1] || parent;
  }
  return path.basename(abs);
}

const MEMORY_SPLIT_CHARS = 1_500;

async function memoryFiles(dir: string): Promise<Array<{ file: string; fm: ReturnType<typeof parseFrontmatter> }>> {
  const out: Array<{ file: string; fm: ReturnType<typeof parseFrontmatter> }> = [];
  let names: string[] = [];
  try { names = (await fs.readdir(dir)).filter(n => n.toLowerCase().endsWith('.md')).sort(); } catch { return out; }
  for (const n of names) {
    if (n.toLowerCase() === 'memory.md') continue;     // the index of the folder, not a memory
    const file = path.join(dir, n);
    try {
      if (!(await fs.lstat(file)).isFile()) continue;
      const fm = parseFrontmatter(await readText(file, MAX_MD_BYTES));
      if (fm.present && (typeof fm.data.name === 'string' || typeof fm.data.description === 'string')) out.push({ file, fm });
    } catch { /* unreadable: not a memory file */ }
  }
  return out;
}

async function planFromMemoryFolder(dir: string, files: Awaited<ReturnType<typeof memoryFiles>>, opts: { topic?: string; type?: LearnKind }): Promise<ImportPlan> {
  const plan: ImportPlan = { sourceKind: 'claude-memory', path: dir, topics: [], synapses: [], skippedRetired: 0, warnings: [] };
  const topic: PlannedTopic = { topic: opts.topic || `${memoryProjectName(dir)} (Claude Code memory)`, entries: [], source: dir };
  for (const { file, fm } of files) {
    const name = String(fm.data.name || path.basename(file, '.md')).trim();
    const description = typeof fm.data.description === 'string' ? fm.data.description.trim() : '';
    const metaType = (fm.data.metadata && typeof fm.data.metadata === 'object' ? fm.data.metadata.type : undefined) ?? fm.data.type;
    const kind = opts.type ?? memoryKind(metaType);
    const body = fm.body.trim();
    if (!body && !description) continue;
    if (body.length <= MEMORY_SPLIT_CHARS) {
      topic.entries.push({ kind, text: `${name}: ${body || description}` });
    } else {
      for (const section of splitInstructions(body, name)) {
        for (const e of section.entries) topic.entries.push({ kind, text: `${name}: ${e}` });
      }
    }
  }
  if (topic.entries.length) plan.topics.push(topic);
  else plan.warnings.push('no memory file with content was found');
  return plan;
}

/** The name a document's untitled part goes under: the folder of a CLAUDE.md / AGENTS.md, else the file name. */
export function documentRootName(file: string): string {
  const stem = path.basename(file, path.extname(file));
  if (/^(claude|agents|gemini|copilot-instructions)$/i.test(stem)) {
    const folder = path.basename(path.dirname(path.resolve(file)));
    return folder && folder !== '.' ? folder : stem;
  }
  return stem;
}

async function planFromMarkdownFile(file: string, opts: { topic?: string; type?: LearnKind }): Promise<ImportPlan> {
  const text = await readText(file, MAX_MD_BYTES);
  const fm = parseFrontmatter(text);
  const plan: ImportPlan = { sourceKind: 'markdown', path: file, topics: [], synapses: [], skippedRetired: 0, warnings: [] };
  const kind = opts.type ?? 'fact';
  const sections = splitInstructions(fm.body, documentRootName(file));
  if (opts.topic) {
    const all = sections.flatMap(s => s.entries);
    if (all.length) plan.topics.push({ topic: opts.topic, entries: all.map(t => ({ kind, text: t })), source: file });
  } else {
    for (const s of sections) plan.topics.push({ topic: s.topic, entries: s.entries.map(t => ({ kind, text: t })), source: file });
  }
  if (!plan.topics.length) plan.warnings.push('the file holds no paragraph, bullet or block to learn');
  return plan;
}

/** Look at `p` and build the plan. Reads only the source; the brain is not involved yet. */
export async function buildPlan(p: string, opts: { topic?: string; type?: LearnKind } = {}): Promise<ImportPlan> {
  let st;
  try { st = await fs.stat(p); } catch { throw new ImportError(`${p} does not exist.`); }
  const crbroOnly = () => {
    if (opts.topic || opts.type) throw new ImportError('--topic and --type apply to Markdown sources, not to a CRBRO export: its neurons and kinds are kept.');
  };
  if (st.isFile()) {
    const ext = path.extname(p).toLowerCase();
    if (ext === '.json') { crbroOnly(); return planFromJson(p); }
    if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
      const fm = parseFrontmatter(await readText(p, MAX_MD_BYTES));
      if (fm.present && fm.data.crbro_export !== undefined) {
        throw new ImportError(`${p} is one note of an exported vault: import the vault folder instead.`);
      }
      if (fm.present && typeof fm.data.name === 'string' && (fm.data.metadata?.type || fm.data.type)) {
        return planFromMemoryFolder(path.dirname(p), [{ file: p, fm }], opts);
      }
      return planFromMarkdownFile(p, opts);
    }
    throw new ImportError(`${p}: expected a .md, .json or a folder.`);
  }
  if (!st.isDirectory()) throw new ImportError(`${p} is neither a file nor a folder.`);
  const has = async (rel: string) => fs.stat(path.join(p, rel)).then(() => true, () => false);
  if (await has('crbro-export.json')) { crbroOnly(); return planFromJson(path.join(p, 'crbro-export.json')); }
  if (await has(VAULT_MARKER) || await has(path.join('neurons'))) { crbroOnly(); return planFromVault(p); }
  const files = await memoryFiles(p);
  if (files.length) return planFromMemoryFolder(p, files, opts);
  throw new ImportError(`${p} is not a CRBRO export or a Claude Code memory folder. For a CLAUDE.md, pass the file itself.`);
}

// ─── Against the brain ───────────────────────────────────────────

interface TargetState {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  ids: Set<string>;
  hasMap: boolean;
  connections: Set<string>;
}

/** The id an entry will have once stored: learn trims nothing, so we trim first and redact like it does. */
export function storedId(e: PlannedEntry): string {
  if (e.kind === 'map') return 'map';
  const stored = redact(e.text.trim()).text;
  return e.kind === 'fact' ? factId(stored) : entryId(stored);
}

/**
 * The topic name learn should create a neuron under. Only protocols matter:
 * boot injects neurons whose id starts with protocol_, and learn infers the
 * type from the name, so a protocol whose name does not say so would come
 * back as a project. Adding the word steers the inference.
 */
export function learnTopicOf(t: PlannedTopic): string {
  if (t.type === 'protocol' && inferNeuronType(t.topic) !== 'protocol' && inferNeuronType(`${t.topic} protocol`) === 'protocol') {
    return `${t.topic} protocol`;
  }
  return t.topic;
}

/** A protocol whose name steers the inference elsewhere (a tech or process word in it) cannot come back as one. */
export function protocolLost(t: PlannedTopic): boolean {
  return t.type === 'protocol' && inferNeuronType(learnTopicOf(t)) !== 'protocol';
}

async function readTarget(caller: ToolCaller, ref: string): Promise<TargetState | null> {
  const state: TargetState = { id: '', name: '', summary: '', tags: [], ids: new Set(), hasMap: false, connections: new Set() };
  let offset = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const r = await caller.call('crbro_inspect', { view: 'neuron', neuron: ref, include_superseded: true, limit: 40, offset });
    const n = r.data?.neuron ?? r.data;
    if (!r.ok || !n || typeof n.id !== 'string') {
      if (offset === 0) return null;
      throw new Error(`reading ${ref} failed half-way: ${r.text.slice(0, 200)}`);
    }
    if (offset === 0) {
      state.id = n.id; state.name = n.name; state.summary = n.summary || '';
      state.tags = Array.isArray(n.tags) ? n.tags : [];
      for (const c of n.connections || []) if (c?.target_id) state.connections.add(c.target_id);
    }
    const rows: any[] = Array.isArray(n.entries) ? n.entries : [];
    for (const row of rows) {
      if (row.kind === 'map') state.hasMap = true;
      if (typeof row.id === 'string') state.ids.add(row.id);
    }
    if (!n.entries_pagination?.has_more || rows.length === 0) break;
    offset += rows.length;
  }
  return state;
}

/** Find the neuron a topic lands in: its export id, then the name learn will use, then its own name. */
async function resolveTarget(caller: ToolCaller, t: PlannedTopic): Promise<TargetState | null> {
  const refs = [t.exportId, learnTopicOf(t), t.topic].filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
  for (const ref of refs) {
    const s = await readTarget(caller, ref);
    if (s) return s;
  }
  return null;
}

export interface TopicReport {
  topic: string;
  target: string | null;       // existing neuron id, or null for a new one
  fresh: PlannedEntry[];       // what will be (or was) learned
  present: number;             // already in the brain
  summary: boolean;            // summary to set
  tags: boolean;
}

export interface ImportReport {
  plan: ImportPlan;
  applied: boolean;
  topics: TopicReport[];
  learned: number;
  maps: number;
  connected: number;
  skippedRetiredByServer: number;
  failures: string[];
}

/** Compare the plan with the brain and, with apply, write the difference. */
export async function executePlan(caller: ToolCaller, plan: ImportPlan, apply: boolean): Promise<ImportReport> {
  const report: ImportReport = { plan, applied: apply, topics: [], learned: 0, maps: 0, connected: 0, skippedRetiredByServer: 0, failures: [] };
  // A brain that was never initialized has no manifest, and learn would leave
  // half-made neurons behind. Initializing is `init`'s job (or a client's
  // first boot), not an import side effect: say so before writing anything.
  const status = await caller.call('crbro_inspect', { view: 'status' });
  if (!status.ok) {
    const why = /not initialized/i.test(status.text)
      ? 'this brain has not been initialized yet. Run `crbro-memory init` (or start any CRBRO client once) first.'
      : `the CRBRO server could not read the brain: ${status.text.slice(0, 200)}`;
    if (apply) throw new ImportError(`nothing was written: ${why}`);
    plan.warnings.push(why);
  }
  const idMap = new Map<string, string>();          // export id → id in this brain
  const connectionsOf = new Map<string, Set<string>>();

  for (const t of plan.topics) {
    const target = await resolveTarget(caller, t);
    const seen = new Set(target?.ids ?? []);
    const fresh: PlannedEntry[] = [];
    let present = 0;
    for (const e of t.entries) {
      if (!e.text.trim()) continue;
      const id = storedId(e);
      const already = e.kind === 'map' ? (target?.hasMap || seen.has('map')) : seen.has(id);
      if (already) { present++; continue; }
      seen.add(id);
      fresh.push(e);
    }
    const tr: TopicReport = {
      topic: t.topic, target: target?.id ?? null, fresh, present,
      summary: !!t.summary && !target?.summary,
      tags: !!t.tags?.length && !(target?.tags?.length),
    };
    report.topics.push(tr);
    if (!target && fresh.length && protocolLost(t)) {
      plan.warnings.push(`"${t.topic}" was a protocol in the export, but crbro_learn infers the type from the name and this one ` +
        `reads as a ${inferNeuronType(learnTopicOf(t))}: it comes back as an ordinary neuron, and boot will not inject it. ` +
        'Recreate it under a name with the word "protocol" and no technology or process word.');
    }
    if (target && t.exportId) idMap.set(t.exportId, target.id);
    if (target) connectionsOf.set(target.id, target.connections);
    if (!apply) continue;

    let neuronId = target?.id;
    const learnTopic = learnTopicOf(t);
    for (const e of fresh) {
      if (e.kind === 'map') continue;   // after the entries, so the neuron exists with its proper type
      const args: Record<string, unknown> = {
        topic: learnTopic, type: e.kind, content: e.text.trim(),
        ...(neuronId ? { neuron_id: neuronId } : {}),
        ...(t.domain ? { domain: t.domain } : {}),
        ...(e.kind === 'decision' && e.rationale ? { rationale: e.rationale } : {}),
        ...(e.kind === 'fact' && e.keywords?.length ? { keywords: e.keywords } : {}),
        ...(e.kind === 'fact' && typeof e.confidence === 'number' ? { confidence: e.confidence } : {}),
        ...(e.kind === 'fact' && e.shelf_life ? { shelf_life: e.shelf_life } : {}),
        ...(e.kind === 'fact' && e.temporal ? { temporal: e.temporal } : {}),
        ...(e.kind === 'fact' && e.reference ? { reference: e.reference } : {}),
      };
      const r = await caller.call('crbro_learn', args);
      if (!r.ok || !r.data?.neuron_id) {
        report.failures.push(`${t.topic}: ${e.kind} "${preview(redact(e.text).text, 60)}" — ${r.text.slice(0, 200)}`);
        continue;
      }
      neuronId = r.data.neuron_id;
      if (r.data.action === 'skipped_retired') report.skippedRetiredByServer++;
      else report.learned++;
    }
    const map = fresh.find(e => e.kind === 'map');
    if (map) {
      const r = await caller.call('crbro_map', { neuron: neuronId ?? learnTopic, content: map.text.trim(), ...(t.domain ? { domain: t.domain } : {}) });
      if (r.ok) {
        report.maps++;
        if (!neuronId && typeof r.data?.neuron_id === 'string') neuronId = r.data.neuron_id;
      } else report.failures.push(`${t.topic}: map — ${r.text.slice(0, 200)}`);
    }
    if (!neuronId && (tr.summary || tr.tags)) {
      // Nothing new to learn but metadata to carry: the neuron must exist first.
      const s = await readTarget(caller, learnTopic);
      neuronId = s?.id;
    }
    if (neuronId) {
      const revise: Record<string, unknown> = {};
      if (tr.summary) revise.summary = t.summary;
      if (tr.tags) revise.tags = t.tags;
      // A protocol created under "<name> protocol" gets its own name back; the id keeps the prefix boot needs.
      if (!target && learnTopic !== t.topic) revise.name = t.topic;
      if (Object.keys(revise).length) {
        const r = await caller.call('crbro_revise', { neuron: neuronId, ...revise });
        if (!r.ok) report.failures.push(`${t.topic}: summary/tags — ${r.text.slice(0, 200)}`);
      }
      if (t.exportId) idMap.set(t.exportId, neuronId);
      if (!connectionsOf.has(neuronId)) connectionsOf.set(neuronId, new Set());
    }
  }

  // Synapses, between neurons that both made it.
  if (apply) {
    for (const s of plan.synapses) {
      const a = idMap.get(s.from), b = idMap.get(s.to);
      if (!a || !b || a === b) continue;
      if (connectionsOf.get(a)?.has(b) || connectionsOf.get(b)?.has(a)) continue;
      const r = await caller.call('crbro_connect', { from: a, to: b, type: s.type, strength: s.strength, ...(s.context ? { context: s.context } : {}) });
      if (r.ok) {
        report.connected++;
        connectionsOf.get(a)?.add(b);
        connectionsOf.get(b)?.add(a);
      } else report.failures.push(`synapse ${a} ↔ ${b} — ${r.text.slice(0, 200)}`);
    }
  }
  return report;
}

const preview = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const SOURCE_LABEL: Record<ImportPlan['sourceKind'], string> = {
  'crbro-json': 'CRBRO export (JSON)',
  'crbro-md': 'CRBRO export (Markdown vault)',
  'claude-memory': 'Claude Code memory folder',
  markdown: 'instructions Markdown',
};

export function formatReport(r: ImportReport, maxLines = 200): string {
  const out: string[] = [''];
  out.push(`  ${r.applied ? 'Import' : 'Dry run'}: ${r.plan.path}  (${SOURCE_LABEL[r.plan.sourceKind]})`);
  if (!r.applied) out.push('  Nothing is written. Add --apply to write what is listed below.');
  out.push('');
  let lines = 0, hidden = 0;
  for (const t of r.topics) {
    const where = t.target ? `existing neuron ${t.target}` : 'new neuron';
    const extras = [t.summary ? 'summary' : '', t.tags ? 'tags' : ''].filter(Boolean).join(', ');
    out.push(`  → "${t.topic}" (${where}): ${t.fresh.length} new, ${t.present} already there${extras ? ` · sets ${extras}` : ''}`);
    for (const e of t.fresh) {
      if (lines >= maxLines) { hidden++; continue; }
      out.push(`      + ${e.kind}: ${preview(redact(e.text).text, 100)}`);
      lines++;
    }
  }
  if (hidden) out.push(`      … and ${hidden} more`);
  const fresh = r.topics.reduce((s, t) => s + t.fresh.length, 0);
  const present = r.topics.reduce((s, t) => s + t.present, 0);
  const newNeurons = r.topics.filter(t => !t.target && (t.fresh.length || t.summary)).length;
  out.push('');
  out.push(`  ${r.applied ? 'Learned' : 'Would learn'} ${r.applied ? r.learned + r.maps : fresh} entr${(r.applied ? r.learned + r.maps : fresh) === 1 ? 'y' : 'ies'} in ${r.topics.filter(t => t.fresh.length).length} topic(s) (${newNeurons} new neuron(s)); ${present} already in the brain.`);
  if (r.plan.skippedRetired) out.push(`  ${r.plan.skippedRetired} retired entr${r.plan.skippedRetired === 1 ? 'y' : 'ies'} in the source left out: retired knowledge is never re-learned.`);
  if (r.plan.synapses.length) out.push(`  Synapses in the source: ${r.plan.synapses.length}${r.applied ? `; ${r.connected} connected now` : ' (connected on --apply when both ends exist)'}.`);
  if (r.skippedRetiredByServer) out.push(`  ${r.skippedRetiredByServer} matched an entry this brain had retired and were not stored.`);
  for (const w of r.plan.warnings) out.push(`  ⚠️  ${w}`);
  for (const f of r.failures.slice(0, 20)) out.push(`  ❌ ${f}`);
  if (r.failures.length > 20) out.push(`  ❌ … and ${r.failures.length - 20} more failures`);
  out.push('');
  return out.join('\n');
}

/** CLI entry: returns the exit code. */
export async function main(argv: string[], deps: { connect?: () => Promise<ToolCaller> } = {}): Promise<number> {
  const a = parseArgs(argv, { apply: 'boolean', topic: 'string', type: 'string' });
  if (a.flags.help) { console.log(IMPORT_HELP); return 0; }
  const type = a.flags.type as string | undefined;
  if (type !== undefined && !['fact', 'preference', 'pattern'].includes(type)) a.errors.push('--type must be fact, preference or pattern');
  const topic = typeof a.flags.topic === 'string' ? a.flags.topic.trim() : undefined;
  if (a.flags.topic !== undefined && !topic) a.errors.push('--topic needs a name');
  if (a.positionals.length !== 1) a.errors.push(a.positionals.length ? 'one path at a time' : 'missing <path>');
  if (a.errors.length) {
    console.error(`  ❌ ${a.errors.join('; ')}`);
    console.error('     Usage: crbro-memory import <path> [--apply] [--topic <name>] [--type fact|preference|pattern]   (--help for more)');
    return 2;
  }
  let plan: ImportPlan;
  try {
    plan = await buildPlan(path.resolve(a.positionals[0]), { topic, type: type as LearnKind | undefined });
  } catch (err) {
    console.error(`  ❌ import: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  let caller: ToolCaller | null = null;
  try {
    caller = await (deps.connect ? deps.connect() : spawnServer());
    const report = await executePlan(caller, plan, !!a.flags.apply);
    console.log(formatReport(report));
    return report.failures.length ? 1 : 0;
  } catch (err) {
    console.error(`  ❌ import: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await caller?.close();
  }
}
