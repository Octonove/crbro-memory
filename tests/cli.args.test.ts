import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The command line never reports a false success: a typo is an error (exit 2)
 * instead of an MCP server waiting on stdin, `<command> --help` explains and
 * runs nothing, and a command that failed exits 1.
 */
const CLI = join(__dirname, '..', 'bin', 'crbro.mjs');
const VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
let home: string;
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', timeout: 20_000, input: '',
  env: { ...process.env, HOME: home, USERPROFILE: home, CRBRO_PATH: join(home, '.crbro'), CRBRO_MOD: '0',
    CRBRO_SEMANTIC_HOME: join(home, '.semantic'), CRBRO_AUTOBACKUP: '0' },
});

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'crbro-cli-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('crbro-memory command line', () => {
  it('--version and -v print the version', () => {
    for (const flag of ['--version', '-v']) {
      const r = run(flag);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(VERSION);
    }
  });

  it('an unknown command is rejected with exit 2 and a short help, and no server starts', () => {
    const r = run('instal-boot');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown command: instal-boot/);
    expect(r.stderr).toMatch(/install-boot/);
    expect(r.error, 'it returned instead of waiting on stdin').toBeUndefined();
  });

  it('an unknown option is rejected with exit 2, before anything runs', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const r = run('install-hooks', '--gaurd');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown option for install-hooks: --gaurd/);
    expect(readdirSync(join(home, '.claude'))).toEqual([]);
    expect(run('--bogus').status).toBe(2);
    expect(run('doctor', 'extra').status).toBe(2);
    expect(run('semantic', 'rebuild').status).toBe(2);
  });

  it('<command> --help prints that command and runs nothing — install-hooks --help used to install', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    for (const cmd of ['install-hooks', 'install-boot', 'install', 'uninstall', 'init']) {
      const r = run(cmd, '--help');
      expect(r.status, cmd).toBe(0);
      expect(r.stdout, cmd).toContain(`npx crbro-memory ${cmd}`);
    }
    expect(readdirSync(join(home, '.claude'))).toEqual([]);
    expect(existsSync(join(home, '.crbro')), 'init --help did not initialize').toBe(false);
    expect(existsSync(join(home, '.crbro-engine'))).toBe(false);
  });

  it('the help matches the code: doctor, install, uninstall listed; semantic recall installed by init, no CRBRO_SEMANTIC=1 needed', () => {
    const r = run('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('npx crbro-memory doctor');
    expect(r.stdout).toContain('npx crbro-memory install ');
    expect(r.stdout).toContain('npx crbro-memory uninstall ');
    expect(r.stdout).toMatch(/installed by init/);
    expect(r.stdout).not.toMatch(/opt-in, ~500 MB/);
    expect(r.stdout).not.toMatch(/needs CRBRO_SEMANTIC=1/);
    expect(r.stdout).not.toMatch(/\n\s+crbro (?!—)/);   // the binary is crbro-memory
    expect(run('help', 'guard').stdout).toContain('npx crbro-memory guard');
  });

  it('a command that fails exits 1', () => {
    expect(run('status').status, 'no brain yet').toBe(1);
    expect(run('eval').status, 'no query set').toBe(1);
    expect(run('uninstall-hooks').status, 'no option').toBe(2);
  });

  it('values are checked: a flag that needs one and has none is a usage error', () => {
    const r = run('usage', '--days');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--days needs a value/);
  });
});
