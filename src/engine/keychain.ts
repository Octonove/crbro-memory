// ─── CRBRO Keychain Broker ───────────────────────────────────────
//
// The secret filter says no. It refuses to write a credential into the brain,
// which is right — but it leaves the user holding a password and nowhere to
// put it, so it goes back into a config file in plain text and nothing was
// gained. This module is the other half of that sentence: "no, not in memory —
// I put it in your keychain and remembered the name."
//
// CRBRO stores nothing itself and invents no crypto. Every platform already
// ships a credential store that is better reviewed than anything written here
// could be, so the job is to broker access to it and stay out of the way:
//
//   macOS    security(1), the login keychain
//   Linux    secret-tool(1), the Secret Service the desktop already runs
//   Windows  DPAPI through PowerShell, sealed to the user account
//
// Windows is the odd one. Its Credential Manager has no supported way to read
// a secret back from the command line — cmdkey writes but will not return the
// value, and reading needs P/Invoke into CredRead. So there the secret is
// sealed with DPAPI, which is the same crypto the Credential Manager uses,
// into a file only that Windows account can open. Copied to another machine,
// lifted from a backup or pushed to a repository, it is unreadable.
//
// The store lives OUTSIDE the brain on purpose. Nothing under ~/.crbro is ever
// consulted here, so no sync, no team space and no `crbro_share` can reach a
// secret even if some future bug tried to.

import { spawnSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

/** Namespace under which every CRBRO secret is filed in the OS store. */
const SERVICE = 'crbro';

/**
 * Windows only: the sealed file, deliberately a sibling of the brain, never
 * inside it. CRBRO_KEYS_DIR redirects it, which is how the tests avoid writing
 * into the real store — a test suite that can only run by touching the user's
 * own credentials is a test suite nobody runs twice.
 */
function winPaths() {
  const dir = process.env['CRBRO_KEYS_DIR'] || join(homedir(), '.crbro-keys');
  return { dir, file: join(dir, 'keys.dpapi') };
}

export type Backend = 'macos-keychain' | 'linux-secret-service' | 'windows-dpapi';

export interface SecretEntry {
  name: string;
  description: string;
  updated: string;
}

export class KeychainUnavailable extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'KeychainUnavailable';
  }
}

/** Runs a command without a shell, so a value with spaces or quotes cannot be reinterpreted. */
function run(cmd: string, args: string[], input?: string) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    timeout: 30_000,
    windowsHide: true,
  });
}

/**
 * Which store this machine can actually use — not which one it should have.
 * Returns null with a reason the caller can show the user, because "no
 * keychain here" is a normal answer on a headless box, not a failure.
 */
export function detectBackend(): { backend: Backend | null; reason?: string } {
  const os = platform();

  if (os === 'darwin') {
    const probe = run('security', ['-h']);
    if (probe.error) return { backend: null, reason: 'security(1) not found — unexpected on macOS.' };
    return { backend: 'macos-keychain' };
  }

  if (os === 'win32') {
    const probe = run('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
    if (probe.error || probe.status !== 0) {
      return { backend: null, reason: 'PowerShell not available, so DPAPI cannot be reached.' };
    }
    return { backend: 'windows-dpapi' };
  }

  // Linux and the BSDs. secret-tool needs a running Secret Service over D-Bus;
  // over SSH with no desktop session there is usually none, and that is worth
  // saying plainly rather than failing with a D-Bus error.
  const probe = run('secret-tool', ['--help']);
  if (probe.error) {
    return { backend: null, reason: 'secret-tool not installed. On Debian/Ubuntu: apt install libsecret-tools.' };
  }
  if (!process.env['DBUS_SESSION_BUS_ADDRESS']) {
    return {
      backend: null,
      reason: 'secret-tool is installed but no D-Bus session is running, which is normal over SSH. ' +
        'Start a session bus or use the CRBRO_SECRET_* environment variables instead.',
    };
  }
  return { backend: 'linux-secret-service' };
}

function requireBackend(): Backend {
  const { backend, reason } = detectBackend();
  if (!backend) throw new KeychainUnavailable(reason ?? 'No credential store available on this machine.');
  return backend;
}

// ─── Windows: DPAPI-sealed file ──────────────────────────────────
//
// One JSON object, sealed as a whole. Sealing per entry would leak the shape
// of the store; sealing the whole thing means an observer learns only its size.

interface WinStore {
  [name: string]: { value: string; description: string; updated: string };
}

// Every DPAPI call costs a PowerShell start, about a second. A script that
// needs four credentials would pay four seconds for no reason, so a read is
// held briefly in memory.
//
// Briefly is the whole point. The MCP server is long-lived, and a cache with
// no expiry would keep every secret in the heap for as long as the editor is
// open. Thirty seconds covers the burst of reads at the start of a task and
// nothing beyond it.
const CACHE_TTL_MS = 30_000;
let cached: { store: WinStore; at: number; file: string } | null = null;

function invalidateCache(): void {
  cached = null;
}

function psDpapi(script: string, input?: string) {
  const r = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], input);
  if (r.error || r.status !== 0) {
    throw new KeychainUnavailable(`DPAPI call failed: ${(r.stderr || '').trim() || 'unknown error'}`);
  }
  return r.stdout;
}

