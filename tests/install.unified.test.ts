import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { runtimeDependencies } from '../src/engine/installer.js';

/**
 * `crbro-memory install` / `uninstall` against a throwaway machine: HOME,
 * CLAUDE_CONFIG_DIR, CODEX_HOME and APPDATA all point into one temp folder,
 * and a fake `claude` CLI on PATH records what it is asked and keeps its own
 * registry the way the real one does (in <CLAUDE_CONFIG_DIR>/.claude.json).
 * The real CLI runs from this checkout, so the engine copied is this build.
 */
const CLI = join(__dirname, '..', 'bin', 'crbro.mjs');
const VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
let T: string, home: string, claudeCfg: string, codex: string, appdata: string, bin: string, engine: string;

const FAKE = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\\n');
const store = join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, '.claude.json');
let data = {};
try { data = JSON.parse(readFileSync(store, 'utf8')); } catch {}
data.mcpServers = data.mcpServers || {};
if (args[0] === 'mcp' && args[1] === 'add-json') {
  const name = args[args.length - 2];
  data.mcpServers[name] = JSON.parse(args[args.length - 1]);
} else if (args[0] === 'mcp' && args[1] === 'remove') {
  delete data.mcpServers[args[args.length - 1]];
}
writeFileSync(store, JSON.stringify(data, null, 2));
`;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':';
  return {
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeCfg, CODEX_HOME: codex, APPDATA: appdata,
    XDG_CONFIG_HOME: join(home, '.config'), CRBRO_PATH: join(home, '.crbro'), CRBRO_MOD: '0', CRBRO_AUTOBACKUP: '0',
    FAKE_CLAUDE_LOG: join(T, 'claude.log'), PATH: `${bin}${sep}${process.env.PATH || process.env.Path || ''}`, ...extra,
  };
}
function cli(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: env(), timeout: 120_000 });
}
const read = (p: string) => readFileSync(p, 'utf8');
const json = (p: string) => JSON.parse(read(p));
const claudeCalls = () => (existsSync(join(T, 'claude.log')) ? read(join(T, 'claude.log')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const desktopFile = () => (process.platform === 'win32' ? join(appdata, 'Claude', 'claude_desktop_config.json')
  : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : join(home, '.config', 'Claude', 'claude_desktop_config.json'));

function snapshot(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...snapshot(p));
    else out.push(`${p}|${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
  }
  return out.sort();
}

const CODEX_TOML = [
  '# my Codex config',
  'model = "gpt"',
  '',
  '[mcp_servers.other]',
  'command = "other"',
  '',
  '[mcp_servers.crbro]',
  'command = "npx"',
  'args = ["-y", "crbro-memory"]',
  'startup_timeout_sec = 120.0',
  '',
  '[mcp_servers.crbro.env]',
  'NODE_OPTIONS = "--use-system-ca"',
  '',
  '[projects.\'c:\\work\']',
  'trust_level = "trusted"',
  '',
].join('\r\n');

beforeAll(() => {
  T = mkdtempSync(join(tmpdir(), 'crbro-install-'));
  home = join(T, 'home');
  claudeCfg = join(T, 'claude-cfg');
  codex = join(T, 'codex');
  appdata = join(T, 'appdata');
  bin = join(T, 'bin');
  engine = join(T, 'engine');
  for (const d of [home, claudeCfg, codex, appdata, bin, join(home, '.cursor'), path.dirname(desktopFile()), join(home, '.crbro')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, 'claude-fake.mjs'), FAKE);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "%~dp0claude-fake.mjs" %*\r\n`);
  } else {
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/claude-fake.mjs" "$@"\n`);
    chmodSync(join(bin, 'claude'), 0o755);
  }
  // What the machine had before: a brain, other servers, a CRBRO started through npx.
  writeFileSync(join(home, '.crbro', 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(desktopFile(), JSON.stringify({ mcpServers: {
    other: { command: 'other' },
    crbro: { command: 'npx', args: ['-y', 'crbro-memory'], env: { CRBRO_PATH: 'C:/brain' } },
  } }, null, 2));
  writeFileSync(join(codex, 'config.toml'), CODEX_TOML);
  writeFileSync(join(claudeCfg, 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2));
  writeFileSync(join(claudeCfg, '.claude.json'), JSON.stringify({ mcpServers: { crbro: { type: 'stdio', command: 'npx', args: ['-y', 'crbro-memory'], env: { NODE_OPTIONS: '--use-system-ca' } } } }));
});
afterAll(() => { rmSync(T, { recursive: true, force: true }); });

