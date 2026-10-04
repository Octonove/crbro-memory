// ─── The Claude Code mod: install, uninstall, verify ─────────────
//
// mods/crbro-pending is a Claude Code mod (a plugin of function hooks): the
// open-items band above the prompt and the /pending pane. Claude Code loads a
// plugin folder named in CLAUDE_CODE_PLUGIN_DIRS, from the process environment
// or from the `env` block of ~/.claude/settings.json; that block is the one
// place that reaches the desktop app's Code tab as well as the CLI.
//
// `install-mod` copies the mod to ~/.claude/crbro-mods/crbro-pending — a
// stable path, because the npx cache moves with every release — and adds that
// folder to the list, with the platform's separator, once. It takes the same
// care as the install-hooks commands: a settings.json that does not parse is
// never touched, the write is atomic (.tmp + rename), and a second run
// changes nothing. A folder already in the list whose plugin.json is named
// crbro-pendientes (the local copy this mod grew out of) is replaced in place,
// said so and written down in crbro-mods/crbro-pending.replaced.json; the
// folder itself is left on disk. Any other crbro-pending in the list, or a
// copy in ~/.claude/mods, is pointed out and left alone.
//
// `uninstall-mod` takes the path out of the list (and the variable, if it
// ends up empty), puts back what install-mod replaced if that folder is still
// there, and deletes ~/.claude/crbro-mods/crbro-pending, nothing else.
//
// `verifyMod` compares the installed copy with the package, file by file, by
// SHA-256, the way hookverify.ts does for the hooks, and names any other copy
// Claude Code would load beside it. It only reads.
//
// `autoInstallMod` is what crbro_boot runs, once per process: the band
// reaches everyone who has CRBRO and Claude Code without a command, and says
// so (mod_notice in the boot answer). It installs the way install-mod does,
// refreshes the files alone when the package ships different ones, and stays
// out for good once uninstall-mod has been run (state.json, optedOut) or the
// folder was taken out of the list by hand; CRBRO_MOD=0 keeps the client it
// is set in out of it.

import { createHash, randomBytes } from 'crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync,
  statSync, writeFileSync, promises as fsp,
} from 'fs';
import { homedir } from 'os';
import path from 'path';

export const MOD_NAME = 'crbro-pending';
/** The local copy this mod grew out of: a folder in the list holding it is replaced. */
export const LEGACY_NAME = 'crbro-pendientes';
/** Plugin names that would load a second band beside this one. */
export const COPY_NAMES = [LEGACY_NAME, MOD_NAME];
/** pluginConfigs keys Claude Code may store this plugin's options under. */
const CONFIG_KEYS = [MOD_NAME, `${MOD_NAME}@inline`];
export const PLUGIN_DIRS_VAR = 'CLAUDE_CODE_PLUGIN_DIRS';
export type ModLang = 'auto' | 'en' | 'es';

/** What the package ships but the install leaves out: tests and editor config. */
const NOT_SHIPPED_TOP = new Set(['test', 'tsconfig.json', '.gitignore', '.npmignore', 'node_modules']);
const NOT_SHIPPED_DIRS = new Set(['.claude-plugin/types']);

export interface ModOptions {
  /** mods/crbro-pending of this package. */
  packageDir: string;
  /** The home folder whose .claude/ is used. */
  home: string;
  /** Picks the list separator: `;` on win32, `:` elsewhere. */
  platform?: NodeJS.Platform;
  /**
   * CLAUDE_CODE_PLUGIN_DIRS as this process's environment holds it; defaults
   * to process.env. Claude Code reads the variable from there as well as from
   * settings.json's env block.
   */
  envDirs?: string;
}

export function modPaths(home: string) {
  const claudeDir = path.join(home, '.claude');
  return {
    claudeDir,
    settingsPath: path.join(claudeDir, 'settings.json'),
    modsDir: path.join(claudeDir, 'crbro-mods'),
    installedDir: path.join(claudeDir, 'crbro-mods', MOD_NAME),
    /** What install-mod took out of the list, so uninstall-mod can put it back. */
    replacedPath: path.join(claudeDir, 'crbro-mods', `${MOD_NAME}.replaced.json`),
    /** The opt-out mark, what was installed and what failed: see ModState. */
    statePath: path.join(claudeDir, 'crbro-mods', 'state.json'),
    /** A notice the automatic install left for the next crbro_boot to hand over. */
    noticePath: path.join(claudeDir, 'crbro-mods', 'notice.json'),
    /** Held while an automatic install runs, so two sessions starting at once do not both write. */
    lockPath: path.join(claudeDir, 'crbro-mods', 'auto.lock'),
  };
}

export function pathListSeparator(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? ';' : ':';
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function lfSha(buf: Buffer): string {
  return sha256(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

/** The files the mod is made of, relative and with forward slashes, sorted. */
export function modFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name;
      if (!rel && NOT_SHIPPED_TOP.has(name)) continue;
      if (NOT_SHIPPED_DIRS.has(relPath)) continue;
      const st = statSync(path.join(dir, relPath));
      if (st.isDirectory()) walk(relPath);
      else if (st.isFile()) out.push(relPath);
    }
  };
  if (existsSync(dir)) walk('');
  return out.sort();
}

/** Every file under a folder, nothing left out: what an installed copy really holds. */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name;
      const st = statSync(path.join(dir, relPath));
      if (st.isDirectory()) walk(relPath);
      else out.push(relPath);
    }
  };
  if (existsSync(dir)) walk('');
  return out.sort();
}

/** A list entry without the quotes a hand-edited list sometimes has around it. */
function unquote(p: string): string {
  return p.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
}

