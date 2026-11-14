#!/usr/bin/env node
// Performance gate on a brain of realistic size (CI, nightly). Everything the
// unit tests cannot see: the 2.11 audit found a recall that took 2 s for
// minutes after an upgrade, and no test noticed because they run on tiny
// brains without the semantic layer.
//
// Builds the synthetic brain (benchmarks/retrieval/synthetic-brain.mjs: ~500
// neurons, ~7,000 entries, most with accents), starts the real server over
// stdio the way a client does, and measures:
//   keyword     first boot (index built), second boot, recall p50/p90, sizes, RSS
//   semantic    only when the runtime and model are installed: recall while the
//               vectors are still being filled in (the upgrade case), and after
// Exit code 1 when a budget is broken. Budgets are about three times what a
// workstation measures, because CI runners are slower and noisier.
//
// Usage: node benchmarks/perf/nightly.mjs [--out result.json] [--no-semantic]
//        [--neurons 500] [--entries 7000] [--semantic-wait 900]

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const out = flag('--out', null);
const withSemantic = !argv.includes('--no-semantic');
const neurons = Number(flag('--neurons', 500));
const entries = Number(flag('--entries', 7000));
const semanticWaitS = Number(flag('--semantic-wait', 900));

export const BUDGETS = {
  tools_list_chars: 30_000, boot_chars: 12_000, recall_chars: 12_000,
  first_boot_ms: 20_000, second_boot_ms: 6_000,
  keyword_recall_p50_ms: 200, keyword_recall_p90_ms: 600, keyword_rss_mb: 1_200,
  backfill_recall_p90_ms: 1_500, steady_recall_p50_ms: 400, steady_recall_p90_ms: 1_000,
};

const QUERIES = [
  'diseño de la página de inicio', 'configuración del servidor de hosting', 'campaña de anuncios', 'título del artículo del blog',
  'migración a Portugal', 'integración con Stripe', 'categoría principal España', 'guía de estilo',
];

const home = mkdtempSync(join(tmpdir(), 'crbro-perf-'));
const brain = join(home, 'brain');
const baseEnv = {
  ...process.env, HOME: home, USERPROFILE: home, CRBRO_PATH: brain, CRBRO_KEYS_DIR: join(home, 'keys'), CRBRO_BACKUP_DIR: join(home, 'backups'),
  CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), CRBRO_MOD: '0', CRBRO_AUTOBACKUP: '0', CRBRO_DAEMON: '0', CRBRO_HOOK_REFRESH: '0',
};

/** A minimal MCP client over stdio. */
function client(env) {
  const child = spawn(process.execPath, [join(root, 'dist', 'index.js')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', id = 0;
  const pending = new Map();
  child.stdout.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* not ours */ }
    }
  });
  const rpc = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const call = async (name, args = {}) => {
    const t = performance.now();
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.result?.content?.map(c => c.text || '').join('') || '';
    let json = null; try { json = JSON.parse(text); } catch { /* text */ }
    return { ms: performance.now() - t, chars: text.length, json, error: !!(r.error || r.result?.isError) };
  };
  return {
    child,
    async init() {
      const t = performance.now();
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'perf', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const tl = await rpc('tools/list', {});
      return { initialize_ms: performance.now() - t, tools_list_chars: JSON.stringify(tl.result).length };
    },
    call,
    async close() { try { child.stdin.end(); } catch { /* gone */ } await new Promise(r => { child.once('exit', r); setTimeout(() => { try { child.kill(); } catch { /* gone */ } r(); }, 10_000).unref(); }); },
  };
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
/** Resident memory of a process, where /proc says it (Linux); null elsewhere. */
const rssMb = pid => {
  try { return Math.round(Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024); } catch { return null; }
};

async function recalls(c, n) {
  const times = [];
  let chars = 0;
  for (let i = 0; i < n; i++) {
    const r = await c.call('crbro_recall', { query: QUERIES[i % QUERIES.length] });
    times.push(r.ms);
    if (i === 0) chars = r.chars;
  }
  return { p50: pct(times, 0.5), p90: pct(times, 0.9), max: Math.round(Math.max(...times)), chars };
}

