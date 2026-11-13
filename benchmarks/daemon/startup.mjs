#!/usr/bin/env node
// How long a client waits for CRBRO, launched the four ways that matter:
//
//   classic        node dist/index.js, no daemon (one full server per client)
//   proxy-warm     daemon mode, the daemon already running
//   proxy-spawn    daemon mode, the proxy has to start the daemon
//   slow-client    daemon mode, warm daemon, a client that waits before it
//                  sends initialize (Codex and others were seen taking 17 s);
//                  2.10 cut such a client three times and then served it
//                  in-process for good
//
// For each: time from launch to the answer to `initialize`, and to the first
// tool result (crbro_boot). Medians over --runs. Non-gating: it prints, and
// with --out writes JSON; it never fails a build.
//
//   npm run build && node benchmarks/daemon/startup.mjs [--dist DIR] [--runs 5]
//        [--neurons 150] [--slow-wait 17] [--skip-slow] [--trace] [--out FILE]
//
// Everything runs on a throwaway brain and home folder under the OS temp dir,
// with CRBRO_SEMANTIC=0 (no model download), CRBRO_MOD=0 and CRBRO_AUTOBACKUP=0.
// Every daemon it starts is stopped before it exits. --dist points at another
// compiled tree (for example a copy of the previous release) to compare.

import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const flag = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const has = name => process.argv.includes(name);
const DIST = resolve(flag('--dist', join(HERE, '..', '..', 'dist')));
const RUNS = Number(flag('--runs', '5'));
const NEURONS = Number(flag('--neurons', '150'));
const SLOW_WAIT_S = Number(flag('--slow-wait', '17'));
const OUT = flag('--out', null);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const holder = mkdtempSync(join(tmpdir(), 'crbro-startup-bench-'));
const brain = join(holder, 'brain');
const home = join(holder, 'home');
mkdirSync(home, { recursive: true });
const sandbox = {
  CRBRO_PATH: brain, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'),
  CRBRO_KEYS_DIR: join(home, 'keys'), CRBRO_BACKUP_DIR: join(home, 'backups'),
  CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CRBRO_SEMANTIC: '0', CRBRO_MOD: '0', CRBRO_AUTOBACKUP: '0', CRBRO_DAEMON_IDLE_MIN: '3',
};
Object.assign(process.env, sandbox);   // the in-process seeding below reads the same brain, and only it

const ep = await import(pathToFileURL(join(DIST, 'daemon', 'endpoint.js')).href);
const { controlDaemon } = await import(pathToFileURL(join(DIST, 'daemon', 'proxy.js')).href);

async function seed() {
  const { createServer, createEngines } = await import(pathToFileURL(join(DIST, 'server.js')).href);
  const { LoopbackTransport } = await import(pathToFileURL(join(DIST, 'daemon', 'lines.js')).href);
  const pending = new Map();
  const t = new LoopbackTransport(line => { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); });
  const engines = createEngines();
  const server = createServer(engines);
  await server.connect(t);
  let id = 0;
  const rpc = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); t.receive(JSON.stringify({ jsonrpc: '2.0', id: i, method, params })); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'seed', version: '1' } });
  await rpc('tools/call', { name: 'crbro_boot', arguments: {} });
  const words = ['deploy', 'factura', 'cliente', 'puerto', 'staging', 'backup', 'índice', 'migración', 'pipeline', 'reunión'];
  for (let n = 0; n < NEURONS; n++) {
    const topic = `Proyecto ${n} ${words[n % words.length]}`;
    await rpc('tools/call', { name: 'crbro_learn', arguments: { topic, type: 'fact', content: `El ${words[(n + 3) % words.length]} de ${topic} usa el puerto ${8000 + n} y lo lleva el equipo ${n % 7}.` } });
    await rpc('tools/call', { name: 'crbro_learn', arguments: { topic, type: 'decision', content: `Para ${topic} se decidió ${words[(n + 5) % words.length]} los lunes.` } });
  }
  await engines.searchEngine.flush();   // the index on disk, as a brain in use has it
  await server.close();
}

/** One launch: spawn, wait `waitMs`, initialize, initialized, crbro_boot. Times from the spawn. */
function launch(daemon, { waitMs = 0, trace = false } = {}) {
  return new Promise(resolveRun => {
    const env = { ...process.env, ...sandbox, CRBRO_DAEMON: daemon ? '1' : '0', ...(trace ? { CRBRO_STARTUP_TRACE: '1' } : {}) };
    const t0 = performance.now();
    const child = spawn(process.execPath, [join(DIST, 'index.js')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const r = { wait_ms: waitMs };
    let buf = '', err = '', tInit = 0, finished = false;
    const finish = why => {
      if (finished) return;
      finished = true;
      r.end = why;
      r.stderr = err.trim();
      clearTimeout(guard);
      child.once('exit', () => resolveRun(r));
      try { child.stdin.end(); } catch { /* gone */ }
      setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 5_000).unref();
    };
    const guard = setTimeout(() => finish('timeout 90 s'), 90_000 + waitMs);
    child.stderr.on('data', d => { err += d; });
    child.stdout.on('data', d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          r.initialize_ms = Math.round(performance.now() - t0);
          r.initialize_after_send_ms = Math.round(performance.now() - tInit);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'crbro_boot', arguments: {} } })}\n`);
        } else if (m.id === 2) {
          r.first_tool_ms = Math.round(performance.now() - t0);
          r.first_tool_after_init_ms = Math.round(performance.now() - tInit);
          r.tool_error = !!(m.error || m.result?.isError);
          finish('ok');
        }
      }
    });
    setTimeout(() => {
      tInit = performance.now();
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'startup-bench', version: '1' } } })}\n`);
    }, waitMs);
  });
}

