// ─── Memory that speaks at the moment of action (2.5) ────────────
//
// Recall is pull-only: a lesson is found when somebody thinks to ask. The
// error ledger holds the opposite kind of knowledge — "deployed without
// pulling first and resurrected a deleted file" is worth nothing in answer
// to a question nobody asks, and everything one second before the next
// `firebase deploy`. On the reference brain the same mistake was recorded
// twice, weeks apart, by sessions that never recalled it.
//
// This module derives a small lookup from the ledgers: command → the errors,
// debts and patterns that mention it. It is written next to the search index
// (derived data, never backed up, rebuilt at every consolidate) so that a
// PreToolUse hook can answer in milliseconds without loading a 40 MB index
// or a model. The smart half lives here, where it is tested; the hook only
// looks keys up, so the two cannot drift apart.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readJSON, writeJSON, listJSONFiles, now } from '../utils/fs.js';
import { entryId } from '../sync/ops.js';
import type { Brain } from './brain.js';
import type { Neuron } from '../types/index.js';

// 2: path: keys, so exploring a project wakes its lessons. 3 (2.11): each entry
// says which projects it belongs to (p) and, when it is not the user's own,
// where it came from (o); `projects` maps a folder or alias to its project.
export const TRIGGER_INDEX_VERSION = 3;
export const TRIGGER_FILE = 'triggers.json';
const PREVIEW = 320;
/** Lessons handed over per command. More than this is a lecture, and lectures get skimmed. */
export const MAX_LESSONS = 3;

export interface TriggerEntry {
  /** neuron id · neuron name · entry id · kind · day recorded ('' when undated) · opening of the text */
  n: string; name: string; e: string; k: 'error' | 'debt' | 'pattern'; d: string; t: string;
  /** The projects its neuron belongs to (ids of projects.json); absent = no project, it may speak anywhere. */
  p?: string[];
  /** Where it came from when it is not the user's own: 'team:<author>' or 'miner' (entry_source). */
  o?: string;
}
export interface TriggerIndex {
  v: number;
  built: string;
  /** "firebase deploy" → positions in `entries`. */
  keys: Record<string, number[]>;
  entries: TriggerEntry[];
  /** A folder name or alias (lower-cased) → its project id, from projects.json. */
  projects?: Record<string, string>;
}

/** What the guard reads from the brain's project registry (projects.json). */
export interface ProjectsFile {
  projects?: Record<string, { id?: string; aliases?: string[]; neurons?: string[] }>;
}

/**
 * Subcommands that only look: `git status`, `gh repo view`… A lesson that
 * mentions one in passing ("after git status showed…") is not about running it,
 * so prose never makes a key of these — only a command in backticks does. They
 * were most of the guard's noise: `git status` in one repo woke three lessons
 * about another project because each said "git status" somewhere.
 */
const READ_ONLY = new Set(('git status|git log|git branch|git diff|git show|git remote|git config|git rev-parse|git ls-files|git blame|'
  + 'gh repo view|gh pr view|gh pr list|gh pr status|gh pr checks|gh issue view|gh issue list|gh run list|gh run view|gh release view|gh release list|gh api|'
  + 'npm ls|npm view|npm list|npm outdated|docker ps|docker images|docker logs|kubectl get|kubectl describe|kubectl logs|'
  + 'gcloud config|aws sts|node --version|npm --version|python --version').split('|'));

/** Programs whose next word names the action. Anything else needs backticks or a script name to count. */
const HEADS = new Set(('git npm npx pnpm yarn bun bunx node deno python python3 py pip pipx uv firebase gcloud gsutil gh docker '
  + 'kubectl helm terraform wp composer php supabase vercel netlify wrangler aws az ssh scp rsync curl wget robocopy '
  + 'powershell pwsh psql mysql sqlite3 redis-cli cargo go make tsc vitest jest eslint prettier rm mv cp chmod chown '
  + 'systemctl crontab certbot nginx pm2 stripe heroku flyctl railway expo adb brew apt apt-get choco winget scoop '
  + 'crbro claude codex').split(' '));
/** Run something else: the word after them is the real program. */
const WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'sudo', 'time', 'call', 'exec', 'start']);
/** Run a file: the file is the action. */
const INTERPRETERS = new Set(['node', 'deno', 'bun', 'python', 'python3', 'py', 'bash', 'sh', 'zsh', 'powershell', 'pwsh', 'tsx', 'ts-node', 'php', 'ruby', 'perl']);
/** Two words that still name nothing: `npm run` is not an action, `npm run build` is. */
const DEEP = new Set(('npm run|yarn run|pnpm run|bun run|docker compose|wp plugin|wp post|wp option|wp theme|wp user|wp cache|wp db|'
  + 'gh pr|gh issue|gh repo|gh release|gh run|gcloud run|gcloud auth|gcloud functions|gcloud app|git remote').split('|'));
