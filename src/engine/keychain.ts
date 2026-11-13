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
//
// 2.11. Every operation is written once, as a generator that yields the
// commands it needs, and driven two ways: synchronously (the CLI and the
// callers that already used the sync API) or asynchronously, so that a slow
// PowerShell start inside the shared daemon no longer blocks every other
// conversation. The probe is memoised; the Windows file is never treated as
// empty when it has gone missing; and every successful write keeps a rotated
// byte copy of the sealed file next to it.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import {
  existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync,
  readdirSync, statSync,
} from 'node:fs';
import { withLock, withLockSync } from '../utils/lock.js';

/** Namespace under which every CRBRO secret is filed in the OS store. */
const SERVICE = 'crbro';

/** The one shape a secret name may take, on every action. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function checkName(name: string): void {
  if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) {
    throw new Error(`Invalid secret name "${String(name).slice(0, 60)}". Use SCREAMING_SNAKE_CASE, e.g. WORDPRESS_APP_PASSWORD.`);
  }
}

/**
 * Windows only: the sealed file, deliberately a sibling of the brain, never
 * inside it. CRBRO_KEYS_DIR redirects it, which is how the tests avoid writing
 * into the real store — a test suite that can only run by touching the user's
 * own credentials is a test suite nobody runs twice.
 */
function winPaths() {
  const dir = process.env['CRBRO_KEYS_DIR'] || join(homedir(), '.crbro-keys');
  return {
    dir,
    file: join(dir, 'keys.dpapi'),
    /** Plain, unsealed: says a store existed here. Holds dates only, never names. */
    marker: join(dir, 'keys.dpapi.marker'),
    /** Byte copies of the sealed file, never opened except to validate a restore. */
    copies: join(dir, 'sealed-copies'),
  };
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

/**
 * The Windows store file is gone but something says it existed: the marker, a
 * sealed copy or a leftover temporary file. Reading that as "empty" is how a
 * keychain of seventy entries turned into one of a single entry (2.10).
 */
export class KeychainMissing extends KeychainUnavailable {
  constructor(reason: string, public readonly evidence: string[]) {
    super(reason);
    this.name = 'KeychainMissing';
  }
}

// ─── Running commands, sync or async ─────────────────────────────

interface Cmd { cmd: string; args: string[]; input?: string }
interface RunResult { status: number | null; stdout: string; stderr: string; error?: Error }
type Op<T> = Generator<Cmd, T, RunResult>;

const RUN_TIMEOUT_MS = 30_000;

/**
 * On Windows a bare command name is searched in the child's working directory
 * before PATH, so a powershell.exe dropped into whatever folder the client was
 * opened in would run instead of the real one. The system copy has a fixed
 * place; use it whenever it is there.
 */
function resolveCommand(cmd: string): string {
  if (platform() === 'win32' && cmd === 'powershell.exe') {
    const root = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows';
    const abs = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(abs)) return abs;
  }
  return cmd;
}

function runSyncReal(c: Cmd): RunResult {
  const r = spawnSync(resolveCommand(c.cmd), c.args, {
    encoding: 'utf8',
    input: c.input,
    timeout: RUN_TIMEOUT_MS,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function runAsyncReal(c: Cmd): Promise<RunResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: RunResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveCommand(c.cmd), c.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      done({ status: null, stdout: '', stderr: '', error: err as Error });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ status: null, stdout, stderr, error: Object.assign(new Error(`${c.cmd} timed out`), { code: 'ETIMEDOUT' }) });
    }, RUN_TIMEOUT_MS);
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', d => { stdout += d; });
    child.stderr!.on('data', d => { stderr += d; });
    child.on('error', err => done({ status: null, stdout, stderr, error: err }));
    child.on('close', code => done({ status: code, stdout, stderr }));
    child.stdin!.on('error', () => { /* the child may exit before reading: its status says why */ });
    child.stdin!.end(c.input ?? '');
  });
}

let runSync: (c: Cmd) => RunResult = runSyncReal;
let runAsync: (c: Cmd) => Promise<RunResult> = runAsyncReal;
let platformOverride: NodeJS.Platform | null = null;
const os = (): NodeJS.Platform => platformOverride ?? platform();

function driveSync<T>(g: Op<T>): T {
  let step = g.next();
  while (!step.done) step = g.next(runSync(step.value));
  return step.value;
}

async function driveAsync<T>(g: Op<T>): Promise<T> {
  let step = g.next();
  while (!step.done) step = g.next(await runAsync(step.value));
  return step.value;
}