const result = { when: new Date().toISOString(), node: process.version, platform: process.platform, brain: { neurons, entries }, metrics: {}, skipped: [] };
const m = result.metrics;
try {
  const { generateBrain } = await import(pathToFileURL(join(root, 'benchmarks', 'retrieval', 'synthetic-brain.mjs')).href);
  mkdirSync(brain, { recursive: true });
  await generateBrain(brain, { neurons, entries });

  // ── keyword engine ──
  const kenv = { ...baseEnv, CRBRO_SEMANTIC: '0' };
  let c = client(kenv);
  let t0 = performance.now();
  const h = await c.init();
  m.tools_list_chars = h.tools_list_chars;
  const boot1 = await c.call('crbro_boot', { project: 'perf' });
  m.first_boot_ms = Math.round(performance.now() - t0);
  m.boot_chars = boot1.chars;
  const kw = await recalls(c, 24);
  m.keyword_recall_p50_ms = kw.p50; m.keyword_recall_p90_ms = kw.p90; m.recall_chars = kw.chars;
  m.keyword_rss_mb = rssMb(c.child.pid);
  await c.close();
  c = client(kenv);
  t0 = performance.now();
  await c.init();
  await c.call('crbro_boot', { project: 'perf' });
  m.second_boot_ms = Math.round(performance.now() - t0);
  await c.close();

  // ── semantic layer, from an upgrade: no vectors yet ──
  // Read, never written by the measurement: CI points CRBRO_SEMANTIC_HOME at its cached copy.
  const semHome = process.env.CRBRO_SEMANTIC_HOME || join(homedir(), '.crbro', '.semantic');
  const senv = { ...baseEnv, CRBRO_SEMANTIC: '1', CRBRO_SEMANTIC_HOME: semHome };
  c = client(senv);
  await c.init();
  const st = (await c.call('crbro_inspect', { view: 'status' })).json?.semantic;
  if (!withSemantic || !st?.installed || !st?.model_downloaded) {
    result.skipped.push(withSemantic ? 'semantic: runtime or model not installed' : 'semantic: --no-semantic');
    await c.close();
  } else {
    await c.call('crbro_boot', { project: 'perf' });
    const during = [];
    const deadline = Date.now() + semanticWaitS * 1000;
    let calm = 0, filled = null;
    while (Date.now() < deadline) {
      const r = await c.call('crbro_recall', { query: QUERIES[during.length % QUERIES.length] });
      during.push(r.ms);
      const cov = (await c.call('crbro_inspect', { view: 'status' })).json?.semantic?.coverage;
      if (cov && cov.chunks > 0 && cov.vectors >= cov.chunks && r.json?.semantic !== 'warming') { if (++calm >= 3) { filled = Math.round((Date.now() - (deadline - semanticWaitS * 1000)) / 1000); break; } } else calm = 0;
      await new Promise(r2 => setTimeout(r2, 1500));
    }
    m.backfill_recalls = during.length;
    m.backfill_recall_p90_ms = pct(during, 0.9);
    m.backfill_recall_max_ms = Math.round(Math.max(...during));
    m.backfill_seconds = filled;
    if (filled === null) result.skipped.push(`semantic: vectors not complete after ${semanticWaitS} s (budget checked on what ran)`);
    else {
      const sd = await recalls(c, 24);
      m.steady_recall_p50_ms = sd.p50; m.steady_recall_p90_ms = sd.p90;
    }
    await c.close();
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

const broken = Object.entries(BUDGETS).filter(([k, limit]) => typeof m[k] === 'number' && m[k] > limit);
result.budgets = BUDGETS;
result.broken = broken.map(([k, limit]) => ({ metric: k, value: m[k], limit }));
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log('\n== Performance (synthetic brain, real server over stdio) ==');
for (const [k, v] of Object.entries(m)) console.log(`  ${k.padEnd(26)} ${String(v ?? 'n/a').padStart(8)}${BUDGETS[k] ? `   (budget ${BUDGETS[k]})` : ''}`);
for (const s of result.skipped) console.log(`  skipped: ${s}`);
if (broken.length) {
  console.error(`\nPerformance gate FAILED:\n${broken.map(([k, l]) => `- ${k} = ${m[k]} > ${l}`).join('\n')}`);
  process.exitCode = 1;
} else console.log('\nPerformance gate passed.');