describe('crbro-memory install', () => {
  let out: ReturnType<typeof cli>;
  beforeAll(() => { out = cli('install', '--engine-dir', engine); }, 180_000);

  it('exits 0 and names every client it found', () => {
    expect(out.status, out.stderr + out.stdout).toBe(0);
    expect(out.stdout).toMatch(/clients: Claude Code, Claude Desktop, Codex, Cursor/);
  });

  it('copies the engine and its runtime dependencies to a stable folder, with a launcher that starts it', async () => {
    const dir = join(engine, VERSION);
    expect(json(join(engine, 'current.json')).dir).toBe(VERSION);
    expect(existsSync(join(dir, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(dir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'))).toBe(true);
    expect(existsSync(join(dir, 'node_modules', 'zod', 'package.json'))).toBe(true);
    expect(existsSync(join(dir, 'node_modules', 'vitest')), 'dev dependencies stay out').toBe(false);
    // The launcher answers initialize with no npx and nothing but the engine folder.
    const child = spawn(process.execPath, [join(engine, 'crbro.mjs')], { env: env(), stdio: ['pipe', 'pipe', 'ignore'] });
    const reply = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('no answer')), 30_000);
      child.stdout.on('data', d => { buf += d; if (buf.includes('\n')) { clearTimeout(timer); resolve(buf); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    }).finally(() => child.kill());
    expect(JSON.parse(reply.split('\n')[0]).result.serverInfo.version).toBe(VERSION);
  }, 60_000);

  it('Claude Code: re-registered through its CLI as node + launcher, keeping its env; settings.json never hand-edits .claude.json', () => {
    const calls = claudeCalls();
    expect(calls[0]).toEqual(['mcp', 'remove', '--scope', 'user', 'crbro']);
    expect(calls[1].slice(0, 5)).toEqual(['mcp', 'add-json', '--scope', 'user', 'crbro']);
    const spec = JSON.parse(calls[1][5]);
    expect(spec).toEqual({ type: 'stdio', command: process.execPath, args: [join(engine, 'crbro.mjs')], env: { NODE_OPTIONS: '--use-system-ca' } });
    expect(json(join(claudeCfg, 'settings.json')).hooks.SessionStart[0].hooks[0].command).toContain('crbro_boot');
    expect(json(join(claudeCfg, 'settings.json')).model).toBe('opus');
  });

  it('Claude Desktop and Cursor: registered as node + launcher; other servers and the old env kept; a backup beside the file', () => {
    const d = json(desktopFile()).mcpServers;
    expect(d.other).toEqual({ command: 'other' });
    expect(d.crbro).toEqual({ command: process.execPath, args: [join(engine, 'crbro.mjs')], env: { CRBRO_PATH: 'C:/brain' } });
    expect(readdirSync(path.dirname(desktopFile())).some(n => n.startsWith('claude_desktop_config.json.crbro-bak-'))).toBe(true);
    expect(json(join(home, '.cursor', 'mcp.json')).mcpServers.crbro.args).toEqual([join(engine, 'crbro.mjs')]);
  });

  it('Codex: the registration runs the engine, the user\'s startup timeout is kept, the missing one added, nothing else moved', () => {
    const toml = read(join(codex, 'config.toml'));
    expect(toml).toContain(`command = ${JSON.stringify(process.execPath)}`);
    expect(toml).toContain('startup_timeout_sec = 120.0');
    expect(toml).toContain('tool_timeout_sec = 120');
    expect(toml).toContain('NODE_OPTIONS = "--use-system-ca"');
    expect(toml).toContain('[mcp_servers.other]\r\ncommand = "other"');
    expect(toml).toContain("[projects.'c:\\work']\r\ntrust_level = \"trusted\"");
    expect(toml.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out.stdout).toContain('kept your startup_timeout_sec = 120');
    const hook = json(join(codex, 'hooks.json')).hooks.SessionStart[0].hooks[0].command;
    expect(hook).toContain('crbro-codex.mjs');
    expect(hook).toContain(`--engine "${engine.split('\\').join('/')}"`);
  });

  it('a second run changes nothing and copies nothing', () => {
    const before = [...snapshot(claudeCfg), ...snapshot(codex), ...snapshot(appdata), ...snapshot(join(home, '.cursor'))];
    const calls = claudeCalls().length;
    const again = cli('install', '--engine-dir', engine);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain(`CRBRO ${VERSION} already in`);
    expect([...snapshot(claudeCfg), ...snapshot(codex), ...snapshot(appdata), ...snapshot(join(home, '.cursor'))]).toEqual(before);
    expect(claudeCalls().length).toBe(calls);
  }, 120_000);
});

describe('crbro-memory uninstall', () => {
  it('--dry-run lists what it would remove and writes nothing', () => {
    const before = [...snapshot(T)].filter(l => !l.includes('claude.log'));
    const r = cli('uninstall', '--dry-run', '--engine-dir', engine);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/dry run/);
    expect(r.stdout).toMatch(/→ {2}Codex: config\.toml: remove \[mcp_servers\.crbro\]/);
    expect([...snapshot(T)].filter(l => !l.includes('claude.log'))).toEqual(before);
  });

  it('takes back what CRBRO added, keeps everything else and the brain, and says where the brain is', () => {
    const r = cli('uninstall', '--engine-dir', engine);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(claudeCalls().at(-1)).toEqual(['mcp', 'remove', '--scope', 'user', 'crbro']);
    expect(json(join(claudeCfg, 'settings.json'))).toEqual({ model: 'opus' });
    expect(json(desktopFile()).mcpServers).toEqual({ other: { command: 'other' } });
    expect(json(join(home, '.cursor', 'mcp.json')).mcpServers).toEqual({});
    const toml = read(join(codex, 'config.toml'));
    expect(toml).not.toContain('crbro');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml).toContain("[projects.'c:\\work']");
    expect(json(join(codex, 'hooks.json'))).toEqual({});
    expect(existsSync(join(codex, 'crbro-hooks'))).toBe(false);
    expect(existsSync(engine)).toBe(false);
    // The brain and the backups stay.
    expect(existsSync(join(home, '.crbro', 'manifest.json'))).toBe(true);
    expect(r.stdout).toContain(join(home, '.crbro'));
    expect(readdirSync(codex).some(n => n.startsWith('config.toml.crbro-bak-'))).toBe(true);
  });

  it('leaves alone a server named crbro that does not run CRBRO', () => {
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { crbro: { command: 'something-else' } } }));
    const r = cli('uninstall', '--clients', 'cursor');
    expect(r.status).toBe(0);
    expect(json(join(home, '.cursor', 'mcp.json')).mcpServers.crbro).toEqual({ command: 'something-else' });
    expect(r.stdout).toMatch(/not CRBRO: left alone/);
  });

  it('rejects an unknown client with exit code 2', () => {
    const r = cli('install', '--clients', 'vscode', '--dry-run');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown client/);
  });
});

