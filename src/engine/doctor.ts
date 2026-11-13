// Diagnóstico observacional: no construye motores, no arranca servidores y no
// abre el llavero. Las salidas se construyen por lista blanca, nunca volcados.
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { resolveBrainDir } from './brain.js';
import { listBackups, resolveBackupDir } from './backup.js';
import { listStates, endpointFor } from '../daemon/endpoint.js';
import { controlDaemon } from '../daemon/proxy.js';
import { readPackageVersion } from '../version.js';
import { verifyHooks } from './hookverify.js';
import { refreshHooks, packageHooksDir } from './hookrefresh.js';
import { claudeDir, claudeJson, codexHome, findOnPath } from './installio.js';

export type DoctorStatus = 'ok' | 'warning' | 'error' | 'unknown';
export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  brainDir?: string;
  cwd?: string;
  /** Tests only: the clock ages are measured against. */
  now?: number;
}

type Parsed = { status: 'ok' | 'missing' | 'invalid' | 'unreadable'; value?: any };
async function readParsed(file: string): Promise<Parsed> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { return { status: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  try { return { status: 'ok', value: JSON.parse(text) }; }
  catch { return { status: 'invalid' }; } // No error.message: it may quote a credential.
}

async function exists(file: string): Promise<boolean | null> {
  try { await fs.stat(file); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? false : null; }
}

function stamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function version(value: unknown): string | null {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value) ? value : null;
}

