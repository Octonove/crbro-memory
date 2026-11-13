import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { endpointFor, newToken, proof, writeState } from '../src/daemon/endpoint.js';

let pkg: string;
let home: string;
let brain: string;
let env: NodeJS.ProcessEnv;
const forbidden = 'FAKE_CREDENTIAL_MUST_NEVER_APPEAR';

async function put(file: string, value: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

// Exercise the actual CLI with the current source in a disposable package.
// The absent doctor command must not fall through to a real MCP server.
beforeAll(async () => {
  pkg = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-doctor-code-'));
  await put(path.join(pkg, 'bin/crbro.mjs'), await fs.readFile('bin/crbro.mjs'));
  await put(path.join(pkg, 'package.json'), JSON.stringify({ name: 'crbro-memory', version: '0.0.0-fixture' }));
  const files = ['engine/doctor', 'engine/brain', 'engine/backup', 'utils/fs', 'utils/lock',
    'daemon/endpoint', 'daemon/proxy', 'daemon/lines', 'engine/shelf', 'sync/ops', 'utils/hash', 'version',
    'engine/hookverify', 'engine/hookrefresh', 'engine/installio'];
  for (const file of files) {
    let source: string;
    try { source = await fs.readFile(path.resolve('src', `${file}.ts`), 'utf8'); }
    catch (e) { if (file === 'engine/doctor' && (e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    await put(path.join(pkg, 'dist', `${file}.js`), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText);
  }
});
afterAll(async () => { await fs.rm(pkg, { recursive: true, force: true }); });
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-doctor-home-'));
  brain = path.join(home, 'brain');
  env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CRBRO_PATH: brain, CRBRO_KEYS_DIR: path.join(home, 'forbidden-keychain'),
    CRBRO_SEMANTIC_HOME: path.join(home, '.semantic'), CRBRO_SEMANTIC: '0',
    CRBRO_BACKUP_DIR: path.join(home, 'backups'), CRBRO_DAEMON: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
});
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(process.execPath, [path.join(pkg, 'bin/crbro.mjs'), ...args], {
    env, cwd: home, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  }, (err, stdout, stderr) => resolve({ code: err ? Number(err.code) || 1 : 0, stdout, stderr })));
}

async function report() {
  const result = await cli('doctor', '--json');
  expect(result.stdout, 'doctor must return pure JSON instead of falling through to MCP').toMatch(/^\{/);
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toContain(forbidden);
  return { ...result, data: JSON.parse(result.stdout) };
}

async function manifest() {
  await put(path.join(brain, 'manifest.json'), JSON.stringify({ version: '1.0.0', last_boot: '2026-10-17T12:30:00.000Z' }));
}

async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, e.name);
    if (e.isDirectory()) out.push(...await snapshot(file));
    else if (e.isFile()) {
      const st = await fs.stat(file);
      out.push(`${file}|${st.mtimeMs}|${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`);
    } else out.push(`${file}|nonregular`);
  }
  return out.sort();
}