/** The lock that serialises read-modify-write on every backend (macOS and Linux keep an index). */
function storeLockTarget(): string {
  return winPaths().file;
}

function lockedSync<T>(make: () => Op<T>): T {
  return withLockSync(storeLockTarget(), () => driveSync(make()));
}

function lockedAsync<T>(make: () => Op<T>): Promise<T> {
  return withLock(storeLockTarget(), () => driveAsync(make()));
}

// ─── Which store, memoised ───────────────────────────────────────

// The probe is a PowerShell start on Windows, around half a second, and it
// used to run before every get, list and set. Its answer does not change from
// one call to the next: a success is kept five minutes, a failure thirty
// seconds (a transient failure should not hide a store for long).
const PROBE_OK_MS = 5 * 60_000;
const PROBE_FAIL_MS = 30_000;
let probe: { result: { backend: Backend | null; reason?: string }; at: number; os: string } | null = null;

function* detectGen(): Op<{ backend: Backend | null; reason?: string }> {
  const current = os();
  if (probe && probe.os === current) {
    const ttl = probe.result.backend ? PROBE_OK_MS : PROBE_FAIL_MS;
    if (Date.now() - probe.at < ttl) return probe.result;
  }
  const result = yield* probeGen(current);
  probe = { result, at: Date.now(), os: current };
  return result;
}

function* probeGen(current: string): Op<{ backend: Backend | null; reason?: string }> {
  if (current === 'darwin') {
    const r = yield { cmd: 'security', args: ['-h'] };
    if (r.error) return { backend: null, reason: 'security(1) not found — unexpected on macOS.' };
    return { backend: 'macos-keychain' };
  }

  if (current === 'win32') {
    // Starting PowerShell is not the same as being able to encrypt. On CI
    // runners and locked-down corporate machines it answers happily and then
    // fails at the first write, so the probe seals a byte for real.
    const r = yield { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROBE] };
    if (r.error || r.status !== 0 || !r.stdout.includes('ok')) {
      return {
        backend: null,
        reason: 'DPAPI is not reachable from PowerShell here, which happens on CI runners and ' +
          'locked-down machines. Credentials can still be passed as CRBRO_SECRET_<NAME> environment variables.',
      };
    }
    return { backend: 'windows-dpapi' };
  }

  // Linux and the BSDs. secret-tool needs a running Secret Service over D-Bus;
  // over SSH with no desktop session there is usually none, and that is worth
  // saying plainly rather than failing with a D-Bus error.
  const r = yield { cmd: 'secret-tool', args: ['--help'] };
  if (r.error) {
    return { backend: null, reason: 'secret-tool not installed. On Debian/Ubuntu: apt install libsecret-tools.' };
  }
  if (!process.env['DBUS_SESSION_BUS_ADDRESS']) {
    return {
      backend: null,
      reason: 'secret-tool is installed but no D-Bus session is running, which is normal over SSH. ' +
        'Start a session bus or use CRBRO_SECRET_<NAME> environment variables instead.',
    };
  }
  return { backend: 'linux-secret-service' };
}

/**
 * Which store this machine can actually use — not which one it should have.
 * Returns null with a reason the caller can show the user, because "no
 * keychain here" is a normal answer on a headless box, not a failure.
 */
export function detectBackend(): { backend: Backend | null; reason?: string } {
  return driveSync(detectGen());
}

let probeInFlight: Promise<{ backend: Backend | null; reason?: string }> | null = null;
export function detectBackendAsync(): Promise<{ backend: Backend | null; reason?: string }> {
  if (!probeInFlight) {
    probeInFlight = driveAsync(detectGen()).finally(() => { probeInFlight = null; });
  }
  return probeInFlight;
}

function* requireBackendGen(): Op<Backend> {
  const { backend, reason } = yield* detectGen();
  if (!backend) throw new KeychainUnavailable(reason ?? 'No credential store available on this machine.');
  return backend;
}

// ─── Environment overrides: explicit, never the whole environment ─

/**
 * Until 2.10 any variable of the server's environment came back from get —
 * USERNAME, ANTHROPIC_API_KEY, whatever the client had. Now only two things
 * count, both opt-in: a variable named CRBRO_SECRET_<NAME>, which exists for
 * no other reason, and a plain <NAME> that CRBRO_SECRET_ENV lists by name.
 */
