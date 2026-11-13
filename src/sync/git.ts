// ─── CRBRO Shared Memory: the git transport ──────────────────────
//
// Git is the whole backend. No service to run, no account to create, no bill:
// a private repository is already storage, history, access control and a merge
// engine, and the user picks where it lives.
//
// Two things about running git from inside an MCP server matter more than the
// commands themselves. It must never wait for a human — there is no terminal
// on the other end of stdio, so a credential prompt would hang the assistant
// forever. And it must never rewrite what it stores: git on Windows converts
// line endings by default, which turns one appended line into two different
// lines on two machines, and the logs here are append-only.
//
// 2.11: a third. Inside the shared daemon a synchronous git call blocks every
// client for as long as a push takes (up to 30 s). Each multi-step operation is
// written once as a generator of git calls and driven either synchronously or
// asynchronously; the server path uses the async drivers.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set when the failure has a cause worth telling the user about. */
  reason?: 'no_git' | 'offline' | 'auth' | 'timeout' | 'conflict';
}

/**
 * Everything that could make git stop and ask a person something, turned off.
 * Without this the server hangs on the first private repository it meets.
 * A GIT_SSH_COMMAND the user set is kept: replacing it silently overrode their
 * own ssh setup (G16).
 */
function silentEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_SSH_COMMAND: process.env['GIT_SSH_COMMAND'] || 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    GCM_INTERACTIVE: 'never',
  };
}

function classify(stderr: string): GitResult['reason'] | undefined {
  const s = stderr.toLowerCase();
  if (s.includes('could not resolve host') || s.includes('unable to access') ||
      s.includes('network is unreachable') || s.includes('operation timed out')) return 'offline';
  if (s.includes('authentication failed') || s.includes('permission denied') ||
      s.includes('could not read username') || s.includes('terminal prompts disabled')) return 'auth';
  if (s.includes('conflict')) return 'conflict';
  return undefined;
}

// ─── Which git ───────────────────────────────────────────────────
//
// On Windows a bare "git" is looked up in the child's working directory before
// PATH. Every call here runs with cwd = a space directory, whose contents come
// from teammates: a git.exe committed at its root would run as the user (G10).
// So the executable is resolved once, from absolute PATH entries only.

let resolved: string | null = null;

export function resolveGit(): string {
  if (process.platform !== 'win32') return 'git';
  if (resolved && existsSync(resolved)) return resolved;
  resolved = null;
  for (const entry of (process.env['PATH'] || process.env['Path'] || '').split(path.delimiter)) {
    const d = entry.trim().replace(/^"|"$/g, '');
    if (!d || !path.isAbsolute(d)) continue;
    const exe = path.join(d, 'git.exe');
    try {
      if (statSync(exe).isFile()) { resolved = exe; return exe; }
    } catch { /* not here */ }
  }
  // Not on PATH: the bare name fails with ENOENT from a neutral directory
  // (see git()), which reports no_git rather than running a planted binary.
  return 'git';
}

function neutralCwd(cwd: string): { cwd: string; args: string[] } {
  // With an absolute executable the space directory is a safe cwd. Without one
  // (git not found), run from the system directory and pass -C instead.
  if (process.platform === 'win32' && resolveGit() === 'git') {
    const root = process.env['SystemRoot'] || 'C:\\Windows';
    return { cwd: root, args: ['-C', cwd] };
  }
  return { cwd, args: [] };
}

function toResult(status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string, error?: Error): GitResult {
  if (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, stdout: '', stderr: String(error.message || ''), reason: code === 'ENOENT' ? 'no_git' : 'timeout' };
  }
  if (signal) return { ok: false, stdout, stderr, reason: 'timeout' };
  return { ok: status === 0, stdout, stderr, reason: status === 0 ? undefined : classify(stderr) };
}

export function git(args: string[], cwd: string, timeoutMs = 20_000): GitResult {
  const where = neutralCwd(cwd);
  const r = spawnSync(resolveGit(), [...where.args, ...args], {
    cwd: where.cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
    env: silentEnv(),
  });
  return toResult(r.status, r.signal, r.stdout || '', r.stderr || '', r.error);
}

