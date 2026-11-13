import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs hook, no types
import { alreadyBooted, contextFrom, engineFrom, FALLBACK, findEngine, RECEIPT, respond } from '../hooks/crbro-codex.mjs';

/**
 * The Codex boot hook: boots the engine itself and hands the session its
 * protocols, once per session, never from an npx cache folder, and falls back
 * to the printed notice whenever it cannot.
 */
const ROOT = join(__dirname, '..');
const HOOK = join(ROOT, 'hooks', 'crbro-codex.mjs');
let dir: string;
const okBoot = async () => ({ status: 'ok', protocol_enforcement: 'ACTIVE PROTOCOLS\n- be honest', memory_discipline: 'recall first', open_items: [{ text: 'x' }] });
const transcript = (lines: unknown[]) => {
  const f = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return f;
};
const ctx = (r: any) => r?.hookSpecificOutput?.additionalContext as string | undefined;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'crbro-codexhook-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('crbro-codex.mjs', () => {
  it('SessionStart boots and hands over the receipt, the protocols and the memory', async () => {
    const r = await respond({ hook_event_name: 'SessionStart', source: 'startup', cwd: '/w/my-proj' }, { argv: ['--engine', ROOT], env: {}, boot: okBoot });
    expect(r.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(ctx(r)).toContain(RECEIPT);
    expect(ctx(r)).toContain('ACTIVE PROTOCOLS');
    expect(ctx(r)).toContain('"open_items"');
  });

  it('passes the folder as project to crbro_boot', async () => {
    let seen: any;
    await respond({ hook_event_name: 'SessionStart', source: 'startup', cwd: 'C:\\work\\shop-site' }, {
      argv: ['--engine', ROOT], env: {}, boot: async (_e: string, a: any) => { seen = a; return okBoot(); },
    });
    expect(seen).toEqual({ project: 'shop-site' });
  });

  it('a resumed session that already booted is left alone; after clear or compact it boots again', async () => {
    const t = transcript([{ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: RECEIPT }] } }]);
    expect(await respond({ hook_event_name: 'SessionStart', source: 'resume', transcript_path: t }, { argv: ['--engine', ROOT], env: {}, boot: okBoot })).toBeNull();
    expect(await respond({ hook_event_name: 'UserPromptSubmit', transcript_path: t, session_id: 'a' }, { argv: ['--engine', ROOT], env: {}, boot: okBoot })).toBeNull();
    expect(ctx(await respond({ hook_event_name: 'SessionStart', source: 'compact', transcript_path: t }, { argv: ['--engine', ROOT], env: {}, boot: okBoot }))).toContain(RECEIPT);
  });

  it('a crbro_boot the model called itself counts as booted', async () => {
    const t = transcript([
      { type: 'response_item', payload: { type: 'function_call', name: 'mcp__crbro__crbro_boot', arguments: '{}', call_id: 'c1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '{"protocol_enforcement":"…"}' } },
    ]);
    expect(await alreadyBooted(t)).toBe(true);
    expect(await alreadyBooted(join(dir, 'missing.jsonl'))).toBe(false);
  });

  it('UserPromptSubmit boots a session that has none, at most twice per session', async () => {
    let calls = 0;
    const failing = async () => { calls++; throw new Error('timeout'); };
    const ev = { hook_event_name: 'UserPromptSubmit', session_id: `s${Date.now()}`, prompt: 'hola' };
    expect(ctx(await respond(ev, { argv: ['--engine', ROOT], env: {}, boot: failing }))).toBe(FALLBACK);
    expect(ctx(await respond(ev, { argv: ['--engine', ROOT], env: {}, boot: failing }))).toBe(FALLBACK);
    expect(await respond(ev, { argv: ['--engine', ROOT], env: {}, boot: failing })).toBeNull();
    expect(calls).toBe(2);
  });

  it('with no engine anywhere, SessionStart prints the notice and UserPromptSubmit says nothing', () => {
    // A copy outside any package, as installed in <CODEX_HOME>/crbro-hooks, with no ~/.crbro-engine.
    const copy = join(dir, 'codex-home', 'crbro-hooks', 'crbro-codex.mjs');
    mkdirSync(join(dir, 'codex-home', 'crbro-hooks'), { recursive: true });
    writeFileSync(copy, require('node:fs').readFileSync(HOOK));
    const run = (ev: object) => spawnSync(process.execPath, [copy], {
      input: JSON.stringify(ev), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, HOME: join(dir, 'h'), USERPROFILE: join(dir, 'h'), CRBRO_ENGINE_DIR: '' },
    });
    const start = run({ hook_event_name: 'SessionStart', source: 'startup' });
    expect(start.status).toBe(0);
    expect(JSON.parse(start.stdout).hookSpecificOutput.additionalContext).toBe(FALLBACK);
    const prompt = run({ hook_event_name: 'UserPromptSubmit', session_id: 'none' });
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toBe('');
    // The package this test runs from is found through the hook's own location.
    expect(findEngine([], { HOME: join(dir, 'h') })).toBe(ROOT);
  });

  it('never takes an engine out of an npx cache folder', () => {
    const npx = join(dir, '_npx', 'abc', 'node_modules', 'crbro-memory');
    mkdirSync(join(npx, 'dist'), { recursive: true });
    writeFileSync(join(npx, 'dist', 'index.js'), '');
    expect(engineFrom(npx)).toBe(npx);
    expect(findEngine(['--engine', npx], { HOME: dir })).not.toBe(npx);
  });

  it('reads a stable engine folder through its current.json', () => {
    const root = join(dir, 'engine');
    mkdirSync(join(root, '9.9.9', 'dist'), { recursive: true });
    writeFileSync(join(root, '9.9.9', 'dist', 'index.js'), '');
    writeFileSync(join(root, 'current.json'), JSON.stringify({ dir: '9.9.9' }));
    expect(engineFrom(root)).toBe(join(root, '9.9.9'));
  });

  it('a brain without protocols still boots; an empty answer is not a boot', () => {
    expect(contextFrom({ status: 'ok', memory_discipline: 'x' })).toContain(RECEIPT);
    expect(contextFrom(null)).toBeNull();
    expect(contextFrom({})).toBeNull();
  });

  it('CRBRO_CODEX_HOOK=0 silences it', async () => {
    expect(await respond({ hook_event_name: 'SessionStart', source: 'startup' }, { argv: [], env: { CRBRO_CODEX_HOOK: '0' }, boot: okBoot })).toBeNull();
  });

  it('end to end: boots this build over stdio against a throwaway brain', () => {
    const brain = join(dir, 'brain');
    const r = spawnSync(process.execPath, [HOOK, '--engine', ROOT], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: join(dir, 'proj'), session_id: 'e2e' }),
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, CRBRO_PATH: brain, CRBRO_MOD: '0', CRBRO_SEMANTIC: '0', CRBRO_AUTOBACKUP: '0', CRBRO_DAEMON: '0' },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain(RECEIPT);
  }, 40_000);
});