/** A flag names an action only where it changes what the program does to your files. `curl -s` and `grep -n` are not lessons. */
const FLAG_PAIRS = new Set(['rm -rf', 'rm -r', 'rm -fr', 'git -c', 'cp -r', 'node --check', 'node -e', 'python -c', 'python -m', 'python3 -m', 'npx -y']);
const SCRIPT = /\.(ps1|sh|bash|py|mjs|cjs|js|ts|bat|cmd|rb|php)$/;
/** After a program's name in a sentence these are grammar, not a subcommand ("python en Windows", "git is"). */
const PROSE = new Set(('a al con de del el en es la las lo los no o para por que se si sin su un una y ya '
  + 'and are as at but by can does for from has in is it not of on or so that the to was when with').split(' '));
const SUBCOMMAND = /^(?:[a-z][a-z0-9:_-]*|-{1,2}[a-z][a-z0-9-]*)$/;

/** A shell word as a key part: unquoted, lower-cased, path stripped. */
function word(raw: string): string {
  const w = raw.replace(/^["'`(]+|["'`),;:.]+$/g, '').toLowerCase();
  if (!w || w.startsWith('-')) return w;
  return w.split(/[\\/]/).pop() || w;   // "scripts/x.ps1" and ".\x.ps1" are both "x.ps1"
}

/**
 * A heredoc body is data, not commands: a Python script fed through <<'EOF'
 * named every file it mentioned and woke lessons that had nothing to do with
 * the command. Procedural on purpose — no backreferences to get wrong.
 */
function stripHeredocs(command: string): string {
  const out: string[] = [];
  let end: string | null = null;
  for (const line of command.split('\n')) {
    if (end !== null) { if (line.trim() === end) end = null; continue; }
    out.push(line);
    const m = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (m) end = m[1];
  }
  return out.join('\n');
}

/**
 * The project folders a text walks into, as `path:<folder>` keys.
 *
 * Command keys only fire on the program being run, so the first commands of a
 * task — `ls`, `find`, `grep -r` over someone's repo — woke nothing, and the
 * lesson about that repo arrived ten commands late, once a `git` line finally
 * matched. A folder name is what those commands and the lesson have in common.
 *
 * Only hyphenated segments of six characters or more count (`crbro-memory`,
 * `synthetica-decks`): plain words like `projects`, `src` or `docs` name
 * everything and would wake everything.
 */
function pathKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9._-]{2,}[\\/][A-Za-z0-9._\\/-]{2,}/g)) {
    for (const seg of m[0].split(/[\\/]+/)) {
      const s = seg.toLowerCase();
      if (s.length >= 6 && s.includes('-') && !/^-|-$/.test(s) && !/\.[a-z0-9]{1,5}$/.test(s)) keys.add(`path:${s}`);
    }
  }
  return [...keys];
}

/**
 * The keys a COMMAND LINE asks about. Deliberately dumb and mirrored in
 * hooks/crbro-guard.mjs: per segment, the program and its next word, the word
 * after a wrapper, and a script when it is what runs, plus the project folders
 * it touches.
 */
export function keysOfCommand(command: string): string[] {
  const keys = new Set<string>();
  const body = stripHeredocs(command);
  for (const k of pathKeys(body)) keys.add(k);
  for (const segment of stripHeredocs(command).split(/&&|\|\||[;|\n]/)) {
    let t = segment.trim().split(/\s+/).map(word).filter(Boolean);
    while (t.length && (/^[a-z_][a-z0-9_]*=/.test(t[0]) || t[0] === '&' || WRAPPERS.has(t[0]))) {
      if (WRAPPERS.has(t[0]) && t[1] && !t[1].startsWith('-')) keys.add(`${t[0]} ${t[1]}`);
      t = t.slice(1);
    }
    if (t.length === 0) continue;
    if (SCRIPT.test(t[0])) keys.add(t[0]);
    if (t[1]) {
      const pair = `${t[0]} ${t[1]}`;
      if (!t[1].startsWith('-') || FLAG_PAIRS.has(pair)) keys.add(DEEP.has(pair) && t[2] && !t[2].startsWith('-') ? `${pair} ${t[2]}` : pair);
      if (INTERPRETERS.has(t[0])) {
        const file = t.slice(1).find(x => !x.startsWith('-'));
        if (file && SCRIPT.test(file)) keys.add(file);
      }
    }
  }
  return [...keys];
}