describe('runtime dependencies', () => {
  it('are resolved where Node would find them next to an npx-style install, nesting kept, nothing downloaded', () => {
    const root = mkdtempSync(join(tmpdir(), 'crbro-deps-'));
    try {
      const put = (rel: string, pj: Record<string, unknown>) => {
        mkdirSync(join(root, rel), { recursive: true });
        writeFileSync(join(root, rel, 'package.json'), JSON.stringify(pj));
      };
      put('node_modules/crbro-memory', { name: 'crbro-memory', dependencies: { a: '1', '@s/c': '1' }, optionalDependencies: { gone: '1' } });
      put('node_modules/a', { name: 'a', dependencies: { b: '2' } });
      put('node_modules/a/node_modules/b', { name: 'b' });
      put('node_modules/b', { name: 'b' });
      put('node_modules/@s/c', { name: '@s/c', dependencies: { b: '1' } });
      const r = runtimeDependencies(join(root, 'node_modules', 'crbro-memory'));
      expect(r.missing).toEqual([]);
      expect(r.deps.map(d => d.rel.split(path.sep).join('/')).sort()).toEqual(['@s/c', 'a', 'a/node_modules/b', 'b']);
      put('node_modules/crbro-memory', { name: 'crbro-memory', dependencies: { nowhere: '1' } });
      expect(runtimeDependencies(join(root, 'node_modules', 'crbro-memory')).missing).toEqual(['nowhere']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The default engine folder is ~/.crbro-engine: never the real one from the suite.
it('the engine folder of these tests is never the real home', () => {
  expect(engine.startsWith(T)).toBe(true);
  expect(statSync(T).isDirectory()).toBe(true);
});