function fromEnvironment(name: string): string | null {
  const prefixed = process.env[`CRBRO_SECRET_${name}`];
  if (prefixed) return prefixed;
  const allowed = (process.env['CRBRO_SECRET_ENV'] || '').split(/[\s,;]+/).filter(Boolean);
  if (allowed.includes(name)) {
    const plain = process.env[name];
    if (plain) return plain;
  }
  return null;
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
// nothing beyond it — and a timer drops it then, not the next call.
const CACHE_TTL_MS = 30_000;
let cached: { store: WinStore; at: number; file: string; sealed: string } | null = null;
let cacheTimer: ReturnType<typeof setTimeout> | null = null;

function invalidateCache(): void {
  cached = null;
  if (cacheTimer) { clearTimeout(cacheTimer); cacheTimer = null; }
}

function remember(store: WinStore, file: string, sealed: string): void {
  invalidateCache();
  cached = { store, at: Date.now(), file, sealed };
  cacheTimer = setTimeout(() => { cached = null; cacheTimer = null; }, CACHE_TTL_MS);
  cacheTimer.unref?.();
}

// ConvertTo-SecureString and its twin live in Microsoft.PowerShell.Security,
// and there are Windows machines where that module does not load at all — CI
// runners, constrained language mode, corporate policy. The cmdlets are only a
// wrapper over ProtectedData, so the wrapper is skipped: same DPAPI, same
// CurrentUser scope, no module to fail.
const DPAPI_PREAMBLE =
  "Add-Type -AssemblyName System.Security;" +
  "$ErrorActionPreference='Stop';";

const DPAPI_SEAL =
  DPAPI_PREAMBLE +
  "$j=[Console]::In.ReadToEnd();" +
  "$b=[Text.Encoding]::UTF8.GetBytes($j);" +
  "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
  "[Convert]::ToBase64String($p)";

const DPAPI_OPEN =
  DPAPI_PREAMBLE +
  "$e=[Console]::In.ReadToEnd().Trim();" +
  "$b=[Convert]::FromBase64String($e);" +
  "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
  "[Text.Encoding]::UTF8.GetString($p)";

/** Seals one byte and opens it again — the only honest test of "can I do this". */
const DPAPI_PROBE =
  DPAPI_PREAMBLE +
  "$p=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('ok'),$null,'CurrentUser');" +
  "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($p,$null,'CurrentUser'))";

const LEGACY_OPEN =
  '$e = [Console]::In.ReadToEnd().Trim();' +
  '$s = ConvertTo-SecureString $e;' +
  '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);' +
  'try { [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) }' +
  'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }';

function* psDpapi(script: string, input?: string): Op<string> {
  const r = yield { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], input };
  if (r.error || r.status !== 0) {
    throw new KeychainUnavailable(`DPAPI call failed: ${(r.stderr || '').trim() || r.error?.message || 'unknown error'}`);
  }
  return r.stdout;
}

/** Opens sealed text into a store object. Throws on anything that is not one. */
function* openSealed(sealed: string): Op<WinStore> {
  // 1.8.0 and 1.8.1 sealed with ConvertFrom-SecureString, whose output is hex.
  // Anything else is the ProtectedData format. Reading both means an existing
  // store keeps working instead of looking corrupt after an update.
  const legacy = /^[0-9a-f]+$/i.test(sealed);
  const json = yield* psDpapi(legacy ? LEGACY_OPEN : DPAPI_OPEN, sealed);
  let store: unknown;
  try {
    store = JSON.parse(json);
  } catch {
    throw new KeychainUnavailable('The key store exists but could not be read. It was sealed by a different Windows account.');
  }
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new KeychainUnavailable('The key store opened but does not hold a credential list. Refusing to use it.');
  }
  return store as WinStore;
}

// ── Evidence that a store existed ──
//
// The marker is written on every successful write; sealed copies and
// temporary files are what a crash or an older writer leaves behind. Any one
// of them next to a missing keys.dpapi means "lost", not "never had one".

/** Unique temporary files are named keys.dpapi.<pid>.<uuid>.tmp; older releases used keys.dpapi.tmp. */
const TMP_RE = /^keys\.dpapi(?:\..+)?\.tmp$/;
const UNIQUE_TMP_RE = /^keys\.dpapi(?:\.marker)?\.\d+\.[0-9a-f-]{36}\.tmp$/;
const LEGACY_BAK_RE = /^keys\.dpapi\.bak/;
const COPY_RE = /^keys\.dpapi\.(\d{8}T\d{9})-[0-9a-f]{6}\.sealed$/;

