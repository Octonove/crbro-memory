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
import { readJSON, writeJSON, listJSONFiles, now } from '../utils/fs.js';
import { entryId } from '../sync/ops.js';
import type { Brain } from './brain.js';
import type { Neuron } from '../types/index.js';

export const TRIGGER_INDEX_VERSION = 1;
export const TRIGGER_FILE = 'triggers.json';
const PREVIEW = 320;
/** Lessons handed over per command. More than this is a lecture, and lectures get skimmed. */
export const MAX_LESSONS = 3;

export interface TriggerEntry {
  /** neuron id · neuron name · entry id · kind · day recorded ('' when undated) · opening of the text */
  n: string; name: string; e: string; k: 'error' | 'debt' | 'pattern'; d: string; t: string;
}
export interface TriggerIndex {
  v: number;
  built: string;
  /** "firebase deploy" → positions in `entries`. */
  keys: Record<string, number[]>;
  entries: TriggerEntry[];
}

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
 * The keys a COMMAND LINE asks about. Deliberately dumb and mirrored in
 * hooks/crbro-guard.mjs: per segment, the program and its next word, the word
 * after a wrapper, and a script when it is what runs.
 */
export function keysOfCommand(command: string): string[] {
  const keys = new Set<string>();
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    let t = segment.trim().split(/\s+/).map(word).filter(Boolean);
    while (t.length && (/^[a-z_][a-z0-9_]*=/.test(t[0]) || t[0] === '&' || WRAPPERS.has(t[0]))) {
      if (WRAPPERS.has(t[0]) && t[1] && !t[1].startsWith('-')) keys.add(`${t[0]} ${t[1]}`);
      t = t.slice(1);
    }
    if (t.length === 0) continue;
    if (SCRIPT.test(t[0])) keys.add(t[0]);
    if (t[1]) {
      keys.add(`${t[0]} ${t[1]}`);
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
  for (const m of text.matchAll(/`([^`\n]{2,200})`/g)) for (const k of keysOfCommand(m[1])) keys.add(k);
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = word(words[i]);
    if (SCRIPT.test(w) && w.length >= 5) keys.add(w);
    if (!HEADS.has(w)) continue;
    const next = word(words[i + 1] || '');
    if (next && SUBCOMMAND.test(next) && !PROSE.has(next)) keys.add(`${w} ${next}`);
  }
  // A script is only a trigger as the thing that runs; a program pair needs a known program.
  return [...keys].filter(k => (k.includes(' ') ? HEADS.has(k.split(' ')[0]) || WRAPPERS.has(k.split(' ')[0]) : SCRIPT.test(k)));
}

export function buildTriggerIndex(neurons: Neuron[], builtAt: string = now()): TriggerIndex {
  const index: TriggerIndex = { v: TRIGGER_INDEX_VERSION, built: builtAt, keys: {}, entries: [] };
  for (const n of neurons) {
    if (!n || n.type === 'protocol') continue;
    const lists: Array<[TriggerEntry['k'], string[] | undefined]> = [['error', n.errors], ['debt', n.debts], ['pattern', n.patterns]];
    for (const [k, list] of lists) {
      for (const text of list || []) {
        if (!text || n.entry_status?.[entryId(text)]) continue;   // retired: it no longer speaks
        const keys = keysOfEntry(text);
        if (keys.length === 0) continue;
        const at = index.entries.length;
        index.entries.push({
          n: n.id, name: n.name, e: entryId(text), k,
          d: (n.entry_dates?.[entryId(text)] || '').slice(0, 10),
          t: text.length > PREVIEW ? `${text.slice(0, PREVIEW).trimEnd()}…` : text,
        });
        for (const key of keys) (index.keys[key] ||= []).push(at);
      }
    }
  }
  return index;
}

/** What the hook would say for this command: errors first, then newest first, capped. */
export function lessonsFor(index: TriggerIndex, command: string, max: number = MAX_LESSONS): TriggerEntry[] {
  const hits = new Set<number>();
  for (const k of keysOfCommand(command)) for (const i of index.keys[k] || []) hits.add(i);
  const rank = { error: 0, debt: 1, pattern: 2 } as const;
  return [...hits].map(i => index.entries[i])
    .sort((a, b) => rank[a.k] - rank[b.k] || (a.d < b.d ? 1 : a.d > b.d ? -1 : a.e < b.e ? -1 : 1))
    .slice(0, max);
}

export function triggerIndexPath(brain: Brain): string {
  return path.join(brain.paths.search, TRIGGER_FILE);
}

/** Rebuild from the cortex and write. Derived data: a failure is reported, never thrown. */
export async function writeTriggerIndex(brain: Brain): Promise<{ entries: number; keys: number } | { error: string }> {
  try {
    const neurons: Neuron[] = [];
    for (const id of await listJSONFiles(brain.paths.cortex)) {
      try {
        const n = await readJSON<Neuron>(brain.paths.neuron(id));
        if (n) neurons.push(n);
      } catch { /* corrupted: the integrity check reports it */ }
    }
    const index = buildTriggerIndex(neurons);
    await writeJSON(triggerIndexPath(brain), index, { pretty: false });
    return { entries: index.entries.length, keys: Object.keys(index.keys).length };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
