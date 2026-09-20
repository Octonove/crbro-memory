#!/usr/bin/env node
// What daemon mode buys, measured: three MCP clients on one brain, classic
// (one full server each) against daemon (three proxies, one server).
//
//   node benchmarks/daemon/measure.mjs <backup.json.gz> [--search-from <brain>/.search] [--json]
//
// Works on a COPY restored from the backup into a temp folder; the brain the
// backup came from is never opened. --search-from copies that brain's derived
// index and vectors next to the copy so the semantic layer does not have to
// re-embed everything first (read-only on the source).

import { mkdtempSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');
const ENTRY = join(DIST, 'index.js');
const backup = process.argv.slice(2).find(a => !a.startsWith('--') && a.endsWith('.gz'));
const flag = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
if (!backup) { console.error('usage: measure.mjs <backup.json.gz> [--search-from DIR] [--json]'); process.exit(1); }
const CLIENTS = 3;
const QUERY = 'copia de seguridad del cerebro';

const { restoreBackup } = await import(pathToFileURL(join(DIST, 'engine', 'backup.js')).href);
const ep = await import(pathToFileURL(join(DIST, 'daemon', 'endpoint.js')).href);
const { controlDaemon } = await import(pathToFileURL(join(DIST, 'daemon', 'proxy.js')).href);

const rssMb = pid => {
  try {
    if (process.platform === 'win32') {
      return Math.round(Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' }).trim()) / 1048576);
    }
    return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024);
  } catch { return 0; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scenario(mode) {
  const holder = mkdtempSync(join(tmpdir(), `crbro-measure-${mode}-`));
  const brain = join(holder, 'brain');
  await restoreBackup(backup, brain);
  const from = flag('--search-from');
  if (from) cpSync(from, join(brain, '.search'), { recursive: true });
  const env = { ...process.env, CRBRO_PATH: brain, CRBRO_AUTOBACKUP: '0', CRBRO_DAEMON: mode === 'daemon' ? '1' : '0', CRBRO_DAEMON_IDLE_MIN: '2' };

  const clients = [];
  const rows = [];
  for (let i = 0; i < CLIENTS; i++) {
    const t0 = Date.now();
    const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: 'ignore' });
    const c = new Client({ name: `measure-${i}`, version: '1.0.0' });
    await c.connect(transport);
    await c.callTool({ name: 'crbro_boot', arguments: {} });
    const tBoot = Date.now() - t0;
    const t1 = Date.now();
    const r = JSON.parse((await c.callTool({ name: 'crbro_recall', arguments: { query: QUERY } })).content[0].text);
    rows.push({ client: i + 1, ready_ms: tBoot, first_recall_ms: Date.now() - t1, results: r.results.length });
    clients.push({ c, pid: transport.pid });
  }
  await sleep(20_000);   // let every process finish loading what it is going to load (the model is ~13 s)
  for (const [i, cl] of clients.entries()) {
    const t = Date.now();
    await cl.c.callTool({ name: 'crbro_recall', arguments: { query: QUERY } });
    rows[i].warm_recall_ms = Date.now() - t;
    rows[i].rss_mb = rssMb(cl.pid);
  }
  let daemon = null;
  if (mode === 'daemon') {
    process.env.CRBRO_PATH = brain;
    const [st] = await ep.listStates(brain);
    const s = st ? await controlDaemon(brain, 'status', st.build) : null;
    if (s) daemon = { pid: s.pid, rss_mb: rssMb(s.pid), conversations: s.connections, semantic_vectors: s.semantic_vectors };
  }
  for (const cl of clients) await cl.c.close();
  if (daemon) { await controlDaemon(brain, 'stop', (await ep.listStates(brain))[0]?.build); await sleep(1500); }
  await sleep(500);
  try { rmSync(holder, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ }
  const total = rows.reduce((a, r) => a + r.rss_mb, 0) + (daemon ? daemon.rss_mb : 0);
  return { mode, clients: rows, daemon, total_rss_mb: total };
}

const classic = await scenario('classic');
const daemon = await scenario('daemon');
const out = { date: new Date().toISOString().slice(0, 10), node: process.version, platform: process.platform, clients: CLIENTS, classic, daemon };

console.log(`\n══ ${CLIENTS} clients on one brain · classic vs daemon ══`);
for (const s of [classic, daemon]) {
  console.log(`\n  ${s.mode.toUpperCase()}`);
  for (const r of s.clients) console.log(`    client ${r.client}: ready ${r.ready_ms} ms · first recall ${r.first_recall_ms} ms · warm recall ${r.warm_recall_ms} ms · ${r.rss_mb} MB`);
  if (s.daemon) console.log(`    daemon : ${s.daemon.rss_mb} MB · ${s.daemon.conversations} conversations · ${s.daemon.semantic_vectors} vectors`);
  console.log(`    total memory: ${s.total_rss_mb} MB`);
}
console.log(`\n  memory: ${classic.total_rss_mb} MB -> ${daemon.total_rss_mb} MB (${Math.round(100 * (1 - daemon.total_rss_mb / classic.total_rss_mb))}% less)\n`);
if (process.argv.includes('--json')) writeFileSync(join(HERE, 'results.json'), JSON.stringify(out, null, 2) + '\n');
process.exit(0);
