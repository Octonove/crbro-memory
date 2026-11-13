// ─── export / import / view through the real binary and a spawned server ─
//
// The other cli.* tests talk to an in-process server. These run what a user
// runs: bin/crbro.mjs, and the stdio server import and view spawn from dist/.
// They need a build (CI builds before testing); without one they are skipped.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { main as viewMain, type Viewer } from '../src/cli/view.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'crbro.mjs');
const built = existsSync(path.join(ROOT, 'dist', 'cli', 'import.js')) && existsSync(path.join(ROOT, 'dist', 'index.js'));
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';

let tmp: string;
let env: NodeJS.ProcessEnv;
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 90_000, cwd: tmp });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-g-e2e-'));
  const home = path.join(tmp, 'home');
  await fs.mkdir(home, { recursive: true });
  env = {
    ...process.env,
    CRBRO_PATH: path.join(tmp, 'brain'), HOME: home, USERPROFILE: home,
    CRBRO_KEYS_DIR: path.join(tmp, 'keys'), CRBRO_BACKUP_DIR: path.join(tmp, 'backups'),
    CRBRO_MOD: '0', CRBRO_AUTOBACKUP: '0', CRBRO_SEMANTIC: '0',
  };
  delete env.CRBRO_HTTP_TOKEN;
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe.skipIf(!built)('the commands, end to end on a temp brain', () => {
  it('--help on each exits 0; bad input exits non-zero', () => {
    for (const cmd of ['export', 'import', 'view', 'serve']) {
      const r = run(cmd, '--help');
      expect(r.code, cmd).toBe(0);
      expect(r.out).toContain(`crbro-memory ${cmd}`);
    }
    expect(run('export', '--nope').code).toBe(2);
    expect(run('import').code).toBe(2);
    expect(run('import', path.join(tmp, 'missing.md')).code).toBe(1);
    expect(run('serve').code).toBe(2);
    expect(run('view', '--port', 'x').code).toBe(2);
  });

  it('init → import (dry run, apply, again) → export json and md', async () => {
    expect(run('init', '--no-semantic').code).toBe(0);
    const doc = path.join(tmp, 'acme', 'CLAUDE.md');
    await fs.mkdir(path.dirname(doc), { recursive: true });
    await fs.writeFile(doc, `# Acme\n\nStorefront for the hardware shop.\n\n## Commands\n\n- Build with npm run build.\n- The CI token is ${SECRET} for now.\n`);

    const dry = run('import', doc);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('Dry run');
    expect(dry.out).toContain('Would learn 3 entries');
    expect(dry.out).not.toContain(SECRET);
    expect(await fs.readdir(path.join(tmp, 'brain', 'cortex'))).toEqual([]);

    const applied = run('import', doc, '--apply');
    expect(applied.code, applied.out).toBe(0);
    expect(applied.out).toContain('Learned 3 entries');
    const again = run('import', doc, '--apply');
    expect(again.code).toBe(0);
    expect(again.out).toContain('Learned 0 entries');
    expect(again.out).toContain('3 already in the brain');

    const out = path.join(tmp, 'export-json');
    const ex = run('export', '--format', 'json', '--out', out);
    expect(ex.code, ex.out).toBe(0);
    const data = JSON.parse(await fs.readFile(path.join(out, 'crbro-export.json'), 'utf8'));
    expect(data.neurons.map((n: any) => n.name).sort()).toEqual(['Acme', 'Acme — Commands']);
    expect(JSON.stringify(data)).not.toContain(SECRET);

    const md = path.join(tmp, 'export-md');
    expect(run('export', '--out', md).code).toBe(0);
    expect(existsSync(path.join(md, 'neurons', 'project_acme_commands.md'))).toBe(true);
    expect(run('export', '--out', path.join(tmp, 'brain', 'inside')).code).toBe(1);

    // The vault goes back into a second brain, through a second spawned server.
    const env2 = { ...env, CRBRO_PATH: path.join(tmp, 'brain2') };
    expect(spawnSync(process.execPath, [BIN, 'init', '--no-semantic'], { env: env2, encoding: 'utf8' }).status).toBe(0);
    const back = spawnSync(process.execPath, [BIN, 'import', md, '--apply'], { env: env2, encoding: 'utf8', timeout: 90_000 });
    expect(back.status, back.stdout + back.stderr).toBe(0);
    expect(back.stdout).toContain('Learned 3 entries');
  });

  it('view: the page and the API over a spawned server, then a clean stop', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { CRBRO_PATH: env.CRBRO_PATH, CRBRO_MOD: '0', CRBRO_AUTOBACKUP: '0' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ac = new AbortController();
    let viewer: Viewer | null = null;
    try {
      const done = viewMain(['--no-open', '--port', '0'], { onReady: v => { viewer = v; }, signal: ac.signal });
      await vi.waitFor(() => expect(viewer).not.toBeNull(), { timeout: 60_000 });
      const base = `http://127.0.0.1:${viewer!.port}`;
      const r = await fetch(`${base}/api/neurons`, { headers: { 'X-CRBRO-Token': viewer!.token } });
      expect(r.status).toBe(200);
      const body: any = await r.json();
      expect(body.neurons.map((n: any) => n.name)).toContain('Acme');
      expect((await fetch(`${base}/api/neurons`)).status).toBe(401);
      ac.abort();
      expect(await done).toBe(0);
    } finally {
      ac.abort();
      log.mockRestore();
      for (const k of ['CRBRO_PATH', 'CRBRO_MOD', 'CRBRO_AUTOBACKUP']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });
});
