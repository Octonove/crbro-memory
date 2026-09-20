// ─── Memory at the moment of action (2.5) ────────────────────────
//
// The trigger index maps a command to the stored errors, debts and patterns
// that mention it, and a PreToolUse hook reads it before the command runs.
// What these tests pin: the lookup is precise (a lesson about `firebase
// deploy` says nothing before `firebase login`), retired lessons stop
// speaking, a lesson is said once per session, and the hook — a separate,
// dependency-free file — extracts keys exactly like the module does.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { keysOfCommand, keysOfEntry, buildTriggerIndex, lessonsFor } from '../src/engine/triggers.js';
// @ts-expect-error — a plain .mjs hook, no types on purpose
import { keysOfCommand as hookKeys } from '../hooks/crbro-guard.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'crbro-guard.mjs');

describe('keysOfCommand', () => {
  it('reads the program and its action, per segment, through wrappers and paths', () => {
    expect(keysOfCommand('cd app && git pull --rebase && firebase deploy --only hosting')).toEqual(
      expect.arrayContaining(['git pull', 'firebase deploy']));
    expect(keysOfCommand('npx firebase deploy')).toEqual(expect.arrayContaining(['npx firebase', 'firebase deploy']));
    expect(keysOfCommand('NODE_ENV=prod sudo systemctl restart nginx')).toContain('systemctl restart');
    expect(keysOfCommand('rm -rf build')).toContain('rm -rf');
  });

  it('names a script when it is what runs', () => {
    expect(keysOfCommand('node scripts/gen-catalog.cjs --check')).toContain('gen-catalog.cjs');
    expect(keysOfCommand('& "C:\\proyectos\\scripts\\upload-skill.ps1" -Slug x')).toContain('upload-skill.ps1');
    expect(keysOfCommand('powershell -File .\\upload-skill.ps1')).toContain('upload-skill.ps1');
    // Reading a file is not running it.
    expect(keysOfCommand('grep -n foo src/server.ts')).not.toContain('server.ts');
  });

  it('the hook extracts the same keys, command for command', () => {
    for (const c of [
      'cd app && git pull --rebase && firebase deploy --only hosting',
      'npx -y crbro-memory secret get X | head -1',
      'FOO=1 BAR=2 python3 tools/build_site.py; git stash -u',
      '& "C:\\x y\\upload-skill.ps1" -Slug a',
      'sudo   rm   -rf   /var/www/old\nnpm publish --access public',
      '',
    ]) expect(hookKeys(c).sort(), c).toEqual(keysOfCommand(c).sort());
  });
});

describe('keysOfEntry', () => {
  it('takes commands from backticks and known programs from prose, and scripts by name', () => {
    const k = keysOfEntry('Desplegué con `firebase deploy --only hosting` sin hacer git pull antes; usar scripts/stamp-assets.cjs.');
    expect(k).toEqual(expect.arrayContaining(['firebase deploy', 'git pull', 'stamp-assets.cjs']));
  });
  it('makes nothing of prose without a command', () => {
    expect(keysOfEntry('Antonio prefiere los commits en español y las respuestas cortas.')).toEqual([]);
  });
});

describe('lessonsFor', () => {
  const neuron = (over: Record<string, unknown>) => ({
    id: 'project_web', name: 'Web', type: 'project', domain: 'x', facts: [], decisions: [], patterns: [], preferences: [],
    tags: [], connections: [], entry_dates: {}, ...over,
  }) as any;

  it('errors before patterns, newest first, capped, and precise', () => {
    const E1 = 'Hice `firebase deploy` sin `git pull` y resucité un fichero borrado.';
    const E2 = 'Otro `firebase deploy` con el canal equivocado.';
    const P = 'Antes de `firebase deploy`, comprobar el site con --only.';
    const idx = buildTriggerIndex([neuron({ errors: [E1, E2], patterns: [P, 'Usar `firebase login` una vez.'] })]);
    const got = lessonsFor(idx, 'firebase deploy --only hosting:invokard');
    expect(got.map(l => l.k)).toEqual(['error', 'error', 'pattern']);
    expect(lessonsFor(idx, 'firebase login').map(l => l.t)).toEqual(['Usar `firebase login` una vez.']);
    expect(lessonsFor(idx, 'firebase hosting:channel:list')).toEqual([]);
    expect(lessonsFor(idx, 'firebase deploy', 1)).toHaveLength(1);
  });
});

