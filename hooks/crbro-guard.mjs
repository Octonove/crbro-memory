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
// Cost: one small JSON read. No search index, no model, no network.
//
// Noise control: a lesson is shown once per session, at most three per
// command, errors before debts before patterns, newest first.
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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const MAX_LESSONS = 3;
const WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'sudo', 'time', 'call', 'exec', 'start']);
const INTERPRETERS = new Set(['node', 'deno', 'bun', 'python', 'python3', 'py', 'bash', 'sh', 'zsh', 'powershell', 'pwsh', 'tsx', 'ts-node', 'php', 'ruby', 'perl']);
/** Two words that still name nothing: `npm run` is not an action, `npm run build` is. */
const DEEP = new Set(('npm run|yarn run|pnpm run|bun run|docker compose|wp plugin|wp post|wp option|wp theme|wp user|wp cache|wp db|'
  + 'gh pr|gh issue|gh repo|gh release|gh run|gcloud run|gcloud auth|gcloud functions|gcloud app|git remote').split('|'));
const SCRIPT = /\.(ps1|sh|bash|py|mjs|cjs|js|ts|bat|cmd|rb|php)$/;

function brainDir() {
  const raw = (process.env.CRBRO_BRAIN_PATH || process.env.CRBRO_PATH || '').trim();
  if (raw && !/\$\{|%[A-Za-z_][A-Za-z0-9_]*%/.test(raw)) return raw;
  return join(homedir(), '.crbro');
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

export function keysOfCommand(command) {
  const keys = new Set();
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
      keys.add(DEEP.has(pair) && t[2] && !t[2].startsWith('-') ? `${pair} ${t[2]}` : pair);
      if (INTERPRETERS.has(t[0])) {
        const file = t.slice(1).find(x => !x.startsWith('-'));
        if (file && SCRIPT.test(file)) keys.add(file);
      }
    }
  }
  return [...keys];
}

function lessonsFor(index, command) {
  const hits = new Set();
  for (const k of keysOfCommand(command)) for (const i of index.keys[k] || []) hits.add(i);
  const rank = { error: 0, debt: 1, pattern: 2 };
  return [...hits].map(i => index.entries[i]).filter(Boolean)
    .sort((a, b) => rank[a.k] - rank[b.k] || (a.d < b.d ? 1 : a.d > b.d ? -1 : a.e < b.e ? -1 : 1));
}

/** Which lessons this session already saw. A temp file per session; losing it only repeats a lesson. */
function seenStore(sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'nosession';
  const dir = join(tmpdir(), 'crbro-guard');
  const file = join(dir, `${safe}.json`);
  let seen = [];
  try { seen = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first call of the session */ }
  return {
    has: id => seen.includes(id),
    add: ids => {
      try { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify([...seen, ...ids])); } catch { /* best effort */ }
    },
  };
}

function respond(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return null;

  let index;
  try {
    index = JSON.parse(readFileSync(join(brainDir(), '.search', 'triggers.json'), 'utf8'));
  } catch {
    return null;   // no index yet: the next crbro_consolidate writes it
  }
  if (!index || index.v !== 1 || !index.keys || !Array.isArray(index.entries)) return null;

  const store = seenStore(input.session_id);
  const fresh = lessonsFor(index, command).filter(l => !store.has(`${l.n}#${l.e}`)).slice(0, MAX_LESSONS);
  if (fresh.length === 0) return null;
  store.add(fresh.map(l => `${l.n}#${l.e}`));

  const lines = fresh.map(l => `• [${l.k}${l.d ? ` · ${l.d}` : ''} · ${l.n}] ${l.t}  (entry ${l.e})`);
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