describe('doctor is observational', () => {
  it('doctor --json handles a missing brain without initializing anything', async () => {
    const before = await snapshot(home);
    const { code, data } = await report();
    expect(code).toBe(0);
    expect(data.read_only).toBe(true);
    expect(data.brain).toMatchObject({ path: brain, exists: false, status: 'unknown', last_boot: null, client_autorun: 'unknown' });
    expect(data.versions.installed).toBe('0.0.0-fixture');
    expect(data.versions.daemon_status).toBe('unknown');
    expect(data.semantic.operation).toBe('not_probed');
    expect(await snapshot(home)).toEqual(before);
  });

  it('reports aggregate last_boot without claiming any client auto-started', async () => {
    await manifest();
    const before = await snapshot(home);
    const { code, data } = await report();
    expect(code).toBe(0);
    expect(data.brain).toMatchObject({ last_boot: '2026-10-17T12:30:00.000Z', last_boot_scope: 'aggregate', client_autorun: 'unknown' });
    expect(await snapshot(home)).toEqual(before);
    const help = await cli('--help');
    expect(help.stdout).toContain('doctor');
    const human = await cli('doctor');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('not_probed');
  });

  it('flags invalid brain JSON as an error without echoing its content or repairing it', async () => {
    await manifest();
    const bad = path.join(brain, 'cortex', 'broken.json');
    await put(bad, `{"value":"${forbidden}`);
    const before = await snapshot(home);
    const { code, data } = await report();
    expect(code).toBe(1);
    expect(data.status).toBe('error');
    expect(data.brain.invalid_json_paths).toEqual([bad]);
    expect(await snapshot(home)).toEqual(before);
  });

  it('compares known client brain paths while returning only whitelisted config fields', async () => {
    await manifest();
    const other = path.join(home, 'other-brain');
    await put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { crbro: {
      command: 'npx', args: ['-y', 'crbro-memory', forbidden], env: { CRBRO_PATH: brain, API_KEY: forbidden },
    } }, token: forbidden }));
    await put(path.join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { crbro: {
      env: { CRBRO_PATH: other, TOKEN: forbidden }, headers: { Authorization: forbidden }, disabled: true,
    } } }));
    await put(path.join(home, '.codex/config.toml'), `[mcp_servers.crbro]\nenabled = true\ncommand = "npx"\n[mcp_servers.crbro.env]\nCRBRO_PATH = '${brain}'\nTOKEN = "${forbidden}"\n`);
    const before = await snapshot(home);
    const { code, data } = await report();
    expect(code).toBe(0);
    expect(data.configs.different_brain_paths).toBe(true);
    expect(data.configs.distinct_brain_paths.sort()).toEqual([brain, other].sort());
    expect(data.configs.clients.find((c: any) => c.client === 'Codex')).toMatchObject({ registered: true, enabled: true, brain_paths: [brain], client_autorun: 'unknown' });
    expect(data.configs.clients.find((c: any) => c.client === 'Cursor')).toMatchObject({ registered: true, enabled: false, brain_paths: [other] });
    expect(JSON.stringify(data)).not.toMatch(/Authorization|API_KEY|TOKEN/);
    expect(await snapshot(home)).toEqual(before);
  });

  it('malformed client configuration is unknown and noncritical, never silently healthy', async () => {
    await put(path.join(home, '.claude.json'), `{"token":"${forbidden}`);
    const { code, data } = await report();
    expect(code).toBe(0);
    expect(data.configs.clients.find((c: any) => c.client === 'Claude Code')).toMatchObject({ status: 'unknown', registered: null });
  });

  it('also detects divergence between the selected brain and a single client configuration', async () => {
    await manifest();
    const other = path.join(home, 'other-brain');
    await put(path.join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { crbro: { env: { CRBRO_PATH: other } } } }));
    const { data } = await report();
    expect(data.configs.different_brain_paths).toBe(true);
    expect(data.configs.distinct_brain_paths.sort()).toEqual([brain, other].sort());
  });

  it('does not claim an unsupported Codex registration or malformed JSON entry is healthy', async () => {
    await put(path.join(home, '.codex/config.toml'), `[mcp_servers]\ncrbro = { command = "npx", env = { TOKEN = "${forbidden}" } }\n`);
    await put(path.join(home, '.cursor/mcp.json'), '{"mcpServers":{"crbro":null}}');
    const { data } = await report();
    expect(data.configs.clients.find((c: any) => c.client === 'Codex')).toMatchObject({ status: 'unknown', registered: null, enabled: null });
    expect(data.configs.clients.find((c: any) => c.client === 'Cursor')).toMatchObject({ status: 'unknown', enabled: null });
  });

  it('inspects semantic files without importing the runtime or claiming an operational model', async () => {
    await manifest();
    env.CRBRO_SEMANTIC = '1';
    await put(path.join(home, '.semantic/node_modules/@huggingface/transformers/package.json'), '{"main":"index.js"}');
    await put(path.join(home, '.semantic/node_modules/@huggingface/transformers/index.js'), 'throw new Error("runtime must not load")');
    await fs.mkdir(path.join(home, '.semantic/models/Xenova/multilingual-e5-small'), { recursive: true });
    await put(path.join(brain, '.search/vectors.meta.json'), JSON.stringify({ model: 'Xenova/multilingual-e5-small', dtype: 'q8', dim: 3, ids: ['fixture'] }));
    await put(path.join(brain, '.search/vectors.f32'), Buffer.alloc(12));
    const before = await snapshot(home);
    const { data } = await report();
    expect(data.semantic).toMatchObject({ mode: 'forced', runtime_present: true, model_cache_present: true, operation: 'not_probed', index: { status: 'ok', vectors: 1 } });
    expect(await snapshot(home)).toEqual(before);
    await put(path.join(brain, '.search/vectors.f32'), Buffer.alloc(4));
    expect((await report()).data.semantic.index.status).toBe('warning');
  });

  it('reports the newest backup as observed, without unpacking or validating its payload', async () => {
    await manifest();
    await put(path.join(home, 'backups/brain-20261016-120000.json.gz'), 'fixture-old');
    const newest = path.join(home, 'backups/brain-20261017-120000.json.gz');
    await put(newest, 'fixture-new');
    const before = await snapshot(home);
    const { data } = await report();
    expect(data.backups).toMatchObject({ latest: { path: newest, created: '2026-10-17T12:00:00.000Z' }, integrity: 'not_probed' });
    expect(await snapshot(home)).toEqual(before);
  });

  it('reads local team history without claiming worktree cleanliness, fetching or exposing remotes', async () => {
    await manifest();
    const team = path.join(brain, 'shared/equipo');
    const git = path.join(team, '.git');
    // Minimal real repository, hand-built fake objects: no commits in the shared repo.
    const object = async (type: string, body: string) => {
      const bytes = Buffer.from(`${type} ${Buffer.byteLength(body)}\0${body}`);
      const id = createHash('sha1').update(bytes).digest('hex');
      await put(path.join(git, 'objects', id.slice(0, 2), id.slice(2)), deflateSync(bytes));
      return id;
    };
    const tree = await object('tree', '');
    const stamp = 'Fixture <fixture@example.test> 1700000000 +0000';
    const first = await object('commit', `tree ${tree}\nauthor ${stamp}\ncommitter ${stamp}\n\nfirst\n`);
    const next = await object('commit', `tree ${tree}\nparent ${first}\nauthor ${stamp}\ncommitter ${stamp}\n\nnext\n`);
    await put(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
    await put(path.join(git, 'refs/heads/main'), `${next}\n`);
    await put(path.join(git, 'refs/remotes/origin/main'), `${first}\n`);
    await put(path.join(git, 'config'), `[core]\nrepositoryformatversion = 0\nbare = false\n[remote "origin"]\nurl = https://${forbidden}@invalid.test/repo\nfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\nremote = origin\nmerge = refs/heads/main\n`);
    await put(path.join(team, 'pending.jsonl'), '{"fixture":true}\n');
    const before = await snapshot(home);
    const { code, data } = await report();
    expect(code).toBe(0);
    expect(data.teams.spaces).toHaveLength(1);
    expect(data.teams.spaces[0]).toMatchObject({ path: team, dirty: null, worktree_state: 'not_probed', ahead: 1, behind: 0, remote_state: 'not_fetched' });
    expect(await snapshot(home)).toEqual(before);
    await put(path.join(git, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
    expect((await report()).data.teams.spaces[0]).toMatchObject({ status: 'unknown', dirty: null, worktree_state: 'not_probed', ahead: null, behind: null });
  });

  it.each(['clean', 'process'])('never executes a Git %s filter while doctor --json observes a team', async kind => {
    await manifest();
    const team = path.join(brain, 'shared', `filter-${kind}`);
    await fs.mkdir(team, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-C', team, ...args], {
      env, encoding: 'utf8', windowsHide: true, timeout: 5_000,
    });
    git('init', '-q');
    const tracked = path.join(team, 'tracked.txt');
    await put(tracked, 'AAAA\n');
    git('add', '--', 'tracked.txt'); // Índice real, antes de configurar el filtro.
    const marker = path.join(team, 'filter-executed');
    const filter = path.join(home, 'fixture-filter.cjs');
    await put(filter, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'FILTER EXECUTED');\n`
      + (kind === 'clean' ? 'process.stdin.pipe(process.stdout);\n' : 'process.exit(1);\n'));
    // El filtro process deja el marcador antes de rechazar el handshake: su
    // ejecución ya violaría read_only, aunque Git acabara devolviendo error.
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${filter.replace(/\\/g, '/')}"`;
    git('config', `filter.doctor-fixture.${kind}`, command);
    await put(path.join(team, '.gitattributes'), 'tracked.txt filter=doctor-fixture\n');
    await put(tracked, 'BBBB\n'); // Mismo tamaño: status necesita comprobar el contenido.
    const earlier = new Date(Date.now() - 60_000);
    await fs.utimes(tracked, earlier, earlier);
    const before = await snapshot(home);
    const { code, data } = await report(); // CLI real; JSON.parse exige stdout puro.
    expect(await fs.stat(marker).then(() => true, () => false), 'doctor must not execute configured Git filters').toBe(false);
    expect(code).toBe(0);
    expect(data.read_only).toBe(true);
    expect(data.teams.spaces[0]).toMatchObject({ dirty: null, worktree_state: 'not_probed', status: 'unknown' });
    expect(await snapshot(home)).toEqual(before);
    const human = await cli('doctor');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('dirty=unknown');
    expect(human.stdout).toContain('worktree=not_probed');
    expect(await snapshot(home)).toEqual(before);
  });

  it('reports a running version only after the existing local authenticated status exchange', async () => {
    await manifest();
    const build = `doctor-${process.pid}`;
    const endpoint = endpointFor(brain, build);
    const token = newToken();
    if (process.platform !== 'win32') await fs.mkdir(path.dirname(endpoint), { recursive: true });
    const messages: string[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      let pending = '';
      socket.on('data', chunk => {
        pending += chunk.toString();
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const m = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
          messages.push(m.crbro);
          const send = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
          if (m.crbro === 'hello') send({ crbro: 'hello', nonce: 'a'.repeat(32), proof: proof(token, 'daemon', m.nonce) });
          else if (m.crbro === 'auth' && m.proof === proof(token, 'client', 'a'.repeat(32))) send({ crbro: 'ready' });
          else if (m.crbro === 'control' && m.op === 'status') send({ crbro: 'status', version: '2.8.0', build, brain, pid: process.pid });
          else socket.destroy();
        }
      });
    });
    await new Promise<void>(resolve => server.listen(endpoint, resolve));
    try {
      await writeState(brain, { protocol: 1, pid: process.pid, version: 'stale-file', build, endpoint, token, started: '2026-10-17T00:00:00Z', brain });
      const before = await snapshot(home);
      const { data, stdout } = await report();
      expect(data.versions.daemons[0]).toMatchObject({ status: 'ok', running_version: '2.8.0', observed_via: 'authenticated_status' });
      expect(stdout).not.toContain(token);
      expect(stdout).not.toContain('stale-file');
      expect(messages).toEqual(['hello', 'auth', 'control']);
      expect(await snapshot(home)).toEqual(before);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const { data } = await report();
    expect(data.versions.daemons[0]).toMatchObject({ status: 'unknown', running_version: null });
  });
});