export interface RecoveryCandidate {
  /** Pass this to restoreSealedCopy / `crbro-memory secret restore`. */
  id: string;
  kind: 'sealed-copy' | 'temporary' | 'manual-backup';
  modified: string;
  bytes: number;
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** Sealed copies, temporaries and manual .bak files, newest first. Never opens them. */
export function listSealedCopies(): RecoveryCandidate[] {
  const { dir, copies } = winPaths();
  const out: RecoveryCandidate[] = [];
  const add = (folder: string, f: string, kind: RecoveryCandidate['kind']) => {
    try {
      const st = statSync(join(folder, f));
      if (!st.isFile()) return;
      out.push({ id: f, kind, modified: st.mtime.toISOString(), bytes: st.size });
    } catch { /* gone meanwhile */ }
  };
  for (const f of safeList(copies)) if (COPY_RE.test(f)) add(copies, f, 'sealed-copy');
  for (const f of safeList(dir)) {
    if (TMP_RE.test(f)) add(dir, f, 'temporary');
    else if (LEGACY_BAK_RE.test(f)) add(dir, f, 'manual-backup');
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified) || b.id.localeCompare(a.id));
}

function evidenceOfStore(): string[] {
  const { marker } = winPaths();
  const ev: string[] = [];
  if (existsSync(marker)) ev.push('keys.dpapi.marker');
  for (const c of listSealedCopies()) ev.push(c.kind === 'sealed-copy' ? `sealed-copies/${c.id}` : c.id);
  return ev;
}

function missingError(): KeychainMissing {
  const { dir } = winPaths();
  const ev = evidenceOfStore();
  const newest = listSealedCopies()[0];
  return new KeychainMissing(
    `The key store ${join(dir, 'keys.dpapi')} is missing, but ${ev.slice(0, 4).join(', ')}` +
    `${ev.length > 4 ? ` and ${ev.length - 4} more` : ''} show it existed. It was NOT treated as empty and nothing ` +
    'was written. To recover: `npx crbro-memory secret copies` lists sealed copies and leftovers; ' +
    `\`npx crbro-memory secret restore ${newest ? newest.id : '<id>'} --yes\` validates one with DPAPI and puts it back. ` +
    'To start an empty store on purpose instead: `npx crbro-memory secret set NAME --force`.',
    ev);
}

function readMain(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The store, or {} on a machine that never had one. `allowMissing` is the
 * explicit --force of set: an empty store over a lost one, on purpose.
 */
function* winRead(fresh = false, allowMissing = false): Op<WinStore> {
  const { file } = winPaths();
  // Compare the ciphertext itself, not mtime/size: a same-size replacement or
  // restored timestamp must not hide an external update. Reading is cheap;
  // the cache avoids the expensive DPAPI subprocess only while bytes match.
  const sealed = readMain(file);
  if (sealed === null) {
    invalidateCache();
    if (!allowMissing && evidenceOfStore().length > 0) throw missingError();
    return {};
  }
  if (!fresh && cached && cached.file === file && cached.sealed === sealed && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.store;
  }
  invalidateCache();
  if (!sealed) throw new KeychainUnavailable('The key store is empty or truncated. Refusing to overwrite it.');
  const store = yield* openSealed(sealed);
  remember(store, file, sealed);
  return store;
}

/** Writes with wx then renames, so a crash never leaves half a file under the final name. */
function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    created = true;
    writeFileSync(fd, content, { encoding: 'ascii' });
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created && existsSync(tmp)) unlinkSync(tmp);
  }
}

function copiesToKeep(): number {
  const n = Number(process.env['CRBRO_KEYS_COPIES']);
  return Number.isInteger(n) && n >= 2 && n <= 100 ? n : 5;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:.Z]/g, '').slice(0, 18);
}

/** A byte copy of sealed text, skipped when the newest copy already holds it. */
function keepCopy(sealed: string): void {
  const { copies } = winPaths();
  if (!existsSync(copies)) mkdirSync(copies, { recursive: true, mode: 0o700 });
  const newest = listSealedCopies().find(c => c.kind === 'sealed-copy');
  if (newest) {
    try {
      if (readFileSync(join(copies, newest.id), 'utf8').trim() === sealed) return;
    } catch { /* unreadable copy: write a fresh one */ }
  }
  atomicWrite(join(copies, `keys.dpapi.${stamp()}-${randomBytes(3).toString('hex')}.sealed`), sealed);
}

function rotateCopies(): void {
  const { copies } = winPaths();
  const all = listSealedCopies().filter(c => c.kind === 'sealed-copy');
  for (const old of all.slice(copiesToKeep())) {
    try { unlinkSync(join(copies, old.id)); } catch { /* next write retries */ }
  }
}

