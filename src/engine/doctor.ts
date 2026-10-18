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

export type DoctorStatus = 'ok' | 'warning' | 'error' | 'unknown';
export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  brainDir?: string;
  cwd?: string;
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
    { client: 'Claude Code', file: path.join(home, '.claude.json') },
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
      status: 'unknown', registered: null, enabled: null, brain_paths: [], inherited_brain_path: false, client_autorun: 'unknown' };
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
      row.status = uncertain ? 'unknown' : 'ok';
    } catch { /* missing, unreadable or unsupported: unknown, no raw error */ }
    clients.push(row);
  }
  const paths = new Map<string, string>([[canonical(root), root]]);
  for (const client of clients) for (const file of client.brain_paths) paths.set(canonical(file), file);
  const distinct_brain_paths = [...paths.values()].sort();
  return { status: distinct_brain_paths.length > 1 ? 'warning' as const : clients.some(c => c.status === 'unknown') ? 'unknown' as const : 'ok' as const,
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
  return { status: index.status === 'warning' ? 'warning' as const : 'unknown' as const,
    mode, home: semanticHome, runtime_present, model_cache_present, index, operation: 'not_probed' as const };
}

async function inspectBackups(root: string, env: NodeJS.ProcessEnv, home: string) {
  const directory = resolveBackupDir(root, env, home);
  const files = await listBackups(directory);
  return { status: files.length ? 'ok' as const : 'unknown' as const, directory,
    latest: files[0] ? { path: files[0].path, created: files[0].created, size_bytes: files[0].size_bytes } : null,
    integrity: 'not_probed' as const };
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
  const [brain, versions, configs, semantic, backups, teams] = await Promise.all([
    inspectBrain(root), inspectVersions(root), inspectConfigs(home, env, root, options.cwd),
    inspectSemantic(root, home, env), inspectBackups(root, env, home), inspectTeams(root, env),
  ]);
  const statuses: DoctorStatus[] = [brain.status, configs.status, semantic.status, backups.status, teams.status];
  const status: DoctorStatus = statuses.includes('error') ? 'error' : statuses.includes('warning') ? 'warning'
    : statuses.includes('unknown') || versions.daemon_status === 'unknown' ? 'unknown' : 'ok';
  return { schema_version: 1 as const, read_only: true as const, status, versions, brain, configs, semantic, backups, teams };
}

export type DoctorReport = Awaited<ReturnType<typeof diagnose>>;

export function formatDoctor(report: DoctorReport): string {
  const show = (v: unknown) => v === null || v === undefined ? 'unknown' : String(v);
  return [
    `CRBRO doctor — read-only — ${report.status}`,
    `Installed: ${show(report.versions.installed)}`,
    `Running daemons: ${report.versions.daemons.map(d => show(d.running_version)).join(', ') || 'unknown'} (authenticated status only)`,
    `Brain: ${report.brain.path} [${report.brain.status}]`,
    `Last boot: ${show(report.brain.last_boot)} (aggregate); client autorun: unknown`,
    ...report.brain.invalid_json_paths.map(file => `Invalid JSON: ${file}`),
    ...report.brain.unreadable_paths.map(file => `Unreadable: ${file}`),
    ...report.configs.clients.map(c => `${c.client}: ${c.path} [${c.status}]; registered=${show(c.registered)}; enabled=${show(c.enabled)}; brain=${c.brain_paths.join(', ') || 'unknown (inherited)'}`),
    `Different configured brain paths: ${report.configs.different_brain_paths}`,
    `Semantic: ${report.semantic.mode}; runtime=${show(report.semantic.runtime_present)}; model cache=${show(report.semantic.model_cache_present)}; index=${report.semantic.index.status}; operation=not_probed`,
    `Latest backup: ${report.backups.latest?.path || 'unknown'}; integrity=not_probed`,
    ...report.teams.spaces.map(s => `Team: ${s.path}; dirty=${show(s.dirty)}; worktree=${s.worktree_state}; ahead=${show(s.ahead)}; behind=${show(s.behind)}; remote=not_fetched`),
    `Team remote state: not_fetched. Unknown values are not evidence of a working integration.`,
  ].join('\n');
}