function canonical(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function inspectBrain(root: string) {
  const invalid: string[] = [], unreadable: string[] = [];
  const manifestFile = path.join(root, 'manifest.json');
  const manifest = await readParsed(manifestFile);
  let checked = 0;
  const check = (file: string, result: Parsed) => {
    if (result.status === 'ok' || result.status === 'invalid') checked++;
    if (result.status === 'invalid') invalid.push(file);
    if (result.status === 'unreadable') unreadable.push(file);
  };
  check(manifestFile, manifest);
  if (manifest.status === 'ok' && (!manifest.value || typeof manifest.value !== 'object' || Array.isArray(manifest.value))) invalid.push(manifestFile);
  // Sólo JSON del cerebro; excluye llavero, .daemon, cuarentena y backups.
  for (const name of ['cortex', 'synapses', 'hippocampus', 'prefrontal']) {
    const dir = path.join(root, name);
    try {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const file = path.join(dir, entry.name);
        check(file, await readParsed(file));
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(dir); }
  }
  const status: DoctorStatus = invalid.length || unreadable.length ? 'error' : manifest.status === 'ok' ? 'ok' : 'unknown';
  return { status, path: root, exists: await exists(root), json_files_checked: checked,
    invalid_json_paths: invalid.sort(), unreadable_paths: unreadable.sort(),
    last_boot: stamp(manifest.value?.last_boot), last_boot_scope: 'aggregate' as const,
    client_autorun: 'unknown' as const };
}

async function inspectVersions(root: string) {
  const states = await listStates(root);
  const daemons = await Promise.all(states.map(async state => {
    const unknown = { status: 'unknown' as DoctorStatus, running_version: null as string | null,
      observed_via: null as 'authenticated_status' | null };
    // Sólo el socket/pipe local derivado por CRBRO; nunca un destino de red de
    // una configuración arbitraria. No se publica el estado ni su token.
    if (typeof state.build !== 'string' || state.endpoint !== endpointFor(root, state.build)
      || typeof state.brain !== 'string' || canonical(state.brain) !== canonical(root)) return unknown;
    try {
      const reply = await controlDaemon(root, 'status', state.build);
      if (reply?.crbro !== 'status' || reply.build !== state.build || typeof reply.brain !== 'string'
        || canonical(reply.brain) !== canonical(root) || !version(reply.version)) return unknown;
      return { status: 'ok' as DoctorStatus, running_version: version(reply.version), observed_via: 'authenticated_status' as const };
    } catch { return unknown; }
  }));
  return { installed: version(readPackageVersion()), daemon_status: daemons.some(d => d.status === 'ok') ? 'ok' as const : 'unknown' as const, daemons };
}

interface ClientConfig {
  client: string;
  path: string;
  exists: boolean | null;
  status: DoctorStatus;
  registered: boolean | null;
  enabled: boolean | null;
  brain_paths: string[];
  inherited_brain_path: boolean;
  client_autorun: 'unknown';
  /** The registration starts CRBRO through npx (a download check at every start, a cache that moves). */
  uses_npx: boolean | null;
  /** Its command is an existing file or is found on PATH. Never the command itself. */
  command_exists: boolean | null;
  /** The script it runs (an absolute .mjs/.js argument, e.g. the stable launcher) exists. */
  script_exists: boolean | null;
  /** Codex only: the timeouts in its [mcp_servers.crbro] table, seconds, or null when absent. */
  startup_timeout_sec: number | null;
  tool_timeout_sec: number | null;
}

function configuredPath(value: unknown, home: string): string | null {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]|\$\{|%\w+%|:\/\//.test(value)) return null;
  return path.resolve(resolveBrainDir({ HOME: home, CRBRO_PATH: value }, () => undefined));
}

// Lector conservador de las tablas MCP de Codex; no ejecuta TOML ni devuelve
// comandos, argumentos, cabeceras o valores del resto de variables.
function codexEntries(text: string): { entries: any[]; uncertain: boolean } {
  const entries = new Map<string, any>();
  let current: any = null, inEnv = false, serverTable = false, uncertain = false, multiline = '';
  for (const raw of text.split(/\r?\n/)) {
    if (multiline) { if (raw.includes(multiline)) multiline = ''; continue; }
    const multi = raw.match(/(?:^|=)\s*("""|''')/);
    if (multi) {
      if (current) uncertain = true;
      if (raw.indexOf(multi[1], raw.indexOf(multi[1]) + 3) < 0) multiline = multi[1];
      continue;
    }
    // Elimina comentarios respetando las comillas de las rutas.
    const line = (raw.match(/^(?:[^#"']|"(?:\\.|[^"\\])*"|'[^']*')*/)?.[0] ?? '').trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      serverTable = /^\[\s*mcp_servers\s*\]$/.test(line);
      const table = /^\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([\w-]+))(?:\.(env))?\s*\]$/.exec(line);
      const name = table ? table[1] || table[2] || table[3] : '';
      current = null;
      if (name.toLowerCase().includes('crbro')) {
        if (!entries.has(name)) entries.set(name, { env: {} });
        current = entries.get(name); inEnv = table![4] === 'env';
      } else if (line.includes('mcp_servers') && line.includes('crbro')) uncertain = true;
      continue;
    }
    if (!current) {
      if ((serverTable && /^['"]?[\w-]*crbro[\w-]*['"]?\s*=/.test(line)) || /^mcp_servers\s*=/.test(line)) uncertain = true;
      continue;
    }
    const pair = /^([\w.]+)\s*=\s*(.*)$/.exec(line);
    if (!pair) { uncertain = true; continue; }
    const [, key, value] = pair;
    if (!inEnv && key === 'enabled') {
      if (value === 'true' || value === 'false') current.enabled = value === 'true';
      else uncertain = true;
    }
    if ((!inEnv && key === 'env.CRBRO_PATH') || (inEnv && key === 'CRBRO_PATH')) {
      try {
        current.env.CRBRO_PATH = value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : JSON.parse(value);
      } catch { uncertain = true; }
    }
    if (!inEnv && key === 'env') uncertain = true; // tabla inline no interpretada
    // Sólo para comprobaciones booleanas (existe, usa npx) y los plazos: nunca se devuelven.
    if (!inEnv && key === 'command') {
      const m = /^"((?:\\.|[^"\\])*)"$|^'([^']*)'$/.exec(value);
      if (m) { try { current.command = m[2] ?? JSON.parse(`"${m[1]}"`); } catch { /* no interpretado */ } }
    }
    if (!inEnv && key === 'args' && value.startsWith('[') && value.endsWith(']')) {
      current.args = [...value.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)].map(x => {
        try { return x[2] ?? JSON.parse(`"${x[1]}"`); } catch { return ''; }
      });
    }
    if (!inEnv && (key === 'startup_timeout_sec' || key === 'tool_timeout_sec')) {
      if (/^\+?\d+(\.\d+)?$/.test(value)) current[key] = Number(value); else uncertain = true;
    }
  }
  return { entries: [...entries.values()], uncertain: uncertain || !!multiline };
}

async function inspectConfigs(home: string, env: NodeJS.ProcessEnv, root: string, cwd?: string) {
  const desktop = process.platform === 'win32'
    ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
  const locations = [
    { client: 'Claude Desktop', file: desktop },
    { client: 'Claude Code', file: claudeJson(home, env) },
    { client: 'Cursor', file: path.join(home, '.cursor', 'mcp.json') },
    { client: 'Codex', file: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml') },
  ];
  if (cwd) locations.push(
    { client: 'Claude Code (project)', file: path.join(cwd, '.mcp.json') },
    { client: 'Cursor (project)', file: path.join(cwd, '.cursor', 'mcp.json') },
    { client: 'Codex (project)', file: path.join(cwd, '.codex', 'config.toml') },
  );
  const clients: ClientConfig[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    if (seen.has(canonical(location.file))) continue;
    seen.add(canonical(location.file));
    const row: ClientConfig = { client: location.client, path: location.file, exists: await exists(location.file),
      status: 'unknown', registered: null, enabled: null, brain_paths: [], inherited_brain_path: false, client_autorun: 'unknown',
      uses_npx: null, command_exists: null, script_exists: null, startup_timeout_sec: null, tool_timeout_sec: null };
    let problem = false;
    let entries: any[] = [], uncertain = false;
    try {
      if (location.file.endsWith('.toml')) {
        ({ entries, uncertain } = codexEntries(await fs.readFile(location.file, 'utf8')));
      } else {
        const parsed = await readParsed(location.file);
        if (parsed.status !== 'ok' || !parsed.value || typeof parsed.value !== 'object') { clients.push(row); continue; }
        const servers = parsed.value.mcpServers;
        if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) uncertain = true;
        else entries = Object.entries(servers || {})
          .filter(([name]) => name.toLowerCase().includes('crbro')).map(([, server]) => server);
      }
      const malformed = entries.some(e => !e || typeof e !== 'object' || Array.isArray(e)
        || (e.enabled !== undefined && typeof e.enabled !== 'boolean')
        || (e.disabled !== undefined && typeof e.disabled !== 'boolean')
        || (e.env !== undefined && (!e.env || typeof e.env !== 'object' || Array.isArray(e.env))));
      uncertain ||= malformed;
      row.registered = entries.length ? true : uncertain ? null : false;
      row.enabled = entries.length && !malformed ? entries.some(e => e.enabled !== false && e.disabled !== true) : null;
      for (const entry of entries) {
        const raw = entry?.env?.CRBRO_PATH;
        if (raw === undefined) row.inherited_brain_path = true;
        else {
          const resolved = configuredPath(raw, home);
          if (resolved) row.brain_paths.push(resolved); else uncertain = true;
        }
      }
      // What starts it: booleans only, never the command line (it can carry a token).
      const first = entries.find(e => e && typeof e === 'object' && !Array.isArray(e));
      if (first && typeof first.command === 'string') {
        const command: string = first.command;
        const args: string[] = Array.isArray(first.args) ? first.args.filter((a: unknown) => typeof a === 'string') : [];
        row.uses_npx = /(^|[\\/])npx(\.cmd|\.exe)?$/i.test(command);
        row.command_exists = path.isAbsolute(command) ? !!(await exists(command)) : findOnPath(command, env) !== null;
        const script = args.find(a => path.isAbsolute(a) && /\.(mjs|cjs|js)$/i.test(a));
        row.script_exists = script ? !!(await exists(script)) : null;
        if (row.command_exists === false || row.script_exists === false) problem = true;
      }
      if (location.file.endsWith('.toml') && first) {
        row.startup_timeout_sec = typeof first.startup_timeout_sec === 'number' ? first.startup_timeout_sec : null;
        row.tool_timeout_sec = typeof first.tool_timeout_sec === 'number' ? first.tool_timeout_sec : null;
        if (row.startup_timeout_sec === null || row.tool_timeout_sec === null) problem = true;
      }
      row.status = uncertain ? 'unknown' : problem ? 'warning' : 'ok';
    } catch { /* missing, unreadable or unsupported: unknown, no raw error */ }
    clients.push(row);
  }
  const paths = new Map<string, string>([[canonical(root), root]]);
  for (const client of clients) for (const file of client.brain_paths) paths.set(canonical(file), file);
  const distinct_brain_paths = [...paths.values()].sort();
  return { status: distinct_brain_paths.length > 1 || clients.some(c => c.status === 'warning') ? 'warning' as const
    : clients.some(c => c.status === 'unknown') ? 'unknown' as const : 'ok' as const,
    clients, distinct_brain_paths, different_brain_paths: distinct_brain_paths.length > 1,
    inherited_environment: 'unknown' as const };
}

async function inspectSemantic(root: string, home: string, env: NodeJS.ProcessEnv) {
  const setting = (env.CRBRO_SEMANTIC || '').toLowerCase();
  const mode = ['0', 'off', 'false'].includes(setting) ? 'disabled' : ['1', 'on', 'true'].includes(setting) ? 'forced' : 'auto';
  const semanticHome = path.resolve(env.CRBRO_SEMANTIC_HOME || path.join(home, '.crbro', '.semantic'));
  const model = env.CRBRO_SEMANTIC_MODEL || 'Xenova/multilingual-e5-small';
  let runtime_present: boolean | null = null;
  try { createRequire(path.join(semanticHome, 'package.json')).resolve('@huggingface/transformers'); runtime_present = true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') runtime_present = false; }
  const model_cache_present = /^[\w.-]+\/[\w.-]+$/.test(model) && !model.split('/').includes('..')
    ? await exists(path.join(semanticHome, 'models', ...model.split('/'))) : null;
  const meta = await readParsed(path.join(root, '.search', 'vectors.meta.json'));
  let bytes: number | null = null;
  try { bytes = (await fs.stat(path.join(root, '.search', 'vectors.f32'))).size; } catch { /* unobserved */ }
  const m = meta.value;
  const valid = meta.status === 'ok' && Number.isSafeInteger(m?.dim) && m.dim > 0 && Array.isArray(m.ids)
    && m.ids.every((id: unknown) => typeof id === 'string') && m.model === model
    && m.dtype === (env.CRBRO_SEMANTIC_DTYPE || 'q8') && bytes === m.ids.length * m.dim * 4;
  const index = { status: valid ? 'ok' as const : meta.status === 'missing' && bytes === null ? 'unknown' as const : 'warning' as const,
    vectors: valid ? m.ids.length as number : null, metadata_present: meta.status !== 'missing', data_present: bytes !== null };
  // A valid index is evidence it works; no index is no evidence (semantic recall not installed), not a fault.
  return { status: index.status,
    mode, home: semanticHome, runtime_present, model_cache_present, index, operation: 'not_probed' as const };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Newest backup older than this: a warning; older than BACKUP_FAIL_DAYS: an error. */
export const BACKUP_WARN_DAYS = 2;
export const BACKUP_FAIL_DAYS = 7;

async function inspectBackups(root: string, env: NodeJS.ProcessEnv, home: string, now: number) {
  const directory = resolveBackupDir(root, env, home);
  const files = await listBackups(directory);
  const latest = files[0] ? { path: files[0].path, created: files[0].created, size_bytes: files[0].size_bytes } : null;
  const age_days = latest ? Math.max(0, Math.floor((now - Date.parse(latest.created)) / DAY_MS)) : null;
  const brainThere = await exists(path.join(root, 'manifest.json'));
  // Automatic copies come from consolidate once a day. A consolidate newer than
  // the newest copy by more than a day, with them switched on, means they fail.
  const enabled = !['0', 'off', 'false', 'no'].includes(String(env.CRBRO_AUTOBACKUP ?? '').trim().toLowerCase());
  const manifest = await readParsed(path.join(root, 'manifest.json'));
  const lastConsolidation = stamp(manifest.value?.last_consolidation);
  const failing = !enabled || !lastConsolidation ? null
    : (latest === null || Date.parse(lastConsolidation) - Date.parse(latest.created) > DAY_MS) && now - Date.parse(lastConsolidation) < BACKUP_FAIL_DAYS * DAY_MS;
  const status: DoctorStatus = !brainThere ? 'unknown'
    : age_days === null ? 'warning'
      : age_days > BACKUP_FAIL_DAYS ? 'error'
        : age_days > BACKUP_WARN_DAYS || failing ? 'warning' : 'ok';
  return { status, directory, latest, age_days, warn_after_days: BACKUP_WARN_DAYS, fail_after_days: BACKUP_FAIL_DAYS,
    automatic: { enabled, last_consolidation: lastConsolidation, failing },
    integrity: 'not_probed' as const };
}

/** A pid that exists right now (signal 0 checks, it sends nothing). */
function pidAlive(pid: unknown): boolean | null {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null;
  try { process.kill(pid as number, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function inspectHooks(home: string, env: NodeJS.ProcessEnv) {
  const pkg = packageHooksDir();
  // dryRun: compares and reports, writes nothing.
  const copies = refreshHooks({ home, env, pkgHooks: pkg, dryRun: true });
  const dirs = [
    { client: 'claude-code' as const, dir: claudeDir(home, env), settings: 'settings.json' },
    { client: 'codex' as const, dir: codexHome(home, env), settings: 'hooks.json' },
  ];
  const missing_scripts: string[] = [];
  let settings_unreadable = false;
  let npx_cache_references = 0;
  for (const d of dirs) {
    const settingsPath = path.join(d.dir, d.settings);
    if (!(await exists(settingsPath))) continue;
    const v = verifyHooks({ packageDir: pkg, installedDir: path.join(d.dir, 'crbro-hooks'), settingsPath });
    missing_scripts.push(...v.missing_scripts);
    settings_unreadable ||= v.settings_unreadable;
    const parsed = await readParsed(settingsPath);
    for (const list of Object.values(parsed.value?.hooks ?? {})) {
      for (const entry of Array.isArray(list) ? list : []) {
        for (const h of Array.isArray((entry as any)?.hooks) ? (entry as any).hooks : []) {
          const cmd = `${h?.command ?? ''} ${h?.commandWindows ?? ''}`;
          if (/crbro/i.test(cmd) && /[\\/]_npx[\\/]/.test(cmd)) npx_cache_references++;
        }
      }
    }
  }
  const installed = copies.map(c => ({ client: c.client, file: path.join(c.dir, c.name),
    state: c.state === 'stale' ? 'older_release' as const : c.state }));
  const status: DoctorStatus = missing_scripts.length || settings_unreadable || npx_cache_references
    || installed.some(c => c.state === 'older_release' || c.state === 'modified') ? 'warning' : 'ok';
  return { status, installed, missing_scripts: [...new Set(missing_scripts)].sort(), settings_unreadable, npx_cache_references };
}

async function inspectDaemonLeftovers(root: string, now: number) {
  const dir = path.join(root, '.daemon');
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return { status: 'ok' as DoctorStatus, directory: dir, descriptors: 0, dead_descriptors: 0, orphan_tmp: 0 }; }
  let descriptors = 0, dead = 0, orphan = 0;
  for (const n of names) {
    const file = path.join(dir, n);
    if (/\.json$/.test(n)) {
      descriptors++;
      const st = await readParsed(file);
      if (st.status === 'ok' && pidAlive(st.value?.pid) === false) dead++;
    } else if (/\.tmp$/.test(n)) {
      // A write that never finished: its writer is gone, or it is older than an hour.
      const pid = Number(/\.(\d+)\.tmp$/.exec(n)?.[1]);
      let old = false;
      try { old = now - (await fs.stat(file)).mtimeMs > 60 * 60 * 1000; } catch { continue; }
      if (old || pidAlive(pid) === false) orphan++;
    }
  }
  return { status: (dead || orphan ? 'warning' : 'ok') as DoctorStatus, directory: dir, descriptors, dead_descriptors: dead, orphan_tmp: orphan };
}

async function inspectQuarantine(root: string, env: NodeJS.ProcessEnv, now: number) {
  const dir = path.join(root, '.quarantine');
  const days = Number(env.CRBRO_QUARANTINE_DAYS ?? 180);
  const retention_days = Number.isFinite(days) && days >= 0 ? days : 180;
  let files = 0, bytes = 0, oldest: number | null = null;
  const walk = async (d: string) => {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      try {
        const st = await fs.stat(p);
        files++; bytes += st.size;
        oldest = oldest === null ? st.mtimeMs : Math.min(oldest, st.mtimeMs);
      } catch { /* gone */ }
    }
  };
  await walk(dir);
  const oldest_days = oldest === null ? null : Math.floor((now - oldest) / DAY_MS);
  const status: DoctorStatus = (retention_days > 0 && oldest_days !== null && oldest_days > retention_days) || bytes > 500 * 1024 * 1024 ? 'warning' : 'ok';
  return { status, directory: dir, files, bytes, oldest_days, retention_days };
}

async function inspectTriggers(root: string, home: string, env: NodeJS.ProcessEnv) {
  const file = path.join(root, '.search', 'triggers.json');
  const parsed = await readParsed(file);
  const settings = await readParsed(path.join(claudeDir(home, env), 'settings.json'));
  const guard_wired = /crbro-guard/.test(JSON.stringify(settings.value?.hooks ?? {}));
  const v = parsed.value;
  const valid = parsed.status === 'ok' && v && typeof v === 'object' && v.keys && typeof v.keys === 'object' && Array.isArray(v.entries);
  const version = valid && Number.isSafeInteger(v.v) ? v.v as number : null;
  const status: DoctorStatus = parsed.status === 'invalid' || parsed.status === 'unreadable' ? 'warning'
    : parsed.status === 'missing' ? (guard_wired ? 'warning' : 'ok')
      : !valid || ![2, 3].includes(version ?? -1) ? 'warning' : 'ok';
  return { status, path: file, exists: parsed.status !== 'missing', version, built: valid ? stamp(v.built) : null,
    entries: valid ? v.entries.length as number : null, guard_wired };
}

function gitRead(dir: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', dir, ...args], {
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true,
    }, (err, stdout) => resolve(err ? null : stdout)); // stderr may contain a remote credential.
  });
}

async function inspectTeams(root: string, env: NodeJS.ProcessEnv) {
  const shared = path.join(root, 'shared');
  const spaces: Array<{ path: string; status: DoctorStatus; dirty: boolean | null; worktree_state: 'not_probed'; ahead: number | null;
    behind: number | null; last_commit_at: string | null; remote_state: 'not_fetched' }> = [];
  let entries;
  try { entries = await fs.readdir(shared, { withFileTypes: true }); }
  catch { return { status: 'unknown' as const, spaces, remote_state: 'not_fetched' as const }; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(shared, entry.name);
    const row = { path: dir, status: 'unknown' as DoctorStatus, dirty: null as boolean | null, worktree_state: 'not_probed' as const,
      ahead: null as number | null, behind: null as number | null, last_commit_at: null as string | null, remote_state: 'not_fetched' as const };
    // Never accidentally report the enclosing project repository.
    if (await exists(path.join(dir, '.git'))) {
      // No inspeccionar contenido del worktree: incluso git status puede
      // ejecutar filtros clean/process configurados por el repositorio.
      // Sólo leer historia; dirty queda desconocido, no limpio por omisión.
      const [ahead, behind, log] = await Promise.all([
        gitRead(dir, ['rev-list', '--count', '@{upstream}..HEAD'], env),
        gitRead(dir, ['rev-list', '--count', 'HEAD..@{upstream}'], env),
        gitRead(dir, ['log', '-1', '--no-patch', '--no-show-signature', '--no-ext-diff', '--no-textconv', '--format=%cI'], env),
      ]);
      const count = (s: string | null) => s !== null && /^\d+\s*$/.test(s) ? Number(s.trim()) : null;
      row.ahead = count(ahead); row.behind = count(behind); row.last_commit_at = stamp(log?.trim());
      row.status = row.ahead === null || row.behind === null ? 'unknown'
        : row.ahead || row.behind ? 'warning' : 'unknown';
    }
    spaces.push(row);
  }
  return { status: spaces.some(s => s.status === 'warning') ? 'warning' as const : spaces.some(s => s.status === 'unknown') ? 'unknown' as const : 'ok' as const,
    spaces, remote_state: 'not_fetched' as const };
}

/** Reads local evidence only. Supplying env replaces, rather than merges, the process environment. */
export async function diagnose(options: DoctorOptions = {}) {
  const env = options.env ?? process.env;
  const home = path.resolve(options.homeDir || env.HOME || env.USERPROFILE || os.homedir());
  const root = path.resolve(options.brainDir || resolveBrainDir({ ...env, HOME: home }, () => undefined));
  const now = options.now ?? Date.now();
  const [brain, versions, configs, semantic, backups, teams, hooks, daemon_leftovers, quarantine, triggers] = await Promise.all([
    inspectBrain(root), inspectVersions(root), inspectConfigs(home, env, root, options.cwd),
    inspectSemantic(root, home, env), inspectBackups(root, env, home, now), inspectTeams(root, env),
    inspectHooks(home, env), inspectDaemonLeftovers(root, now), inspectQuarantine(root, env, now), inspectTriggers(root, home, env),
  ]);
  // A problem anywhere decides; otherwise a brain that reads well is "ok".
  // What could not be observed (no daemon running, semantic not installed, a
  // client not installed) is listed as not checked, never as a fault.
  const statuses: DoctorStatus[] = [brain.status, configs.status, semantic.status, backups.status, teams.status,
    hooks.status, daemon_leftovers.status, quarantine.status, triggers.status];
  const status: DoctorStatus = statuses.includes('error') ? 'error' : statuses.includes('warning') ? 'warning'
    : brain.status === 'ok' ? 'ok' : 'unknown';
  return { schema_version: 1 as const, read_only: true as const, status, versions, brain, configs, semantic, backups, teams,
    hooks, daemon_leftovers, quarantine, triggers };
}

export type DoctorReport = Awaited<ReturnType<typeof diagnose>>;

interface Finding { level: 'problem' | 'warning' | 'unchecked'; text: string; action?: string }

/** What the report means, in three lists, each with the command that fixes it. */
export function findings(report: DoctorReport): Finding[] {
  const out: Finding[] = [];
  const add = (level: Finding['level'], text: string, action?: string) => out.push({ level, text, action });
  const b = report.brain;
  if (b.exists === false) add('unchecked', `no brain at ${b.path} yet`, 'npx crbro-memory init (or start any client: the first boot creates it)');
  for (const f of b.invalid_json_paths) add('problem', `invalid JSON: ${f}`, 'restore that file from a backup: npx crbro-memory backup list');
  for (const f of b.unreadable_paths) add('problem', `unreadable: ${f}`, 'check its permissions');
  const k = report.backups;
  if (k.status === 'error') add('problem', `the newest backup is ${k.age_days} days old (${k.latest?.path})`, 'npx crbro-memory backup');
  else if (k.status === 'warning' && k.latest === null) add('warning', 'no backup yet', 'npx crbro-memory backup');
  else if (k.status === 'warning') add('warning', `the newest backup is ${k.age_days} day(s) old`, 'npx crbro-memory backup');
  if (k.automatic.failing) add('warning', `automatic backups look like they fail: consolidate ran on ${k.automatic.last_consolidation}, the newest copy is older`, `check that ${k.directory} is writable, then npx crbro-memory backup`);
  for (const c of report.configs.clients) {
    if (!c.registered) continue;
    if (c.command_exists === false) add('warning', `${c.client}: the command its CRBRO registration runs does not exist (${c.path})`, 'npx crbro-memory install');
    if (c.script_exists === false) add('warning', `${c.client}: the script its CRBRO registration runs does not exist (${c.path})`, 'npx crbro-memory install');
    if (c.client.startsWith('Codex') && (c.startup_timeout_sec === null || c.tool_timeout_sec === null)) {
      add('warning', `${c.client}: [mcp_servers.crbro] has no ${c.startup_timeout_sec === null ? 'startup_timeout_sec' : 'tool_timeout_sec'}: a slow start loses the memory (${c.path})`, 'npx crbro-memory install-boot');
    }
    if (c.uses_npx) add('unchecked', `${c.client} starts CRBRO through npx (works; a stable engine starts faster and keeps one daemon)`, 'npx crbro-memory install');
  }
  if (report.configs.different_brain_paths) add('warning', `clients point at different brains: ${report.configs.distinct_brain_paths.join(', ')}`, 'set the same CRBRO_PATH in every client');
  const h = report.hooks;
  for (const c of h.installed) {
    if (c.state === 'older_release') add('warning', `hook from an older CRBRO: ${c.file}`, 'refreshed at the next crbro_boot, or now: npx crbro-memory install-hooks …');
    if (c.state === 'modified') add('warning', `hook edited by hand, not refreshed: ${c.file}`, 'keep it, or take this version (backup kept): run the install-hooks you used again');
  }
  for (const s of h.missing_scripts) add('warning', `a hook runs ${s}, which does not exist: it fails in every session`, 'npx crbro-memory install-boot, or remove that hook');
  if (h.npx_cache_references) add('warning', `${h.npx_cache_references} CRBRO hook(s) run out of the npx cache, which disappears when it is cleaned`, 'npx crbro-memory install');
  if (h.settings_unreadable) add('warning', 'a client settings file with hooks is not valid JSON', 'fix the JSON by hand');
  const d = report.daemon_leftovers;
  if (d.dead_descriptors) add('warning', `${d.dead_descriptors} daemon descriptor(s) of processes that are gone in ${d.directory}`, 'npx crbro-memory daemon status (removes them)');
  if (d.orphan_tmp) add('warning', `${d.orphan_tmp} unfinished temp file(s) in ${d.directory}`, 'safe to delete while no daemon starts');
  const q = report.quarantine;
  if (q.status === 'warning') add('warning', `quarantine holds ${q.files} file(s), ${(q.bytes / 1048576).toFixed(1)} MB, the oldest ${q.oldest_days} day(s) old`, `review ${q.directory}`);
  const t = report.triggers;
  if (t.status === 'warning') add('warning', t.exists ? `the guard's trigger index (${t.path}) is unreadable or an old format: the guard says nothing` : 'the guard is installed but its trigger index does not exist yet', 'npx crbro-memory guard --rebuild');
  if (report.semantic.index.status === 'warning') add('warning', 'the semantic vectors do not match their metadata', 'npx crbro-memory semantic build');
  for (const s of report.teams.spaces) if (s.status === 'warning') add('warning', `team space ${s.path} is ${s.ahead} ahead / ${s.behind} behind`, 'crbro_boot syncs it');
  if (report.versions.daemon_status !== 'ok') add('unchecked', 'no daemon answered (normal when daemon mode is off or no client is open)');
  if (report.semantic.index.status === 'unknown') add('unchecked', 'semantic recall: no vectors yet (not installed, or never built)', 'npx crbro-memory semantic status');
  add('unchecked', 'semantic operation and backup integrity: not_probed (doctor never loads the model or unpacks a backup)');
  add('unchecked', 'whether each client runs crbro_boot on its own: unknown (doctor reads files, it does not start clients)');
  return out;
}

export function formatDoctor(report: DoctorReport): string {
  const show = (v: unknown) => v === null || v === undefined ? 'unknown' : String(v);
  const list = findings(report);
  const block = (title: string, level: Finding['level']) => {
    const items = list.filter(f => f.level === level);
    if (!items.length) return [];
    return [title, ...items.map(f => `  • ${f.text}${f.action ? `\n      → ${f.action}` : ''}`), ''];
  };
  const verdict = report.status === 'ok' ? 'Everything observed is in order.'
    : report.status === 'error' ? 'There are problems to fix (below).'
      : report.status === 'warning' ? 'Working, with warnings (below).' : 'Not enough evidence to say (below).';
  return [
    `CRBRO doctor — read-only — ${report.status}`,
    verdict,
    '',
    ...block('Problems:', 'problem'),
    ...block('Warnings:', 'warning'),
    ...block('Not checked:', 'unchecked'),
    'Details:',
    `Installed: ${show(report.versions.installed)}`,
    `Running daemons: ${report.versions.daemons.map(d => show(d.running_version)).join(', ') || 'unknown'} (authenticated status only)`,
    `Brain: ${report.brain.path} [${report.brain.status}]`,
    `Last boot: ${show(report.brain.last_boot)} (aggregate); client autorun: unknown`,
    ...report.brain.invalid_json_paths.map(file => `Invalid JSON: ${file}`),
    ...report.brain.unreadable_paths.map(file => `Unreadable: ${file}`),
    ...report.configs.clients.map(c => `${c.client}: ${c.path} [${c.status}]; registered=${show(c.registered)}; enabled=${show(c.enabled)}; brain=${c.brain_paths.join(', ') || 'unknown (inherited)'}`),
    `Different configured brain paths: ${report.configs.different_brain_paths}`,
    `Semantic: ${report.semantic.mode}; runtime=${show(report.semantic.runtime_present)}; model cache=${show(report.semantic.model_cache_present)}; index=${report.semantic.index.status}; operation=not_probed`,
    `Latest backup: ${report.backups.latest?.path || 'unknown'}${report.backups.age_days !== null ? ` (${report.backups.age_days} day(s) old)` : ''}; integrity=not_probed`,
    `Hooks: ${report.hooks.installed.map(h => `${path.basename(h.file)} (${h.client}) ${h.state}`).join(', ') || 'none installed'} [${report.hooks.status}]`,
    `Daemon leftovers: ${report.daemon_leftovers.dead_descriptors} dead descriptor(s), ${report.daemon_leftovers.orphan_tmp} orphan temp file(s) [${report.daemon_leftovers.status}]`,
    `Quarantine: ${report.quarantine.files} file(s), ${report.quarantine.bytes} bytes, oldest ${show(report.quarantine.oldest_days)} day(s) [${report.quarantine.status}]`,
    `Trigger index: ${report.triggers.exists ? `v${show(report.triggers.version)}, ${show(report.triggers.entries)} lessons, built ${show(report.triggers.built)}` : 'none'}${report.triggers.guard_wired ? ' (guard wired)' : ''} [${report.triggers.status}]`,
    ...report.teams.spaces.map(s => `Team: ${s.path}; dirty=${show(s.dirty)}; worktree=${s.worktree_state}; ahead=${show(s.ahead)}; behind=${show(s.behind)}; remote=not_fetched`),
    `Team remote state: not_fetched. Unknown values are not evidence of a working integration.`,
  ].join('\n');
}