/** Our own temporaries, older than an hour: a crash between write and rename. Never the legacy name. */
function sweepStaleTemporaries(): void {
  const { dir } = winPaths();
  const limit = Date.now() - 60 * 60_000;
  for (const f of safeList(dir)) {
    if (!UNIQUE_TMP_RE.test(f)) continue;
    const p = join(dir, f);
    try {
      if (statSync(p).mtimeMs < limit) unlinkSync(p);
    } catch { /* in use or gone */ }
  }
}

function writeMarker(): void {
  const { marker } = winPaths();
  let created = new Date().toISOString();
  try {
    const prev = JSON.parse(readFileSync(marker, 'utf8')) as { created?: string };
    if (typeof prev.created === 'string') created = prev.created;
  } catch { /* first write */ }
  try {
    atomicWrite(marker, JSON.stringify({ v: 1, store: 'keys.dpapi', created, last_write: new Date().toISOString() }) + '\n');
  } catch { /* the store itself is written; the marker comes back on the next write */ }
}

/**
 * Seal, keep the previous bytes as a copy, replace atomically, keep the new
 * bytes as a copy, rotate. A copy of the previous state that cannot be written
 * stops the write: the copy is what makes an overwrite or a removal reversible.
 */
function* winWrite(store: WinStore): Op<void> {
  const { dir, file } = winPaths();
  invalidateCache();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sealed = (yield* psDpapi(DPAPI_SEAL, JSON.stringify(store))).trim();
  if (!sealed) throw new KeychainUnavailable('DPAPI returned nothing to store. Nothing was written.');
  const previous = readMain(file);
  if (previous) keepCopy(previous);
  atomicWrite(file, sealed);
  remember(store, file, sealed);
  try {
    keepCopy(sealed);
    rotateCopies();
  } catch { /* the store is written; copies catch up on the next write */ }
  writeMarker();
  if (previous) sweepStaleTemporaries();
}

/**
 * Put a sealed copy (or a leftover temporary, or a manual .bak) back as the
 * store. It is opened with DPAPI first, so a copy from another account or a
 * truncated file is refused; the current store, if any, is kept as a copy.
 */
function* restoreGen(id: string): Op<{ restored: string; entries: number }> {
  const { dir, copies, file } = winPaths();
  if (typeof id !== 'string' || /[\\/]/.test(id) || id.includes('..')) throw new Error('Invalid copy id.');
  const cand = listSealedCopies().find(c => c.id === id);
  if (!cand) throw new Error(`No sealed copy or leftover named "${id}". List them with: npx crbro-memory secret copies`);
  const src = join(cand.kind === 'sealed-copy' ? copies : dir, id);
  const sealed = readFileSync(src, 'utf8').trim();
  if (!sealed) throw new KeychainUnavailable(`"${id}" is empty. Refusing to restore it.`);
  const store = yield* openSealed(sealed);
  const current = readMain(file);
  if (current) keepCopy(current);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWrite(file, sealed);
  invalidateCache();
  try { keepCopy(sealed); rotateCopies(); } catch { /* best effort */ }
  writeMarker();
  return { restored: id, entries: Object.keys(store).length };
}

export function restoreSealedCopy(id: string): { restored: string; entries: number } {
  if (os() !== 'win32') throw new Error('Sealed copies exist only for the Windows DPAPI store.');
  return lockedSync(() => restoreGen(id));
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

const INDEX_ACCOUNT = '__crbro_index__';

interface NameIndex {
  [name: string]: { description: string; updated: string };
}

/** errSecItemNotFound, truncated to eight bits by security(1). */
const MAC_NOT_FOUND = 44;
/** errSecInteractionNotAllowed: a locked keychain. */
const MAC_LOCKED = 36;

function macFailure(what: string, r: RunResult): KeychainUnavailable {
  if (r.status === MAC_LOCKED) {
    return new KeychainUnavailable(
      'The macOS keychain is locked, which is usual over SSH or in CI. Unlock it in a desktop session, ' +
      'or pass the credential as a CRBRO_SECRET_<NAME> environment variable instead.');
  }
  return new KeychainUnavailable(`${what} (exit ${r.status ?? 'none'}): ${(r.stderr || r.error?.message || '').trim() || 'no detail'}`);
}

function parseIndex(raw: string, where: string): NameIndex {
  let index: unknown;
  try { index = JSON.parse(raw); } catch {
    throw new KeychainUnavailable(`The CRBRO name index in ${where} is unreadable. Refusing to rewrite it, so no name is lost.`);
  }
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    throw new KeychainUnavailable(`The CRBRO name index in ${where} is not a name list. Refusing to rewrite it.`);
  }
  return index as NameIndex;
}