describe('doctor tells the truth (2.11)', () => {
  const stampNow = (daysAgo: number) => {
    const d = new Date(Date.now() - daysAgo * 86400000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  };
  const slash = (p: string) => p.replace(/\\/g, '/');
  const backup = (daysAgo: number) => put(path.join(home, `backups/brain-${stampNow(daysAgo)}.json.gz`), 'fixture');
  beforeAll(async () => {
    // The fixture package ships the hooks, so installed copies can be compared with it.
    for (const f of await fs.readdir('hooks')) await put(path.join(pkg, 'hooks', f), await fs.readFile(path.join('hooks', f)));
    // A release newer than any hook in the history, so an old copy reads as an older release.
    await put(path.join(pkg, 'package.json'), JSON.stringify({ name: 'crbro-memory', version: '99.0.0' }));
  });

  it('a healthy brain with a fresh backup is "ok", and the human summary says so', async () => {
    await manifest();
    await backup(0);
    const { code, data } = await report();
    expect(code).toBe(0);
    expect(data.status).toBe('ok');
    expect(data.backups).toMatchObject({ status: 'ok', age_days: 0 });
    const human = await cli('doctor');
    expect(human.stdout).toMatch(/— ok\nEverything observed is in order\./);
    expect(human.stdout).toContain('Not checked:');
  });

  it('backup age: a warning past 2 days, an error past 7; no backup at all is a warning with the command', async () => {
    await manifest();
    expect((await report()).data.backups).toMatchObject({ status: 'warning', latest: null });
    await backup(3);
    expect((await report()).data.backups).toMatchObject({ status: 'warning', age_days: 3 });
    await fs.rm(path.join(home, 'backups'), { recursive: true });
    await backup(10);
    const { code, data } = await report();
    expect(code).toBe(1);
    expect(data.status).toBe('error');
    const human = await cli('doctor');
    expect(human.stdout).toMatch(/Problems:\n {2}• the newest backup is 10 days old/);
    expect(human.stdout).toContain('→ npx crbro-memory backup');
  });

  it('automatic backups that stopped are noticed: consolidate ran, no copy since', async () => {
    await put(path.join(brain, 'manifest.json'), JSON.stringify({ version: '1.0.0', last_consolidation: new Date().toISOString() }));
    await backup(3);
    env.CRBRO_AUTOBACKUP = '1';
    expect((await report()).data.backups.automatic).toMatchObject({ enabled: true, failing: true });
  });

  it('installed hooks: an older release, an edited copy, a missing script and an npx-cache path, all named', async () => {
    await manifest();
    await backup(0);
    const old = execFileSync('git', ['show', 'c1edbb8:hooks/crbro-guard.mjs'], { encoding: 'utf8' });
    const hooksDir = path.join(home, '.claude', 'crbro-hooks');
    await put(path.join(hooksDir, 'crbro-guard.mjs'), old);
    await put(path.join(hooksDir, 'crbro-subagent.mjs'), '// edited by hand');
    await put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: `node "${slash(path.join(hooksDir, 'crbro-guard.mjs'))}"` }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: `node "${slash(path.join(home, 'gone', 'crbro-lifecycle.mjs'))}" session-start` }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "C:/Users/x/AppData/Local/npm-cache/_npx/1f9/node_modules/crbro-memory/hooks/crbro-x.mjs"' }] }],
    } }));
    const before = await snapshot(home);
    const { data } = await report();
    expect(data.hooks.installed).toEqual(expect.arrayContaining([
      { client: 'claude-code', file: path.join(hooksDir, 'crbro-guard.mjs'), state: 'older_release' },
      { client: 'claude-code', file: path.join(hooksDir, 'crbro-subagent.mjs'), state: 'modified' },
    ]));
    expect(data.hooks.missing_scripts.some((s: string) => s.includes('gone'))).toBe(true);
    expect(data.hooks.npx_cache_references).toBe(1);
    expect(data.status).toBe('warning');
    expect(await snapshot(home), 'doctor refreshed nothing').toEqual(before);
  });

  it('daemon leftovers, quarantine and the trigger index are inspected', async () => {
    await manifest();
    await backup(0);
    await put(path.join(brain, '.daemon', 'dead.json'), JSON.stringify({ pid: 2 ** 22 + 12345, build: 'x' }));
    await put(path.join(brain, '.daemon', 'dead.json.4194303.tmp'), '{}');
    await put(path.join(brain, '.quarantine', 'n-2026.json'), '{"x":1}');
    const old = path.join(brain, '.quarantine', 'n-2025.json');
    await put(old, '{"x":2}');
    const then = new Date(Date.now() - 400 * 86400000);
    await fs.utimes(old, then, then);
    await put(path.join(brain, '.search', 'triggers.json'), JSON.stringify({ v: 1, keys: {}, entries: [] }));
    const { data } = await report();
    expect(data.daemon_leftovers).toMatchObject({ status: 'warning', descriptors: 1, dead_descriptors: 1, orphan_tmp: 1 });
    expect(data.quarantine).toMatchObject({ status: 'warning', files: 2, retention_days: 180 });
    expect(data.quarantine.oldest_days).toBeGreaterThanOrEqual(399);
    expect(data.triggers).toMatchObject({ status: 'warning', exists: true, version: 1 });
    await put(path.join(brain, '.search', 'triggers.json'), JSON.stringify({ v: 3, built: '2026-11-13T00:00:00.000Z', keys: {}, entries: [] }));
    expect((await report()).data.triggers).toMatchObject({ status: 'ok', version: 3, entries: 0 });
  });

  it('client registrations: Codex timeouts, npx, and a command or script that does not exist', async () => {
    await manifest();
    await backup(0);
    await put(path.join(home, '.codex/config.toml'), `[mcp_servers.crbro]\ncommand = "npx"\nargs = ["-y", "crbro-memory", "${forbidden}"]\nstartup_timeout_sec = 60\n`);
    await put(path.join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { crbro: {
      command: path.join(home, 'no-node.exe'), args: [path.join(home, '.crbro-engine', 'crbro.mjs')] } } }));
    const { data, stdout } = await report();
    const codex = data.configs.clients.find((c: any) => c.client === 'Codex');
    expect(codex).toMatchObject({ status: 'warning', uses_npx: true, startup_timeout_sec: 60, tool_timeout_sec: null });
    const cursor = data.configs.clients.find((c: any) => c.client === 'Cursor');
    expect(cursor).toMatchObject({ status: 'warning', uses_npx: false, command_exists: false, script_exists: false });
    expect(stdout).not.toContain(forbidden);
    expect(stdout).not.toContain('no-node.exe');
    const human = await cli('doctor');
    expect(human.stdout).toContain('has no tool_timeout_sec');
    expect(human.stdout).toContain('→ npx crbro-memory install-boot');
  });
});