function expandHome(p: string, home: string): string {
  p = unquote(p);
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

function samePath(a: string, b: string, home: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => {
    const s = expandHome(p.trim(), home).replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/** The `name` in <dir>/.claude-plugin/plugin.json, or null. */
function pluginNameAt(dir: string, home: string): string | null {
  try {
    const raw = readFileSync(path.join(expandHome(dir.trim(), home), '.claude-plugin', 'plugin.json'), 'utf8');
    const name = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)?.name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

type Settings = Record<string, any>;
type SettingsRead =
  | { ok: true; settings: Settings | null; indent: string | number; eol: string; hash: string }
  | { ok: false; error: string };

const isObject = (v: unknown): v is Settings => typeof v === 'object' && v !== null && !Array.isArray(v);

/** settings.json as an object, null when absent; refuses anything it would have to guess about. */
function readSettings(settingsPath: string): SettingsRead {
  if (!existsSync(settingsPath)) return { ok: true, settings: null, indent: 2, eol: '\n', hash: 'absent' };
  let settings: unknown;
  let raw: string;
  let hash: string;
  try {
    const buf = readFileSync(settingsPath);
    hash = sha256(buf);
    raw = buf.toString('utf8');
    settings = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    return { ok: false, error: `${settingsPath} exists but could not be parsed — not touching it.\n     ${(e as Error).message}` };
  }
  if (!isObject(settings)) {
    return { ok: false, error: `${settingsPath} is not a JSON object — not touching it.` };
  }
  const env = settings.env;
  if (env !== undefined && !isObject(env)) {
    return { ok: false, error: `env in ${settingsPath} is not an object — not touching it.` };
  }
  const dirs = env?.[PLUGIN_DIRS_VAR];
  if (dirs !== undefined && typeof dirs !== 'string') {
    return { ok: false, error: `env.${PLUGIN_DIRS_VAR} in ${settingsPath} is not a string — not touching it.` };
  }
  const configs = settings.pluginConfigs;
  if (configs !== undefined && !isObject(configs)) {
    return { ok: false, error: `pluginConfigs in ${settingsPath} is not an object — not touching it.` };
  }
  for (const key of CONFIG_KEYS) {
    const mine = configs?.[key];
    if (mine === undefined) continue;
    if (!isObject(mine)) {
      return { ok: false, error: `pluginConfigs["${key}"] in ${settingsPath} is not an object — not touching it.` };
    }
    if (mine.options !== undefined && !isObject(mine.options)) {
      return { ok: false, error: `pluginConfigs["${key}"].options in ${settingsPath} is not an object — not touching it.` };
    }
  }
  // Written back with the indentation and the line endings it came with.
  const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? 2;
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
  return { ok: true, settings, indent, eol, hash };
}

/** Thrown by writeAtomic when settings.json changed after it was read: the caller merges again. */
const SETTINGS_CHANGED = 'ESETTINGSCHANGED';
/** Errors a later start may well not meet (a file held open, an antivirus scan): never written down as a failure. */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST', SETTINGS_CHANGED]);

/**
 * Writes settings.json through a .tmp + rename. A symlinked settings.json
 * (dotfiles) is written at its target, so the link stays a link, and the
 * file keeps its permission bits (on POSIX: its env block often carries
 * tokens) and its line endings. With `expectHash`, the file is hashed once
 * more right before the rename and nothing is written if it is no longer
 * what was read: Claude Code or an editor saved it in between, and their
 * change must not be lost. On Windows the renamed file takes the folder's
 * inherited ACL, and a hard link to settings.json is not kept.
 */
function writeAtomic(
  settingsPath: string, settings: Settings, indent: string | number = 2, eol = '\n', expectHash?: string,
): void {
  let target = settingsPath;
  try {
    if (lstatSync(settingsPath).isSymbolicLink()) target = realpathSync(settingsPath);
  } catch {
    // Not there yet: written as a plain file.
  }
  let mode: number | undefined;
  try {
    mode = statSync(target).mode & 0o777;
  } catch {
    mode = undefined;
  }
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    let text = JSON.stringify(settings, null, indent) + '\n';
    if (eol !== '\n') text = text.replace(/\n/g, eol);
    writeFileSync(tmp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    if (expectHash !== undefined && settingsFingerprint(target) !== expectHash) {
      const changed = new Error(`${settingsPath} changed while it was being written.`) as NodeJS.ErrnoException;
      changed.code = SETTINGS_CHANGED;
      throw changed;
    }
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function splitList(value: string | undefined, sep: string): string[] {
  return (value ?? '').split(sep).map(s => s.trim()).filter(Boolean);
}

const STAGING = /^crbro-pending\.\d+\.(tmp|old)$/;

function copyFailed(installedDir: string, e: unknown): NodeJS.ErrnoException {
  const err = new Error(
    `could not replace ${installedDir} (${(e as Error).message}).\n` +
    '     Close the sessions and terminals using that folder and run it again.',
  ) as NodeJS.ErrnoException;
  err.code = (e as NodeJS.ErrnoException)?.code;
  return err;
}

/**
 * Copies the shipped files into a fresh folder, then swaps it in: the old
 * folder is renamed aside first and put back if the swap fails, so the
 * listed folder is never left missing or half written.
 */
function copyMod(packageDir: string, installedDir: string): string[] {
  const files = modFiles(packageDir);
  const parent = path.dirname(installedDir);
  mkdirSync(parent, { recursive: true });
  // A staging or set-aside folder left by a run that failed half way: its pid is gone.
  for (const name of readdirSync(parent)) {
    if (STAGING.test(name)) rmSync(path.join(parent, name), { recursive: true, force: true, maxRetries: 3 });
  }
  const staging = `${installedDir}.${process.pid}.tmp`;
  const aside = `${installedDir}.${process.pid}.old`;
  let setAside = false;
  try {
    for (const rel of files) {
      const target = path.join(staging, ...rel.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(packageDir, ...rel.split('/')), target);
    }
    if (existsSync(installedDir)) { renameSync(installedDir, aside); setAside = true; }
    renameSync(staging, installedDir);
  } catch (e) {
    if (setAside && !existsSync(installedDir)) {
      try { renameSync(aside, installedDir); } catch { /* left as .old: the next run puts in a fresh copy */ }
    }
    rmSync(staging, { recursive: true, force: true });
    throw copyFailed(installedDir, e);
  }
  if (setAside) {
    try { rmSync(aside, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the next run removes it */ }
  }
  return files;
}

/**
 * copyMod for crbro_boot: the same steps through fs.promises, so a slow disk
 * or a file an antivirus holds (rm's retries) never stalls the event loop,
 * which in daemon mode serves every conversation.
 */
async function copyModAsync(packageDir: string, installedDir: string): Promise<string[]> {
  const files = modFiles(packageDir);
  const parent = path.dirname(installedDir);
  await fsp.mkdir(parent, { recursive: true });
  for (const name of await fsp.readdir(parent)) {
    if (STAGING.test(name)) await fsp.rm(path.join(parent, name), { recursive: true, force: true, maxRetries: 3 });
  }
  const staging = `${installedDir}.${process.pid}.tmp`;
  const aside = `${installedDir}.${process.pid}.old`;
  let setAside = false;
  try {
    for (const rel of files) {
      const target = path.join(staging, ...rel.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(path.join(packageDir, ...rel.split('/')), target);
    }
    if (existsSync(installedDir)) { await fsp.rename(installedDir, aside); setAside = true; }
    await fsp.rename(staging, installedDir);
  } catch (e) {
    if (setAside && !existsSync(installedDir)) await fsp.rename(aside, installedDir).catch(() => undefined);
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw copyFailed(installedDir, e);
  }
  if (setAside) await fsp.rm(aside, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  return files;
}

type Replaced = { dir: string; name: string };

/** What an earlier install-mod took out of the list; [] when nothing or unreadable. */
function readReplaced(file: string): Replaced[] {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'))?.replaced;
    return Array.isArray(list)
      ? list.filter((r): r is Replaced => typeof r?.dir === 'string' && typeof r?.name === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Other copies Claude Code would load beside this one: folders in the list
 * whose plugin is named crbro-pendientes or crbro-pending, and the same in
 * ~/.claude/mods, which Claude Code may load on its own.
 */
function otherCopies(list: string[], home: string, platform: NodeJS.Platform): string[] {
  const { claudeDir, installedDir } = modPaths(home);
  const isCopy = (dir: string) => {
    const name = pluginNameAt(dir, home);
    return name !== null && COPY_NAMES.includes(name);
  };
  const listed = list.filter(dir => !samePath(dir, installedDir, home, platform) && isCopy(dir));
  const modsFolder = path.join(claudeDir, 'mods');
  let local: string[] = [];
  try {
    local = readdirSync(modsFolder).map(name => path.join(modsFolder, name)).filter(isCopy);
  } catch {
    local = [];
  }
  return [...listed, ...local.filter(dir => !listed.some(d => samePath(d, dir, home, platform)))];
}

// ─── State: the opt-out mark and what the automatic install knows ──

export interface ModState {
  /** uninstall-mod was run, or the folder was taken out of the list by hand: never installed again on its own. */
  optedOut?: boolean;
  optedOutAt?: string;
  optedOutBy?: 'uninstall-mod' | 'unlisted';
  /** install-mod or the automatic install put it in at least once. */
  installed?: boolean;
  /** The CRBRO version whose files are in crbro-mods/crbro-pending. */
  version?: string;
  /** treeHash of the files written there: tells two builds of one version apart. */
  pkg?: string;
  /** The shell-only plugin list the boot last said it would not override (its hash), so it is said once. */
  envListNoticed?: string;
  /** The last automatic attempt that failed, so it is not retried at every start for the same cause. */
  failed?: { pkg: string; settings: string; at: string; error: string };
}

export function readModState(home: string): ModState {
  try {
    const raw = JSON.parse(readFileSync(modPaths(home).statePath, 'utf8'));
    return isObject(raw) ? raw as ModState : {};
  } catch {
    return {};
  }
}

function stateClean(state: ModState): ModState {
  return Object.fromEntries(Object.entries(state).filter(([, v]) => v !== undefined)) as ModState;
}

/** Written through .tmp + rename; an empty state removes the file. */
function writeModState(home: string, state: ModState): void {
  const { modsDir, statePath } = modPaths(home);
  const clean = stateClean(state);
  if (Object.keys(clean).length === 0) {
    rmSync(statePath, { force: true });
    return;
  }
  mkdirSync(modsDir, { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  renameSync(tmp, statePath);
}

/** The version in the package.json two folders above mods/crbro-pending, or null. */
function packageVersion(packageDir: string): string | null {
  try {
    const v = JSON.parse(readFileSync(path.join(packageDir, '..', '..', 'package.json'), 'utf8'))?.version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * -1, 0 or 1 on x.y.z; a prerelease (2.8.0-beta.1) is below its release.
 * Anything that is not x.y.z compares equal, so it never blocks an update.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)(-)?/.exec(v);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  if (!!x[4] !== !!y[4]) return x[4] ? -1 : 1;
  return 0;
}

/**
 * One hash for every shipped file and its path, read with LF line endings:
 * what "this build of the mod" means. A git checkout with autocrlf and the
 * npm copy of the same release hash the same.
 */
function treeHash(dir: string): string {
  const h = createHash('sha256');
  for (const rel of modFiles(dir)) {
    h.update(rel).update('\0').update(lfSha(readFileSync(path.join(dir, ...rel.split('/'))))).update('\0');
  }
  return h.digest('hex');
}

/** What settings.json holds right now, as a hash, or "absent": a failure is retried once this changes. */
function settingsFingerprint(settingsPath: string): string {
  try {
    return sha256(readFileSync(settingsPath));
  } catch {
    return 'absent';
  }
}

export interface InstallModResult {
  ok: boolean;
  /** Why nothing was done (ok false), or why it was skipped (ok true, nothing installed). */
  error?: string;
  skipped?: string;
  installedDir: string;
  settingsPath: string;
  files: string[];
  /** settings.json was written. */
  changed: boolean;
  /** The path was already in the list. */
  alreadyListed: boolean;
  /** crbro-pendientes folders taken out of the list; uninstall-mod puts them back. */
  replaced: Replaced[];
  /** Other copies (another crbro-pending in the list, or in ~/.claude/mods), reported and left alone. */
  elsewhere: string[];
  /** Folders the process environment lists that settings.json does not. */
  envOnly: string[];
  lang?: ModLang;
  /** The error is one a later attempt may not meet (a file held open, settings.json being saved). */
  transient?: boolean;
  /** What the CLI prints, one line each. */
  lines: string[];
}

const REQUIREMENT_LINES = [
  '     Needs Claude Code 2.1.286 or later with mods: the CLI and the desktop app\'s Code tab.',
  '     Claude Desktop chat, Codex, Cursor and the VS Code extension do not draw it.',
  '     Open a new session to see the band; /pending (or /pendientes) opens the list.',
];

export interface InstallOptions extends ModOptions {
  lang?: ModLang;
  /** The automatic install at boot: it never lifts an opt-out mark, and stops if one appears. */
  auto?: boolean;
  /** The files, when the caller already copied them (the boot copies without blocking). */
  copied?: string[];
  /** Tests only: runs right before settings.json is written. */
  beforeSettingsWrite?: () => void;
}

export function installMod(opts: InstallOptions): InstallModResult {
  const platform = opts.platform ?? process.platform;
  const { claudeDir, settingsPath, installedDir, replacedPath } = modPaths(opts.home);
  const base: InstallModResult = {
    ok: false, installedDir, settingsPath, files: [], changed: false, alreadyListed: false, replaced: [], elsewhere: [],
    envOnly: [], lines: [],
  };

  if (!existsSync(path.join(opts.packageDir, '.claude-plugin', 'plugin.json'))) {
    return { ...base, error: `The mod is missing from this package (${opts.packageDir}).` };
  }
  const read = readSettings(settingsPath);
  if (!read.ok) return { ...base, error: read.error };
  if (read.settings === null && !existsSync(claudeDir)) {
    const skipped = '~/.claude not found: the mod is for Claude Code (2.1.286 or later), so nothing was installed.';
    return { ...base, ok: true, skipped, lines: [`  ⚪ ${skipped}`] };
  }

  // The files go in first, so the time between reading settings.json and
  // writing it back is as short as it can be.
  let files: string[];
  try {
    files = opts.copied ?? copyMod(opts.packageDir, installedDir);
  } catch (e) {
    return { ...base, error: (e as Error).message, transient: TRANSIENT.has((e as NodeJS.ErrnoException).code ?? '') };
  }

  // Read, merge and write; if settings.json changed in between, merge again
  // onto what is there now. Three tries, then give up without writing.
  for (let attempt = 0; ; attempt++) {
    const fresh = readSettings(settingsPath);
    if (!fresh.ok) return { ...base, files, error: fresh.error };
    const merged = mergeInto(fresh, opts, platform);
    try {
      opts.beforeSettingsWrite?.();
      // uninstall-mod ran while this was under way: its answer wins. Checked
      // last, right before the write; uninstall-mod writes its mark first.
      if (opts.auto && readModState(opts.home).optedOut) return { ...base, ok: true, files, skipped: 'opted-out' };
      recordReplaced(replacedPath, merged.replaced, opts.home, platform);
      if (merged.changed) writeAtomic(settingsPath, merged.settings, fresh.indent, fresh.eol, fresh.hash);
      return finishInstall(opts, merged, base, files, platform);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === SETTINGS_CHANGED && attempt < 2) continue;
      return { ...base, files, error: (e as Error).message, transient: TRANSIENT.has((e as NodeJS.ErrnoException).code ?? '') };
    }
  }
}

type Merged = { settings: Settings; changed: boolean; next: string[]; replaced: Replaced[]; alreadyListed: boolean };

/** The mod's folder put into the list of a settings.json just read, and its language. Writes nothing. */
function mergeInto(read: Extract<SettingsRead, { ok: true }>, opts: InstallOptions, platform: NodeJS.Platform): Merged {
  const { installedDir } = modPaths(opts.home);
  const settings: Settings = read.settings ?? {};
  const before = JSON.stringify(settings);
  const sep = pathListSeparator(platform);
  const env: Settings = settings.env ?? {};
  const current = splitList(env[PLUGIN_DIRS_VAR], sep);

  const next: string[] = [];
  const replaced: Replaced[] = [];
  let placed = false;
  let alreadyListed = false;
  for (const dir of current) {
    if (samePath(dir, installedDir, opts.home, platform)) {
      alreadyListed = true;
      if (!placed) { next.push(installedDir); placed = true; }
      continue;
    }
    // Only the copy this mod grew out of is replaced; any other crbro-pending
    // (a checkout someone works on, say) is pointed out below and kept.
    if (pluginNameAt(dir, opts.home) === LEGACY_NAME) {
      replaced.push({ dir, name: LEGACY_NAME });
      if (!placed) { next.push(installedDir); placed = true; }
      continue;
    }
    next.push(dir);
  }
  if (!placed) next.push(installedDir);

  // An unchanged list keeps its own spelling: idempotent byte for byte.
  const joined = next.join(sep);
  const sameList = next.length === current.length && next.every((d, i) => samePath(d, current[i]!, opts.home, platform));
  if (!sameList) {
    env[PLUGIN_DIRS_VAR] = joined;
    settings.env = env;
  }

  if (opts.lang === 'en' || opts.lang === 'es') {
    settings.pluginConfigs = settings.pluginConfigs ?? {};
    const mine = settings.pluginConfigs[MOD_NAME] = settings.pluginConfigs[MOD_NAME] ?? {};
    mine.options = { ...(mine.options ?? {}), language: opts.lang };
    // Claude Code may keep the options under "<name>@inline" too: the same answer there.
    const inline = settings.pluginConfigs[`${MOD_NAME}@inline`];
    if (inline !== undefined) inline.options = { ...(inline.options ?? {}), language: opts.lang };
  } else if (opts.lang === 'auto') {
    dropLanguage(settings);
  }
  return { settings, changed: JSON.stringify(settings) !== before, next, replaced, alreadyListed };
}

/** What install-mod replaced, written down before settings.json so a failure there never loses it. */
function recordReplaced(replacedPath: string, replaced: Replaced[], home: string, platform: NodeJS.Platform): void {
  if (replaced.length === 0) return;
  const known = readReplaced(replacedPath);
  const all = [...known, ...replaced.filter(r => !known.some(k => samePath(k.dir, r.dir, home, platform)))];
  writeFileSync(replacedPath, JSON.stringify({ replaced: all }, null, 2) + '\n', 'utf8');
}

function finishInstall(
  opts: InstallOptions, merged: Merged, base: InstallModResult, files: string[], platform: NodeJS.Platform,
): InstallModResult {
  const { installedDir, settingsPath } = modPaths(opts.home);
  const sep = pathListSeparator(platform);
  const { changed, next, replaced, alreadyListed } = merged;

  // Installed on purpose: any earlier opt-out is lifted, and the automatic
  // install knows which build these files are. The automatic install itself
  // never lifts a mark: that is the user's to do.
  const state = readModState(opts.home);
  const wasOptedOut = state.optedOut === true;
  if (!opts.auto) {
    delete state.optedOut;
    delete state.optedOutAt;
    delete state.optedOutBy;
  }
  delete state.failed;
  state.installed = true;
  state.version = packageVersion(opts.packageDir) ?? undefined;
  try {
    state.pkg = treeHash(opts.packageDir);
  } catch {
    delete state.pkg;
  }
  try {
    writeModState(opts.home, state);
  } catch {
    // The mod is in; only the bookkeeping is missing.
  }

  const lines: string[] = [];
  lines.push(`  ✅ Mod ${MOD_NAME} copied (${files.length} files).`);
  if (wasOptedOut && !opts.auto) lines.push('     CRBRO keeps it up to date at boot again (CRBRO_MOD=0 turns that off).');
  lines.push(`     ${installedDir}`);
  for (const r of replaced) {
    lines.push(`  ✅ Replaced your earlier copy "${r.name}" in ${PLUGIN_DIRS_VAR}: ${r.dir}`);
    lines.push('     Its folder is left where it is; uninstall-mod puts it back in the list.');
  }
  if (alreadyListed && replaced.length === 0) {
    lines.push(`  ✅ Already in ${PLUGIN_DIRS_VAR}. Files refreshed.`);
  } else if (!alreadyListed) {
    lines.push(`  ✅ Added to ${PLUGIN_DIRS_VAR} in ${settingsPath}`);
  }
  // Another crbro-pending in the list, or a copy in ~/.claude/mods (which
  // Claude Code may load on its own): not ours to delete, but two bands and
  // two /pendientes would be confusing.
  const elsewhere = otherCopies(next, opts.home, platform);
  for (const dir of elsewhere) {
    lines.push(`  ⚠️  Another copy is in ${dir}, which Claude Code may load as well.`);
    lines.push('     Remove it, or take it out of the list, if you see two bands; this command does not touch it.');
  }
  // The variable can also come from the shell. settings.json's env is applied
  // on top of it, so folders listed only there may stop loading.
  const fromEnv = splitList(opts.envDirs ?? process.env[PLUGIN_DIRS_VAR], sep);
  const envOnly = fromEnv.filter(dir => !next.some(d => samePath(d, dir, opts.home, platform)));
  if (envOnly.length > 0) {
    lines.push(`  ⚠️  ${PLUGIN_DIRS_VAR} is also set in this shell's environment, with folders settings.json does not list:`);
    for (const dir of envOnly) lines.push(`       ${dir}`);
    lines.push('     settings.json\'s env is applied on top of the environment: if those plugins stop loading, add them there.');
  }
  if (opts.lang === 'en' || opts.lang === 'es') {
    lines.push(`     Language: ${opts.lang === 'es' ? 'Spanish' : 'English'} (pluginConfigs.${MOD_NAME}.options.language; /config changes it).`);
  } else if (opts.lang === 'auto') {
    lines.push('     Language: auto (CRBRO_LANG, then LC_ALL / LC_MESSAGES / LANG, then the system locale).');
  }
  lines.push(...REQUIREMENT_LINES);
  lines.push('     Undo with: npx crbro-memory uninstall-mod');

  return { ...base, ok: true, files, changed, alreadyListed, replaced, elsewhere, envOnly, lang: opts.lang, lines };
}

/** Removes the language this installer set, under either key; true when something went. */
function dropLanguage(settings: Settings): boolean {
  let dropped = false;
  for (const key of CONFIG_KEYS) {
    const mine = settings.pluginConfigs?.[key];
    if (!isObject(mine)) continue;
    if (isObject(mine.options) && 'language' in mine.options) {
      delete mine.options.language;
      dropped = true;
      if (Object.keys(mine.options).length === 0) delete mine.options;
    }
    if (Object.keys(mine).length === 0) delete settings.pluginConfigs[key];
  }
  if (isObject(settings.pluginConfigs) && Object.keys(settings.pluginConfigs).length === 0) delete settings.pluginConfigs;
  return dropped;
}

export interface UninstallModResult {
  ok: boolean;
  error?: string;
  installedDir: string;
  settingsPath: string;
  /** settings.json was written. */
  changed: boolean;
  /** The folder existed and was deleted. */
  removedDir: boolean;
  /** Folders install-mod had replaced, put back in the list. */
  restored: string[];
  /**
   * ~/.claude exists but the opt-out mark could not be written: the boot may
   * install the mod again. The CLI says so and exits 1.
   */
  markFailed: boolean;
  lines: string[];
}

export function uninstallMod(opts: Omit<ModOptions, 'packageDir'>): UninstallModResult {
  const platform = opts.platform ?? process.platform;
  const { settingsPath, installedDir, modsDir, replacedPath } = modPaths(opts.home);
  const base: UninstallModResult = {
    ok: false, installedDir, settingsPath, changed: false, removedDir: false, restored: [], markFailed: false, lines: [],
  };

  // The opt-out mark goes first, whatever happens next: crbro_boot never
  // installs the mod again on its own until install-mod is run.
  const { claudeDir, noticePath } = modPaths(opts.home);
  let marked = false;
  const markWanted = existsSync(claudeDir);
  if (markWanted) {
    try {
      writeModState(opts.home, { optedOut: true, optedOutAt: new Date().toISOString(), optedOutBy: 'uninstall-mod' });
      rmSync(noticePath, { force: true });
      marked = true;
    } catch {
      marked = false;
    }
  }

  const read = readSettings(settingsPath);
  if (!read.ok) return { ...base, error: read.error };

  let changed = false;
  let unlisted = false;
  const restored: string[] = [];
  const gone: string[] = [];
  const settings = read.settings;
  if (settings !== null) {
    const before = JSON.stringify(settings);
    const sep = pathListSeparator(platform);
    const current = splitList(settings.env?.[PLUGIN_DIRS_VAR], sep);
    const kept: string[] = [];
    let at = -1;
    for (const dir of current) {
      if (samePath(dir, installedDir, opts.home, platform)) {
        if (at < 0) at = kept.length;
        continue;
      }
      kept.push(dir);
    }
    unlisted = at >= 0;
    // What install-mod replaced goes back where this mod stood, if it is
    // still on disk and still that plugin.
    for (const r of readReplaced(replacedPath)) {
      if (kept.some(d => samePath(d, r.dir, opts.home, platform)) || restored.includes(r.dir)) continue;
      if (pluginNameAt(r.dir, opts.home) === r.name) restored.push(r.dir);
      else gone.push(r.dir);
    }
    kept.splice(at < 0 ? kept.length : at, 0, ...restored);
    const sameList = kept.length === current.length && kept.every((d, i) => samePath(d, current[i]!, opts.home, platform));
    if (!sameList) {
      const env: Settings = settings.env ?? {};
      if (kept.length) env[PLUGIN_DIRS_VAR] = kept.join(sep);
      else delete env[PLUGIN_DIRS_VAR];
      // An env block this leaves empty goes too, as it was before install-mod.
      if (Object.keys(env).length === 0) delete settings.env;
      else settings.env = env;
    }
    for (const key of CONFIG_KEYS) {
      if (settings.pluginConfigs?.[key] !== undefined) delete settings.pluginConfigs[key];
    }
    if (isObject(settings.pluginConfigs) && Object.keys(settings.pluginConfigs).length === 0) delete settings.pluginConfigs;
    changed = JSON.stringify(settings) !== before;
    if (changed) writeAtomic(settingsPath, settings, read.indent);
  }

  const removedDir = existsSync(installedDir);
  rmSync(installedDir, { recursive: true, force: true, maxRetries: 3 });
  rmSync(replacedPath, { force: true });
  try {
    if (readdirSync(modsDir).length === 0) rmdirSync(modsDir);
  } catch {
    // Not there, or not empty: left as it is.
  }

  const lines: string[] = [];
  if (unlisted) lines.push(`  ✅ Removed from ${PLUGIN_DIRS_VAR} in ${settingsPath}`);
  else if (changed && restored.length === 0) lines.push(`  ✅ Its language setting was removed from ${settingsPath}`);
  for (const dir of restored) lines.push(`  ✅ Put your earlier copy back in ${PLUGIN_DIRS_VAR}: ${dir}`);
  for (const dir of gone) lines.push(`  ⚪ Your earlier copy ${dir} is no longer there, so it was not put back.`);
  if (removedDir) lines.push(`  ✅ Deleted ${installedDir}`);
  if (!changed && !removedDir) lines.push('  ⚪ The mod was not installed. Nothing changed.');
  else lines.push('     Open a new session: the band and /pending are gone from it.');
  if (marked) {
    lines.push('     CRBRO will not install it again on its own (marked in ~/.claude/crbro-mods/state.json);');
    lines.push('     npx crbro-memory install-mod brings it back.');
  } else if (markWanted) {
    lines.push('  ⚠️  Could not write the opt-out mark (~/.claude/crbro-mods/state.json): CRBRO may install the mod');
    lines.push('     again at its next start. Fix that folder and run this again, or set CRBRO_MOD=0 in every MCP client.');
  }

  return { ...base, ok: true, changed, removedDir, restored, markFailed: markWanted && !marked, lines };
}

// ─── Verify ──────────────────────────────────────────────────────

export type ModFileStatus =
  /** Byte for byte the packaged file. */
  | 'same'
  /** Same text once CRLF is read as LF. */
  | 'line_endings_only'
  | 'different'
  /** Shipped by the package, absent from the installed copy. */
  | 'missing'
  /** In the installed copy, not shipped by the package. */
  | 'unknown';

export interface ModFileCheck {
  name: string;
  status: ModFileStatus;
  installed_sha256?: string;
  package_sha256?: string;
}

export interface ModVerifyReport {
  package_dir: string;
  installed_dir: string;
  settings_path: string;
  /** The installed folder exists. */
  installed: boolean;
  /**
   * CLAUDE_CODE_PLUGIN_DIRS lists it: settings.json's env, or the process
   * environment when settings.json does not set the variable.
   */
  listed: boolean;
  files: ModFileCheck[];
  /** Other copies Claude Code would load beside this one (crbro-pendientes or crbro-pending). */
  duplicates: string[];
  settings_unreadable: boolean;
  /** Not installed and not listed, or installed, listed, matching and alone. */
  ok: boolean;
}

/** Read-only: hashes files and parses settings.json, writes nothing. */
export function verifyMod(opts: ModOptions): ModVerifyReport {
  const platform = opts.platform ?? process.platform;
  const sep = pathListSeparator(platform);
  const { settingsPath, installedDir } = modPaths(opts.home);
  const installed = existsSync(installedDir);

  let settingsUnreadable = false;
  let fromSettings: string | undefined;
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      const value = settings?.env?.[PLUGIN_DIRS_VAR];
      if (typeof value === 'string') fromSettings = value;
    } catch {
      settingsUnreadable = true;
    }
  }
  // settings.json's env wins over the environment; without it, the environment counts.
  const list = splitList(fromSettings ?? opts.envDirs ?? process.env[PLUGIN_DIRS_VAR], sep);
  const listed = list.some(d => samePath(d, installedDir, opts.home, platform));

  const files: ModFileCheck[] = [];
  if (installed) {
    const shipped = modFiles(opts.packageDir);
    // Everything in the installed folder: install-mod never writes a test,
    // tsconfig or node_modules there, so any of them is somebody else's.
    const present = allFiles(installedDir);
    for (const name of shipped) {
      const pkg = readFileSync(path.join(opts.packageDir, ...name.split('/')));
      const check: ModFileCheck = { name, status: 'missing', package_sha256: sha256(pkg) };
      if (present.includes(name)) {
        const mine = readFileSync(path.join(installedDir, ...name.split('/')));
        check.installed_sha256 = sha256(mine);
        if (check.installed_sha256 === check.package_sha256) check.status = 'same';
        else if (lfSha(mine) === lfSha(pkg)) check.status = 'line_endings_only';
        else check.status = 'different';
      }
      files.push(check);
    }
    for (const name of present) {
      if (shipped.includes(name)) continue;
      files.push({ name, status: 'unknown', installed_sha256: sha256(readFileSync(path.join(installedDir, ...name.split('/')))) });
    }
  }

  // Two copies mean two bands and two /pendientes: only a problem once this one is in.
  const duplicates = installed || listed ? otherCopies(list, opts.home, platform) : [];
  const filesOk = files.every(f => f.status === 'same' || f.status === 'line_endings_only');
  const ok = !settingsUnreadable && installed === listed && filesOk && duplicates.length === 0;
  return {
    package_dir: opts.packageDir,
    installed_dir: installedDir,
    settings_path: settingsPath,
    installed,
    listed,
    files,
    duplicates,
    settings_unreadable: settingsUnreadable,
    ok,
  };
}

const STATUS_TEXT: Record<ModFileStatus, string> = {
  same: '✅ same as the package',
  line_endings_only: '✅ same except line endings (CRLF/LF)',
  different: '⚠️  DIFFERENT from the package',
  missing: '⚠️  missing from the installed copy',
  unknown: '⚠️  not a file of this package',
};

export function formatModVerify(r: ModVerifyReport): string {
  const L: string[] = [''];
  L.push(`  Mod verification: ${MOD_NAME} (read-only: nothing is changed)`);
  L.push(`  Package:    ${r.package_dir}`);
  L.push(`  Installed:  ${r.installed_dir}`);
  L.push('');
  if (!r.installed && !r.listed) {
    L.push('  ⚪ Not installed. Install it with: npx crbro-memory install-mod');
  }
  for (const f of r.files) {
    L.push(`  ${f.name.padEnd(28)} ${STATUS_TEXT[f.status]}`);
    if (f.status === 'different' || f.status === 'unknown') {
      if (f.package_sha256) L.push(`      package    sha256 ${f.package_sha256}`);
      if (f.installed_sha256) L.push(`      installed  sha256 ${f.installed_sha256}`);
    }
  }
  if (r.settings_unreadable) {
    L.push('');
    L.push(`  ⚠️  ${r.settings_path} cannot be read as JSON: whether Claude Code loads the mod could not be checked.`);
  } else if (r.installed && !r.listed) {
    L.push('');
    L.push(`  ⚠️  The folder exists but ${PLUGIN_DIRS_VAR} does not list it: Claude Code does not load it.`);
  } else if (r.listed && !r.installed) {
    L.push('');
    L.push(`  ⚠️  ${PLUGIN_DIRS_VAR} lists ${r.installed_dir}, which does not exist.`);
  }
  if (r.duplicates.length > 0) {
    L.push('');
    for (const dir of r.duplicates) L.push(`  ⚠️  Another copy is in ${dir}: Claude Code may load it too, with a second band.`);
    L.push('     Remove it, or take it out of the list; install-mod and uninstall-mod never touch it.');
  }
  if (r.installed || r.listed) {
    L.push('');
    if (r.ok) {
      L.push('  The installed mod matches this package.');
    } else if (r.duplicates.length > 0 && r.files.every(f => f.status === 'same' || f.status === 'line_endings_only')
      && r.installed === r.listed && !r.settings_unreadable) {
      L.push('  The installed mod matches this package, but it is not the only copy.');
    } else {
      L.push('  There are differences. If you just updated CRBRO that is expected: run');
      L.push('  npx crbro-memory install-mod again and the copy is refreshed. If you did not');
      L.push('  update, find out who changed those files before using the mod again.');
    }
  }
  L.push('');
  return L.join('\n');
}

// ─── Automatic install at boot ───────────────────────────────────
//
// crbro_boot runs this once per process (once per daemon too). It installs
// the mod for anyone who has Claude Code (~/.claude exists) and refreshes its
// files when the package ships a newer build, so an update of CRBRO reaches
// the band with no command. What it changes, it says through a notice the
// next boots hand to the agent (mod_notice). It never:
//   - runs in a client whose env has CRBRO_MOD=0 (or off / false / no); a
//     daemon started without it does not serve that client, because the
//     variable is part of configFingerprint;
//   - comes back after uninstall-mod (state.json optedOut), from any client,
//     or after the folder was taken out of CLAUDE_CODE_PLUGIN_DIRS by hand
//     (said once, with the way back);
//   - touches a settings.json it cannot parse, adds a second band beside
//     another crbro-pending already in the list, or writes a list into
//     settings.json while only the environment holds one: settings.json's env
//     wins over it, and the folders listed there would stop loading (said
//     once instead);
//   - throws or stalls the boot: files are copied through fs.promises, every
//     failure is caught, and one that is not transient is written down and
//     not retried until the package or settings.json changes, or a day has
//     gone by.
// Two sessions starting at once take turns through an exclusive lock file
// (auto.lock, released only by its owner, taken over after a minute if that
// owner died); settings.json is written only if it is still what was read,
// and the write is checked afterwards.

export const MOD_SWITCH_VAR = 'CRBRO_MOD';
/** The values of CRBRO_MOD that turn the automatic install off; src/daemon/endpoint.ts mirrors them. */
export const MOD_OFF_VALUES: ReadonlySet<string> = new Set(['0', 'off', 'false', 'no']);
const DEFAULT_STALE_LOCK_MS = 60_000;
const DEFAULT_RETRY_FAILED_MS = 24 * 60 * 60 * 1000;
/** How long crbro_boot waits for the automatic install before answering without its notice. */
export const BOOT_BUDGET_MS = 1_500;
/** A notice is handed to this many server processes, in case one is a background run nobody reads... */
export const NOTICE_SESSIONS = 3;
/** ...and dropped after this long, whoever saw it. */
const NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type AutoModAction = 'installed' | 'updated' | 'current' | 'skipped' | 'failed';

export interface AutoModResult {
  action: AutoModAction;
  /**
   * Why it was skipped or failed: disabled, no-claude-code, not-in-package,
   * opted-out, removed-by-hand, another-copy, env-list, newer-installed,
   * other-build, failed-before, busy, or the error.
   */
  reason?: string;
  /** The sentence for the user, when there is one to say. */
  notice?: string;
}

export interface AutoModOptions extends ModOptions {
  /** Where CRBRO_MOD is read; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  staleLockMs?: number;
  retryFailedMs?: number;
  /** Tests only: runs right before settings.json is written. */
  beforeSettingsWrite?: () => void;
}

export function modSwitchedOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return MOD_OFF_VALUES.has(String(env[MOD_SWITCH_VAR] ?? '').trim().toLowerCase());
}

const HOW_TO_REMOVE =
  'To remove it: npx crbro-memory uninstall-mod (CRBRO will not put it back, whichever app runs it), ' +
  'or set CRBRO_MOD=0 in the env of every MCP client that runs CRBRO to stop automatic installs.';
const TELL_ONCE =
  'Tell the user this once, briefly, in their language. It is handed to up to ' +
  `${NOTICE_SESSIONS} sessions in case one is a background run nobody reads; if the user plainly knows already, skip it.`;

function installedNotice(version: string | null, r: InstallModResult): string {
  const parts = [
    `CRBRO${version ? ` ${version}` : ''} installed its Claude Code mod "${MOD_NAME}": the user's open items in a band above the prompt, and /pending (alias /pendientes) to see them all.`,
    'It shows up in NEW Claude Code sessions (CLI and the desktop app\'s Code tab, 2.1.286 or later), not in this one.',
    `Files: ${r.installedDir}, listed in env.${PLUGIN_DIRS_VAR} of ${r.settingsPath}.`,
  ];
  for (const rep of r.replaced) {
    parts.push(`It took the place of the earlier copy "${rep.name}" (${rep.dir}) in that list; that folder was left on disk and uninstall-mod puts it back.`);
  }
  // A replaced copy that sits in ~/.claude/mods is named once, above.
  const elsewhere = r.elsewhere.filter(dir => !r.replaced.some(rep => path.resolve(rep.dir).toLowerCase() === path.resolve(dir).toLowerCase()));
  for (const dir of elsewhere) parts.push(`Another copy is in ${dir}: if two bands appear, remove that one.`);
  parts.push(HOW_TO_REMOVE, TELL_ONCE);
  return parts.join(' ');
}

function updatedNotice(version: string | null, installedDir: string, files: number): string {
  return [
    `CRBRO${version ? ` ${version}` : ''} updated its Claude Code mod "${MOD_NAME}" (the open-items band and /pending): ${files} files refreshed in ${installedDir}.`,
    'New Claude Code sessions load the new version; settings.json was not touched.',
    HOW_TO_REMOVE,
    TELL_ONCE,
  ].join(' ');
}

function unlistedNotice(installedDir: string, settingsPath: string): string {
  return [
    `CRBRO's Claude Code mod "${MOD_NAME}" (the open-items band and /pending) is no longer in env.${PLUGIN_DIRS_VAR} of ${settingsPath}, where CRBRO had put it.`,
    'CRBRO takes that as a no and will not put it back on its own (marked in ~/.claude/crbro-mods/state.json).',
    `If the user did not take it out (a settings.json restored or rewritten by another tool, say), npx crbro-memory install-mod brings it back; its files are in ${installedDir}.`,
    TELL_ONCE,
  ].join(' ');
}

function envListNotice(list: string[], settingsPath: string): string {
  return [
    `CRBRO did not install its Claude Code mod "${MOD_NAME}" (the open-items band and /pending): ${PLUGIN_DIRS_VAR} is set in the environment Claude Code starts from (${list.join(', ')}) and not in ${settingsPath},`,
    'whose env block wins over the environment: writing the variable there would stop those plugins from loading.',
    `To get the band, move that variable into the env block of ${settingsPath}; the next CRBRO start adds the mod beside those folders.`,
    'npx crbro-memory uninstall-mod (or CRBRO_MOD=0) stops CRBRO from looking at this again.',
    TELL_ONCE,
  ].join(' ');
}

/** The lock's token when taken, null when another live process holds it. */
async function takeLock(lockPath: string, now: () => number, staleMs: number): Promise<string | null> {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fsp.open(lockPath, 'wx');
      try {
        await fh.writeFile(JSON.stringify({ token, pid: process.pid, at: new Date(now()).toISOString() }));
      } finally {
        await fh.close();
      }
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let age = 0;
      try {
        age = now() - (await fsp.stat(lockPath)).mtimeMs;
      } catch {
        continue; // Released between the two calls: try again.
      }
      if (age <= staleMs) return null;
      // Its owner died half way. Renamed aside, not deleted: of two processes
      // that both found it stale, only one rename succeeds.
      const aside = `${lockPath}.${token}.stale`;
      try {
        await fsp.rename(lockPath, aside);
      } catch {
        return null;
      }
      try {
        // What was renamed is a lock somebody took a moment ago: give it back.
        if (now() - (await fsp.stat(aside)).mtimeMs <= staleMs) {
          if (!existsSync(lockPath)) await fsp.rename(aside, lockPath);
          return null;
        }
      } catch {
        return null;
      }
      await fsp.rm(aside, { force: true }).catch(() => undefined);
    }
  }
  return null;
}

/** Removes the lock only if it is still the one this token took. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const held = JSON.parse(await fsp.readFile(lockPath, 'utf8'))?.token;
    if (held === token) await fsp.rm(lockPath, { force: true });
  } catch {
    // Gone, or not ours to remove.
  }
}

/** The list settings.json sets, or null when it does not set the variable. */
function settingsList(settingsPath: string, platform: NodeJS.Platform): string[] | null {
  const read = readSettings(settingsPath);
  if (!read.ok) return null;
  const value = read.settings?.env?.[PLUGIN_DIRS_VAR];
  return typeof value === 'string' ? splitList(value, pathListSeparator(platform)) : null;
}

/** Folders in the list holding another crbro-pending (a checkout): installing beside it would draw two bands. */
function listedOtherPending(settingsPath: string, home: string, platform: NodeJS.Platform, envDirs?: string): string[] {
  const list = settingsList(settingsPath, platform)
    ?? splitList(envDirs ?? process.env[PLUGIN_DIRS_VAR], pathListSeparator(platform));
  const { installedDir } = modPaths(home);
  return list.filter(dir => !samePath(dir, installedDir, home, platform) && pluginNameAt(dir, home) === MOD_NAME);
}

/**
 * Folders only the environment lists: settings.json does not set the
 * variable, the environment does. Writing a list into settings.json would
 * hide them from Claude Code.
 */
function environmentOnlyList(settingsPath: string, home: string, platform: NodeJS.Platform, envDirs?: string): string[] {
  if (settingsList(settingsPath, platform) !== null) return [];
  const { installedDir } = modPaths(home);
  return splitList(envDirs ?? process.env[PLUGIN_DIRS_VAR], pathListSeparator(platform))
    .filter(dir => !samePath(dir, installedDir, home, platform));
}

/** Leaves a notice for the next crbro_boot calls, in this process or another; a newer one replaces it. */
function leaveNotice(home: string, text: string): void {
  const { noticePath } = modPaths(home);
  const tmp = `${noticePath}.${process.pid}.tmp`;
  const notice = { notice: text, id: randomBytes(8).toString('hex'), at: new Date().toISOString(), delivered: 0 };
  writeFileSync(tmp, JSON.stringify(notice) + '\n', 'utf8');
  renameSync(tmp, noticePath);
}

/** Notice ids this process has handed over: a later boot of the same conversation, or a subagent's, does not hear it again. */
const handedOver = new Set<string>();

/**
 * Takes the pending notice, if any, for this boot. The rename is atomic, so
 * of two boots reaching for it at once exactly one gets it. It goes back for
 * a later process until NOTICE_SESSIONS processes have had it or it is a
 * week old: the first boot to take it may be a background run, a scheduled
 * `claude -p` or another app, with nobody reading.
 */
export function takeModNotice(home: string, now: () => number = Date.now): string | null {
  const { noticePath } = modPaths(home);
  try {
    const peek = JSON.parse(readFileSync(noticePath, 'utf8'));
    if (typeof peek?.id === 'string' && handedOver.has(peek.id)) return null;
  } catch {
    return null;
  }
  const taken = `${noticePath}.${process.pid}.${randomBytes(4).toString('hex')}.taken`;
  try {
    renameSync(noticePath, taken);
  } catch {
    return null;
  }
  try {
    const n = JSON.parse(readFileSync(taken, 'utf8'));
    const text = n?.notice;
    if (typeof text !== 'string' || !text) return null;
    const id = typeof n.id === 'string' ? n.id : null;
    if (id) handedOver.add(id);
    const delivered = (Number(n.delivered) || 0) + 1;
    const age = now() - Date.parse(String(n.at));
    if (id && delivered < NOTICE_SESSIONS && age < NOTICE_MAX_AGE_MS && !existsSync(noticePath)) {
      writeFileSync(taken, JSON.stringify({ ...n, delivered }) + '\n', 'utf8');
      renameSync(taken, noticePath);
    }
    return text;
  } catch {
    return null;
  } finally {
    rmSync(taken, { force: true });
  }
}

export async function autoInstallMod(opts: AutoModOptions): Promise<AutoModResult> {
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const { claudeDir, settingsPath, installedDir, lockPath } = modPaths(opts.home);

  if (modSwitchedOff(opts.env ?? process.env)) return { action: 'skipped', reason: 'disabled' };
  // No ~/.claude, no Claude Code: nothing is created for it.
  if (!existsSync(claudeDir)) return { action: 'skipped', reason: 'no-claude-code' };
  if (!existsSync(path.join(opts.packageDir, '.claude-plugin', 'plugin.json'))) {
    return { action: 'skipped', reason: 'not-in-package' };
  }
  if (readModState(opts.home).optedOut) return { action: 'skipped', reason: 'opted-out' };

  const pkg = treeHash(opts.packageDir);
  const version = packageVersion(opts.packageDir);
  const before = readModState(opts.home).failed;
  if (before && before.pkg === pkg && before.settings === settingsFingerprint(settingsPath)
    && now() - Date.parse(before.at) < (opts.retryFailedMs ?? DEFAULT_RETRY_FAILED_MS)) {
    return { action: 'skipped', reason: 'failed-before' };
  }

  const token = await takeLock(lockPath, now, opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
  if (!token) {
    // Another session is doing it right now; its notice reaches whoever boots next.
    return { action: 'skipped', reason: 'busy' };
  }

  // A failure is written down so the same cause is not retried at every
  // start; one that may well pass next time (a file held open, settings.json
  // being saved by someone else) is not.
  const fail = (error: string, transient = false): AutoModResult => {
    if (!transient) {
      try {
        const state = readModState(opts.home);
        state.failed = { pkg, settings: settingsFingerprint(settingsPath), at: new Date(now()).toISOString(), error };
        writeModState(opts.home, state);
      } catch {
        // Nowhere to write it down: the next start tries again, still without touching anything.
      }
    }
    return { action: 'failed', reason: error };
  };
  const isTransient = (e: unknown) => TRANSIENT.has((e as NodeJS.ErrnoException)?.code ?? '');

  try {
    // Read again under the lock: the session before may have just changed it.
    const state = readModState(opts.home);
    if (state.optedOut) return { action: 'skipped', reason: 'opted-out' };
    const v = verifyMod({ ...opts, platform });
    if (v.settings_unreadable) return fail(`${settingsPath} could not be parsed — not touching it.`);

    if (v.installed && v.listed) {
      if (v.files.every(f => f.status === 'same' || f.status === 'line_endings_only')) {
        // Installed by hand before this existed, or by another build with the
        // same files: remember it, quietly. A copy already known writes nothing.
        const newest = version && (!state.version || compareVersions(version, state.version) > 0) ? version : state.version;
        const known: ModState = { ...state, installed: true, version: newest ?? undefined, pkg, failed: undefined };
        if (JSON.stringify(stateClean(known)) !== JSON.stringify(stateClean(state))) writeModState(opts.home, known);
        return { action: 'current' };
      }
      // A newer CRBRO elsewhere on this machine (another client, a global
      // install) put its files there: an older one does not take them back.
      const order = version && state.version ? compareVersions(version, state.version) : 0;
      if (order < 0) return { action: 'skipped', reason: 'newer-installed' };
      // Another build of the same version (a checkout beside the npm copy)
      // wrote them and they are still as it left them: it keeps them, or the
      // two would rewrite each other at every start.
      if (order === 0 && state.pkg && state.pkg !== pkg && treeHash(installedDir) === state.pkg) {
        return { action: 'skipped', reason: 'other-build' };
      }
      // Only the files: the list already names the folder.
      const files = await copyModAsync(opts.packageDir, installedDir);
      writeModState(opts.home, { ...state, installed: true, version: version ?? undefined, pkg, failed: undefined });
      const notice = updatedNotice(version, installedDir, files.length);
      leaveNotice(opts.home, notice);
      return { action: 'updated', notice };
    }

    // It was in once and is no longer listed: somebody took it out by hand.
    // That is an answer too, kept like uninstall-mod's, and said once.
    if (state.installed && !v.listed) {
      writeModState(opts.home, {
        ...state, optedOut: true, optedOutAt: new Date(now()).toISOString(), optedOutBy: 'unlisted', failed: undefined,
      });
      const notice = unlistedNotice(installedDir, settingsPath);
      leaveNotice(opts.home, notice);
      return { action: 'skipped', reason: 'removed-by-hand', notice };
    }

    if (listedOtherPending(settingsPath, opts.home, platform, opts.envDirs).length > 0) {
      return { action: 'skipped', reason: 'another-copy' };
    }

    const envOnly = environmentOnlyList(settingsPath, opts.home, platform, opts.envDirs);
    if (envOnly.length > 0) {
      const seen = sha256(Buffer.from(envOnly.join('\n'), 'utf8'));
      if (state.envListNoticed === seen) return { action: 'skipped', reason: 'env-list' };
      writeModState(opts.home, { ...state, envListNoticed: seen });
      const notice = envListNotice(envOnly, settingsPath);
      leaveNotice(opts.home, notice);
      return { action: 'skipped', reason: 'env-list', notice };
    }

    const hadDir = existsSync(installedDir);
    const dropCopy = async () => {
      if (!hadDir) await fsp.rm(installedDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    };
    let files: string[];
    try {
      files = await copyModAsync(opts.packageDir, installedDir);
    } catch (e) {
      return fail((e as Error).message, isTransient(e));
    }
    const install = () => installMod({
      packageDir: opts.packageDir, home: opts.home, platform, envDirs: opts.envDirs, auto: true, copied: files,
      beforeSettingsWrite: opts.beforeSettingsWrite,
    });
    let r = install();
    // Checked after writing: something else (Claude Code itself, an editor)
    // may have written settings.json right after. Once more if so.
    if (r.ok && !r.skipped && !verifyMod({ ...opts, platform }).listed) r = install();
    if (r.ok && r.skipped === 'opted-out') {
      await dropCopy();
      return { action: 'skipped', reason: 'opted-out' };
    }
    if (!r.ok) {
      await dropCopy();
      return fail(r.error ?? 'install-mod failed', r.transient);
    }
    if (r.skipped) return { action: 'skipped', reason: 'no-claude-code' };
    const notice = installedNotice(version, r);
    leaveNotice(opts.home, notice);
    return { action: 'installed', notice };
  } catch (e) {
    return fail((e as Error).message, isTransient(e));
  } finally {
    await releaseLock(lockPath, token);
  }
}

let onBoot: Promise<AutoModResult> | null = null;

/**
 * What crbro_boot calls first: starts the automatic install the first time in
 * this process and returns the function to call once the boot has its answer
 * ready. That function waits for the install until `budgetMs` after the start
 * and takes the notice waiting to be said, or null. Neither throws. A boot
 * that fails never calls it, so it never takes a notice it cannot hand over.
 */
export function startModOnBoot(opts: Partial<AutoModOptions> & { budgetMs?: number } = {}): () => Promise<string | null> {
  try {
    const home = opts.home ?? homedir();
    const env = opts.env ?? process.env;
    if (modSwitchedOff(env) || !existsSync(modPaths(home).claudeDir)) return async () => null;
    if (!onBoot) {
      const packageDir = opts.packageDir ?? path.join(__dirname, '..', '..', 'mods', MOD_NAME);
      onBoot = autoInstallMod({ ...opts, home, env, packageDir })
        .catch(e => ({ action: 'failed' as const, reason: (e as Error).message }));
    }
    const running = onBoot;
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>(resolve => {
      timer = setTimeout(resolve, opts.budgetMs ?? BOOT_BUDGET_MS);
      timer.unref?.();
    });
    return async () => {
      try {
        await Promise.race([running, budget]);
        if (timer) clearTimeout(timer);
        return takeModNotice(home, opts.now);
      } catch {
        return null;
      }
    };
  } catch {
    return async () => null;
  }
}

/** startModOnBoot and its notice in one call. */
export async function modNoticeOnBoot(opts: Partial<AutoModOptions> & { budgetMs?: number } = {}): Promise<string | null> {
  return startModOnBoot(opts)();
}

/** Tests only: the next boot in this process behaves as the first boot of a new process. */
export function resetModOnBoot(): void {
  onBoot = null;
  handedOver.clear();
}
