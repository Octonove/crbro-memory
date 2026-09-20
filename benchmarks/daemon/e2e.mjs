#!/usr/bin/env node
// End-to-end check of daemon mode with REAL processes — what the unit tests
// cannot show: a detached daemon spawned by a client, surviving that client,
// being killed hard under another, and replaced without the client noticing.
// Runs on a throwaway brain; never touches ~/.crbro.
//
//   npm run build && node benchmarks/daemon/e2e.mjs

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', '..', 'dist', 'index.js');
const CLI = join(HERE, '..', '..', 'bin', 'crbro.mjs');
const holder = mkdtempSync(join(tmpdir(), 'crbro-daemon-e2e-'));
const brain = join(holder, 'brain');
const env = { ...process.env, CRBRO_PATH: brain, CRBRO_SEMANTIC: '0', CRBRO_AUTOBACKUP: '0', CRBRO_DAEMON: '1', CRBRO_DAEMON_IDLE_MIN: '1' };

const ep = await import(pathToFileURL(join(HERE, '..', '..', 'dist', 'daemon', 'endpoint.js')).href);
const { controlDaemon } = await import(pathToFileURL(join(HERE, '..', '..', 'dist', 'daemon', 'proxy.js')).href);
process.env.CRBRO_PATH = brain;

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? '✅' : '❌'} ${what}`); if (!ok) failures++; };
const body = r => JSON.parse(r.content[0].text);
const rssMb = pid => {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' });
      return Math.round(Number(out.trim()) / 1048576);
    }
    return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024);
  } catch { return null; }
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const status = async () => { const [st] = await ep.listStates(brain); return st ? controlDaemon(brain, 'status', st.build) : null; };

async function client(name) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: 'pipe' });
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(transport);
  return { c, pid: transport.pid, call: (tool, args = {}) => c.callTool({ name: tool, arguments: args }) };
}

try {
  console.log(`\n══ Daemon mode, real processes · brain ${brain} ══\n`);
  const t0 = Date.now();
  const a = await client('client-a');
  const boot = body(await a.call('crbro_boot'));
  check(typeof boot.total_neurons === 'number', `client A booted through a daemon it had to start (${Date.now() - t0} ms)`);
  const s1 = await status();
  check(!!s1 && s1.pid !== a.pid && s1.pid !== process.pid, `the daemon is its own process (pid ${s1?.pid}; client A is ${a.pid})`);

  const t1 = Date.now();
  const b = await client('client-b');
  await b.call('crbro_boot');
  check((await status()).connections === 2, `client B attached to the same daemon (${Date.now() - t1} ms): 2 conversations, one process`);

  await a.call('crbro_learn', { topic: 'Albatros', type: 'fact', content: 'La API de staging de Albatros escucha en el puerto 8443.' });
  const hit = body(await b.call('crbro_recall', { query: 'puerto API staging Albatros' })).results[0];
  check(hit?.matching_content.includes('8443'), 'what A saved, B recalled at once');

  const mem = { daemon: rssMb(s1.pid), a: rssMb(a.pid), b: rssMb(b.pid) };
  console.log(`     memory: daemon ${mem.daemon} MB · proxy A ${mem.a} MB · proxy B ${mem.b} MB`);

  await a.c.close();
  await new Promise(r => setTimeout(r, 600));
  const s2 = await status();
  check(!!s2 && s2.pid === s1.pid && s2.connections === 1, 'client A left; the daemon it started lives on for B');

  process.kill(s1.pid);   // no goodbye: TerminateProcess on Windows, SIGTERM elsewhere
  await new Promise(r => setTimeout(r, 400));
  check(!alive(s1.pid), 'the daemon was killed under client B');
  const t2 = Date.now();
  const again = body(await b.call('crbro_recall', { query: 'puerto API staging Albatros' }));
  check(again.results[0]?.matching_content.includes('8443'), `B's next call was answered anyway (${Date.now() - t2} ms) — by a new daemon, handshake replayed`);
  const s3 = await status();
  check(!!s3 && s3.pid !== s1.pid && s3.connections === 1, `a new daemon took over (pid ${s3?.pid})`);

  await b.c.close();
  await new Promise(r => setTimeout(r, 400));
  execFileSync(process.execPath, [CLI, 'daemon', 'stop'], { env, encoding: 'utf8' });
  await new Promise(r => setTimeout(r, 1200));
  check(!alive(s3.pid), 'crbro daemon stop: the process is gone');
  check((await ep.listStates(brain)).length === 0, 'and it removed its state file');
  check(existsSync(join(brain, '.search', 'chunks.index.json')), 'the index was flushed to disk on the way out');
} catch (err) {
  console.error('  ❌ e2e aborted:', err);
  failures++;
} finally {
  for (const st of await ep.listStates(brain)) { try { process.kill(st.pid); } catch { /* gone */ } }
  await new Promise(r => setTimeout(r, 300));
  try { rmSync(holder, { recursive: true, force: true }); } catch { /* Windows may hold a handle for a moment */ }
  console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}\n`);
  process.exit(failures === 0 ? 0 : 1);
}
