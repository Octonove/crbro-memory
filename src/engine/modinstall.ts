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

import { createHash } from 'crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync,
  statSync, writeFileSync,
} from 'fs';
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
type SettingsRead = { ok: true; settings: Settings | null; indent: string | number } | { ok: false; error: string };

const isObject = (v: unknown): v is Settings => typeof v === 'object' && v !== null && !Array.isArray(v);

/** settings.json as an object, null when absent; refuses anything it would have to guess about. */
function readSettings(settingsPath: string): SettingsRead {
  if (!existsSync(settingsPath)) return { ok: true, settings: null, indent: 2 };
  let settings: unknown;
  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf8');
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
  // Written back with the indentation it came with (tabs or n spaces).
  const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? 2;
  return { ok: true, settings, indent };
}

/**
 * Writes settings.json through a .tmp + rename. A symlinked settings.json
 * (dotfiles) is written at its target, so the link stays a link, and the
 * file keeps its permission bits: its env block often carries tokens.
 */
function writeAtomic(settingsPath: string, settings: Settings, indent: string | number = 2): void {
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
    writeFileSync(tmp, JSON.stringify(settings, null, indent) + '\n', mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function splitList(value: string | undefined, sep: string): string[] {
  return (value ?? '').split(sep).map(s => s.trim()).filter(Boolean);
}

const STAGING = /^crbro-pending\.\d+\.tmp$/;

/** Copies the shipped files into a fresh folder, then swaps it in for the old one. */
function copyMod(packageDir: string, installedDir: string): string[] {
  const files = modFiles(packageDir);
  const parent = path.dirname(installedDir);
  mkdirSync(parent, { recursive: true });
  // A staging folder left by a run that failed half way: its pid is gone.
  for (const name of readdirSync(parent)) {
    if (STAGING.test(name)) rmSync(path.join(parent, name), { recursive: true, force: true, maxRetries: 3 });
  }
  const staging = `${installedDir}.${process.pid}.tmp`;
  try {
    for (const rel of files) {
      const target = path.join(staging, ...rel.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(packageDir, ...rel.split('/')), target);
    }
    rmSync(installedDir, { recursive: true, force: true, maxRetries: 3 });
    renameSync(staging, installedDir);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `could not replace ${installedDir} (${(e as Error).message}).\n` +
      '     Close the sessions and terminals using that folder and run it again.',
    );
  }
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
  /** What the CLI prints, one line each. */
  lines: string[];
}

const REQUIREMENT_LINES = [
  '     Needs Claude Code 2.1.286 or later with mods: the CLI and the desktop app\'s Code tab.',
  '     Claude Desktop chat, Codex, Cursor and the VS Code extension do not draw it.',
  '     Open a new session to see the band; /pending (or /pendientes) opens the list.',
];

export function installMod(opts: ModOptions & { lang?: ModLang }): InstallModResult {
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

  let files: string[];
  try {
    files = copyMod(opts.packageDir, installedDir);
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
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

  // Written down before settings.json, so a failure there never loses it.
  if (replaced.length > 0) {
    const known = readReplaced(replacedPath);
    const merged = [...known, ...replaced.filter(r => !known.some(k => samePath(k.dir, r.dir, opts.home, platform)))];
    writeFileSync(replacedPath, JSON.stringify({ replaced: merged }, null, 2) + '\n', 'utf8');
  }

  const changed = JSON.stringify(settings) !== before;
  if (changed) writeAtomic(settingsPath, settings, read.indent);

  const lines: string[] = [];
  lines.push(`  ✅ Mod ${MOD_NAME} copied (${files.length} files).`);
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
  lines: string[];
}

export function uninstallMod(opts: Omit<ModOptions, 'packageDir'>): UninstallModResult {
  const platform = opts.platform ?? process.platform;
  const { settingsPath, installedDir, modsDir, replacedPath } = modPaths(opts.home);
  const base: UninstallModResult = {
    ok: false, installedDir, settingsPath, changed: false, removedDir: false, restored: [], lines: [],
  };

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

  return { ...base, ok: true, changed, removedDir, restored, lines };
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