function winRead(): WinStore {
  const { file } = winPaths();
  if (cached && cached.file === file && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.store;
  }
  if (!existsSync(file)) return {};
  const sealed = readFileSync(file, 'utf8').trim();
  if (!sealed) return {};
  // ConvertTo-SecureString without -Key is DPAPI at CurrentUser scope: only
  // this Windows account, on this machine, can turn it back into text.
  const json = psDpapi(
    '$e = [Console]::In.ReadToEnd().Trim();' +
    '$s = ConvertTo-SecureString $e;' +
    '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);' +
    'try { [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) }' +
    'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }',
    sealed);
  try {
    const store = JSON.parse(json) as WinStore;
    cached = { store, at: Date.now(), file };
    return store;
  } catch {
    throw new KeychainUnavailable('The key store exists but could not be read. It was sealed by a different Windows account.');
  }
}

function winWrite(store: WinStore): void {
  const { dir, file } = winPaths();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sealed = psDpapi(
    '$j = [Console]::In.ReadToEnd();' +
    'ConvertTo-SecureString $j -AsPlainText -Force | ConvertFrom-SecureString',
    JSON.stringify(store)).trim();
  // Atomic: a crash mid-write leaves the previous store intact rather than a
  // truncated file that would take every secret with it.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, sealed, { encoding: 'ascii', mode: 0o600 });
  renameSync(tmp, file);
  cached = { store, at: Date.now(), file };
}

// ─── macOS: an index of its own ──────────────────────────────────
//
// There is no clean way to list the items of one service. dump-keychain asks
// for authorisation once per item, and find-generic-password -g returns a
// single match and prints the password to stderr behind a "password: " prefix
// — reading that back just to enumerate names would mean handling secrets
// for no reason. So the names live in an item of their own: one extra write
// per change, and a listing that tells the truth.

// security(1) prints the whole value as hex pairs if a single byte of it is
// not printable, and a UTF-8 accent is two bytes above 0x7F — so "contraseña"
// comes back as "636f6e747261736ec3b161". Worse, it is ambiguous: the literal
// secret "deadbeef" is returned exactly like the hex of the bytes DE AD BE EF,
// and nothing in the output says which one it was.
//
// Base64 is printable ASCII from end to end, so the hex path is never taken
// and any byte sequence survives the round trip unchanged.
function macEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function macDecode(raw: string): string {
  // -w always ends with a newline of its own (putchar), and only that one is
  // removed: .trim() would eat spaces that belong to the secret.
  return Buffer.from(raw.replace(/\n$/, ''), 'base64').toString('utf8');
}

const MAC_INDEX = '__crbro_index__';

interface MacIndex {
  [name: string]: { description: string; updated: string };
}

function macReadIndex(): MacIndex {
  const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', MAC_INDEX, '-w']);
  if (r.status !== 0) return {};
  try {
    return JSON.parse(macDecode(r.stdout)) as MacIndex;
  } catch {
    return {};
  }
}

function macWriteIndex(index: MacIndex): void {
  run('security',
    ['add-generic-password', '-U', '-s', SERVICE, '-a', MAC_INDEX, '-w', macEncode(JSON.stringify(index)), '-T', '/usr/bin/security']);
}

// ─── Public surface ──────────────────────────────────────────────

