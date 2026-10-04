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
// crbro-pendientes or crbro-pending (a local copy made before this existed)
// is replaced in place, and said so; the folder itself is left on disk.
//
// `uninstall-mod` takes the path out of the list (and the variable, if it
// ends up empty) and deletes ~/.claude/crbro-mods/crbro-pending, nothing else.
//
// `verifyMod` compares the installed copy with the package, file by file, by
// SHA-256, the way hookverify.ts does for the hooks. It only reads.

import { createHash } from 'crypto';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'fs';
import path from 'path';

export const MOD_NAME = 'crbro-pending';
/** Plugin names whose folder in the list is a copy this install replaces. */
export const REPLACED_NAMES = ['crbro-pendientes', 'crbro-pending'];
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
}

export function modPaths(home: string) {
  const claudeDir = path.join(home, '.claude');
  return {
    claudeDir,
    settingsPath: path.join(claudeDir, 'settings.json'),
    modsDir: path.join(claudeDir, 'crbro-mods'),
    installedDir: path.join(claudeDir, 'crbro-mods', MOD_NAME),
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

function expandHome(p: string, home: string): string {
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
type SettingsRead = { ok: true; settings: Settings | null } | { ok: false; error: string };

/** settings.json as an object, null when absent; refuses anything it would have to guess about. */
function readSettings(settingsPath: string): SettingsRead {
  if (!existsSync(settingsPath)) return { ok: true, settings: null };
  let settings: unknown;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    return { ok: false, error: `${settingsPath} exists but could not be parsed — not touching it.\n     ${(e as Error).message}` };
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return { ok: false, error: `${settingsPath} is not a JSON object — not touching it.` };
  }
  const env = (settings as Settings).env;
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
    return { ok: false, error: `env in ${settingsPath} is not an object — not touching it.` };
  }
  const dirs = env?.[PLUGIN_DIRS_VAR];
  if (dirs !== undefined && typeof dirs !== 'string') {
    return { ok: false, error: `env.${PLUGIN_DIRS_VAR} in ${settingsPath} is not a string — not touching it.` };
  }
  const configs = (settings as Settings).pluginConfigs;
  if (configs !== undefined && (typeof configs !== 'object' || configs === null || Array.isArray(configs))) {
    return { ok: false, error: `pluginConfigs in ${settingsPath} is not an object — not touching it.` };
  }
  return { ok: true, settings: settings as Settings };
}

function writeAtomic(settingsPath: string, settings: Settings): void {
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  renameSync(tmp, settingsPath);
}

function splitList(value: string | undefined, sep: string): string[] {
  return (value ?? '').split(sep).map(s => s.trim()).filter(Boolean);
}

/** Copies the shipped files into a fresh folder, then swaps it in for the old one. */
function copyMod(packageDir: string, installedDir: string): string[] {
  const files = modFiles(packageDir);
  const staging = `${installedDir}.${process.pid}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  for (const rel of files) {
    const target = path.join(staging, ...rel.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(packageDir, ...rel.split('/')), target);
  }
  rmSync(installedDir, { recursive: true, force: true });
  mkdirSync(path.dirname(installedDir), { recursive: true });
  renameSync(staging, installedDir);
  return files;
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
  /** Folders taken out of the list because they held another copy of this mod. */
  replaced: { dir: string; name: string }[];
  /** Copies in ~/.claude/mods, reported and left alone. */
  elsewhere: string[];
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
  const { claudeDir, settingsPath, installedDir } = modPaths(opts.home);
  const base: InstallModResult = {
    ok: false, installedDir, settingsPath, files: [], changed: false, alreadyListed: false, replaced: [], elsewhere: [], lines: [],
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

  const files = copyMod(opts.packageDir, installedDir);
  const settings: Settings = read.settings ?? {};
  const before = JSON.stringify(settings);
  const sep = pathListSeparator(platform);
  const env: Settings = settings.env ?? {};
  const current = splitList(env[PLUGIN_DIRS_VAR], sep);

  const next: string[] = [];
  const replaced: { dir: string; name: string }[] = [];
  let placed = false;
  let alreadyListed = false;
  for (const dir of current) {
    if (samePath(dir, installedDir, opts.home, platform)) {
      alreadyListed = true;
      if (!placed) { next.push(installedDir); placed = true; }
      continue;
    }
    const name = pluginNameAt(dir, opts.home);
    if (name !== null && REPLACED_NAMES.includes(name)) {
      replaced.push({ dir, name });
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
  } else if (opts.lang === 'auto') {
    dropLanguage(settings);
  }

  const changed = JSON.stringify(settings) !== before;
  if (changed) writeAtomic(settingsPath, settings);

  const lines: string[] = [];
  lines.push(`  ✅ Mod ${MOD_NAME} copied (${files.length} files).`);
  lines.push(`     ${installedDir}`);
  for (const r of replaced) {
    lines.push(`  ✅ Replaced your earlier copy "${r.name}" in ${PLUGIN_DIRS_VAR}: ${r.dir}`);
    lines.push('     Its folder is left where it is; delete it once you no longer need it.');
  }
  if (alreadyListed && replaced.length === 0) {
    lines.push(`  ✅ Already in ${PLUGIN_DIRS_VAR}. Files refreshed.`);
  } else if (!alreadyListed) {
    lines.push(`  ✅ Added to ${PLUGIN_DIRS_VAR} in ${settingsPath}`);
  }
  // A copy in ~/.claude/mods is loaded by Claude Code on its own, outside the
  // list: it is not ours to delete, but two bands would be confusing.
  const modsFolder = path.join(claudeDir, 'mods');
  const elsewhere = existsSync(modsFolder)
    ? readdirSync(modsFolder)
      .map(name => path.join(modsFolder, name))
      .filter(dir => { const n = pluginNameAt(dir, opts.home); return n !== null && REPLACED_NAMES.includes(n); })
    : [];
  for (const dir of elsewhere) {
    lines.push(`  ⚠️  Another copy is in ${dir}, which Claude Code may load on its own.`);
    lines.push('     Remove or move it if you see two bands; this command does not touch it.');
  }
  if (opts.lang === 'en' || opts.lang === 'es') {
    lines.push(`     Language: ${opts.lang === 'es' ? 'Spanish' : 'English'} (pluginConfigs.${MOD_NAME}.options.language; /config changes it).`);
  } else if (opts.lang === 'auto') {
    lines.push('     Language: auto (CRBRO_LANG, then LC_ALL / LC_MESSAGES / LANG, then the system locale).');
  }
  lines.push(...REQUIREMENT_LINES);
  lines.push('     Undo with: npx crbro-memory uninstall-mod');

  return { ...base, ok: true, files, changed, alreadyListed, replaced, elsewhere, lang: opts.lang, lines };
}

/** Removes the language this installer set; true when something went. */
function dropLanguage(settings: Settings): boolean {
  const mine = settings.pluginConfigs?.[MOD_NAME];
  if (!mine || typeof mine !== 'object') return false;
  if (mine.options && typeof mine.options === 'object' && 'language' in mine.options) {
    delete mine.options.language;
    if (Object.keys(mine.options).length === 0) delete mine.options;
  }
  if (Object.keys(mine).length === 0) delete settings.pluginConfigs[MOD_NAME];
  if (Object.keys(settings.pluginConfigs).length === 0) delete settings.pluginConfigs;
  return true;
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
  lines: string[];
}

export function uninstallMod(opts: Omit<ModOptions, 'packageDir'>): UninstallModResult {
  const platform = opts.platform ?? process.platform;
  const { settingsPath, installedDir } = modPaths(opts.home);
  const base: UninstallModResult = { ok: false, installedDir, settingsPath, changed: false, removedDir: false, lines: [] };

  const read = readSettings(settingsPath);
  if (!read.ok) return { ...base, error: read.error };

  let changed = false;
  let unlisted = false;
  const settings = read.settings;
  if (settings !== null) {
    const before = JSON.stringify(settings);
    const sep = pathListSeparator(platform);
    const env = settings.env;
    const current = splitList(env?.[PLUGIN_DIRS_VAR], sep);
    const kept = current.filter(dir => !samePath(dir, installedDir, opts.home, platform));
    if (kept.length !== current.length) {
      unlisted = true;
      if (kept.length) env[PLUGIN_DIRS_VAR] = kept.join(sep);
      else delete env[PLUGIN_DIRS_VAR];
    }
    if (settings.pluginConfigs?.[MOD_NAME] !== undefined) {
      delete settings.pluginConfigs[MOD_NAME];
      if (Object.keys(settings.pluginConfigs).length === 0) delete settings.pluginConfigs;
    }
    changed = JSON.stringify(settings) !== before;
    if (changed) writeAtomic(settingsPath, settings);
  }

  const removedDir = existsSync(installedDir);
  rmSync(installedDir, { recursive: true, force: true });

  const lines: string[] = [];
  if (unlisted) lines.push(`  ✅ Removed from ${PLUGIN_DIRS_VAR} in ${settingsPath}`);
  else if (changed) lines.push(`  ✅ Its language setting was removed from ${settingsPath}`);
  if (removedDir) lines.push(`  ✅ Deleted ${installedDir}`);
  if (!changed && !removedDir) lines.push('  ⚪ The mod was not installed. Nothing changed.');
  else lines.push('     Open a new session: the band and /pending are gone from it.');

  return { ...base, ok: true, changed, removedDir, lines };
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
  /** settings.json lists it in CLAUDE_CODE_PLUGIN_DIRS. */
  listed: boolean;
  files: ModFileCheck[];
  settings_unreadable: boolean;
  /** Not installed and not listed, or installed, listed and matching. */
  ok: boolean;
}

/** Read-only: hashes files and parses settings.json, writes nothing. */
export function verifyMod(opts: ModOptions): ModVerifyReport {
  const platform = opts.platform ?? process.platform;
  const { settingsPath, installedDir } = modPaths(opts.home);
  const installed = existsSync(installedDir);

  let settingsUnreadable = false;
  let listed = false;
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      const value = settings?.env?.[PLUGIN_DIRS_VAR];
      listed = typeof value === 'string' &&
        splitList(value, pathListSeparator(platform)).some(d => samePath(d, installedDir, opts.home, platform));
    } catch {
      settingsUnreadable = true;
    }
  }

  const files: ModFileCheck[] = [];
  if (installed) {
    const shipped = modFiles(opts.packageDir);
    const present = modFiles(installedDir);
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

  const filesOk = files.every(f => f.status === 'same' || f.status === 'line_endings_only');
  const ok = !settingsUnreadable && installed === listed && filesOk;
  return {
    package_dir: opts.packageDir,
    installed_dir: installedDir,
    settings_path: settingsPath,
    installed,
    listed,
    files,
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
  if (r.installed || r.listed) {
    L.push('');
    if (r.ok) {
      L.push('  The installed mod matches this package.');
    } else {
      L.push('  There are differences. If you just updated CRBRO that is expected: run');
      L.push('  npx crbro-memory install-mod again and the copy is refreshed. If you did not');
      L.push('  update, find out who changed those files before using the mod again.');
    }
  }
  L.push('');
  return L.join('\n');
}
