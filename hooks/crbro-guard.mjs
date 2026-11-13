#!/usr/bin/env node
// CRBRO — Claude Code PreToolUse hook: memory at the moment of action
//
// Recall only answers when somebody asks, and nobody asks "have I broken
// this before?" one second before `firebase deploy`. This hook does: it
// looks the command up in the trigger index the server derives from the
// error, debt and pattern ledgers (<brain>/.search/triggers.json) and, when
// a stored lesson mentions that command, adds it to the model's context for
// this one tool call. It never blocks, never asks, never decides.
//
// Cost: node's own start (~45 ms) and, for most commands, one small file: the
// list of keys the index has, cached in the temp folder by the index's mtime,
// so a command no lesson mentions never parses the whole index.
//
// Noise control: a lesson is shown once per session, at most three per
// command and six per session, errors before debts before patterns, newest
// first. Lessons of this project come first; a lesson tied to another project
// speaks only when the command walks into that project's folder; lessons that
// came from a team space or the miner stay out (CRBRO_GUARD_ORIGINS=all shows
// them, labelled with where they came from).
//
// OPT-IN (crbro install-hooks --guard). An injection nobody measured must not
// be a default; this one is small and removable, and says where it came from.
//
// Failure contract: any error — no index, bad JSON, stdin that never ends —
// degrades to silence. Always exit 0.
//
// The key extraction below mirrors keysOfCommand() in src/engine/triggers.ts.
// tests/triggers.test.ts runs this file against that function: they cannot
// drift without a red test.

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';


const MAX_LESSONS = 3;
/** Lessons per session: past this the guard stays quiet for the rest of it. */
const SESSION_MAX = 6;
/** Index formats this hook reads (src/engine/triggers.ts TRIGGER_INDEX_VERSION and the one before). */
const INDEX_VERSIONS = new Set([2, 3]);
const WEEK_MS = 7 * 24 * 3600 * 1000;
const WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'sudo', 'time', 'call', 'exec', 'start']);
const INTERPRETERS = new Set(['node', 'deno', 'bun', 'python', 'python3', 'py', 'bash', 'sh', 'zsh', 'powershell', 'pwsh', 'tsx', 'ts-node', 'php', 'ruby', 'perl']);
/** Two words that still name nothing: `npm run` is not an action, `npm run build` is. */
const DEEP = new Set(('npm run|yarn run|pnpm run|bun run|docker compose|wp plugin|wp post|wp option|wp theme|wp user|wp cache|wp db|'
  + 'gh pr|gh issue|gh repo|gh release|gh run|gcloud run|gcloud auth|gcloud functions|gcloud app|git remote').split('|'));
/** A flag names an action only where it changes what the program does to your files. `curl -s` and `grep -n` are not lessons. */
const FLAG_PAIRS = new Set(['rm -rf', 'rm -r', 'rm -fr', 'git -c', 'cp -r', 'node --check', 'node -e', 'python -c', 'python -m', 'python3 -m', 'npx -y']);
const SCRIPT = /\.(ps1|sh|bash|py|mjs|cjs|js|ts|bat|cmd|rb|php)$/;

/**
 * Same resolution as resolveBrainDir() in src/engine/brain.ts and brainDir() in
 * the other hooks: CRBRO_PATH (CRBRO_BRAIN_PATH as an alias), with ~, relative
 * paths and unexpanded placeholders handled. Tested against the source.
 */