export function setSecret(name: string, value: string, description = ''): void {
  const backend = requireBackend();
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid secret name "${name}". Use SCREAMING_SNAKE_CASE, e.g. WORDPRESS_APP_PASSWORD.`);
  }
  if (!value) throw new Error('Refusing to store an empty value.');

  if (backend === 'windows-dpapi') {
    const store = winRead();
    store[name] = { value, description, updated: new Date().toISOString().slice(0, 10) };
    winWrite(store);
    return;
  }

  if (backend === 'macos-keychain') {
    // -U updates in place instead of erroring when the item already exists.
    // -w with the value on argv is visible to `ps` for the life of the call;
    // security(1) offers no stdin form, so the exposure is unavoidable and
    // measured in milliseconds on the user's own machine.
    const r = run('security',
      ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', macEncode(value), '-j', description, '-T', '/usr/bin/security']);
    if (r.status !== 0) throw new KeychainUnavailable(`Keychain refused the write: ${(r.stderr || '').trim()}`);
    const index = macReadIndex();
    index[name] = { description, updated: new Date().toISOString().slice(0, 10) };
    macWriteIndex(index);
    return;
  }

  // secret-tool reads the secret from stdin, so it never reaches the process
  // table. It stays open waiting for EOF, which spawnSync gives it.
  const r = run('secret-tool',
    ['store', '--label', `CRBRO ${name}`, 'service', SERVICE, 'account', name, 'description', description],
    value);
  if (r.status !== 0) throw new KeychainUnavailable(`secret-tool refused the write: ${(r.stderr || '').trim()}`);
}

/**
 * The value, or null when there is no such secret. An environment variable of
 * the same name wins, which is what makes CI and one-off overrides work
 * without touching the store.
 */
export function getSecret(name: string): string | null {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;

  const backend = requireBackend();

  if (backend === 'windows-dpapi') {
    return winRead()[name]?.value ?? null;
  }

  if (backend === 'macos-keychain') {
    const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
    // security(1) returns the OSStatus itself, truncated to eight bits: 44 is
    // errSecItemNotFound, 36 is errSecInteractionNotAllowed — a locked
    // keychain, which is the normal state over SSH and in CI. Reporting that
    // one as "no such secret" would send someone hunting for a typo.
    if (r.status === 36) {
      throw new KeychainUnavailable(
        'The macOS keychain is locked, which is usual over SSH or in CI. Unlock it in a desktop session, ' +
        'or pass the credential as an environment variable instead.');
    }
    if (r.status !== 0) return null;
    return macDecode(r.stdout);
  }

  // Unlike security(1), secret-tool adds no trailing newline when stdout
  // is a pipe: write_password_stdout only appends one for a tty. Trimming
  // here would silently eat a newline that was genuinely part of the secret.
  // Exit 1 with nothing on stderr is how it reports "no such item"; anything
  // on stderr is a real failure and must not be mistaken for absence.
  const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', name]);
  if (r.status === 0) return r.stdout;
  if (r.status === 1 && !(r.stderr || '').trim()) return null;
  throw new KeychainUnavailable(`secret-tool failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
}

/** Names and descriptions only. Values are never returned by design. */
export function listSecrets(): SecretEntry[] {
  const backend = requireBackend();

  if (backend === 'windows-dpapi') {
    return Object.entries(winRead())
      .map(([name, e]) => ({ name, description: e.description, updated: e.updated }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  if (backend === 'macos-keychain') {
    return Object.entries(macReadIndex())
      .map(([name, e]) => ({ name, description: e.description, updated: e.updated }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const r = run('secret-tool', ['search', '--all', 'service', SERVICE]);
  if (r.status !== 0) return [];
  const names = [...r.stdout.matchAll(/^attribute\.account = (.+)$/gm)].map(m => m[1].trim());
  return [...new Set(names)].sort().map(name => ({ name, description: '', updated: '' }));
}

export function removeSecret(name: string): boolean {
  const backend = requireBackend();

  if (backend === 'windows-dpapi') {
    const store = winRead();
    if (!(name in store)) return false;
    delete store[name];
    winWrite(store);
    return true;
  }

  if (backend === 'macos-keychain') {
    const gone = run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]).status === 0;
    if (gone) {
      const index = macReadIndex();
      delete index[name];
      macWriteIndex(index);
    }
    return gone;
  }

  return run('secret-tool', ['clear', 'service', SERVICE, 'account', name]).status === 0;
}

/** Windows only, and only for tests: forget the sealed file entirely. */
export function _resetWindowsStoreForTests(): void {
  invalidateCache();
  const { file } = winPaths();
  if (existsSync(file)) unlinkSync(file);
}
