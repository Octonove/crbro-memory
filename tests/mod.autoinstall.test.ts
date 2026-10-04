import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, utimesSync,
} from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  autoInstallMod, installMod, uninstallMod, verifyMod, modPaths, modNoticeOnBoot, resetModOnBoot, takeModNotice,
  readModState, compareVersions, sha256, PLUGIN_DIRS_VAR,
} from '../src/engine/modinstall.js';

/**
 * The automatic install crbro_boot runs once per process: the open-items band
 * reaches whoever has CRBRO and Claude Code without install-mod, says so once,
 * keeps itself up to date and stays out once it has been told to. Always
 * against a throwaway home folder, never the real ~/.claude.
 */
const PKG = join(__dirname, '..', 'mods', 'crbro-pending');
const BUILT_MOD = join(__dirname, '..', 'dist', 'engine', 'modinstall.js');
const VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version as string;

let home: string;
let paths: ReturnType<typeof modPaths>;
const ON = { CRBRO_MOD: '1' } as NodeJS.ProcessEnv;
const win = { platform: 'win32' as const };
const auto = (extra: Record<string, unknown> = {}) => autoInstallMod({ packageDir: PKG, home, env: ON, ...win, ...extra });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crbro-automod-'));
  paths = modPaths(home);
  mkdirSync(paths.claudeDir, { recursive: true });
  resetModOnBoot();
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const settings = () => JSON.parse(readFileSync(paths.settingsPath, 'utf8'));
const writeSettings = (obj: unknown) => writeFileSync(paths.settingsPath, JSON.stringify(obj, null, 2));
const listed = () => String(settings().env?.[PLUGIN_DIRS_VAR] ?? '').split(';').filter(Boolean);

