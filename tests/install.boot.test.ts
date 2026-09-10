import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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

function run(): string {
  return execFileSync(process.execPath, [CLI, 'install-boot'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
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

  it('wires Codex with the direct MCP call AND the printed fallback', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });

    run();

    const steps = leer(join(home, '.codex', 'hooks.json')).hooks.SessionStart[0].hooks;
    // The mcp_tool call alone is not enough: the hook can fire before the
    // server is up, and then it is lost with nothing to catch it.
    expect(steps.map((h: { type: string }) => h.type)).toEqual(['mcp_tool', 'command']);
    expect(steps[0]).toMatchObject({ server: 'crbro', tool: 'crbro_boot' });
  });

  it('leaves a hand-written hook alone, even one that points at a file', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const p = join(home, '.claude', 'settings.json');
    // The shape this project's own author had: the word crbro_boot never
    // appears in the config, it lives in the file the hook prints.
    const mio = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cat "$HOME/.claude/crbro-session-start.txt"' }] }] } };
    writeFileSync(p, JSON.stringify(mio));

    run();

    expect(leer(p), 'a second hook was added and the brain would boot twice').toEqual(mio);
  });

  it('runs twice without duplicating anything', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });

    run();
    const primera = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    run();

    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(primera);
    expect(leer(join(home, '.codex', 'hooks.json')).hooks.SessionStart).toHaveLength(1);
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
