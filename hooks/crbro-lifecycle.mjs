#!/usr/bin/env node
// CRBRO — Claude Code lifecycle hook: compact without losing the thread
//
// Two modes, picked by the first argument:
//
//   pre-compact    PreCompact. Before the context is summarised, writes a
//                  mechanical checkpoint of the session — the last two things
//                  the user asked, the last state of the task list, the open
//                  items of the brain, the folder and its git remote — to
//                  <brain>/checkpoints/<session_id>.json. No model is called:
//                  it is a read of the transcript, nothing more. Then prints
//                  the "keep what is not saved yet" reminder the hand-written
//                  PreCompact hooks print today, so installing this is a
//                  superset of what was there.
//
//   session-start  SessionStart. Prints the boot notice — the one
//                  `install-boot` writes (BOOT_NOTICE below is the one copy of
//                  it; the CLI imports it from here), here with the folder
//                  name filled in as project=… — a "Project: … · git: …"
//                  line, and — only when the session restarts after a
//                  compaction and a checkpoint of that session younger than
//                  24 h exists — a "Resuming after compaction" block, never
//                  longer than 1,500 characters.
//
// Flags: `--no-boot` (session-start) and `--no-reminder` (pre-compact) leave
// out the text a hand-written hook of the user already prints, so the
// installer never makes the model read the same instruction twice.
//
// Nothing reaches disk unredacted, and every text is redacted whole before it
// is cut to length: a cut first could leave half a token the patterns no
// longer recognise. The secret patterns are a copy of
// src/engine/secrets.ts, because this file is copied to ~/.claude/crbro-hooks
// and cannot import the package. tests/lifecycle.hook.test.ts compares both
// lists pattern by pattern: they cannot drift without a red test.
//
// Failure contract: dependency-free, never blocks, never asks. stdin that
// never ends (the Windows PowerShell wrapper can swallow it), a missing
// transcript, an unreadable brain, bad JSON — all degrade to printing what can
// be printed. A watchdog ends the process at WATCHDOG_MS. Always exit 0.

import {
  readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, unlinkSync,
  openSync, readSync, closeSync, fstatSync, writeSync, existsSync,
} from 'node:fs';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

// ─── Texts ───────────────────────────────────────────────────────

/** What install-boot prints for Claude Code, and what session-start prints when it knows no folder. One copy. */
export const BOOT_NOTICE =
  'CRBRO: call mcp__crbro__crbro_boot as your FIRST tool action, before answering, ' +
  'with project=<name of the working folder or repo>, ' +
  'unless this session already contains its result. Discover deferred CRBRO tools first if needed. ' +
  'Apply the protocol_enforcement block it returns for the rest of the session.';