async function daemons() {
  const out = [];
  for (const st of await ep.listStates(brain)) { const s = await controlDaemon(brain, 'status', st.build); if (s) out.push(s); }
  return out;
}
async function stopDaemons() {
  for (const st of await ep.listStates(brain)) await controlDaemon(brain, 'stop', st.build);
  const until = Date.now() + 15_000;
  while ((await daemons()).length && Date.now() < until) await sleep(200);
  await sleep(300);
}
const logLines = re => {
  try { return readFileSync(join(brain, '.daemon', 'daemon.log'), 'utf8').split('\n').filter(l => re.test(l)).length; } catch { return 0; }
};
const median = (rows, k) => {
  const v = rows.map(x => x[k]).filter(x => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const summary = rows => ({
  runs: rows.length,
  initialize_ms: median(rows, 'initialize_ms'),
  first_tool_ms: median(rows, 'first_tool_ms'),
  errors: rows.filter(x => x.end !== 'ok' || x.tool_error).length,
});

const results = { date: new Date().toISOString().slice(0, 10), node: process.version, platform: process.platform, dist: DIST, neurons: NEURONS, runs: RUNS, scenarios: {} };
let code = 0;
try {
  const ts = performance.now();
  await seed();
  console.log(`\n══ Start-up · ${NEURONS * 2} entries in ${NEURONS} neurons (seeded in ${Math.round(performance.now() - ts)} ms) · ${DIST} ══\n`);
  const show = (name, s) => console.log(`  ${name.padEnd(13)} initialize ${String(s.initialize_ms).padStart(6)} ms · first tool ${String(s.first_tool_ms).padStart(6)} ms · runs ${s.runs}${s.errors ? ` · ${s.errors} FAILED` : ''}${s.note ? ` · ${s.note}` : ''}`);

  // classic
  const classic = [];
  for (let i = 0; i < RUNS; i++) classic.push(await launch(false, { trace: has('--trace') && i === 0 }));
  if (has('--trace')) console.log(`  trace (classic):\n${classic[0].stderr.split('\n').filter(l => l.includes('trace')).map(l => `    ${l}`).join('\n')}`);
  results.scenarios.classic = { ...summary(classic), rows: classic.map(({ stderr, ...x }) => x) };
  show('classic', results.scenarios.classic);

  // proxy that must start the daemon
  const spawnRows = [];
  for (let i = 0; i < RUNS; i++) {
    await stopDaemons();
    spawnRows.push(await launch(true, { trace: has('--trace') && i === 0 }));
  }
  if (has('--trace')) console.log(`  trace (proxy-spawn):\n${spawnRows[0].stderr.split('\n').filter(l => l.includes('trace')).map(l => `    ${l}`).join('\n')}`);
  results.scenarios.proxy_spawn = { ...summary(spawnRows), rows: spawnRows.map(({ stderr, ...x }) => x) };
  show('proxy-spawn', results.scenarios.proxy_spawn);

  // proxy with the daemon warm (the last spawn run left one running)
  if (!(await daemons()).length) await launch(true);
  const warm = [];
  for (let i = 0; i < RUNS; i++) warm.push(await launch(true));
  results.scenarios.proxy_warm = { ...summary(warm), rows: warm.map(({ stderr, ...x }) => x) };
  show('proxy-warm', results.scenarios.proxy_warm);

  // a client that waits before initialize
  if (!has('--skip-slow')) {
    if (!(await daemons()).length) await launch(true);
    const before = logLines(/handshake timeout/);
    const slow = await launch(true, { waitMs: SLOW_WAIT_S * 1000 });
    const refusals = logLines(/handshake timeout/) - before;
    const gaveUp = /lost \d+ times|staying in-process/.test(slow.stderr);
    results.scenarios.slow_client = {
      wait_s: SLOW_WAIT_S, initialize_after_send_ms: slow.initialize_after_send_ms, first_tool_after_init_ms: slow.first_tool_after_init_ms,
      handshake_timeouts_in_daemon_log: refusals, proxy_gave_up_on_daemons: gaveUp, end: slow.end, tool_error: slow.tool_error,
    };
    console.log(`  slow-client   waited ${SLOW_WAIT_S} s · initialize ${slow.initialize_after_send_ms} ms after sending it · first tool ${slow.first_tool_after_init_ms} ms after that · ${refusals} handshake timeout(s) in daemon.log${gaveUp ? ' · the proxy GAVE UP on daemons' : ''}`);
  }
  console.log('');
} catch (err) {
  console.error('  startup bench aborted:', err);
  code = 1;
} finally {
  try { await stopDaemons(); } catch { /* best effort */ }
  const left = await daemons().catch(() => []);
  if (left.length) console.error(`  ⚠️  ${left.length} daemon(s) still answering in ${brain}`);
  if (OUT) writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
  try { rmSync(holder, { recursive: true, force: true }); } catch { /* Windows may hold a handle for a moment */ }
  if (existsSync(holder)) console.error(`  (left ${holder} behind: a handle was still open)`);
  process.exit(code);
}