// Only "not found" is an empty index. Until 2.10 any failure — a locked
// keychain, a denied prompt, a truncated value — read as {}, and the next set
// rewrote the index with a single name: the others stayed stored but vanished
// from list.
function* macReadIndex(): Op<NameIndex> {
  const r = yield { cmd: 'security', args: ['find-generic-password', '-s', SERVICE, '-a', INDEX_ACCOUNT, '-w'] };
  if (r.status === MAC_NOT_FOUND) return {};
  if (r.error || r.status !== 0) throw macFailure('Could not read the CRBRO name index from the keychain', r);
  return parseIndex(macDecode(r.stdout), 'the macOS keychain');
}

function* macWriteIndex(index: NameIndex): Op<void> {
  const r = yield {
    cmd: 'security',
    args: ['add-generic-password', '-U', '-s', SERVICE, '-a', INDEX_ACCOUNT, '-w', macEncode(JSON.stringify(index)), '-T', '/usr/bin/security'],
  };
  if (r.error || r.status !== 0) throw macFailure('The keychain refused to update the CRBRO name index', r);
}

// ─── Linux: an index too ─────────────────────────────────────────
//
// `secret-tool search --all` prints every matching item WITH its secret, so
// listing names that way pulled every value into this process. The names now
// live in an item of their own, like on macOS. A store from before 2.11 has no
// index; the first listing builds it once from a search, keeping names only.

function linuxNotFound(r: RunResult): boolean {
  return r.status === 1 && !(r.stderr || '').trim() && !r.error;
}