/** The folder name as it goes into project="…": one line, no quotes, bounded. */
function projectName(cwd) {
  return String(basename(cwd || '') || '').replace(/["\r\n\t]/g, '').slice(0, 120);
}

/** The boot notice with the folder already filled in, so P5 (project_neurons) is used. */
export function bootNotice(project) {
  const name = projectName(project ? `/${project}` : '');
  if (!name) return BOOT_NOTICE;
  return BOOT_NOTICE.replace('with project=<name of the working folder or repo>', `with project="${name}"`);
}

/** The PreCompact reminder: the same job as the hand-written crbro-precompact.txt. */
export const PRECOMPACT_REMINDER = [
  'CRBRO — compaction is about to happen. When writing the summary, keep explicitly:',
  '1. Every fact, decision, piece of architecture or work done in this session that has NOT been saved to CRBRO yet ' +
    '(mcp__crbro__crbro_learn / mcp__crbro__crbro_consolidate). Mark it "⚠️ PENDING CRBRO SAVE" with enough detail to save it later without loss.',
  '2. The CRBRO state of the session: what was already saved and what was not.',
  'After the compaction, the FIRST action is mcp__crbro__crbro_learn with everything marked as pending.',
].join('\n');

export const RESUME_CAP = 1500;
const RESUME_MAX_AGE_MS = 24 * 3600 * 1000;
const PRUNE_AGE_MS = 7 * 24 * 3600 * 1000;
const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_MAX = 500;
const TASK_MAX = 200;
const TASKS_KEPT = 40;
const OPEN_ITEMS_KEPT = 10;
const STDIN_WAIT_MS = 1500;
const WATCHDOG_MS = 5000;

// ─── Redaction (mirror of src/engine/secrets.ts) ─────────────────

/** Same kinds, same sources, same flags as PATTERNS in src/engine/secrets.ts. Tested. */
export const SECRET_PATTERNS = [
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'OpenAI key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: 'Supabase token', re: /\bsbp_[a-f0-9]{40,}\b/g },
  { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Stripe key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    kind: 'AWS secret key',
    re: /\b(?:[Aa][Ww][Ss][ _-]?)?[Ss]ecret[ _-]?(?:[Aa]ccess[ _-]?)?[Kk]ey\b[^\n]{0,15}?(?<![A-Za-z0-9/+])((?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*[0-9])[A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/g,
  },
  { kind: 'Twilio account SID', re: /\bAC[0-9a-fA-F]{32,34}\b/g },
  {
    kind: 'auth token (hex)',
    re: /\bauth[ _-]?token\b[^\S\n]{0,3}(?:[:=]|es|is)?[^\S\n]{0,3}["'`]?([0-9a-fA-F]{30,34})\b/gi,
  },
  { kind: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    kind: 'WordPress application password',
    re: /\b(?:application|app)[ _-]?password\b[^\n]{0,80}?\b([A-Za-z0-9]{4}(?: [A-Za-z0-9]{4}){5})\b/gi,
  },
  {
    kind: 'password',
    re: /\b(?:password|passwd|contrase[nñ]a|clave)\s*(?:es|is)?\s*[:=]\s*["'`]?([^\s"'`,;]{8,})/gi,
  },
  {
    kind: 'password (prose)',
    re: /\b(?:password|passwd|contrase[nñ]a|clave)\b(?:\s+(?:de|del|of|for)\s+[^\s]{1,30})?\s+(?:es|is)\s+["'`]?((?=[^\s"'`,;]*[A-Za-z])(?=[^\s"'`,;]*[0-9])[^\s"'`,;]{8,})/gi,
  },
  {
    kind: 'split credential',
    re: /\b(?:token|key|clave|password|contrase[nñ]a|secret|secreto)\b[^.?!\n]{0,40}?\b(?:empieza|comienza|starts?)\s+(?:por|con|with)\s+(\S{2,15}[^.?!\n]{0,30}?\b(?:sigue con|contin[uú]a con|y luego|followed by|then|continues with)\s+["'`]?(?=[A-Za-z0-9_\-+/=]*[A-Za-z])(?=[A-Za-z0-9_\-+/=]*[0-9])[A-Za-z0-9_\-+/=]{16,})/gi,
  },
  {
    kind: 'connection string credentials',
    re: /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi,
  },
  {
    kind: 'generic API key/secret',
    re: /\b(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|secret|token)\s*[:=]\s*["'`]?(?!\/)((?=[A-Za-z0-9_\-+]*[A-Za-z])(?=[A-Za-z0-9_\-+]*[0-9])[A-Za-z0-9_\-+]{24,})/gi,
  },
  { kind: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
];

/** Same algorithm as redact() in src/engine/secrets.ts: left to right, overlaps skipped, longer span wins a tie. */
export function redact(text) {
  if (typeof text !== 'string' || !text) return '';
  const hits = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[1] !== undefined ? m[1] : m[0];
      const at = m[1] !== undefined ? m.index + m[0].indexOf(m[1]) : m.index;
      hits.push({ kind, index: at, length: value.length });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  if (hits.length === 0) return text;
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  let out = '';
  let cursor = 0;
  for (const h of hits) {
    if (h.index < cursor) continue;
    out += text.slice(cursor, h.index) + `[REDACTED: ${h.kind}]`;
    cursor = h.index + h.length;
  }
  return out + text.slice(cursor);
}

/** Every string in a plain JSON value, redacted. What gets written is only ever the output of this. */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

// ─── Where things are ────────────────────────────────────────────

/** Mirror of resolveBrainDir() in src/engine/brain.ts (tested), without its warnings. */
export function brainDir(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const fallback = join(home, '.crbro');
  const raw = (env.CRBRO_PATH || '').trim();
  if (!raw) return fallback;
  if (/\$\{|%[A-Za-z_][A-Za-z0-9_]*%/.test(raw)) return fallback;
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return join(home, raw.slice(1));
  if (!isAbsolute(raw)) return join(home, raw);
  return raw;
}

export function checkpointDir(env = process.env) {
  return join(brainDir(env), 'checkpoints');
}

function safeSessionId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
}

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * The remote of the repository `cwd` is in, read from .git/config. No `git`
 * process: spawning one can hang on a credential helper, and this is a hook.
 * Credentials embedded in the URL are dropped before anything else sees it.
 */
export function gitRemote(cwd) {
  try {
    let dir = resolve(cwd || process.cwd());
    for (let i = 0; i < 40; i++) {
      const dotGit = join(dir, '.git');
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
          if (!m) return null;
          gitDir = resolve(dir, m[1].trim());
        }
        // A worktree keeps its config in the common dir.
        try {
          const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
          if (common) gitDir = resolve(gitDir, common);
        } catch { /* not a worktree */ }
        return remoteFromConfig(readFileSync(join(gitDir, 'config'), 'utf8'));
      }
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch { /* no repo, or unreadable: no remote */ }
  return null;
}

function remoteFromConfig(config) {
  let section = null;
  const urls = new Map();
  for (const line of config.split(/\r?\n/)) {
    const head = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
    if (head) { section = head[1]; continue; }
    if (/^\s*\[/.test(line)) { section = null; continue; }
    const url = section && /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url && !urls.has(section)) urls.set(section, url[1]);
  }
  const raw = urls.get('origin') ?? [...urls.values()][0];
  if (!raw) return null;
  return stripUrlCredentials(raw);
}

/**
 * A remote without what should never be printed: user, password, query and
 * fragment. A URL with a scheme is parsed; an scp-like "user@host:path" loses
 * everything up to the LAST '@' before the host, so a password with an '@' in
 * it does not leave half of itself behind.
 */
export function stripUrlCredentials(raw) {
  const text = String(raw || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      // Not parseable (e.g. a raw '@' in the password): cut by hand.
      const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(text);
      if (!m) return null;
      const host = m[2].slice(m[2].lastIndexOf('@') + 1);
      return `${m[1]}${host}${m[3].replace(/[?#].*$/, '')}`;
    }
  }
  // scp-like: [user@]host:path — no password possible, but drop the user too.
  const colon = text.search(/:(?!\/\/)/);
  const at = text.lastIndexOf('@', colon === -1 ? text.length : colon);
  return (at === -1 ? text : text.slice(at + 1)).replace(/[?#].*$/, '');
}

// ─── Reading the transcript ──────────────────────────────────────

/** JSONL entries, tolerant of a huge file (tail only), a torn last line and junk. */
export function readTranscript(path) {
  if (!path || typeof path !== 'string') return [];
  let text;
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TRANSCRIPT_MAX_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn or foreign line */ }
  }
  return out;
}

function contentOf(entry) {
  const msg = entry && entry.message;
  if (!msg) return null;
  return msg.content;
}

/** Lines the client writes on the person's behalf. Same list as NOT_A_REQUEST in src/engine/postmortem.ts (tested). */
export const NOT_A_REQUEST = /^(?:<local-command-|<system-reminder>|<command-stdout>|<command-message>|<bash-|<user-prompt-submit-hook>|<task-notification>|\[Request interrupted|Caveat: |Alcancé mi límite de uso mientras trabajabas)/;

/**
 * Slash commands that configure the client instead of asking for work. What
 * they carry is not "the last request" and must not come back as one.
 */
export const NOT_WORK_COMMANDS = /^\/(?:compact|model|clear|config|effort|fast|cost|usage|status|help|login|logout|theme|permissions|resume|exit|quit|vim|output-style|statusline|terminal-setup|doctor|context|mcp|hooks|agents|ide|rename|export|release-notes|upgrade|privacy-settings|add-dir|memory|plugin|skills|tasks|bashes|todos|feedback|bug|keybindings|sandbox|remote-control|rewind)\b/i;

/** The text a person typed in one user entry, or '' when it is a tool result, a meta line or a reminder. */
function userText(entry) {
  if (!entry || entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return '';
  // A background task's notification or another agent's message arrives as a
  // user entry. Its text can come from a web page or a third-party repo: it
  // is never presented back as something the user asked.
  if (entry.origin && typeof entry.origin.kind === 'string' && entry.origin.kind !== 'human') return '';
  const content = contentOf(entry);
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some(b => b && b.type === 'tool_result')) return '';
    text = content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
  }
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  // A slash command arrives as tags; keep what was typed.
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    text = `${name[1].trim()} ${args ? args[1].trim() : ''}`.trim();
    // The command that triggers the compaction, /model and the like are not what was being worked on.
    if (NOT_WORK_COMMANDS.test(text)) return '';
  }
  if (!text || NOT_A_REQUEST.test(text)) return '';
  return text;
}

/** The last `n` things the user asked, newest first. */
export function lastUserRequests(entries, n = 2) {
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < n; i--) {
    const t = userText(entries[i]);
    if (t) out.push(clip(redact(t), REQUEST_MAX));
  }
  return out;
}

function taskText(input) {
  if (!input || typeof input !== 'object') return '';
  return String(input.subject ?? input.content ?? input.title ?? input.description ?? input.activeForm ?? '');
}

/**
 * The last state of the task list. Two shapes are known — TodoWrite, which
 * rewrites the whole list each time, and TaskCreate/TaskUpdate, which edit it
 * one task at a time — and they are replayed in transcript order, so whichever
 * came last wins. Anything not recognised is skipped, never guessed.
 */
export function lastTasks(entries) {
  let tasks = [];
  const pendingIds = new Map();   // tool_use_id → task waiting for the id its result announces
  let seq = 0;
  for (const entry of entries) {
    if (!entry || entry.isSidechain) continue;
    const content = contentOf(entry);
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        const input = b.input || {};
        if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
          tasks = input.todos.map((t, i) => ({ id: String(t.id ?? i + 1), text: taskText(t), status: String(t.status || 'pending') }));
          pendingIds.clear();
        } else if (b.name === 'TaskCreate') {
          seq++;
          const task = { id: String(seq), text: taskText(input), status: String(input.status || 'pending') };
          tasks.push(task);
          if (b.id) pendingIds.set(b.id, task);
        } else if (b.name === 'TaskUpdate') {
          const id = String(input.taskId ?? input.task_id ?? input.id ?? '');
          const task = tasks.find(t => t.id === id);
          if (!task) continue;
          if (input.status) task.status = String(input.status);
          const text = String(input.subject ?? input.content ?? input.title ?? '');
          if (text) task.text = text;
        }
      } else if (b.type === 'tool_result' && pendingIds.has(b.tool_use_id)) {
        const raw = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map(c => (c && c.text) || '').join(' ') : '';
        const m = /#(\d+)/.exec(raw);
        if (m) {
          const task = pendingIds.get(b.tool_use_id);
          task.id = m[1];
          seq = Math.max(seq, Number(m[1]));
        }
        pendingIds.delete(b.tool_use_id);
      }
    }
  }
  return tasks
    .filter(t => t.text && t.status !== 'deleted')
    .slice(-TASKS_KEPT)
    .map(t => ({ id: t.id, text: clip(redact(t.text), TASK_MAX), status: t.status }));
}

/** Open items of the brain, from the prefrontal context crbro_boot reads. */
export function openItems(env = process.env) {
  try {
    const raw = readFileSync(join(brainDir(env), 'prefrontal', 'active_context.json'), 'utf8');
    const ctx = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    const list = Array.isArray(ctx.pending_tasks) ? ctx.pending_tasks : [];
    return list
      .filter(t => typeof t === 'string' || (t && !t.closed))
      .map(t => clip(redact(typeof t === 'string' ? t : t.text), TASK_MAX))
      .filter(Boolean)
      .slice(0, OPEN_ITEMS_KEPT);
  } catch {
    return [];
  }
}

// ─── pre-compact ─────────────────────────────────────────────────

export function buildCheckpoint(input, env = process.env, now = new Date()) {
  const entries = readTranscript(input.transcript_path);
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  return redactDeep({
    v: 1,
    session_id: String(input.session_id || ''),
    created: now.toISOString(),
    trigger: String(input.trigger || ''),
    cwd,
    project: basename(cwd),
    git_remote: gitRemote(cwd),
    requests: lastUserRequests(entries, 2),
    tasks: lastTasks(entries),
    open_items: openItems(env),
  });
}

/** Write-then-rename, so a reader never sees half a checkpoint. */
export function writeCheckpoint(dir, sessionId, checkpoint) {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(redactDeep(checkpoint), null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
  return file;
}

/** Checkpoints older than seven days, and temp files a killed run left, go. */
export function pruneCheckpoints(dir, nowMs = Date.now()) {
  let removed = 0;
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
    const file = join(dir, name);
    try {
      if (nowMs - statSync(file).mtimeMs > PRUNE_AGE_MS) { unlinkSync(file); removed++; }
    } catch { /* gone already, or locked: next time */ }
  }
  return removed;
}

export function preCompact(input, env = process.env, flags = {}) {
  let saved = null;
  try {
    const dir = checkpointDir(env);
    const cp = buildCheckpoint(input, env);
    saved = writeCheckpoint(dir, input.session_id, cp);
    pruneCheckpoints(dir);
  } catch { /* no checkpoint this time; the reminder still goes out */ }
  const lines = [];
  if (!flags.noReminder) lines.push(PRECOMPACT_REMINDER);
  if (saved) lines.push('CRBRO saved a checkpoint of this session (last requests, task list, open items); it comes back on its own after the compaction.');
  return lines.join('\n');
}

// ─── session-start ───────────────────────────────────────────────

function readCheckpoint(dir, sessionId, nowMs) {
  const id = safeSessionId(sessionId);
  if (!id) return null;
  try {
    const file = join(dir, `${id}.json`);
    const cp = JSON.parse(readFileSync(file, 'utf8'));
    const created = Date.parse(cp.created) || statSync(file).mtimeMs;
    if (!(nowMs - created < RESUME_MAX_AGE_MS)) return null;
    return cp;
  } catch {
    return null;
  }
}

/** The "Resuming after compaction" block, whole lines only, never over RESUME_CAP characters. */
export function resumeBlock(cp) {
  const lines = [`Resuming after compaction (CRBRO checkpoint, ${String(cp.created || '').slice(0, 16).replace('T', ' ')} UTC):`];
  const req = Array.isArray(cp.requests) ? cp.requests : [];
  if (req[0]) lines.push(`· Last request: ${clip(redact(req[0]), REQUEST_MAX)}`);
  const tasks = (Array.isArray(cp.tasks) ? cp.tasks : []).filter(t => t && t.status !== 'completed');
  if (tasks.length) {
    lines.push('· Pending tasks:');
    for (const t of tasks) lines.push(`  - [${t.status}] ${clip(redact(t.text), TASK_MAX)}`);
  }
  const open = Array.isArray(cp.open_items) ? cp.open_items : [];
  if (open.length) {
    lines.push('· Open items in CRBRO:');
    for (const o of open) lines.push(`  - ${clip(redact(o), TASK_MAX)}`);
  }
  if (req[1]) lines.push(`· Previous request: ${clip(redact(req[1]), REQUEST_MAX)}`);
  if (lines.length === 1) return '';

  const tail = '  … (trimmed)';
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const next = (out ? out + '\n' : '') + redact(lines[i]);
    if (next.length > RESUME_CAP - tail.length - 1) {
      out = out ? `${out}\n${tail}` : clip(lines[i], RESUME_CAP);
      break;
    }
    out = next;
  }
  return out.slice(0, RESUME_CAP);
}

export function sessionStart(input, env = process.env, flags = {}, nowMs = Date.now()) {
  const lines = [];
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const name = projectName(cwd);
  if (!flags.noBoot) lines.push(bootNotice(name));
  const remote = gitRemote(cwd);
  lines.push(redact(`Project: ${name || cwd} · git: ${remote || 'none'}`));
  // A hand-written hook of the user prints its own notice; the folder still has to reach crbro_boot.
  if (flags.noBoot && name) lines.push(`CRBRO: pass project="${name}" to crbro_boot.`);
  if (input.source === 'compact') {
    const cp = readCheckpoint(checkpointDir(env), input.session_id, nowMs);
    const block = cp ? resumeBlock(cp) : '';
    if (block) lines.push('', block);
  }
  return lines.join('\n');
}

// ─── Run as a hook ───────────────────────────────────────────────

function emit(text) {
  // Synchronous on purpose: process.exit() can cut an async pipe write short.
  if (text) try { writeSync(1, text.endsWith('\n') ? text : text + '\n'); } catch { /* nobody listening */ }
}

const isMain = process.argv[1] && /crbro-lifecycle\.mjs$/i.test(process.argv[1]);
if (isMain) {
  const mode = process.argv[2];
  const flags = { noBoot: process.argv.includes('--no-boot'), noReminder: process.argv.includes('--no-reminder') };
  let raw = '';
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    try {
      let input = {};
      try {
        const parsed = JSON.parse((raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || '{}');
        if (parsed && typeof parsed === 'object') input = parsed;
      } catch { /* not JSON: run with nothing */ }
      if (mode === 'pre-compact') emit(preCompact(input, process.env, flags));
      else if (mode === 'session-start') emit(sessionStart(input, process.env, flags));
    } catch { /* silence */ }
    process.exit(0);
  };
  // Whatever happens, the hook ends: the reminder must never become a hang.
  setTimeout(() => {
    if (!finished) {
      if (mode === 'pre-compact' && !flags.noReminder) emit(PRECOMPACT_REMINDER);
      else if (mode === 'session-start' && !flags.noBoot) emit(BOOT_NOTICE);
    }
    process.exit(0);
  }, WATCHDOG_MS);
  const timer = setTimeout(done, STDIN_WAIT_MS);
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { raw += c; });
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); done(); });
  } catch {
    clearTimeout(timer);
    done();
  }
}