describe('the server writes the index and the hook reads it', () => {
  let holder: string;
  let root: string;
  let client: Client;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<any>;
  const body = (r: any) => JSON.parse(r.content[0].text);
  const ERROR = 'Desplegué invokard-comic con `firebase deploy` sin `git pull` y resucité js/billing.js, borrado en remoto. Antes de desplegar: git fetch y mirar la divergencia.';

  const runHook = (command: string, session: string, tool = 'Bash') => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: session, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } }),
      env: { ...process.env, CRBRO_BRAIN_PATH: root }, encoding: 'utf8', timeout: 10_000,
    });
    expect(r.status).toBe(0);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };

  beforeAll(async () => {
    holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-triggers-'));
    root = path.join(holder, 'brain');
    await fs.mkdir(root, { recursive: true });
    process.env.CRBRO_PATH = root;
    const { createServer } = await import('../src/server.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer().connect(st);
    client = new Client({ name: 'triggers-test', version: '1.0.0' });
    await client.connect(ct);
    await call('crbro_boot');
    await call('crbro_learn', { topic: 'Invokard', type: 'error', content: ERROR });
  });

  afterAll(async () => {
    await client?.close();
    delete process.env.CRBRO_PATH;
    await fs.rm(holder, { recursive: true, force: true });
    await fs.rm(path.join(os.tmpdir(), 'crbro-guard'), { recursive: true, force: true }).catch(() => undefined);
  });

  it('is silent before the index exists', () => {
    expect(runHook('firebase deploy', `t-${process.pid}-a`)).toBeNull();
  });

  it('consolidate writes the index, outside what a backup carries', async () => {
    await call('crbro_consolidate', { summary: 'Sesión con un error de despliegue.' });
    const idx = JSON.parse(await fs.readFile(path.join(root, '.search', 'triggers.json'), 'utf8'));
    expect(idx.v).toBe(1);
    expect(Object.keys(idx.keys)).toEqual(expect.arrayContaining(['firebase deploy', 'git pull', 'git fetch']));
  });

  it('the hook adds the lesson to the context of that tool call — and only once per session', () => {
    const s = `t-${process.pid}-b`;
    const out = runHook('cd invokard-comic && firebase deploy --only hosting:invokard', s);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();          // it never decides
    expect(out.hookSpecificOutput.additionalContext).toContain('resucité js/billing.js');
    expect(out.hookSpecificOutput.additionalContext).toContain('project_invokard');
    expect(runHook('firebase deploy', s)).toBeNull();
    expect(runHook('firebase deploy', `t-${process.pid}-c`, 'PowerShell')).not.toBeNull();   // another session hears it again
  });

  it('says nothing for a command no lesson mentions, or for a tool call with no command', () => {
    expect(runHook('ls -la', `t-${process.pid}-d`)).toBeNull();
    const r = spawnSync(process.execPath, [HOOK], { input: '{"tool_name":"Read","tool_input":{"file_path":"x"}}', env: { ...process.env, CRBRO_BRAIN_PATH: root }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('a retired lesson stops speaking after the next maintenance', async () => {
    await call('crbro_revise', { neuron: 'project_invokard', entries: [ERROR], note: 'ya hay un script que lo impide' });
    const m = body(await call('crbro_maintenance', {}));
    expect(m.trigger_index).toEqual({ entries: 0, keys: 0 });
    expect(runHook('firebase deploy', `t-${process.pid}-e`)).toBeNull();
  });

  it('garbage on stdin is silence and exit 0, never a blocked tool call', () => {
    const r = spawnSync(process.execPath, [HOOK], { input: 'no es json', env: { ...process.env, CRBRO_BRAIN_PATH: root }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