/**
 * The keys an ENTRY answers to: what it shows in backticks, the known
 * programs it names with their next word, and every script it mentions.
 * Prose makes junk keys ("git para") — harmless, no command line spells them.
 */
export function keysOfEntry(text: string): string[] {
  const keys = new Set<string>();
  for (const k of pathKeys(text)) keys.add(k);
  for (const m of text.matchAll(/`([^`\n]{2,200})`/g)) for (const k of keysOfCommand(m[1])) keys.add(k);
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = word(words[i]);
    if (SCRIPT.test(w) && w.length >= 5) keys.add(w);
    if (!HEADS.has(w)) continue;
    const next = word(words[i + 1] || '');
    if (!next || !SUBCOMMAND.test(next) || PROSE.has(next)) continue;
    const third = word(words[i + 2] || '');
    const key = DEEP.has(`${w} ${next}`) && third && SUBCOMMAND.test(third) && !third.startsWith('-') && !PROSE.has(third) ? `${w} ${next} ${third}` : `${w} ${next}`;
    if (READ_ONLY.has(key)) continue;   // from backticks only
    keys.add(key);
  }
  // A script is only a trigger as the thing that runs; a program pair needs a known program.
  return [...keys].filter(k => k.startsWith('path:') || (k.includes(' ') ? HEADS.has(k.split(' ')[0]) || WRAPPERS.has(k.split(' ')[0]) : SCRIPT.test(k)));
}

/** "C:\\Work\\Shop-Site" and "shop_site" alike: lower case, every run of other characters one dash. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Alias → project id, and neuron id → its projects. A neuron belongs to a
 * project when the registry binds it (crbro_boot project_neurons), or when
 * its id or name spells the project's folder name as whole words
 * (`project_shop_site` and the alias `shop-site`). Aliases shorter than four
 * characters name too much to count by name.
 */
export function projectMaps(registry: ProjectsFile | null | undefined, neurons: Neuron[]) {
  const aliases: Record<string, string> = {};
  const byNeuron = new Map<string, Set<string>>();
  const named: Array<{ id: string; token: string }> = [];
  for (const [key, p] of Object.entries(registry?.projects ?? {})) {
    const id = typeof p?.id === 'string' ? p.id : key;
    for (const a of [id, ...(Array.isArray(p?.aliases) ? p.aliases : [])]) {
      if (typeof a !== 'string' || !a) continue;
      const lower = a.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
      aliases[lower] = id;
      const base = lower.split('/').pop() || lower;
      aliases[base] ??= id;
      const token = slug(base);
      if (token.length >= 4 && !token.startsWith('project-')) named.push({ id, token });
    }
    for (const n of Array.isArray(p?.neurons) ? p.neurons : []) {
      if (!byNeuron.has(n)) byNeuron.set(n, new Set());
      byNeuron.get(n)!.add(id);
    }
  }
  for (const n of neurons) {
    if (!n?.id) continue;
    const words = `-${slug(n.id)}-${slug(n.name || '')}-`;
    for (const { id, token } of named) {
      if (words.includes(`-${token}-`)) {
        if (!byNeuron.has(n.id)) byNeuron.set(n.id, new Set());
        byNeuron.get(n.id)!.add(id);
      }
    }
  }
  return { aliases, byNeuron };
}

export function buildTriggerIndex(neurons: Neuron[], builtAt: string = now(), registry?: ProjectsFile | null): TriggerIndex {
  const index: TriggerIndex = { v: TRIGGER_INDEX_VERSION, built: builtAt, keys: {}, entries: [] };
  const { aliases, byNeuron } = projectMaps(registry, neurons);
  if (Object.keys(aliases).length) index.projects = aliases;
  for (const n of neurons) {
    if (!n || n.type === 'protocol') continue;
    const projects = [...(byNeuron.get(n.id) ?? [])].sort();
    const lists: Array<[TriggerEntry['k'], string[] | undefined]> = [['error', n.errors], ['debt', n.debts], ['pattern', n.patterns]];
    for (const [k, list] of lists) {
      for (const text of list || []) {
        if (!text || n.entry_status?.[entryId(text)]) continue;   // retired: it no longer speaks
        const keys = keysOfEntry(text);
        if (keys.length === 0) continue;
        const at = index.entries.length;
        const origin = n.entry_source?.[entryId(text)];
        index.entries.push({
          n: n.id, name: n.name, e: entryId(text), k,
          d: (n.entry_dates?.[entryId(text)] || '').slice(0, 10),
          t: text.length > PREVIEW ? `${text.slice(0, PREVIEW).trimEnd()}…` : text,
          ...(projects.length ? { p: projects } : {}),
          ...(origin ? { o: origin } : {}),
        });
        for (const key of keys) (index.keys[key] ||= []).push(at);
      }
    }
  }
  return index;
}

/**
 * The project a working folder belongs to, by the index's alias map: the
 * folder itself, the repository root it is in, or their names. Mirrored in
 * hooks/crbro-guard.mjs (tested).
 */
export function projectOf(index: Pick<TriggerIndex, 'projects'>, cwd: string | undefined): string | null {
  const map = index.projects;
  if (!map || !cwd) return null;
  const candidates: string[] = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i < 12; i++) {
    candidates.push(dir);
    if (existsSync(path.join(dir, '.git'))) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // The folder and the repository root, by full path first, then by name.
  const firstAndRoot = candidates.length > 1 ? [candidates[0], candidates[candidates.length - 1]] : candidates;
  for (const c of firstAndRoot) {
    const full = c.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
    if (map[full]) return map[full];
  }
  for (const c of firstAndRoot) {
    const name = path.basename(c).toLowerCase();
    if (map[name]) return map[name];
  }
  return null;
}

export interface LessonOptions {
  /** The working folder the command runs in: lessons of other projects stay quiet there. */
  cwd?: string;
  /** Show lessons that came from a team space or the miner, labelled. Off by default. */
  allOrigins?: boolean;
}

/**
 * What the hook would say for this command: the lessons whose keys it hits,
 * from this project or from no project — another project's lesson speaks only
 * when the command walks into that project's folder (a path: key) — never a
 * teammate's or the miner's unless asked; this project's first, then errors,
 * debts, patterns, newest first, capped.
 */
export function lessonsFor(index: TriggerIndex, command: string, max: number = MAX_LESSONS, opts: LessonOptions = {}): TriggerEntry[] {
  const hits = new Map<number, boolean>();   // entry → reached through a path: key
  const walked = new Set<string>();           // projects whose folder the command walks into
  for (const k of keysOfCommand(command)) {
    if (k.startsWith('path:') && index.projects?.[k.slice(5)]) walked.add(index.projects[k.slice(5)]);
    for (const i of index.keys[k] || []) hits.set(i, hits.get(i) || k.startsWith('path:'));
  }
  const here = projectOf(index, opts.cwd);
  const rank = { error: 0, debt: 1, pattern: 2 } as const;
  const mine = (l: TriggerEntry) => (here && l.p?.includes(here) ? 0 : 1);
  return [...hits].map(([i, viaPath]) => ({ l: index.entries[i], viaPath }))
    .filter(({ l, viaPath }) => !!l
      && (!l.o || !!opts.allOrigins)
      && (!l.p?.length || (here !== null && l.p.includes(here)) || viaPath || l.p.some(x => walked.has(x))))
    .map(({ l }) => l)
    .sort((a, b) => mine(a) - mine(b) || rank[a.k] - rank[b.k] || (a.d < b.d ? 1 : a.d > b.d ? -1 : a.e < b.e ? -1 : 1))
    .slice(0, max);
}

export function triggerIndexPath(brain: Brain): string {
  return path.join(brain.paths.search, TRIGGER_FILE);
}

/** Every readable neuron of the cortex. A corrupted file is skipped: the integrity check reports it. */
export async function loadAllNeurons(brain: Brain): Promise<Neuron[]> {
  const neurons: Neuron[] = [];
  for (const id of await listJSONFiles(brain.paths.cortex)) {
    try {
      const n = await readJSON<Neuron>(brain.paths.neuron(id));
      if (n) neurons.push(n);
    } catch { /* corrupted: the integrity check reports it */ }
  }
  return neurons;
}

/**
 * Rebuild from the cortex and write. Derived data: a failure is reported,
 * never thrown. `preloaded` lets consolidate read the cortex once for this
 * and for promotion_candidates (2.7) instead of twice.
 */
export async function writeTriggerIndex(brain: Brain, preloaded?: Neuron[]): Promise<{ entries: number; keys: number } | { error: string }> {
  try {
    const neurons = preloaded ?? await loadAllNeurons(brain);
    let registry: ProjectsFile | null = null;
    try { registry = await readJSON<ProjectsFile>(path.join(brain.paths.root, 'projects.json')); } catch { /* no projects yet */ }
    const index = buildTriggerIndex(neurons, now(), registry);
    await writeJSON(triggerIndexPath(brain), index, { pretty: false });
    return { entries: index.entries.length, keys: Object.keys(index.keys).length };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