function* linuxReadIndex(): Op<NameIndex> {
  const r = yield { cmd: 'secret-tool', args: ['lookup', 'service', SERVICE, 'account', INDEX_ACCOUNT] };
  if (r.status === 0) return parseIndex(r.stdout, 'the Secret Service');
  if (!linuxNotFound(r)) {
    throw new KeychainUnavailable(`secret-tool could not read the CRBRO name index: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  }
  // Migration from 2.10: one search, names and descriptions only.
  const s = yield { cmd: 'secret-tool', args: ['search', '--all', 'service', SERVICE] };
  if (s.status !== 0) {
    if (linuxNotFound(s)) return {};
    throw new KeychainUnavailable(`secret-tool could not list the store: ${(s.stderr || '').trim() || `exit ${s.status}`}`);
  }
  const index: NameIndex = {};
  let current: string | null = null;
  for (const line of s.stdout.split('\n')) {
    if (line.startsWith('[')) { current = null; continue; }
    const acc = /^attribute\.account = (.+)$/.exec(line);
    if (acc) {
      const n = acc[1].trim();
      current = SECRET_NAME_RE.test(n) ? n : null;
      if (current && !index[current]) index[current] = { description: '', updated: '' };
      continue;
    }
    const desc = /^attribute\.description = (.*)$/.exec(line);
    if (desc && current) index[current].description = desc[1].trim();
  }
  s.stdout = '';   // the values went by in that output; keep nothing of it
  return index;
}

function* linuxWriteIndex(index: NameIndex): Op<void> {
  const r = yield {
    cmd: 'secret-tool',
    args: ['store', '--label', 'CRBRO name index', 'service', SERVICE, 'account', INDEX_ACCOUNT],
    input: JSON.stringify(index),
  };
  if (r.error || r.status !== 0) {
    throw new KeychainUnavailable(`secret-tool refused to update the CRBRO name index: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  }
}

// ─── Operations ──────────────────────────────────────────────────

export interface SetOptions {
  /** Windows: create a new store although evidence says one existed and is missing. */
  force?: boolean;
}

function* setGen(name: string, value: string, description: string, backend: Backend, opts: SetOptions): Op<void> {
  const today = new Date().toISOString().slice(0, 10);

  if (backend === 'windows-dpapi') {
    const store = yield* winRead(true, !!opts.force);
    store[name] = { value, description, updated: today };
    yield* winWrite(store);
    return;
  }

  if (backend === 'macos-keychain') {
    // Read the index first: if it cannot be read, nothing is written at all.
    const index = yield* macReadIndex();
    // -U updates in place instead of erroring when the item already exists.
    // -w with the value on argv is visible to `ps` for the life of the call;
    // security(1) offers no stdin form for it, so the exposure is unavoidable
    // and measured in milliseconds on the user's own machine (SECURITY.md).
    const r = yield {
      cmd: 'security',
      args: ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', macEncode(value), '-j', description, '-T', '/usr/bin/security'],
    };
    if (r.error || r.status !== 0) throw macFailure('Keychain refused the write', r);
    index[name] = { description, updated: today };
    yield* macWriteIndex(index);
    return;
  }

  const index = yield* linuxReadIndex();
  // secret-tool reads the secret from stdin, so it never reaches the process
  // table. It stays open waiting for EOF, which the runner gives it.
  const r = yield {
    cmd: 'secret-tool',
    args: ['store', '--label', `CRBRO ${name}`, 'service', SERVICE, 'account', name, 'description', description],
    input: value,
  };
  if (r.error || r.status !== 0) throw new KeychainUnavailable(`secret-tool refused the write: ${(r.stderr || '').trim()}`);
  index[name] = { description, updated: today };
  yield* linuxWriteIndex(index);
}

function* getGen(name: string): Op<{ value: string; source: 'env' | 'keychain' } | null> {
  const env = fromEnvironment(name);
  if (env) return { value: env, source: 'env' };

  const backend = yield* requireBackendGen();

  if (backend === 'windows-dpapi') {
    const v = (yield* winRead())[name]?.value;
    return v ? { value: v, source: 'keychain' } : null;
  }

  if (backend === 'macos-keychain') {
    const r = yield { cmd: 'security', args: ['find-generic-password', '-s', SERVICE, '-a', name, '-w'] };
    // Only "not found" is null. A locked keychain, a denied prompt or any other
    // failure is an error: reporting it as "no such secret" sends someone to
    // ask the user for a credential that is sitting right there.
    if (r.status === MAC_NOT_FOUND) return null;
    if (r.error || r.status !== 0) throw macFailure('The keychain refused the read', r);
    return { value: macDecode(r.stdout), source: 'keychain' };
  }

  // Unlike security(1), secret-tool adds no trailing newline when stdout
  // is a pipe: write_password_stdout only appends one for a tty. Trimming
  // here would silently eat a newline that was genuinely part of the secret.
  // Exit 1 with nothing on stderr is how it reports "no such item"; anything
  // on stderr is a real failure and must not be mistaken for absence.
  const r = yield { cmd: 'secret-tool', args: ['lookup', 'service', SERVICE, 'account', name] };
  if (r.status === 0) return { value: r.stdout, source: 'keychain' };
  if (linuxNotFound(r)) return null;
  throw new KeychainUnavailable(`secret-tool failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
}

function sortEntries(index: NameIndex | WinStore): SecretEntry[] {
  return Object.entries(index)
    .filter(([name]) => SECRET_NAME_RE.test(name))
    .map(([name, e]) => ({ name, description: e?.description ?? '', updated: e?.updated ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function* listGen(): Op<SecretEntry[]> {
  const backend = yield* requireBackendGen();
  if (backend === 'windows-dpapi') return sortEntries(yield* winRead());
  if (backend === 'macos-keychain') return sortEntries(yield* macReadIndex());
  return sortEntries(yield* linuxReadIndex());
}

function* removeGen(name: string, backend: Backend): Op<boolean> {
  if (backend === 'windows-dpapi') {
    const store = yield* winRead(true);
    if (!(name in store)) return false;
    delete store[name];
    // winWrite keeps the previous sealed bytes as a copy: the removal can be
    // undone with `secret restore` until the copies rotate it out.
    yield* winWrite(store);
    return true;
  }

  if (backend === 'macos-keychain') {
    const index = yield* macReadIndex();
    const r = yield { cmd: 'security', args: ['delete-generic-password', '-s', SERVICE, '-a', name] };
    if (r.status === MAC_NOT_FOUND) {
      if (name in index) { delete index[name]; yield* macWriteIndex(index); }
      return false;
    }
    if (r.error || r.status !== 0) throw macFailure('The keychain refused the removal', r);
    delete index[name];
    yield* macWriteIndex(index);
    return true;
  }

  const index = yield* linuxReadIndex();
  const r = yield { cmd: 'secret-tool', args: ['clear', 'service', SERVICE, 'account', name] };
  if (r.error || (r.status !== 0 && !linuxNotFound(r))) {
    throw new KeychainUnavailable(`secret-tool refused the removal: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  }
  const had = name in index;
  if (had) { delete index[name]; yield* linuxWriteIndex(index); }
  // secret-tool clear exits 0 whether or not something matched; the index says.
  return had;
}

// ─── Public surface: synchronous (CLI, existing callers) ─────────

export function setSecret(name: string, value: string, description = '', opts: SetOptions = {}): void {
  checkName(name);
  const backend = driveSync(requireBackendGen());
  if (!value) throw new Error('Refusing to store an empty value.');
  lockedSync(() => setGen(name, value, description, backend, opts));
}

/**
 * The value, or null when there is no such secret. An environment variable
 * counts only when it opts in: CRBRO_SECRET_<NAME>, or <NAME> listed in
 * CRBRO_SECRET_ENV. That keeps CI and one-off overrides working without
 * turning get into a reader of the whole server environment.
 */
export function getSecret(name: string): string | null {
  checkName(name);
  return driveSync(getGen(name))?.value ?? null;
}

/** Names and descriptions only. Values are never returned by design. */
export function listSecrets(): SecretEntry[] {
  return driveSync(listGen());
}

export function removeSecret(name: string): boolean {
  checkName(name);
  const backend = driveSync(requireBackendGen());
  return lockedSync(() => removeGen(name, backend));
}

// ─── Public surface: asynchronous (the server, inside the daemon) ─

export async function setSecretAsync(name: string, value: string, description = '', opts: SetOptions = {}): Promise<void> {
  checkName(name);
  const backend = await driveAsync(requireBackendGen());
  if (!value) throw new Error('Refusing to store an empty value.');
  await lockedAsync(() => setGen(name, value, description, backend, opts));
}

export async function getSecretAsync(name: string): Promise<{ value: string; source: 'env' | 'keychain' } | null> {
  checkName(name);
  return driveAsync(getGen(name));
}

export function listSecretsAsync(): Promise<SecretEntry[]> {
  return driveAsync(listGen());
}

export async function removeSecretAsync(name: string): Promise<boolean> {
  checkName(name);
  const backend = await driveAsync(requireBackendGen());
  return lockedAsync(() => removeGen(name, backend));
}

// ─── Confirmation for destructive writes through MCP ─────────────
//
// A token is an HMAC, under a key that never leaves this process, of the
// action, the name, the state of the store and (for set) the new value. A
// stale token — the store changed, the value changed, the server restarted —
// is refused, and nobody can produce one without asking for it first.

const TOKEN_KEY = randomBytes(32);

function* stateGen(name: string): Op<string> {
  const backend = yield* requireBackendGen();
  if (backend === 'windows-dpapi') {
    const sealed = readMain(winPaths().file) ?? '';
    return createHash('sha256').update(sealed).digest('hex');
  }
  const index = backend === 'macos-keychain' ? yield* macReadIndex() : yield* linuxReadIndex();
  return JSON.stringify(index[name] ?? null);
}

export async function secretConfirmToken(action: 'set' | 'remove', name: string, value?: string): Promise<string> {
  checkName(name);
  const state = await driveAsync(stateGen(name));
  const valueDigest = value === undefined ? '' : createHash('sha256').update(value).digest('hex');
  return createHmac('sha256', TOKEN_KEY)
    .update(`${action}\0${name}\0${state}\0${valueDigest}`)
    .digest('hex').slice(0, 16);
}

/** Windows: how many sealed copies sit next to the store. Null elsewhere. */
export function sealedCopyCount(): number | null {
  if (os() !== 'win32') return null;
  return listSealedCopies().filter(c => c.kind === 'sealed-copy').length;
}

// ─── Tests only ──────────────────────────────────────────────────

/** Windows only, and only for tests: forget the sealed file entirely. */
export function _resetWindowsStoreForTests(): void {
  invalidateCache();
  const { file } = winPaths();
  if (existsSync(file)) unlinkSync(file);
}

/** Tests: replace the process runner and the platform, so macOS/Linux logic runs on any CI. */
export function _setKeychainRuntimeForTests(opts: {
  sync?: (c: Cmd) => RunResult;
  async?: (c: Cmd) => Promise<RunResult>;
  platform?: NodeJS.Platform | null;
} | null): void {
  runSync = opts?.sync ?? runSyncReal;
  runAsync = opts?.async ?? (opts?.sync ? (c: Cmd) => Promise.resolve(opts.sync!(c)) : runAsyncReal);
  platformOverride = opts?.platform ?? null;
  probe = null;
  invalidateCache();
}

/** Tests: drop the memoised probe and the read cache. */
export function _resetKeychainMemoForTests(): void {
  probe = null;
  invalidateCache();
}

export type { Cmd as KeychainCommand, RunResult as KeychainRunResult };
