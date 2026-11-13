#!/usr/bin/env node
// Index at scale, on a synthetic brain (synthetic-brain.mjs): file size,
// process memory, rebuild time, crbro_boot with a fresh and with a stale
// index, and how many neurons the probe words find. Lexical only unless
// CRBRO_SEMANTIC says otherwise. Every run lives in a temporary folder; the
// real brain is never read.
//
// Usage: node benchmarks/retrieval/scale.mjs [--json] [--keep]
//   (internal: --phase build|boot|stale|probes <brainDir>)

import { mkdtempSync, rmSync, statSync, utimesSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');
const imp = p => import(pathToFileURL(join(DIST, p)).href);

const phaseIdx = process.argv.indexOf('--phase');
if (phaseIdx >= 0) {
  const phase = process.argv[phaseIdx + 1];
  const dir = process.argv[phaseIdx + 2];
  process.env.CRBRO_SEMANTIC ??= '0';
  process.env.CRBRO_AUTOBACKUP = '0';
  process.env.CRBRO_MOD = '0';
  process.env.CRBRO_PATH = dir;
  const out = {};
  const gcRss = () => { if (global.gc) global.gc(); return Math.round(process.memoryUsage().rss / 1048576); };
  if (phase === 'build' || phase === 'probes') {
    const { Brain } = await imp('engine/brain.js');
    const { SearchEngine } = await imp('search/index.js');
    const brain = new Brain(dir);
    const engine = new SearchEngine(brain);
    const t0 = performance.now();
    await engine.init();
    out.init_ms = Math.round(performance.now() - t0);
    await engine.persist();
    out.rss_mb = gcRss();
    out.index_mb = Math.round(statSync(brain.paths.chunksIndex()).size / 104857.6) / 10;
    if (phase === 'probes') {
      const probes = {};
      for (const w of ['diseño', 'diseno', 'título', 'titulo', 'categoría', 'categoria', 'España', 'espana']) {
        const stats = {};
        await engine.search(w, { limit: 1000, stats });
        probes[w] = stats.matched_neurons ?? 0;
      }
      out.probes_neurons_found = probes;
      const t1 = performance.now();
      for (let i = 0; i < 20; i++) await engine.search('diseño de la cabecera con más contraste', { limit: 5 });
      out.search_ms_avg = Math.round((performance.now() - t1) / 20);
    }
  } else if (phase === 'boot') {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { createServer } = await imp('server.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer().connect(st);
    const client = new Client({ name: 'scale', version: '1.0.0' });
    await client.connect(ct);
    const t0 = performance.now();
    await client.callTool({ name: 'crbro_boot', arguments: {} });
    out.boot_ms = Math.round(performance.now() - t0);
    out.rss_mb = gcRss();
    await client.close();
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

const JSON_OUT = process.argv.includes('--json');
const KEEP = process.argv.includes('--keep');
const holder = mkdtempSync(join(tmpdir(), 'crbro-scale-'));
const dir = join(holder, 'brain');
const { generateBrain } = await import(pathToFileURL(join(HERE, 'synthetic-brain.mjs')).href);
const brainInfo = await generateBrain(dir, {});

const run = (phase) => {
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--phase', phase, dir],
    { encoding: 'utf8', env: { ...process.env, HOME: holder, USERPROFILE: holder } });
  if (r.status !== 0) throw new Error(`phase ${phase} failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
};
const touchOne = () => {
  const cortex = join(dir, 'cortex');
  const f = readdirSync(cortex).find(x => x.endsWith('.json'));
  const later = new Date(Date.now() + 5000);
  utimesSync(join(cortex, f), later, later);
};

const build = run('probes');
const bootFresh = [run('boot'), run('boot'), run('boot')].map(x => x.boot_ms).sort((a, b) => a - b)[1];
const stale = [];
for (let i = 0; i < 3; i++) { touchOne(); stale.push(run('boot')); }
const bootStale = stale.map(x => x.boot_ms).sort((a, b) => a - b)[1];
const out = {
  brain: { neurons: brainInfo.neurons, entries: brainInfo.entries, median_entry_chars: brainInfo.median_entry_chars,
    cortex_mb: Math.round(brainInfo.chars / 104857.6) / 10, probe_entries: brainInfo.probes },
  rebuild_ms: build.init_ms, index_mb: build.index_mb, rss_mb_engine_loaded: build.rss_mb,
  search_ms_avg: build.search_ms_avg,
  probes_neurons_found: build.probes_neurons_found,
  boot_ms_fresh_index: bootFresh, boot_ms_stale_index: bootStale, rss_mb_after_boot: stale[1].rss_mb,
  semantic: process.env.CRBRO_SEMANTIC ?? '0',
};
if (!KEEP) rmSync(holder, { recursive: true, force: true }); else out.dir = dir;
console.log(JSON_OUT ? JSON.stringify(out, null, 2) : out);