/** The same call without blocking the event loop. */
export function gitAsync(args: string[], cwd: string, timeoutMs = 20_000): Promise<GitResult> {
  return new Promise(resolve => {
    const where = neutralCwd(cwd);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const done = (r: GitResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveGit(), [...where.args, ...args], {
        cwd: where.cwd, windowsHide: true, env: silentEnv(), stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      done(toResult(null, null, '', '', err as Error));
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', d => { stdout += d; });
    child.stderr!.on('data', d => { stderr += d; });
    child.on('error', err => done(toResult(null, null, stdout, stderr, err)));
    child.on('close', (code, signal) => done(timedOut
      ? { ok: false, stdout, stderr, reason: 'timeout' }
      : toResult(code, signal, stdout, stderr)));
  });
}

// ─── Multi-step operations, written once ─────────────────────────

interface GitCall { args: string[]; cwd: string; timeoutMs?: number }
type GitOp<T> = Generator<GitCall, T, GitResult>;

function driveSync<T>(g: GitOp<T>): T {
  let step = g.next();
  while (!step.done) step = g.next(git(step.value.args, step.value.cwd, step.value.timeoutMs));
  return step.value;
}

async function driveAsync<T>(g: GitOp<T>): Promise<T> {
  let step = g.next();
  while (!step.done) step = g.next(await gitAsync(step.value.args, step.value.cwd, step.value.timeoutMs));
  return step.value;
}

/** Is git installed at all? */
export function gitAvailable(): boolean {
  return git(['--version'], process.cwd(), 5_000).ok;
}

// Whether git is installed does not change between two syncs; asking costs a
// process start. Kept for a minute, failures included.
let availability: { ok: boolean; at: number } | null = null;
export async function gitAvailableAsync(): Promise<boolean> {
  if (availability && Date.now() - availability.at < 60_000) return availability.ok;
  const ok = (await gitAsync(['--version'], process.cwd(), 5_000)).ok;
  availability = { ok, at: Date.now() };
  return ok;
}

/**
 * Settings that have to be on the repository itself, not on the machine.
 *
 * `core.autocrlf` ships enabled on Windows — verified true at system level on
 * the machine this was built on — and it rewrites files on checkout. With
 * append-only logs merged by union, the same line with two different endings
 * becomes two lines, and the memory quietly duplicates itself. `* -text` in
 * .gitattributes plus this setting stops it at both ends.
 */
function* hardenGen(dir: string): GitOp<void> {
  yield { args: ['config', 'core.autocrlf', 'false'], cwd: dir };
  yield { args: ['config', 'core.safecrlf', 'false'], cwd: dir };
  yield { args: ['config', 'merge.ours.driver', 'true'], cwd: dir };
  // Identity, so committing works on a machine with no global git config.
  if (!(yield { args: ['config', 'user.email'], cwd: dir }).stdout.trim()) {
    yield { args: ['config', 'user.email', 'crbro@localhost'], cwd: dir };
  }
  if (!(yield { args: ['config', 'user.name'], cwd: dir }).stdout.trim()) {
    yield { args: ['config', 'user.name', 'CRBRO'], cwd: dir };
  }
}

export function hardenRepo(dir: string): void {
  driveSync(hardenGen(dir));
}

export const GITATTRIBUTES =
  '# CRBRO shared memory. Do not edit.\n' +
  '# -text keeps git from rewriting line endings: these logs are append-only\n' +
  '# and a rewritten ending turns one line into two on the next merge.\n' +
  '* -text\n' +
  '*.jsonl merge=union\n';

export const GITIGNORE =
  '# Local bookkeeping. Never shared.\n' +
  '.local/\n';

function* initGen(dir: string, remote: string, branch: string): GitOp<GitResult> {
  mkdirSync(dir, { recursive: true });

  const init = yield { args: ['init', '-b', branch], cwd: dir };
  if (!init.ok && !init.stdout.includes('Reinitialized')) {
    const legacy = yield { args: ['init'], cwd: dir };
    if (!legacy.ok) return legacy;
    yield { args: ['checkout', '-b', branch], cwd: dir };
  }
  yield* hardenGen(dir);

  writeFileSync(path.join(dir, '.gitattributes'), GITATTRIBUTES, 'utf-8');
  writeFileSync(path.join(dir, '.gitignore'), GITIGNORE, 'utf-8');

  yield { args: ['remote', 'remove', 'origin'], cwd: dir };
  // "--": a remote that starts with "-" is a URL, never an option.
  const add = yield { args: ['remote', 'add', '--', 'origin', remote], cwd: dir };
  if (!add.ok) return add;

  yield { args: ['add', '-A', '.'], cwd: dir };
  yield { args: ['commit', '-q', '-m', 'CRBRO shared space'], cwd: dir };

  // Push the first commit before anyone clones. Skipping this is how two
  // people end up with unrelated histories and a merge that refuses to run —
  // each of them keeping their own half of the memory without noticing.
  return yield { args: ['push', '-u', 'origin', `HEAD:${branch}`], cwd: dir, timeoutMs: 30_000 };
}

/** Prepare a brand-new space so the first person to clone finds real history. */
export async function initSpace(dir: string, remote: string, branch = 'main'): Promise<GitResult> {
  return driveSync(initGen(dir, remote, branch));
}

export function initSpaceAsync(dir: string, remote: string, branch = 'main'): Promise<GitResult> {
  return driveAsync(initGen(dir, remote, branch));
}

function* cloneGen(dir: string, remote: string, branch: string): GitOp<GitResult> {
  const parent = path.dirname(dir);
  const name = path.basename(dir);
  const r = yield { args: ['clone', '--branch', branch, '--', remote, name], cwd: parent, timeoutMs: 60_000 };
  if (r.ok) yield* hardenGen(dir);
  return r;
}

/** Clone an existing space. */
export function cloneSpace(dir: string, remote: string, branch = 'main'): GitResult {
  return driveSync(cloneGen(dir, remote, branch));
}

export function cloneSpaceAsync(dir: string, remote: string, branch = 'main'): Promise<GitResult> {
  return driveAsync(cloneGen(dir, remote, branch));
}

function* syncGen(dir: string, author: string, branch: string, timeoutMs: number): GitOp<{ pulled: GitResult; pushed: GitResult | null }> {
  yield { args: ['add', '-A', '.'], cwd: dir };
  const hayCambios = !(yield { args: ['diff', '--cached', '--quiet'], cwd: dir }).ok;
  if (hayCambios) {
    yield { args: ['commit', '-q', '-m', `crbro ${author} ${new Date().toISOString()}`], cwd: dir };
  }

  const fetched = yield { args: ['fetch', 'origin', '--', branch], cwd: dir, timeoutMs };
  if (!fetched.ok) return { pulled: fetched, pushed: null };

  const merged = yield { args: ['merge', '--no-edit', '--allow-unrelated-histories', `origin/${branch}`], cwd: dir, timeoutMs };
  if (!merged.ok) {
    // Union merging makes this rare, but a hand-edited file could still clash.
    // Keeping both sides and stopping beats guessing.
    yield { args: ['merge', '--abort'], cwd: dir };
    return { pulled: { ...merged, reason: 'conflict' }, pushed: null };
  }

  // Push, and if someone landed first, take their work and try once more.
  let pushed = yield { args: ['push', 'origin', `HEAD:${branch}`], cwd: dir, timeoutMs };
  for (let intento = 0; intento < 2 && !pushed.ok && pushed.reason !== 'auth'; intento++) {
    if (!(yield { args: ['fetch', 'origin', '--', branch], cwd: dir, timeoutMs }).ok) break;
    if (!(yield { args: ['merge', '--no-edit', `origin/${branch}`], cwd: dir, timeoutMs }).ok) {
      yield { args: ['merge', '--abort'], cwd: dir };
      break;
    }
    pushed = yield { args: ['push', 'origin', `HEAD:${branch}`], cwd: dir, timeoutMs };
  }

  return { pulled: merged, pushed };
}

/**
 * Bring in everyone else's notes and send ours.
 * Offline is a normal outcome, not an error: the work stays local and goes out
 * next time. Nothing here can lose a note, because nobody edits anyone's file.
 */
export function syncSpace(
  dir: string,
  author: string,
  branch = 'main',
  timeoutMs = 30_000
): { pulled: GitResult; pushed: GitResult | null } {
  return driveSync(syncGen(dir, author, branch, timeoutMs));
}

export function syncSpaceAsync(
  dir: string,
  author: string,
  branch = 'main',
  timeoutMs = 30_000
): Promise<{ pulled: GitResult; pushed: GitResult | null }> {
  return driveAsync(syncGen(dir, author, branch, timeoutMs));
}

/** Tests: forget the resolved executable and the availability memo. */
export function _resetGitMemoForTests(): void {
  resolved = null;
  availability = null;
}
