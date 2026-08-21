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

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
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
 */
const SILENT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  GCM_INTERACTIVE: 'never',
};

function classify(stderr: string): GitResult['reason'] | undefined {
  const s = stderr.toLowerCase();
  if (s.includes('could not resolve host') || s.includes('unable to access') ||
      s.includes('network is unreachable') || s.includes('operation timed out')) return 'offline';
  if (s.includes('authentication failed') || s.includes('permission denied') ||
      s.includes('could not read username') || s.includes('terminal prompts disabled')) return 'auth';
  if (s.includes('conflict')) return 'conflict';
  return undefined;
}

export function git(args: string[], cwd: string, timeoutMs = 20_000): GitResult {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, ...SILENT_ENV },
  });

  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      stdout: '',
      stderr: String(r.error.message || ''),
      reason: code === 'ENOENT' ? 'no_git' : 'timeout',
    };
  }
  if (r.signal) {
    return { ok: false, stdout: r.stdout || '', stderr: r.stderr || '', reason: 'timeout' };
  }

  const stderr = r.stderr || '';
  return {
    ok: r.status === 0,
    stdout: r.stdout || '',
    stderr,
    reason: r.status === 0 ? undefined : classify(stderr),
  };
}

/** Is git installed at all? */
export function gitAvailable(): boolean {
  return git(['--version'], process.cwd(), 5_000).ok;
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
export function hardenRepo(dir: string): void {
  git(['config', 'core.autocrlf', 'false'], dir);
  git(['config', 'core.safecrlf', 'false'], dir);
  git(['config', 'merge.ours.driver', 'true'], dir);
  // Identity, so committing works on a machine with no global git config.
  if (!git(['config', 'user.email'], dir).stdout.trim()) {
    git(['config', 'user.email', 'crbro@localhost'], dir);
  }
  if (!git(['config', 'user.name'], dir).stdout.trim()) {
    git(['config', 'user.name', 'CRBRO'], dir);
  }
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

/** Prepare a brand-new space so the first person to clone finds real history. */
export async function initSpace(dir: string, remote: string, branch = 'main'): Promise<GitResult> {
  await fs.mkdir(dir, { recursive: true });

  const init = git(['init', '-b', branch], dir);
  if (!init.ok && !init.stdout.includes('Reinitialized')) {
    const legacy = git(['init'], dir);
    if (!legacy.ok) return legacy;
    git(['checkout', '-b', branch], dir);
  }
  hardenRepo(dir);

  await fs.writeFile(path.join(dir, '.gitattributes'), GITATTRIBUTES, 'utf-8');
  await fs.writeFile(path.join(dir, '.gitignore'), GITIGNORE, 'utf-8');

  git(['remote', 'remove', 'origin'], dir);
  const add = git(['remote', 'add', 'origin', remote], dir);
  if (!add.ok) return add;

  git(['add', '-A', '.'], dir);
  git(['commit', '-q', '-m', 'CRBRO shared space'], dir);

  // Push the first commit before anyone clones. Skipping this is how two
  // people end up with unrelated histories and a merge that refuses to run —
  // each of them keeping their own half of the memory without noticing.
  return git(['push', '-u', 'origin', `HEAD:${branch}`], dir, 30_000);
}

/** Clone an existing space. */
export function cloneSpace(dir: string, remote: string, branch = 'main'): GitResult {
  const parent = path.dirname(dir);
  const name = path.basename(dir);
  const r = git(['clone', '--branch', branch, remote, name], parent, 60_000);
  if (r.ok) hardenRepo(dir);
  return r;
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
  git(['add', '-A', '.'], dir);
  const hayCambios = !git(['diff', '--cached', '--quiet'], dir).ok;
  if (hayCambios) {
    git(['commit', '-q', '-m', `crbro ${author} ${new Date().toISOString()}`], dir);
  }

  const fetched = git(['fetch', 'origin', branch], dir, timeoutMs);
  if (!fetched.ok) return { pulled: fetched, pushed: null };

  const merged = git(
    ['merge', '--no-edit', '--allow-unrelated-histories', `origin/${branch}`],
    dir,
    timeoutMs
  );
  if (!merged.ok) {
    // Union merging makes this rare, but a hand-edited file could still clash.
    // Keeping both sides and stopping beats guessing.
    git(['merge', '--abort'], dir);
    return { pulled: { ...merged, reason: 'conflict' }, pushed: null };
  }

  // Push, and if someone landed first, take their work and try once more.
  let pushed = git(['push', 'origin', `HEAD:${branch}`], dir, timeoutMs);
  for (let intento = 0; intento < 2 && !pushed.ok && pushed.reason !== 'auth'; intento++) {
    if (!git(['fetch', 'origin', branch], dir, timeoutMs).ok) break;
    if (!git(['merge', '--no-edit', `origin/${branch}`], dir, timeoutMs).ok) {
      git(['merge', '--abort'], dir);
      break;
    }
    pushed = git(['push', 'origin', `HEAD:${branch}`], dir, timeoutMs);
  }

  return { pulled: merged, pushed };
}
