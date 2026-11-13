// ─── One command in, one command out ─────────────────────────────
//
// `crbro-memory install` puts CRBRO on this machine for every MCP client it
// finds, the same way each time:
//
//   1. The engine. The running package and its runtime dependencies are copied
//      to a stable folder outside the brain — ~/.crbro-engine/<version>, with
//      current.json naming the live one and crbro.mjs, a launcher that runs it.
//      Under npx the dependencies sit in the same node_modules tree as the
//      package: they are resolved there and copied, never downloaded. Clients
//      then start `node ~/.crbro-engine/crbro.mjs`: no npx at startup, one
//      build for every client (one daemon), hooks that never point at a cache
//      folder that vanishes.
//   2. The registrations. Claude Code through its own CLI
//      (`claude mcp add-json --scope user`; ~/.claude.json is never edited by
//      hand), Claude Desktop's claude_desktop_config.json, Codex's config.toml
//      (with startup and tool timeouts, added only when missing), Cursor's
//      ~/.cursor/mcp.json.
//   3. The start of every session: what install-boot does (wireBoot below).
//
// `crbro-memory uninstall` takes back what CRBRO added and nothing else:
// registrations that run CRBRO, CRBRO's hooks and boot wiring, the mod, the
// engine folder. Backups stay. The brain (~/.crbro) is never touched; the
// command says where it is.
//
// Both take --dry-run, which prints the same list without writing a byte, and
// both print exactly what they did. Every file write goes through
// installio.writeGuarded: a timestamped backup first, refused when the file
// changed between read and write.

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { createHash } from 'crypto';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'fs';
import path from 'path';
import {
  claudeDesktopConfig, claudeDir, claudeJson, codexHome, cursorConfig, engineRoot, findOnPath, lfSha, readJsonObject, readText,
  updateJsonFile, writeGuarded,
} from './installio.js';
import { ensureCodexServer, pointsAtCrbro, readCodexServer, removeCodexServer, SERVER_NAME } from './codexconfig.js';
import { installHookFile, refreshHooks, HOOK_MANIFEST, type HookCopy } from './hookrefresh.js';

export type ClientId = 'claude-code' | 'claude-desktop' | 'codex' | 'cursor';
export const ALL_CLIENTS: ClientId[] = ['claude-code', 'claude-desktop', 'codex', 'cursor'];
export const CLIENT_NAMES: Record<ClientId, string> = {
  'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop', codex: 'Codex', cursor: 'Cursor',
};

export const BOOT_MATCHER = 'startup|resume|clear|compact';
export const CODEX_HOOK = 'crbro-codex.mjs';
export const CODEX_HOOK_TIMEOUT = 20;
export const LAUNCHER = 'crbro.mjs';
export const CURRENT = 'current.json';
export const ENGINE_STAMP = '.crbro-engine.json';

export type StepStatus = 'done' | 'would' | 'kept' | 'skipped' | 'warning' | 'failed';
export interface Step {
  client: string;
  status: StepStatus;
  what: string;
  file?: string;
  backup?: string | null;
}

export interface ClaudeCli {
  /** Runs `claude <args>`; status null when it could not be started. */
  run(args: string[]): { status: number | null; stdout: string; stderr: string };
  path: string;
}

export interface InstallContext {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  dryRun: boolean;
  /** The package this code runs from: package.json, dist/, bin/, hooks/, mods/. */
  packageRoot: string;
  /** The node that clients start (process.execPath). */
  nodePath: string;
  /** The Claude Code SessionStart notice (hooks/crbro-lifecycle.mjs BOOT_NOTICE). */
  bootNotice: string;
  /** The `claude` CLI, or null when it is not on PATH. */
  claude: ClaudeCli | null;
  engineDir?: string;
}

// ─── Small helpers ───────────────────────────────────────────────