/** Every file under ~/.claude with its hash: proof that nothing was written. */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else out.push(`${p}|${st.mtimeMs}|${sha256(readFileSync(p))}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort().join('\n');
}

function pluginAt(dir: string, name: string): string {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  return dir;
}

describe('automatic install', () => {
  it('installs the first time, as install-mod would, and leaves one notice', async () => {
    writeSettings({ model: 'opus', env: { FOO: 'bar' }, hooks: { Stop: [] } });
    const r = await auto();
    expect(r.action).toBe('installed');
    expect(r.notice).toMatch(/installed its Claude Code mod "crbro-pending"/);
    expect(r.notice).toContain(`CRBRO ${VERSION}`);
    expect(r.notice).toMatch(/NEW Claude Code sessions/);
    expect(r.notice).toContain('npx crbro-memory uninstall-mod');
    expect(r.notice).toContain('CRBRO_MOD=0');
    expect(settings()).toEqual({ model: 'opus', env: { FOO: 'bar', [PLUGIN_DIRS_VAR]: paths.installedDir }, hooks: { Stop: [] } });
    expect(verifyMod({ packageDir: PKG, home, ...win }).ok).toBe(true);
    // No language is forced: auto, like install-mod without --lang.
    expect(settings().pluginConfigs).toBeUndefined();
    expect(readModState(home)).toMatchObject({ installed: true, version: VERSION });
    expect(existsSync(paths.lockPath)).toBe(false);
    // Said once: the notice is taken by one boot and is gone after.
    expect(takeModNotice(home)).toBe(r.notice);
    expect(takeModNotice(home)).toBeNull();
  });

  it('the second boot says nothing and writes nothing', async () => {
    await auto();
    takeModNotice(home);
    const before = snapshot(paths.claudeDir);
    const r = await auto();
    expect(r).toEqual({ action: 'current' });
    expect(snapshot(paths.claudeDir)).toBe(before);
    expect(takeModNotice(home)).toBeNull();
  });

  it('refreshes files that differ from the package, never settings.json, and says so once', async () => {
    writeSettings({ theme: 'dark' });
    await auto();
    takeModNotice(home);
    const settingsRaw = readFileSync(paths.settingsPath, 'utf8');
    const settingsMtime = statSync(paths.settingsPath).mtimeMs;
    // What an older version left: one file changed, one the package no longer has.
    writeFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), '// an older band\n');
    writeFileSync(join(paths.installedDir, 'hooks', 'old.ts'), '// gone\n');

    const r = await auto();
    expect(r.action).toBe('updated');
    expect(r.notice).toMatch(/updated its Claude Code mod "crbro-pending"/);
    expect(r.notice).toMatch(/settings\.json was not touched/);
    expect(verifyMod({ packageDir: PKG, home, ...win }).ok).toBe(true);
    expect(existsSync(join(paths.installedDir, 'hooks', 'old.ts'))).toBe(false);
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(settingsRaw);
    expect(statSync(paths.settingsPath).mtimeMs).toBe(settingsMtime);
    expect(takeModNotice(home)).toBe(r.notice);

    expect((await auto()).action).toBe('current');
    expect(takeModNotice(home)).toBeNull();
  });

  it('a copy left by a newer CRBRO is not taken back by an older one', async () => {
    await auto();
    takeModNotice(home);
    writeFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), '// from a newer release\n');
    writeFileSync(paths.statePath, JSON.stringify({ installed: true, version: '99.0.0' }));
    const r = await auto();
    expect(r).toEqual({ action: 'skipped', reason: 'newer-installed' });
    expect(readFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), 'utf8')).toBe('// from a newer release\n');
    expect(takeModNotice(home)).toBeNull();
    expect(compareVersions('2.8.0', '2.7.10')).toBe(1);
    expect(compareVersions('2.7.2', '2.7.2')).toBe(0);
  });

  it.each(['0', 'off', 'false', 'OFF', 'no'])('CRBRO_MOD=%s: nothing at all', async value => {
    writeSettings({ theme: 'dark' });
    const before = snapshot(paths.claudeDir);
    const r = await auto({ env: { CRBRO_MOD: value } });
    expect(r).toEqual({ action: 'skipped', reason: 'disabled' });
    expect(snapshot(paths.claudeDir)).toBe(before);
    expect(existsSync(paths.modsDir)).toBe(false);
  });

  it('respects the mark uninstall-mod leaves, and install-mod lifts it', async () => {
    await auto();
    takeModNotice(home);
    uninstallMod({ home, ...win });
    expect(readModState(home).optedOut).toBe(true);
    const before = snapshot(paths.claudeDir);
    expect(await auto()).toEqual({ action: 'skipped', reason: 'opted-out' });
    expect(snapshot(paths.claudeDir)).toBe(before);
    expect(existsSync(paths.installedDir)).toBe(false);
    expect(settings().env).toBeUndefined();

    installMod({ packageDir: PKG, home, ...win });
    expect(readModState(home).optedOut).toBeUndefined();
    expect(await auto()).toEqual({ action: 'current' });
  });

  it('uninstall-mod before any install still keeps it out', async () => {
    uninstallMod({ home, ...win });
    expect(await auto()).toEqual({ action: 'skipped', reason: 'opted-out' });
    expect(existsSync(paths.installedDir)).toBe(false);
  });

  it('a folder taken out of the list by hand counts as a no, and stays out', async () => {
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one' } });
    await auto();
    takeModNotice(home);
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one' } });
    expect(await auto()).toEqual({ action: 'skipped', reason: 'removed-by-hand' });
    expect(readModState(home)).toMatchObject({ optedOut: true, optedOutBy: 'unlisted' });
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe('C:\\plugins\\one');
    expect(await auto()).toEqual({ action: 'skipped', reason: 'opted-out' });
  });

  it('without ~/.claude it creates nothing', async () => {
    rmSync(paths.claudeDir, { recursive: true, force: true });
    expect(await auto()).toEqual({ action: 'skipped', reason: 'no-claude-code' });
    expect(existsSync(paths.claudeDir)).toBe(false);
    expect(await modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win })).toBeNull();
    expect(existsSync(paths.claudeDir)).toBe(false);
  });

  it('a package without the mod (the .mcpb bundle) is skipped', async () => {
    const r = await auto({ packageDir: join(home, 'nowhere') });
    expect(r).toEqual({ action: 'skipped', reason: 'not-in-package' });
    expect(existsSync(paths.modsDir)).toBe(false);
  });

  it('a settings.json that does not parse: untouched, nothing installed, not retried in a loop', async () => {
    writeFileSync(paths.settingsPath, '{ "env": { broken');
    const r = await auto();
    expect(r.action).toBe('failed');
    expect(r.reason).toMatch(/could not be parsed — not touching it/);
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe('{ "env": { broken');
    expect(existsSync(paths.installedDir)).toBe(false);
    expect(readModState(home).failed?.error).toMatch(/could not be parsed/);
    expect(existsSync(paths.lockPath)).toBe(false);

    // The same cause is not tried again at every start...
    expect(await auto()).toEqual({ action: 'skipped', reason: 'failed-before' });
    // ...but a day later it is, and still touches nothing.
    expect((await auto({ now: () => Date.now() + 25 * 3600 * 1000 })).action).toBe('failed');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe('{ "env": { broken');
    // The boot never sees an error.
    rmSync(paths.statePath);
    await expect(modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win })).resolves.toBeNull();

    // Once settings.json is fixed, the next start installs.
    writeSettings({ theme: 'dark' });
    const fixed = await auto();
    expect(fixed.action).toBe('installed');
    expect(readModState(home).failed).toBeUndefined();
  });

  it('an env block that is not an object is refused like install-mod refuses it', async () => {
    writeSettings({ env: 'nope' });
    const r = await auto();
    expect(r.action).toBe('failed');
    expect(settings()).toEqual({ env: 'nope' });
  });

  it('replaces an earlier crbro-pendientes copy in the list, as install-mod does, and says so', async () => {
    const legacy = pluginAt(join(paths.claudeDir, 'mods', 'crbro-pendientes'), 'crbro-pendientes');
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: [legacy, 'C:\\plugins\\two'].join(';') } });
    const r = await auto();
    expect(r.action).toBe('installed');
    expect(listed()).toEqual([paths.installedDir, 'C:\\plugins\\two']);
    expect(existsSync(join(legacy, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(r.notice).toContain(`earlier copy "crbro-pendientes" (${legacy})`);
    // Named once, not again as "another copy".
    expect(r.notice).not.toContain(`Another copy is in ${legacy}`);
    // uninstall-mod puts it back.
    uninstallMod({ home, ...win });
    expect(listed()).toEqual([legacy, 'C:\\plugins\\two']);
  });

  it('never adds a second band beside another crbro-pending already listed', async () => {
    const checkout = pluginAt(join(home, 'src', 'crbro-pending'), 'crbro-pending');
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: checkout } });
    const before = snapshot(paths.claudeDir);
    expect(await auto()).toEqual({ action: 'skipped', reason: 'another-copy' });
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe(checkout);
    expect(existsSync(paths.installedDir)).toBe(false);
    expect(snapshot(paths.claudeDir).split('\n').filter(l => l.includes('settings.json')))
      .toEqual(before.split('\n').filter(l => l.includes('settings.json')));
  });

  it('a fresh lock means another session is on it; a stale one is taken over', async () => {
    mkdirSync(paths.modsDir, { recursive: true });
    writeFileSync(paths.lockPath, '{}');
    expect(await auto()).toEqual({ action: 'skipped', reason: 'busy' });
    expect(existsSync(paths.settingsPath)).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(true);

    const old = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(paths.lockPath, old, old);
    expect((await auto()).action).toBe('installed');
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  it('two at once in one process: one installs, settings.json stays valid with the path once', async () => {
    writeSettings({ model: 'opus', env: { FOO: 'bar', [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one' } });
    const results = await Promise.all([auto(), auto(), auto()]);
    expect(results.filter(r => r.action === 'installed')).toHaveLength(1);
    for (const r of results) expect(['installed', 'busy', 'current']).toContain(r.action === 'skipped' ? r.reason : r.action);
    expect(settings()).toEqual({ model: 'opus', env: { FOO: 'bar', [PLUGIN_DIRS_VAR]: `C:\\plugins\\one;${paths.installedDir}` } });
    expect(takeModNotice(home)).toMatch(/installed/);
    expect(takeModNotice(home)).toBeNull();
  });

  it.skipIf(!existsSync(BUILT_MOD))('four processes at once: settings.json valid, every key kept, the path once', async () => {
    writeSettings({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, env: { FOO: 'bar' } });
    const script = `require(${JSON.stringify(BUILT_MOD)}).autoInstallMod({ packageDir: ${JSON.stringify(PKG)}, ` +
      `home: ${JSON.stringify(home)}, env: { CRBRO_MOD: '1' } }).then(r => process.stdout.write(JSON.stringify(r)))`;
    const one = () => new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', script], { env: { ...process.env, CLAUDE_CODE_PLUGIN_DIRS: '' } });
      let out = '';
      p.stdout.on('data', d => { out += d; });
      p.on('error', reject);
      p.on('close', () => resolve(out));
    });
    const outs = (await Promise.all([one(), one(), one(), one()])).map(o => JSON.parse(o));
    expect(outs.filter(o => o.action === 'installed')).toHaveLength(1);
    for (const o of outs) expect(['installed', 'current', 'skipped']).toContain(o.action);
    for (const o of outs.filter(x => x.action === 'skipped')) expect(o.reason).toBe('busy');
    const s = settings();
    expect(s.model).toBe('opus');
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(s.env.FOO).toBe('bar');
    const sep = process.platform === 'win32' ? ';' : ':';
    expect(s.env[PLUGIN_DIRS_VAR].split(sep).filter((d: string) => d === paths.installedDir)).toHaveLength(1);
    expect(verifyMod({ packageDir: PKG, home }).ok).toBe(true);
    expect(readdirSync(paths.modsDir).filter(n => n.endsWith('.tmp') || n === 'auto.lock')).toEqual([]);
  }, 30_000);
});

describe('modNoticeOnBoot', () => {
  it('runs once per process and hands the notice over once, whether or not it made the budget', async () => {
    const first = await modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win, budgetMs: 0 });
    const second = await modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win, budgetMs: 10_000 });
    const said = [first, second].filter(Boolean);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/installed its Claude Code mod/);
    // Once per process: a changed file is not looked at again until the next process.
    writeFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), '// changed\n');
    expect(await modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win })).toBeNull();
    resetModOnBoot();
    expect(await modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win })).toMatch(/updated its Claude Code mod/);
  });

  it('CRBRO_MOD=0 hands nothing over, not even a notice left before', async () => {
    await auto();
    expect(await modNoticeOnBoot({ home, packageDir: PKG, env: { CRBRO_MOD: '0' }, ...win })).toBeNull();
    expect(existsSync(paths.noticePath)).toBe(true);
  });
});

describe('crbro_boot', () => {
  let root: string;
  let bootHome: string;
  let client: Client;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CRBRO_MOD: process.env.CRBRO_MOD, CRBRO_PATH: process.env.CRBRO_PATH };
  const boot = async () => JSON.parse(((await client.callTool({ name: 'crbro_boot', arguments: {} })) as any).content[0].text);

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'crbro-automod-brain-'));
    bootHome = await fs.mkdtemp(join(tmpdir(), 'crbro-automod-home-'));
    await fs.mkdir(join(bootHome, '.claude'));
    await fs.writeFile(join(bootHome, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    process.env.CRBRO_PATH = root;
    process.env.HOME = bootHome;
    process.env.USERPROFILE = bootHome;
    process.env.CRBRO_MOD = '1';
    resetModOnBoot();
    const { createServer } = await import('../src/server.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer().connect(st);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(ct);
  });

  afterAll(async () => {
    await client.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(bootHome, { recursive: true, force: true });
  });

  it('carries mod_notice the boot it installs, and not the next', async () => {
    const first = await boot();
    expect(first.mod_notice).toMatch(/installed its Claude Code mod "crbro-pending"/);
    expect(first.mod_notice).toMatch(/uninstall-mod/);
    const s = JSON.parse(readFileSync(join(bootHome, '.claude', 'settings.json'), 'utf8'));
    expect(s.model).toBe('opus');
    expect(s.env[PLUGIN_DIRS_VAR]).toBe(modPaths(bootHome).installedDir);

    const second = await boot();
    expect(second.mod_notice).toBeUndefined();
    expect(second.memory_discipline).toBeTruthy();
  });

  it('a later process that finds old files updates them and says so once', async () => {
    writeFileSync(join(modPaths(bootHome).installedDir, 'hooks', 'register.tsx'), '// older\n');
    resetModOnBoot();
    expect((await boot()).mod_notice).toMatch(/updated its Claude Code mod/);
    expect((await boot()).mod_notice).toBeUndefined();
  });
});
