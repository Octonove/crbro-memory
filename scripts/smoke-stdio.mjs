// Smoke test: start the real server over stdio, the way a client does, and talk
// MCP to it. It runs `node dist/index.js` (so `npm run build` comes first)
// against a throwaway brain and a throwaway home; nothing of the machine it
// runs on is read or written.
//
//   initialize -> tools/list -> crbro_boot -> crbro_learn -> crbro_recall
//
// Exits 0 when all of it holds, 1 otherwise. CI runs it on ubuntu, windows
// and macos. Usage:  npm run smoke   (or: node scripts/smoke-stdio.mjs)

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ENTRY = path.join(ROOT, 'dist', 'index.js');
const TIMEOUT_MS = 90_000;

if (!existsSync(ENTRY)) {
  console.error('dist/index.js does not exist. Run: npm run build');
  process.exit(1);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'crbro-smoke-'));
const brain = path.join(tmp, 'brain');
let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
};

const watchdog = setTimeout(() => {
  console.error(`\nsmoke: no answer within ${TIMEOUT_MS / 1000} s`);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(1);
}, TIMEOUT_MS);

let client;
try {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  console.log(`smoke: node ${process.version} on ${process.platform}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...process.env,
      CRBRO_PATH: brain,
      HOME: tmp,
      USERPROFILE: tmp,
      APPDATA: path.join(tmp, 'appdata'),
      XDG_CONFIG_HOME: path.join(tmp, 'xdg'),
      CRBRO_KEYS_DIR: path.join(tmp, 'keys'),
      CRBRO_BACKUP_DIR: path.join(tmp, 'backups'),
      CODEX_HOME: path.join(tmp, 'codex'),
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
      CRBRO_MOD: '0',
      CRBRO_AUTOBACKUP: '0',
      CRBRO_SEMANTIC: '0',
      CRBRO_DAEMON: '0',
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'crbro-smoke', version: pkg.version });

  console.log('initialize');
  await client.connect(transport); // sends initialize + notifications/initialized
  const info = client.getServerVersion();
  check(Boolean(info && info.name), 'server answers initialize', info ? `${info.name} ${info.version}` : '');
  check(info?.version === pkg.version, 'server version is the package version', `${info?.version} vs ${pkg.version}`);

  console.log('tools/list');
  const { tools } = await client.listTools();
  const names = new Set(tools.map(t => t.name));
  check(tools.length === 15, 'serves 15 tools', `${tools.length}`);
  for (const n of ['crbro_boot', 'crbro_learn', 'crbro_recall', 'crbro_consolidate', 'crbro_inspect']) {
    check(names.has(n), `has ${n}`);
  }
  check(tools.every(t => t.description && t.inputSchema), 'every tool has a description and an input schema');

  const body = (r) => {
    const text = r && Array.isArray(r.content) && r.content[0] && r.content[0].text;
    try { return JSON.parse(text); } catch { return { _raw: String(text).slice(0, 200) }; }
  };

  console.log('crbro_boot');
  const boot = await client.callTool({ name: 'crbro_boot', arguments: {} });
  const bootBody = body(boot);
  check(!boot.isError, 'boot is not an error');
  check(bootBody.status === 'ok' || bootBody.status === 'initialized', 'boot reports a usable brain', String(bootBody.status));
  check(existsSync(brain), 'the brain is written where CRBRO_PATH says');

  console.log('crbro_learn');
  const learn = await client.callTool({ name: 'crbro_learn', arguments: {
    topic: 'Smoke test',
    type: 'fact',
    content: 'The smoke test stores this sentence about zebras and checks that recall finds it again.',
    keywords: ['zebras', 'smoke'],
  } });
  check(!learn.isError, 'learn is not an error', JSON.stringify(body(learn)).slice(0, 80));

  console.log('crbro_recall');
  const recall = await client.callTool({ name: 'crbro_recall', arguments: { query: 'zebras smoke test' } });
  const recallBody = body(recall);
  const first = recallBody.results && recallBody.results[0];
  check(!recall.isError, 'recall is not an error');
  check(Boolean(first), 'recall returns a result', `total_results=${recallBody.total_results}`);
  check(Boolean(first && JSON.stringify(first).includes('zebras')), 'the first result is the stored fact');
} catch (err) {
  check(false, 'exception during the smoke test', err instanceof Error ? err.message : String(err));
} finally {
  clearTimeout(watchdog);
  try { if (client) await client.close(); } catch { /* already gone */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(failures === 0 ? '\nsmoke: all good' : `\nsmoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