function step(steps: Step[], s: Step): Step {
  steps.push(s);
  return s;
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

export { findOnPath } from './installio.js';

/** One argument quoted for the Windows C runtime (what node.exe and claude.exe parse). */
export function winQuote(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const c of arg) {
    if (c === '\\') { slashes++; continue; }
    if (c === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += '\\'.repeat(slashes) + c;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

/** The `claude` CLI as found on PATH. A .cmd/.bat shim runs through cmd.exe with its arguments quoted by hand. */
export function claudeCli(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ClaudeCli | null {
  const found = findOnPath('claude', env, platform);
  if (!found) return null;
  const run = (args: string[]) => {
    let r: SpawnSyncReturns<string>;
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(found)) {
      if (args.some(a => /[%!\r\n]/.test(a))) {
        return { status: null, stdout: '', stderr: 'an argument holds % or ! (cmd.exe would expand it); run the command by hand' };
      }
      const line = [winQuote(found), ...args.map(winQuote)].join(' ');
      r = spawnSync(env.ComSpec || env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`],
        { env, encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 60_000 });
    } else {
      r = spawnSync(found, args, { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    }
    return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
  };
  return { run, path: found };
}

function pkgJson(root: string): Record<string, any> {
  try { return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return {}; }
}

export function packageVersion(root: string): string {
  const v = pkgJson(root).version;
  return typeof v === 'string' && v ? v : 'unknown';
}

/** Paths a hook command runs or reads: quoted or bare, with ~, $HOME and %USERPROFILE% expanded. */
export function referencedFiles(command: string, home: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+\.(?:mjs|cjs|js|txt|md|sh|ps1|py))"|'([^']+\.(?:mjs|cjs|js|txt|md|sh|ps1|py))'|((?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|[A-Za-z]:|\/)[^\s"']*\.(?:mjs|cjs|js|txt|md|sh|ps1|py))(?=$|[\s"';|&)])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3]).replace(/^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?=[\\/])/i, home);
    if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) out.push(raw);
  }
  return out;
}

function hookCommands(entry: any): string[] {
  const out: string[] = [];
  for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
    if (h && typeof h.command === 'string') out.push(h.command);
    if (h && typeof h.commandWindows === 'string') out.push(h.commandWindows);
  }
  return out;
}

/** The install-boot entry, this release's or an older one with other wording. */
export function isInstallBootHook(h: any): boolean {
  return !!h && typeof h.command === 'string' && h.command.startsWith("printf '%s\\n' ") && h.command.includes('crbro_boot');
}

/** Codex's install-boot pair before 2.11: the direct mcp_tool call to crbro_boot. */
function isInstallBootMcpCall(h: any): boolean {
  return !!h && h.type === 'mcp_tool' && h.server === SERVER_NAME && h.tool === 'crbro_boot';
}

interface CrbroHookScan {
  /** Entries that mention CRBRO. */
  mentions: number;
  /** Of those, the ones whose referenced files all exist (or reference none). */
  working: number;
  /** Referenced files that do not exist. */
  missing: string[];
  /** Commands that run CRBRO out of an npx cache folder. */
  npxCache: string[];
}

function scanCrbroHooks(list: any[], home: string, skip: (h: any) => boolean = () => false): CrbroHookScan {
  const scan: CrbroHookScan = { mentions: 0, working: 0, missing: [], npxCache: [] };
  for (const entry of list) {
    const hooks = (Array.isArray(entry?.hooks) ? entry.hooks : []).filter((h: any) => !skip(h));
    if (!/crbro/i.test(JSON.stringify(hooks))) continue;
    scan.mentions++;
    const cmds = hooks.flatMap((h: any) => [h?.command, h?.commandWindows].filter((c: any) => typeof c === 'string'));
    const files = cmds.flatMap((c: string) => referencedFiles(c, home));
    const missing = files.filter((f: string) => !existsSync(f));
    scan.missing.push(...missing);
    if (!missing.length) scan.working++;
    for (const c of cmds) if (/[\\/]_npx[\\/]/.test(c)) scan.npxCache.push(c);
  }
  return scan;
}

// ─── Boot wiring (install-boot) ──────────────────────────────────

/** Claude Code: a SessionStart hook that tells the model to call crbro_boot first. */
export function wireClaudeBoot(ctx: InstallContext, steps: Step[]): void {
  const client = 'Claude Code';
  const dir = claudeDir(ctx.home, ctx.env);
  const file = path.join(dir, 'settings.json');
  if (!existsSync(dir) && !existsSync(file)) {
    step(steps, { client, status: 'skipped', what: `${dir} not found` });
    return;
  }
  const command = `printf '%s\\n' ${JSON.stringify(ctx.bootNotice)}`;
  let outcome: Step | null = null;
  const apply = (s: Record<string, any>) => {
    if (s.hooks !== undefined && !isObject(s.hooks)) throw new Error(`hooks in ${file} is not an object — not touching it.`);
    const hooks = s.hooks ?? {};
    if (hooks.SessionStart !== undefined && !Array.isArray(hooks.SessionStart)) {
      throw new Error(`hooks.SessionStart in ${file} is not a list — not touching it.`);
    }
    const list: any[] = hooks.SessionStart ?? [];
    const scan = scanCrbroHooks(list, ctx.home);
    if (scan.working > 0) {
      outcome = { client, status: 'kept', what: 'SessionStart already starts CRBRO. Left alone.', file };
      if (scan.npxCache.length) steps.push({ client, status: 'warning', what: 'a SessionStart hook runs CRBRO out of the npx cache, which disappears when the cache is cleaned: run npx crbro-memory install for a stable path', file });
      return false;
    }
    if (scan.mentions > 0) {
      steps.push({ client, status: 'warning', what: `a CRBRO SessionStart hook points at files that do not exist (${scan.missing.join(', ')}): it does nothing. Adding the packaged one; remove the broken entry by hand.`, file });
    }
    list.push({ matcher: BOOT_MATCHER, hooks: [{ type: 'command', command, shell: 'bash', timeout: 10, statusMessage: 'Loading CRBRO memory...' }] });
    hooks.SessionStart = list;
    s.hooks = hooks;
    outcome = { client, status: ctx.dryRun ? 'would' : 'done', what: 'SessionStart hook added.', file };
    return !ctx.dryRun;
  };
  const r = ctx.dryRun ? dry(file, apply) : updateJsonFile(file, apply);
  if (!r.ok) { step(steps, { client, status: 'failed', what: r.error, file }); return; }
  if (outcome) step(steps, { ...(outcome as Step), backup: r.changed ? r.backup : undefined });
}

/** Runs a change against a JSON file without writing: for --dry-run. */
function dry(file: string, change: (v: Record<string, any>, existed: boolean) => boolean) {
  const read = readJsonObject(file);
  if (!read.ok) return read;
  try {
    change(read.value ?? {}, read.value !== null);
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
  return { ok: true as const, changed: false, backup: null };
}

export interface CodexWiring {
  /** The command config.toml registers when it has no crbro server. */
  command: string;
  args: string[];
  /** Point an existing registration at command/args (the stable engine). */
  replaceCommand: boolean;
  /** --engine <dir> for the hook, when a stable engine is installed. */
  engineArg?: string;
}

/** Codex: config.toml (registration + timeouts) and hooks.json (the packaged boot hook). */
export function wireCodex(ctx: InstallContext, steps: Step[], wiring: CodexWiring): void {
  const client = 'Codex';
  const dir = codexHome(ctx.home, ctx.env);
  if (!existsSync(dir)) { step(steps, { client, status: 'skipped', what: `${dir} not found` }); return; }

  // — config.toml —
  const tomlFile = path.join(dir, 'config.toml');
  for (let attempt = 0; attempt < 3; attempt++) {
    let read;
    try { read = readText(tomlFile); } catch (e) { step(steps, { client, status: 'failed', what: (e as Error).message, file: tomlFile }); break; }
    const r = ensureCodexServer((read.bom ? '\ufeff' : '') + read.text, wiring);
    if (r.refused) { step(steps, { client, status: 'warning', what: `config.toml: ${r.refused}`, file: tomlFile }); break; }
    for (const k of r.kept) step(steps, { client, status: 'kept', what: `config.toml: kept your ${k}`, file: tomlFile });
    if (!r.changed) {
      if (!r.kept.length) step(steps, { client, status: 'kept', what: 'config.toml: CRBRO already registered.', file: tomlFile });
      break;
    }
    if (ctx.dryRun) {
      for (const a of r.actions) step(steps, { client, status: 'would', what: `config.toml: ${a}`, file: tomlFile });
      break;
    }
    try {
      const backup = writeGuarded(tomlFile, r.text, { expectHash: read.hash });
      for (const a of r.actions) step(steps, { client, status: 'done', what: `config.toml: ${a}`, file: tomlFile, backup });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESETTINGSCHANGED' && attempt < 2) continue;
      step(steps, { client, status: 'failed', what: `config.toml: ${(e as Error).message}`, file: tomlFile });
      break;
    }
  }

  // — the hook script, at a stable path —
  const hookDir = path.join(dir, 'crbro-hooks');
  const script = path.join(hookDir, CODEX_HOOK);
  if (ctx.dryRun) {
    step(steps, { client, status: 'would', what: `copy the boot hook to ${script}` });
  } else {
    try {
      installHookFile(path.join(ctx.packageRoot, 'hooks'), CODEX_HOOK, hookDir);
      step(steps, { client, status: 'done', what: `boot hook copied to ${script}` });
    } catch (e) {
      step(steps, { client, status: 'failed', what: `could not copy the boot hook: ${(e as Error).message}`, file: script });
      return;
    }
  }

  // — hooks.json —
  const hooksFile = path.join(dir, 'hooks.json');
  const base = `node "${script.split('\\').join('/')}"${wiring.engineArg ? ` --engine "${wiring.engineArg.split('\\').join('/')}"` : ''}`;
  const ours = (h: any) => !!h && typeof h.command === 'string' && h.command.includes(CODEX_HOOK);
  const outcomes: Step[] = [];
  const apply = (s: Record<string, any>) => {
    if (s.hooks !== undefined && !isObject(s.hooks)) throw new Error(`hooks in ${hooksFile} is not an object — not touching it.`);
    const hooks = s.hooks ?? {};
    let changed = false;
    for (const [event, matcher, status] of [
      ['SessionStart', BOOT_MATCHER, 'Loading CRBRO memory...'],
      ['UserPromptSubmit', undefined, 'Checking CRBRO memory...'],
    ] as const) {
      if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(`hooks.${event} in ${hooksFile} is not a list — not touching it.`);
      const list: any[] = hooks[event] ?? [];
      const mine = list.flatMap(e => (Array.isArray(e?.hooks) ? e.hooks : []).filter(ours));
      if (mine.length) {
        let refreshed = false;
        for (const h of mine) if (h.command !== base) { h.command = base; refreshed = true; }
        if (refreshed) changed = true;
        outcomes.push({ client, status: refreshed ? (ctx.dryRun ? 'would' : 'done') : 'kept',
          what: `${event}: packaged hook ${refreshed ? 'pointed at the current paths' : 'already installed'}.`, file: hooksFile });
        continue;
      }
      // The pair install-boot wrote before 2.11 (direct mcp_tool call + printed notice) gives way to the hook, which does both.
      let replaced = 0;
      if (event === 'SessionStart') {
        for (let i = list.length - 1; i >= 0; i--) {
          const e = list[i];
          const hs = Array.isArray(e?.hooks) ? e.hooks : [];
          const old = hs.filter((h: any) => isInstallBootMcpCall(h) || isInstallBootHook(h));
          if (!old.length || old.length !== hs.length) continue;
          list.splice(i, 1);
          replaced += old.length;
        }
      }
      const scan = scanCrbroHooks(list, ctx.home);
      if (scan.working > 0 && !replaced) {
        outcomes.push({ client, status: 'kept', what: `${event}: your own CRBRO hook is there. Left alone; the packaged one (${script}) is available if you remove yours and run this again.`, file: hooksFile });
        if (scan.npxCache.length) outcomes.push({ client, status: 'warning', what: `${event}: a hook runs CRBRO out of the npx cache (${scan.npxCache[0].slice(0, 160)}…), which disappears when the cache is cleaned`, file: hooksFile });
        continue;
      }
      if (scan.mentions > scan.working) {
        outcomes.push({ client, status: 'warning', what: `${event}: a CRBRO hook points at files that do not exist (${scan.missing.join(', ')}): it does nothing. Remove it by hand.`, file: hooksFile });
      }
      const entry: Record<string, any> = matcher ? { matcher } : {};
      entry.hooks = [{ type: 'command', command: base, timeout: CODEX_HOOK_TIMEOUT, statusMessage: status }];
      list.push(entry);
      hooks[event] = list;
      changed = true;
      outcomes.push({ client, status: ctx.dryRun ? 'would' : 'done',
        what: `${event}: packaged boot hook added${replaced ? ' (replacing the mcp_tool + notice pair an earlier install-boot wrote)' : ''}.`, file: hooksFile });
    }
    s.hooks = hooks;
    return changed && !ctx.dryRun;
  };
  const r = ctx.dryRun ? dry(hooksFile, apply) : updateJsonFile(hooksFile, apply);
  if (!r.ok) { step(steps, { client, status: 'failed', what: r.error, file: hooksFile }); return; }
  for (const o of outcomes) step(steps, { ...o, backup: r.changed && o.status === 'done' ? r.backup : undefined });
}

/** install-boot: the start of every session, for the clients that have hooks. */
export function wireBoot(ctx: InstallContext, clients: ClientId[], wiring: CodexWiring): Step[] {
  const steps: Step[] = [];
  if (clients.includes('claude-code')) wireClaudeBoot(ctx, steps);
  if (clients.includes('codex')) wireCodex(ctx, steps, wiring);
  return steps;
}

// ─── The engine ──────────────────────────────────────────────────

/** What the package ships besides package.json (its "files"), minus what never runs. */
function shippedEntries(root: string): string[] {
  const files = pkgJson(root).files;
  const list = Array.isArray(files) && files.length ? files : ['dist/', 'bin/', 'hooks/', 'mods/'];
  return list.map((f: string) => f.replace(/\/$/, '')).filter((f: string) => existsSync(path.join(root, f)));
}

/** Walks up from `from` the way Node resolves a bare package name. */
function resolvePackageDir(name: string, from: string): string | null {
  let dir = from;
  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const cand = path.join(dir, 'node_modules', ...name.split('/'));
      if (existsSync(path.join(cand, 'package.json'))) return cand;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export interface Dependency {
  name: string;
  dir: string;
  /** Where it goes under the engine's node_modules, as a relative path (keeps nesting). */
  rel: string;
}

/**
 * The runtime dependencies of the package, transitively, as Node would
 * resolve them from where the package sits: dependencies, optional ones that
 * are present, and peers that resolve. Missing required ones are returned as
 * names in `missing`; nothing is downloaded.
 */
export function runtimeDependencies(root: string): { deps: Dependency[]; missing: string[] } {
  const tops: string[] = [];
  for (let d = root; ; d = path.dirname(d)) {
    tops.push(path.basename(d) === 'node_modules' ? d : path.join(d, 'node_modules'));
    if (path.dirname(d) === d) break;
  }
  const relOf = (dir: string) => {
    for (const t of tops) {
      const rel = path.relative(t, dir);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    }
    return null;
  };
  const seen = new Map<string, Dependency>();
  const missing: string[] = [];
  const queue: Array<{ name: string; from: string; required: boolean }> = [];
  const enqueue = (pj: Record<string, any>, from: string) => {
    for (const n of Object.keys(pj.dependencies ?? {})) queue.push({ name: n, from, required: true });
    for (const n of Object.keys(pj.optionalDependencies ?? {})) queue.push({ name: n, from, required: false });
    for (const n of Object.keys(pj.peerDependencies ?? {})) queue.push({ name: n, from, required: false });
  };
  enqueue(pkgJson(root), root);
  while (queue.length) {
    const { name, from, required } = queue.shift()!;
    const dir = resolvePackageDir(name, from);
    if (!dir) { if (required && !missing.includes(name)) missing.push(name); continue; }
    if (seen.has(dir)) continue;
    const rel = relOf(dir) ?? name;
    seen.set(dir, { name, dir, rel });
    enqueue(pkgJson(dir), dir);
  }
  return { deps: [...seen.values()], missing };
}

function walkFiles(dir: string, rel = '', skipNodeModules = true): string[] {
  const out: string[] = [];
  let names: string[];
  try { names = readdirSync(path.join(dir, rel)).sort(); } catch { return out; }
  for (const name of names) {
    if (skipNodeModules && name === 'node_modules') continue;
    const r = rel ? `${rel}/${name}` : name;
    const st = statSync(path.join(dir, r));
    if (st.isDirectory()) out.push(...walkFiles(dir, r, skipNodeModules));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

/** One hash for the package files an engine copy is made of (LF-read), to tell two builds of one version apart. */
export function packageHash(root: string): string {
  const h = createHash('sha256');
  for (const entry of ['package.json', ...shippedEntries(root)]) {
    const st = statSync(path.join(root, entry));
    const files = st.isDirectory() ? walkFiles(root, entry) : [entry];
    for (const f of files) {
      if (/(^|\/)\.crbro-engine\.json$/.test(f)) continue;
      h.update(f).update('\0').update(lfSha(readFileSync(path.join(root, ...f.split('/'))))).update('\0');
    }
  }
  return h.digest('hex');
}

export const LAUNCHER_SOURCE = `#!/usr/bin/env node
// CRBRO launcher, written by \`crbro-memory install\`. MCP clients run this file;
// it starts the engine version current.json names, from this same folder.
// \`crbro-memory install\` with a newer CRBRO adds that version and updates
// current.json; \`crbro-memory uninstall\` removes this whole folder.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let dir;
try {
  const current = JSON.parse(readFileSync(join(here, 'current.json'), 'utf8'));
  dir = isAbsolute(current.dir) ? current.dir : join(here, current.dir);
} catch (e) {
  process.stderr.write('[crbro] ' + join(here, 'current.json') + ' is missing or unreadable: run npx crbro-memory install again.\\n');
  process.exit(1);
}
await import(pathToFileURL(join(dir, 'bin', 'crbro.mjs')).href);
`;

export interface EngineResult {
  root: string;
  dir: string;
  launcher: string;
  version: string;
}

/** True when the package runs from inside the engine folder already. */
function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function installEngine(ctx: InstallContext, steps: Step[]): EngineResult | null {
  const client = 'Engine';
  const root = ctx.engineDir ? path.resolve(ctx.engineDir) : engineRoot(ctx.home, ctx.env);
  const version = packageVersion(ctx.packageRoot);
  const dir = path.join(root, version);
  const launcher = path.join(root, LAUNCHER);
  const result = { root, dir, launcher, version };
  if (!existsSync(path.join(ctx.packageRoot, 'dist', 'index.js'))) {
    step(steps, { client, status: 'failed', what: `${ctx.packageRoot} has no dist/index.js (run npm run build first)` });
    return null;
  }
  const running = inside(ctx.packageRoot, root);
  const { deps, missing } = running ? { deps: [], missing: [] } : runtimeDependencies(ctx.packageRoot);
  if (missing.length) {
    step(steps, { client, status: 'failed', what: `runtime dependencies not found next to ${ctx.packageRoot}: ${missing.join(', ')}` });
    return null;
  }
  const hash = running ? null : packageHash(ctx.packageRoot);
  let stamp: any = null;
  try { stamp = JSON.parse(readFileSync(path.join(dir, ENGINE_STAMP), 'utf8')); } catch { /* not there */ }
  const current = running || (stamp?.hash === hash && existsSync(path.join(dir, 'dist', 'index.js')));

  if (ctx.dryRun) {
    step(steps, { client, status: current ? 'kept' : 'would',
      what: current ? `${version} already in ${dir}` : `copy CRBRO ${version} and ${deps.length} runtime package(s) to ${dir}` });
  } else if (!current) {
    const staging = `${dir}.${process.pid}.tmp`;
    const aside = `${dir}.${process.pid}.old`;
    try {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      for (const entry of ['package.json', ...shippedEntries(ctx.packageRoot)]) {
        cpSync(path.join(ctx.packageRoot, entry), path.join(staging, entry), {
          recursive: true, dereference: true,
          filter: src => !/[\\/]node_modules([\\/]|$)/.test(path.relative(ctx.packageRoot, src)),
        });
      }
      for (const d of deps) {
        cpSync(d.dir, path.join(staging, 'node_modules', d.rel), {
          recursive: true, dereference: true,
          filter: src => !/[\\/]node_modules([\\/]|$)/.test(path.relative(d.dir, src)),
        });
      }
      writeFileSync(path.join(staging, ENGINE_STAMP), JSON.stringify({ version, hash, installed: new Date().toISOString(), from: ctx.packageRoot }, null, 2) + '\n');
      let setAside = false;
      if (existsSync(dir)) { renameSync(dir, aside); setAside = true; }
      try {
        renameSync(staging, dir);
      } catch (e) {
        if (setAside) try { renameSync(aside, dir); } catch { /* left as .old */ }
        throw e;
      }
      if (setAside) rmSync(aside, { recursive: true, force: true, maxRetries: 3 });
      step(steps, { client, status: 'done', what: `CRBRO ${version} and ${deps.length} runtime package(s) copied to ${dir}` });
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      step(steps, { client, status: 'failed', what: `could not copy the engine to ${dir}: ${(e as Error).message}` });
      return null;
    }
  } else {
    step(steps, { client, status: 'kept', what: `CRBRO ${version} already in ${dir}` });
  }

  // current.json and the launcher.
  let previous: string | null = null;
  try { previous = JSON.parse(readFileSync(path.join(root, CURRENT), 'utf8')).dir ?? null; } catch { /* first install */ }
  if (!ctx.dryRun) {
    try {
      mkdirSync(root, { recursive: true });
      if (previous !== version) {
        const tmp = path.join(root, `${CURRENT}.${process.pid}.tmp`);
        writeFileSync(tmp, JSON.stringify({ version, dir: version, updated: new Date().toISOString() }, null, 2) + '\n');
        renameSync(tmp, path.join(root, CURRENT));
        step(steps, { client, status: 'done', what: `current version: ${version}${previous ? ` (was ${previous})` : ''}`, file: path.join(root, CURRENT) });
      }
      let launcherText = '';
      try { launcherText = readFileSync(launcher, 'utf8'); } catch { /* none */ }
      if (launcherText !== LAUNCHER_SOURCE) {
        writeFileSync(launcher, LAUNCHER_SOURCE);
        step(steps, { client, status: 'done', what: `launcher written: ${launcher}` });
      }
    } catch (e) {
      step(steps, { client, status: 'failed', what: `could not write ${path.join(root, CURRENT)}: ${(e as Error).message}` });
      return null;
    }
    // Older versions go; the one just replaced stays, in case a running client still uses it.
    try {
      for (const name of readdirSync(root)) {
        const p = path.join(root, name);
        if (name === version || name === previous || !/^\d+\.\d+\.\d+/.test(name) || !statSync(p).isDirectory()) continue;
        if (/\.\d+\.(tmp|old)$/.test(name)) continue;
        rmSync(p, { recursive: true, force: true, maxRetries: 3 });
        step(steps, { client, status: 'done', what: `old engine ${name} removed` });
      }
    } catch { /* best effort */ }
  } else if (previous !== version) {
    step(steps, { client, status: 'would', what: `point ${path.join(root, CURRENT)} at ${version} and write the launcher ${launcher}` });
  }
  return result;
}

// ─── Registrations ───────────────────────────────────────────────

export interface ServerSpec { command: string; args: string[] }

function sameSpec(entry: any, spec: ServerSpec): boolean {
  return isObject(entry) && entry.command === spec.command && JSON.stringify(entry.args ?? []) === JSON.stringify(spec.args);
}

function specOf(entry: any): string {
  return isObject(entry) ? [entry.command ?? entry.url ?? '?', ...(Array.isArray(entry.args) ? entry.args : [])].join(' ') : '?';
}

/** Claude Desktop and Cursor: mcpServers.crbro in a JSON file the client reads. */
function registerJson(ctx: InstallContext, steps: Step[], client: string, file: string, spec: ServerSpec): void {
  if (!existsSync(path.dirname(file))) { step(steps, { client, status: 'skipped', what: `${path.dirname(file)} not found` }); return; }
  let outcome: Step | null = null;
  const apply = (s: Record<string, any>) => {
    if (s.mcpServers !== undefined && !isObject(s.mcpServers)) throw new Error(`mcpServers in ${file} is not an object — not touching it.`);
    const servers = s.mcpServers ?? {};
    const existing = servers[SERVER_NAME];
    if (sameSpec(existing, spec)) { outcome = { client, status: 'kept', what: 'already runs the stable engine.', file }; return false; }
    const env = isObject(existing?.env) ? existing.env : undefined;
    servers[SERVER_NAME] = { ...(isObject(existing) ? existing : {}), command: spec.command, args: spec.args, ...(env ? { env } : {}) };
    delete servers[SERVER_NAME].url;
    s.mcpServers = servers;
    outcome = { client, status: ctx.dryRun ? 'would' : 'done',
      what: existing ? `registration now runs ${specOf(spec)} (was: ${specOf(existing)}${env ? '; its env is kept' : ''})` : `registered: ${specOf(spec)}`, file };
    return !ctx.dryRun;
  };
  const r = ctx.dryRun ? dry(file, apply) : updateJsonFile(file, apply);
  if (!r.ok) { step(steps, { client, status: 'failed', what: r.error, file }); return; }
  if (outcome) step(steps, { ...(outcome as Step), backup: r.changed ? r.backup : undefined });
}

/** Claude Code: through `claude mcp add-json --scope user`, never by editing ~/.claude.json. */
function registerClaudeCode(ctx: InstallContext, steps: Step[], spec: ServerSpec): void {
  const client = 'Claude Code';
  const file = claudeJson(ctx.home, ctx.env);
  const read = readJsonObject(file);
  const existing = read.ok ? read.value?.mcpServers?.[SERVER_NAME] : undefined;
  if (sameSpec(existing, spec)) { step(steps, { client, status: 'kept', what: 'MCP server already runs the stable engine (user scope).' }); return; }
  const env = isObject(existing?.env) ? existing.env : undefined;
  const json = JSON.stringify({ type: 'stdio', command: spec.command, args: spec.args, ...(env ? { env } : {}) });
  const manual = `claude mcp add-json --scope user ${SERVER_NAME} '${json}'`;
  if (!ctx.claude) {
    step(steps, { client, status: 'warning', what: `the claude CLI is not on PATH, so CRBRO was not registered. Run: ${manual}` });
    return;
  }
  if (ctx.dryRun) {
    step(steps, { client, status: 'would', what: existing ? `re-register through the claude CLI: ${specOf(spec)} (was: ${specOf(existing)})` : `register through the claude CLI: ${specOf(spec)}` });
    return;
  }
  if (existing !== undefined) {
    const rm = ctx.claude.run(['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
    if (rm.status !== 0) {
      step(steps, { client, status: 'failed', what: `claude mcp remove failed (${(rm.stderr || rm.stdout).trim().slice(0, 200)}); nothing changed` });
      return;
    }
  }
  const add = ctx.claude.run(['mcp', 'add-json', '--scope', 'user', SERVER_NAME, json]);
  if (add.status !== 0) {
    step(steps, { client, status: 'failed', what: `claude mcp add-json failed (${(add.stderr || add.stdout).trim().slice(0, 200)}). Run: ${manual}` });
    return;
  }
  step(steps, { client, status: 'done', what: existing ? `MCP server re-registered (user scope): ${specOf(spec)} (was: ${specOf(existing)}${env ? '; its env is kept' : ''})` : `MCP server registered (user scope): ${specOf(spec)}` });
}

// ─── Which clients ───────────────────────────────────────────────

export function detectClients(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, claude: ClaudeCli | null): ClientId[] {
  const out: ClientId[] = [];
  if (claude || existsSync(claudeDir(home, env))) out.push('claude-code');
  if (existsSync(path.dirname(claudeDesktopConfig(home, env, platform)))) out.push('claude-desktop');
  if (existsSync(codexHome(home, env))) out.push('codex');
  if (existsSync(path.dirname(cursorConfig(home)))) out.push('cursor');
  return out;
}

/** "auto" or a comma list of client ids; throws on an unknown one. */
export function parseClients(spec: string | undefined, detected: () => ClientId[]): ClientId[] {
  if (!spec || spec === 'auto') return detected();
  const list = spec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter(c => !ALL_CLIENTS.includes(c as ClientId));
  if (bad.length || !list.length) throw new Error(`unknown client "${bad.join(', ') || spec}": use auto or a comma list of ${ALL_CLIENTS.join(', ')}`);
  return [...new Set(list)] as ClientId[];
}

// ─── install ─────────────────────────────────────────────────────

export interface InstallReport { steps: Step[]; clients: ClientId[]; engine: EngineResult | null; hooks: HookCopy[] }

export function install(ctx: InstallContext, clients: ClientId[]): InstallReport {
  const steps: Step[] = [];
  const engine = installEngine(ctx, steps);
  if (!engine) return { steps, clients, engine, hooks: [] };
  const spec: ServerSpec = { command: ctx.nodePath, args: [engine.launcher] };
  if (!clients.length) step(steps, { client: 'Clients', status: 'warning', what: 'no MCP client found (Claude Code, Claude Desktop, Codex, Cursor); pass --clients to name them' });
  for (const c of clients) {
    if (c === 'claude-code') {
      registerClaudeCode(ctx, steps, spec);
      wireClaudeBoot(ctx, steps);
    } else if (c === 'claude-desktop') {
      registerJson(ctx, steps, 'Claude Desktop', claudeDesktopConfig(ctx.home, ctx.env, ctx.platform), spec);
    } else if (c === 'cursor') {
      registerJson(ctx, steps, 'Cursor', cursorConfig(ctx.home), spec);
    } else if (c === 'codex') {
      wireCodex(ctx, steps, { command: spec.command, args: spec.args, replaceCommand: true, engineArg: engine.root });
    }
  }
  // Hook copies installed earlier (install-hooks) are brought up to this version when unmodified.
  const hooks = refreshHooks({ home: ctx.home, env: ctx.env, pkgHooks: path.join(ctx.packageRoot, 'hooks'), dryRun: ctx.dryRun });
  for (const h of hooks) {
    if (h.state === 'stale') step(steps, { client: 'Hooks', status: ctx.dryRun ? 'would' : h.error ? 'failed' : 'done', what: `${h.name} ${ctx.dryRun ? 'refresh to' : h.error ? `could not be refreshed (${h.error}) to` : 'refreshed to'} this version`, file: path.join(h.dir, h.name) });
    if (h.state === 'modified') step(steps, { client: 'Hooks', status: 'warning', what: `${h.name} was edited by hand: left as it is (install-hooks replaces it after a backup)`, file: path.join(h.dir, h.name) });
  }
  return { steps, clients, engine, hooks };
}

// ─── uninstall ───────────────────────────────────────────────────

const OUR_CLAUDE_HOOKS = /crbro-(lifecycle|guard|subagent)\.mjs/;

/** Takes out of a hooks object every hook CRBRO's installers write. Returns how many went. */
function stripOurHooks(hooks: Record<string, any>, isOurs: (h: any) => boolean): number {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    const kept: any[] = [];
    for (const entry of list) {
      const hs = Array.isArray(entry?.hooks) ? entry.hooks : null;
      if (!hs) { kept.push(entry); continue; }
      const rest = hs.filter((h: any) => !isOurs(h));
      removed += hs.length - rest.length;
      if (rest.length) kept.push(rest.length === hs.length ? entry : { ...entry, hooks: rest });
    }
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }
  return removed;
}

function removeHookFolder(ctx: InstallContext, steps: Step[], client: string, dir: string): void {
  if (!existsSync(dir)) return;
  const ours = readdirSync(dir).filter(n => /^crbro-[\w-]+\.mjs$/.test(n) || n === HOOK_MANIFEST || /^crbro-[\w-]+\.replaced\.json$/.test(n));
  if (ctx.dryRun) {
    if (ours.length) step(steps, { client, status: 'would', what: `delete ${ours.length} CRBRO hook file(s) in ${dir} (backups kept)` });
    return;
  }
  for (const n of ours) rmSync(path.join(dir, n), { force: true });
  let left: string[] = [];
  try { left = readdirSync(dir); } catch { /* gone */ }
  if (!left.length) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* keep */ } }
  if (ours.length) step(steps, { client, status: 'done', what: `${ours.length} CRBRO hook file(s) deleted from ${dir}${left.length ? ` (${left.length} other file(s) kept there, backups included)` : ''}` });
}

export interface UninstallReport { steps: Step[]; brain: string }

export function uninstall(ctx: InstallContext, clients: ClientId[], opts: {
  brainDir: string;
  /** Delete the engine folder too: true unless --clients named only some clients. */
  removeEngine: boolean;
  uninstallMod?: (home: string) => { ok: boolean; lines: string[]; error?: string };
}): UninstallReport {
  const steps: Step[] = [];
  for (const c of clients) {
    if (c === 'claude-code') uninstallClaudeCode(ctx, steps, opts.uninstallMod);
    else if (c === 'claude-desktop') unregisterJson(ctx, steps, 'Claude Desktop', claudeDesktopConfig(ctx.home, ctx.env, ctx.platform));
    else if (c === 'cursor') unregisterJson(ctx, steps, 'Cursor', cursorConfig(ctx.home));
    else if (c === 'codex') uninstallCodex(ctx, steps);
  }
  // The engine folder goes too, unless --clients named only some clients: the others still run it.
  if (opts.removeEngine) {
    const root = ctx.engineDir ? path.resolve(ctx.engineDir) : engineRoot(ctx.home, ctx.env);
    if (existsSync(root)) {
      if (ctx.dryRun) step(steps, { client: 'Engine', status: 'would', what: `delete ${root}` });
      else {
        try {
          rmSync(root, { recursive: true, force: true, maxRetries: 3 });
          step(steps, { client: 'Engine', status: 'done', what: `deleted ${root}` });
        } catch (e) {
          step(steps, { client: 'Engine', status: 'failed', what: `could not delete ${root} (${(e as Error).message}); close the clients that run it and run uninstall again` });
        }
      }
    }
  }
  return { steps, brain: opts.brainDir };
}

function uninstallClaudeCode(ctx: InstallContext, steps: Step[], uninstallMod?: (home: string) => { ok: boolean; lines: string[]; error?: string }): void {
  const client = 'Claude Code';
  // Registration.
  const read = readJsonObject(claudeJson(ctx.home, ctx.env));
  const existing = read.ok ? read.value?.mcpServers?.[SERVER_NAME] : undefined;
  if (existing !== undefined) {
    if (!pointsAtCrbro(existing?.command ?? null, Array.isArray(existing?.args) ? existing.args : [])) {
      step(steps, { client, status: 'kept', what: `an MCP server named ${SERVER_NAME} runs ${specOf(existing)}, not CRBRO: left alone` });
    } else if (!ctx.claude) {
      step(steps, { client, status: 'warning', what: `the claude CLI is not on PATH. Run: claude mcp remove --scope user ${SERVER_NAME}` });
    } else if (ctx.dryRun) {
      step(steps, { client, status: 'would', what: `claude mcp remove --scope user ${SERVER_NAME}` });
    } else {
      const r = ctx.claude.run(['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
      step(steps, r.status === 0 ? { client, status: 'done', what: 'MCP server unregistered (user scope).' }
        : { client, status: 'failed', what: `claude mcp remove failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}` });
    }
  }
  // Hooks in settings.json.
  const dir = claudeDir(ctx.home, ctx.env);
  const file = path.join(dir, 'settings.json');
  if (existsSync(file)) {
    let removed = 0;
    const apply = (s: Record<string, any>) => {
      if (!isObject(s.hooks)) return false;
      removed = stripOurHooks(s.hooks, h => isInstallBootHook(h) || (typeof h?.command === 'string' && OUR_CLAUDE_HOOKS.test(h.command)));
      if (Object.keys(s.hooks).length === 0) delete s.hooks;
      const left = scanCrbroHooks(Object.values(isObject(s.hooks) ? s.hooks : {}).flat() as any[], ctx.home);
      if (left.mentions) steps.push({ client, status: 'warning', what: `${left.mentions} hook(s) you wrote yourself still mention CRBRO: left alone`, file });
      return removed > 0 && !ctx.dryRun;
    };
    const r = ctx.dryRun ? dry(file, apply) : updateJsonFile(file, apply);
    if (!r.ok) step(steps, { client, status: 'failed', what: r.error, file });
    else if (removed) step(steps, { client, status: ctx.dryRun ? 'would' : 'done', what: `${removed} CRBRO hook(s) removed from settings.json`, file, backup: r.changed ? r.backup : undefined });
  }
  removeHookFolder(ctx, steps, client, path.join(dir, 'crbro-hooks'));
  // The mod, through uninstall-mod's own logic.
  if (uninstallMod && existsSync(path.join(dir, 'crbro-mods'))) {
    if (ctx.dryRun) step(steps, { client, status: 'would', what: 'uninstall the mod (npx crbro-memory uninstall-mod)' });
    else {
      const m = uninstallMod(ctx.home);
      step(steps, m.ok ? { client, status: 'done', what: 'mod removed (uninstall-mod); CRBRO will not put it back on its own' }
        : { client, status: 'failed', what: `uninstall-mod: ${m.error}` });
    }
  }
}

function unregisterJson(ctx: InstallContext, steps: Step[], client: string, file: string): void {
  if (!existsSync(file)) return;
  let outcome: Step | null = null;
  const apply = (s: Record<string, any>) => {
    const e = isObject(s.mcpServers) ? s.mcpServers[SERVER_NAME] : undefined;
    if (e === undefined) return false;
    if (!pointsAtCrbro(e?.command ?? null, Array.isArray(e?.args) ? e.args : [])) {
      outcome = { client, status: 'kept', what: `${SERVER_NAME} runs ${specOf(e)}, not CRBRO: left alone`, file };
      return false;
    }
    delete s.mcpServers[SERVER_NAME];
    outcome = { client, status: ctx.dryRun ? 'would' : 'done', what: 'MCP server unregistered.', file };
    return !ctx.dryRun;
  };
  const r = ctx.dryRun ? dry(file, apply) : updateJsonFile(file, apply);
  if (!r.ok) { step(steps, { client, status: 'failed', what: r.error, file }); return; }
  if (outcome) step(steps, { ...(outcome as Step), backup: r.changed ? r.backup : undefined });
}

function uninstallCodex(ctx: InstallContext, steps: Step[]): void {
  const client = 'Codex';
  const dir = codexHome(ctx.home, ctx.env);
  const tomlFile = path.join(dir, 'config.toml');
  if (existsSync(tomlFile)) {
    const read = readText(tomlFile);
    const r = removeCodexServer((read.bom ? '\ufeff' : '') + read.text);
    if (r.refused) step(steps, { client, status: 'warning', what: `config.toml: ${r.refused}`, file: tomlFile });
    else if (r.notOurs) step(steps, { client, status: 'kept', what: `config.toml: ${SERVER_NAME} runs ${r.notOurs}, not CRBRO: left alone`, file: tomlFile });
    else if (r.changed) {
      if (ctx.dryRun) step(steps, { client, status: 'would', what: `config.toml: remove [mcp_servers.${SERVER_NAME}]`, file: tomlFile });
      else {
        try {
          const backup = writeGuarded(tomlFile, r.text, { expectHash: read.hash });
          step(steps, { client, status: 'done', what: `config.toml: [mcp_servers.${SERVER_NAME}] removed`, file: tomlFile, backup });
        } catch (e) {
          step(steps, { client, status: 'failed', what: `config.toml: ${(e as Error).message}`, file: tomlFile });
        }
      }
    }
  }
  const hooksFile = path.join(dir, 'hooks.json');
  if (existsSync(hooksFile)) {
    let removed = 0;
    const apply = (s: Record<string, any>) => {
      if (!isObject(s.hooks)) return false;
      removed = stripOurHooks(s.hooks, h => isInstallBootMcpCall(h) || isInstallBootHook(h)
        || (typeof h?.command === 'string' && (h.command.includes(CODEX_HOOK) || OUR_CLAUDE_HOOKS.test(h.command))));
      const left = scanCrbroHooks(Object.values(s.hooks).flat() as any[], ctx.home);
      if (left.mentions) steps.push({ client, status: 'warning', what: `${left.mentions} hook(s) you wrote yourself still mention CRBRO: left alone`, file: hooksFile });
      if (Object.keys(s.hooks).length === 0) delete s.hooks;
      return removed > 0 && !ctx.dryRun;
    };
    const r = ctx.dryRun ? dry(hooksFile, apply) : updateJsonFile(hooksFile, apply);
    if (!r.ok) step(steps, { client, status: 'failed', what: r.error, file: hooksFile });
    else if (removed) step(steps, { client, status: ctx.dryRun ? 'would' : 'done', what: `${removed} CRBRO hook(s) removed from hooks.json`, file: hooksFile, backup: r.changed ? r.backup : undefined });
  }
  removeHookFolder(ctx, steps, client, path.join(dir, 'crbro-hooks'));
}

// ─── Output ──────────────────────────────────────────────────────

const ICON: Record<StepStatus, string> = { done: '✅', would: '→ ', kept: '⚪', skipped: '⚪', warning: '⚠️ ', failed: '❌' };

export function formatSteps(steps: Step[]): string[] {
  const lines: string[] = [];
  for (const s of steps) {
    lines.push(`  ${ICON[s.status]} ${s.client}: ${s.what}`);
    if (s.file && s.status !== 'kept' && s.status !== 'skipped') lines.push(`     ${s.file}`);
    if (s.backup) lines.push(`     backup: ${s.backup}`);
  }
  return lines;
}

export function failed(steps: Step[]): boolean {
  return steps.some(s => s.status === 'failed');
}

/** For doctor: does a Codex registration carry both timeouts, and does its command exist? */
export function codexRegistration(home: string, env: NodeJS.ProcessEnv) {
  const file = path.join(codexHome(home, env), 'config.toml');
  try {
    const info = readCodexServer(readText(file).text);
    return { file, ...info };
  } catch {
    return null;
  }
}
