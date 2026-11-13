import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * install-boot is the step that decides whether the memory works at all:
 * registering the MCP server does not call it, so without this the brain sits
 * on disk and the assistant answers from nothing.
 *
 * These run the real CLI against a throwaway home, because the failure modes
 * are all about other people's files — overwriting a config, duplicating a
 * hook that was already there, or writing one that does not survive a reread.
 */
const CLI = join(__dirname, '..', 'bin', 'crbro.mjs');
let home: string;

function env(extra: Record<string, string> = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CRBRO_PATH: join(home, '.crbro'), CRBRO_MOD: '0', ...extra };
  delete e.CLAUDE_CONFIG_DIR;
  delete e.CODEX_HOME;
  delete e.CRBRO_ENGINE_DIR;
  return { ...e, ...extra };
}
function run(...extra: string[]): string {
  return execFileSync(process.execPath, [CLI, 'install-boot', ...extra], { encoding: 'utf8', env: env() });
}
const leer = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'crbro-boot-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('install-boot', () => {
  it('wires Claude Code without touching the rest of settings.json', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const p = join(home, '.claude', 'settings.json');
    writeFileSync(p, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [] }] } }));

    run();

    const s = leer(p);
    expect(s.model, 'an unrelated setting was lost').toBe('opus');
    expect(s.hooks.Stop, 'an unrelated hook was lost').toHaveLength(1);
    const entry = s.hooks.SessionStart[0];
    expect(entry.matcher).toBe('startup|resume|clear|compact');
    expect(entry.hooks[0].command).toContain('crbro_boot');
  });

  it('keeps a timestamped backup of the file it changed', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const p = join(home, '.claude', 'settings.json');
    const before = JSON.stringify({ model: 'opus' });
    writeFileSync(p, before);

    const out = run();

    const backups = readdirSync(join(home, '.claude')).filter(n => n.startsWith('settings.json.crbro-bak-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, '.claude', backups[0]), 'utf8')).toBe(before);
    expect(out).toContain('backup:');
  });

  it('wires Codex: the server with its timeouts in config.toml and the packaged boot hook at a stable path', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });

    run();

    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.crbro]');
    expect(toml).toMatch(/startup_timeout_sec = 60/);
    expect(toml).toMatch(/tool_timeout_sec = 120/);
    const hooks = leer(join(home, '.codex', 'hooks.json')).hooks;
    const start = hooks.SessionStart[0];
    expect(start.matcher).toBe('startup|resume|clear|compact');
    expect(start.hooks.map((h: { type: string }) => h.type)).toEqual(['command']);
    expect(start.hooks[0].command).toContain('crbro-hooks/crbro-codex.mjs');
    expect(start.hooks[0].command, 'never an npx cache path').not.toMatch(/_npx/);
    expect(start.hooks[0].timeout).toBe(20);
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain('crbro-codex.mjs');
    expect(existsSync(join(home, '.codex', 'crbro-hooks', 'crbro-codex.mjs'))).toBe(true);
    expect(existsSync(join(home, '.codex', 'crbro-hooks', 'crbro-hooks.manifest.json'))).toBe(true);
  });

  it('keeps the timeouts and the registration a user already has, and says so', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    const p = join(home, '.codex', 'config.toml');
    const mine = '# mine\r\n[mcp_servers.crbro]\r\ncommand = "npx"\r\nargs = ["-y", "crbro-memory"]\r\nstartup_timeout_sec = 120.0\r\n\r\n[mcp_servers.crbro.env]\r\nNODE_OPTIONS = "--use-system-ca"\r\n';
    writeFileSync(p, mine);

    const out = run();

    const toml = readFileSync(p, 'utf8');
    expect(toml).toContain('startup_timeout_sec = 120.0');
    expect(toml).not.toMatch(/startup_timeout_sec = 60/);
    expect(toml).toContain('tool_timeout_sec = 120\r\n');
    expect(toml.replace(/\r\n/g, '')).not.toContain('\n');   // CRLF kept
    expect(toml).toContain('NODE_OPTIONS = "--use-system-ca"');
    expect(out).toContain('kept your startup_timeout_sec = 120');
  });

  it('replaces the mcp_tool + notice pair an earlier install-boot wrote for Codex', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    const p = join(home, '.codex', 'hooks.json');
    writeFileSync(p, JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [
      { type: 'mcp_tool', server: 'crbro', tool: 'crbro_boot', input: {}, timeout: 30 },
      { type: 'command', command: "printf '%s\\n' \"CRBRO: call mcp__crbro__crbro_boot as your FIRST tool action\"", timeout: 10 },
    ] }] } }));

    run();

    const start = leer(p).hooks.SessionStart;
    expect(start).toHaveLength(1);
    expect(start[0].hooks[0].command).toContain('crbro-codex.mjs');
  });

  it('leaves a hand-written hook alone when the file it points at exists', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const p = join(home, '.claude', 'settings.json');
    writeFileSync(join(home, '.claude', 'crbro-session-start.txt'), 'call crbro_boot');
    // The shape this project's own author had: the word crbro_boot never
    // appears in the config, it lives in the file the hook prints.
    const mio = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cat "$HOME/.claude/crbro-session-start.txt"' }] }] } };
    writeFileSync(p, JSON.stringify(mio));

    run();

    expect(leer(p), 'a second hook was added and the brain would boot twice').toEqual(mio);
  });

  it('a hand-written hook whose file is gone is reported as broken and the packaged one is added', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const p = join(home, '.claude', 'settings.json');
    const roto = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cat "$HOME/.claude/crbro-session-start.txt"' }] }] } };
    writeFileSync(p, JSON.stringify(roto));

    const out = run();

    expect(out).toMatch(/do not exist/);
    const start = leer(p).hooks.SessionStart;
    expect(start).toHaveLength(2);
    expect(start[1].hooks[0].command).toContain('crbro_boot');
  });

  it('runs twice without duplicating anything', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });

    run();
    const primera = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    run();

    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(primera);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(toml);
    expect(leer(join(home, '.codex', 'hooks.json')).hooks.SessionStart).toHaveLength(1);
    expect(leer(join(home, '.codex', 'hooks.json')).hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('honours CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
    const claude = join(home, 'cfg', 'claude');
    const codex = join(home, 'cfg', 'codex');
    mkdirSync(claude, { recursive: true });
    mkdirSync(codex, { recursive: true });

    execFileSync(process.execPath, [CLI, 'install-boot'], { encoding: 'utf8', env: env({ CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex }) });

    expect(existsSync(join(claude, 'settings.json'))).toBe(true);
    expect(existsSync(join(codex, 'config.toml'))).toBe(true);
    expect(existsSync(join(home, '.claude'))).toBe(false);
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it('--dry-run says what it would do and writes nothing', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });

    const out = run('--dry-run');

    expect(out).toMatch(/Dry run/);
    expect(readdirSync(join(home, '.claude'))).toEqual([]);
    expect(readdirSync(join(home, '.codex'))).toEqual([]);
  });

  it('refuses a settings.json that is not an object and exits non-zero', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const p = join(home, '.claude', 'settings.json');
    writeFileSync(p, '[1, 2]');

    const r = spawnSync(process.execPath, [CLI, 'install-boot'], { encoding: 'utf8', env: env() });

    expect(r.status).toBe(1);
    expect(readFileSync(p, 'utf8')).toBe('[1, 2]');
  });

  it('says so instead of writing when there is no client', () => {
    const salida = run();
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
    expect(salida).toMatch(/Neither .* nor .* was found/);
    // The line for tools without hooks is printed either way: it is the only
    // route Cursor and Windsurf have.
    expect(salida).toContain('crbro_boot');
  });
});