export function brainDir(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const fallback = join(home, '.crbro');
  const raw = (env.CRBRO_PATH || env.CRBRO_BRAIN_PATH || '').trim();
  if (!raw) return fallback;
  if (/\$\{|%[A-Za-z_][A-Za-z0-9_]*%/.test(raw)) return fallback;
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return join(home, raw.slice(1));
  if (!isAbsolute(raw)) return join(home, raw);
  return raw;
}

function word(raw) {
  const w = raw.replace(/^["'`(]+|["'`),;:.]+$/g, '').toLowerCase();
  if (!w || w.startsWith('-')) return w;
  return w.split(/[\\/]/).pop() || w;
}

/**
 * A heredoc body is data, not commands: a Python script fed through <<'EOF'
 * named every file it mentioned and woke lessons that had nothing to do with
 * the command. Procedural on purpose — no backreferences to get wrong.
 */
function stripHeredocs(command) {
  const out = [];
  let end = null;
  for (const line of command.split('\n')) {
    if (end !== null) { if (line.trim() === end) end = null; continue; }
    out.push(line);
    const m = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (m) end = m[1];
  }
  return out.join('\n');
}

/** Mirrors pathKeys() in src/engine/triggers.ts: the project folders a text walks into. */
function pathKeys(text) {
  const keys = new Set();
  for (const m of text.matchAll(/[A-Za-z0-9._-]{2,}[\\/][A-Za-z0-9._\\/-]{2,}/g)) {
    for (const seg of m[0].split(/[\\/]+/)) {
      const s = seg.toLowerCase();
      if (s.length >= 6 && s.includes('-') && !/^-|-$/.test(s) && !/\.[a-z0-9]{1,5}$/.test(s)) keys.add(`path:${s}`);
    }
  }
  return [...keys];
}

export function keysOfCommand(command) {
  const keys = new Set();
  const body = stripHeredocs(command);
  for (const k of pathKeys(body)) keys.add(k);
  for (const segment of body.split(/&&|\|\||[;|\n]/)) {
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

/** Mirrors projectOf() in src/engine/triggers.ts: the project the working folder (or its repository root) belongs to. */
export function projectOf(index, cwd) {
  const map = index && index.projects;
  if (!map || !cwd) return null;
  const candidates = [];
  let dir = resolve(cwd);
  for (let i = 0; i < 12; i++) {
    candidates.push(dir);
    if (existsSync(join(dir, '.git'))) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const firstAndRoot = candidates.length > 1 ? [candidates[0], candidates[candidates.length - 1]] : candidates;
  for (const c of firstAndRoot) {
    const full = c.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
    if (map[full]) return map[full];
  }
  for (const c of firstAndRoot) {
    const name = basename(c).toLowerCase();
    if (map[name]) return map[name];
  }
  return null;
}

/** Mirrors lessonsFor() in src/engine/triggers.ts (tested): this project's, or no project's, or walked into; never another origin unless asked. */
export function lessonsFor(index, command, opts = {}) {
  const hits = new Map();
  const walked = new Set();
  for (const k of keysOfCommand(command)) {
    if (k.startsWith('path:') && index.projects && index.projects[k.slice(5)]) walked.add(index.projects[k.slice(5)]);
    for (const i of index.keys[k] || []) hits.set(i, hits.get(i) || k.startsWith('path:'));
  }
  const here = projectOf(index, opts.cwd);
  const rank = { error: 0, debt: 1, pattern: 2 };
  const mine = l => (here && Array.isArray(l.p) && l.p.includes(here) ? 0 : 1);
  return [...hits].map(([i, viaPath]) => ({ l: index.entries[i], viaPath }))
    .filter(({ l, viaPath }) => !!l
      && (!l.o || !!opts.allOrigins)
      && (!Array.isArray(l.p) || !l.p.length || (here !== null && l.p.includes(here)) || viaPath || l.p.some(x => walked.has(x))))
    .map(({ l }) => l)
    .sort((a, b) => mine(a) - mine(b) || rank[a.k] - rank[b.k] || (a.d < b.d ? 1 : a.d > b.d ? -1 : a.e < b.e ? -1 : 1));
}

/** Which lessons this session already saw. A temp file per session; losing it only repeats a lesson. */
function seenStore(sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'nosession';
  const dir = join(tmpdir(), 'crbro-guard');
  const file = join(dir, `${safe}.json`);
  let seen = [];
  try { seen = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first call of the session */ }
  return {
    count: () => seen.length,
    has: id => seen.includes(id),
    add: ids => {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, JSON.stringify([...seen, ...ids]));
        // Sessions older than a week leave nothing behind.
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          try { if (Date.now() - statSync(p).mtimeMs > WEEK_MS) rmSync(p, { force: true }); } catch { /* next time */ }
        }
      } catch { /* best effort */ }
    },
  };
}

/**
 * The keys the index has, cached in the temp folder per index file and keyed
 * by its mtime and size: a command that hits none of them is answered without
 * parsing the whole index. Null when there is no fresh cache.
 */
function keysCache(file, st) {
  // FNV-1a of the path: one name per index file, without loading node:crypto on every command.
  let h = 0x811c9dc5;
  for (let i = 0; i < file.length; i++) { h ^= file.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const name = h.toString(16);
  const path = join(tmpdir(), 'crbro-guard', `keys-${name}.json`);
  let keys = null;
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    if (c.mtimeMs === st.mtimeMs && c.size === st.size && Array.isArray(c.keys)) keys = new Set(c.keys);
  } catch { /* none yet */ }
  return {
    keys,
    save: list => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ mtimeMs: st.mtimeMs, size: st.size, keys: list }));
      } catch { /* best effort */ }
    },
  };
}

function respond(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return null;

  const wanted = keysOfCommand(command);
  if (wanted.length === 0) return null;   // nothing in it any lesson could be about
  const file = join(brainDir(), '.search', 'triggers.json');
  let st;
  try { st = statSync(file); } catch { return null; }   // no index yet: the next crbro_consolidate writes it
  const cache = keysCache(file, st);
  if (cache.keys && !wanted.some(k => cache.keys.has(k))) return null;

  let index;
  try {
    index = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  // Mirrors TRIGGER_INDEX_VERSION in src/engine/triggers.ts. An older index simply
  // says nothing until the next consolidate rewrites it.
  if (!index || !INDEX_VERSIONS.has(index.v) || !index.keys || !Array.isArray(index.entries)) return null;
  if (!cache.keys) cache.save(Object.keys(index.keys));

  const store = seenStore(input.session_id);
  const room = Math.min(MAX_LESSONS, SESSION_MAX - store.count());
  if (room <= 0) return null;
  const allOrigins = String(process.env.CRBRO_GUARD_ORIGINS || '').toLowerCase() === 'all';
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const fresh = lessonsFor(index, command, { cwd, allOrigins }).filter(l => !store.has(`${l.n}#${l.e}`)).slice(0, room);
  if (fresh.length === 0) return null;
  store.add(fresh.map(l => `${l.n}#${l.e}`));

  // A lesson that is not the user's own says whose it is: data to weigh, not an instruction.
  const lines = fresh.map(l => `• [${l.o ? `from ${l.o} · ` : ''}${l.k}${l.d ? ` · ${l.d}` : ''} · ${l.n}] ${l.t}  (entry ${l.e})`);
  const text = [
    'CRBRO — stored lessons that mention this command (shown once per session):',
    ...lines,
    'These are memories, not orders: check they still apply. Read one whole with crbro_inspect view=neuron neuron=<id> entries=[<entry>].',
  ].join('\n');
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } };
}

// Imported by the test suite for keysOfCommand; run as a hook otherwise.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isMain) {
  let raw = '';
  const done = () => {
    try {
      const out = respond(JSON.parse((raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || '{}'));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* silence */ }
    process.exit(0);
  };
  // The Windows PowerShell wrapper can swallow piped JSON so 'end' never fires.
  const timer = setTimeout(done, 1500);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', () => { clearTimeout(timer); done(); });
  process.stdin.on('error', () => { clearTimeout(timer); done(); });
}
