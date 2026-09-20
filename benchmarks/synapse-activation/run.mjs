#!/usr/bin/env node
// Synapse-activation experiment — see PREREGISTRO.md (committed before this file).
//
//   node benchmarks/synapse-activation/run.mjs <backup.json.gz> [--json]
//
// Restores the backup into a temporary folder and measures known-item search
// on that COPY under three weights of CRBRO_SYNAPSE. The brain the backup came
// from is never opened. Writes results.json next to this file with --json.

import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');
const backup = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!backup) { console.error('usage: run.mjs <backup.json.gz> [--json]'); process.exit(1); }

process.env.CRBRO_SEMANTIC = '0';
process.env.CRBRO_AUTOBACKUP = '0';
delete process.env.CRBRO_RECENCY;
const ARMS = [['control', 0], ['A', 0.05], ['B', 0.10]];

// ── Set 1: the frozen blind benchmark, once per arm ──
const set1 = {};
for (const [arm, w] of ARMS) {
  const r = spawnSync(process.execPath, [join(HERE, '..', 'retrieval', 'run.mjs')],
    { env: { ...process.env, CRBRO_SYNAPSE: String(w) }, encoding: 'utf8' });
  const m = /recall@1\s+(\d+)% · recall@3\s+(\d+)% · MRR ([\d.]+)/.exec(r.stdout || '');
  set1[arm] = m ? { at1: +m[1], at3: +m[2], mrr: +m[3] } : { error: (r.stderr || 'no output').slice(0, 200) };
}

// ── Set 2: known-item search on a restored copy ──
const { restoreBackup } = await import(pathToFileURL(join(DIST, 'engine/backup.js')).href);
const { Brain } = await import(pathToFileURL(join(DIST, 'engine/brain.js')).href);
const { SearchEngine } = await import(pathToFileURL(join(DIST, 'search/index.js')).href);
const { factId } = await import(pathToFileURL(join(DIST, 'utils/hash.js')).href);
const { entryId } = await import(pathToFileURL(join(DIST, 'sync/ops.js')).href);

const holder = mkdtempSync(join(tmpdir(), 'crbro-synapse-exp-'));
const root = join(holder, 'brain');
await restoreBackup(backup, root);
const brain = new Brain(root);
await brain.initialize();
const engine = new SearchEngine(brain);
await engine.init();
await engine.rebuild();

const queries = [];
let conSinapsis = 0, neuronas = 0;
for (const f of readdirSync(join(root, 'cortex')).sort()) {
  const n = JSON.parse(readFileSync(join(root, 'cortex', f), 'utf8'));
  if (n.type === 'protocol') continue;
  neuronas++;
  const retirada = t => !!n.entry_status?.[entryId(t)];
  const vivas = [
    ...(n.facts || []).filter(x => x?.text && (!x.status || x.status === 'active')).map(x => ({ id: x.id || factId(x.text), text: x.text })),
    ...(n.patterns || []).filter(t => t && !retirada(t)).map(t => ({ id: entryId(t), text: t })),
    ...(n.errors || []).filter(t => t && !retirada(t)).map(t => ({ id: entryId(t), text: t })),
  ];
  if (vivas.length < 3) continue;
  const linked = (n.connections || []).length > 0;
  vivas.forEach((e, i) => {
    if (i % 5 !== 0) return;
    const w = [...new Set(e.text.toLowerCase().match(/[a-záéíóúñü]{6,}/g) || [])].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, 3);
    if (w.length < 3) return;
    queries.push({ q: w.join(' '), id: e.id, linked });
    if (linked) conSinapsis++;
  });
}

const medir = async (w) => {
  process.env.CRBRO_SYNAPSE = String(w);
  const all = { n: 0, at1: 0, at3: 0, mrr: 0 }, sub = { n: 0, at1: 0, at3: 0, mrr: 0 };
  for (const { q, id, linked } of queries) {
    const hits = await engine.search(q, { limit: 10 });
    const pos = hits.findIndex(h => h.entry_id === id);
    for (const b of linked ? [all, sub] : [all]) {
      b.n++;
      if (pos === 0) b.at1++;
      if (pos >= 0 && pos < 3) b.at3++;
      if (pos >= 0) b.mrr += 1 / (pos + 1);
    }
  }
  const pct = b => ({ n: b.n, at1: +(100 * b.at1 / b.n).toFixed(2), at3: +(100 * b.at3 / b.n).toFixed(2), mrr: +(b.mrr / b.n).toFixed(4) });
  return { all: pct(all), linked: sub.n ? pct(sub) : null };
};
const set2 = {};
for (const [arm, w] of ARMS) set2[arm] = await medir(w);
rmSync(holder, { recursive: true, force: true });

// ── Decision, by the pre-registered rule ──
const c = set2.control.all;
const gana = ARMS.slice(1).map(([arm]) => arm).filter(arm => {
  const a = set2[arm].all;
  return a.at3 - c.at3 >= 1.0 && a.at1 >= c.at1 && a.mrr >= c.mrr;
});
const inerte = ARMS.every(([arm]) => JSON.stringify(set1[arm]) === JSON.stringify(set1.control));
const decision = gana.length > 0 && inerte ? `ADOPT (${gana.join(', ')})` : 'DISCARD';

const out = { date: new Date().toISOString().slice(0, 10), neurons: neuronas, queries: queries.length, queries_on_linked_neurons: conSinapsis, set1, set2, inert_without_synapses: inerte, decision };
console.log(`\n══ Synapse activation — known-item search on a copy (${queries.length} queries, ${conSinapsis} on linked neurons) ══`);
for (const [arm, w] of ARMS) {
  const a = set2[arm].all, l = set2[arm].linked;
  console.log(`  ${arm.padEnd(8)} w=${String(w).padEnd(5)} all: r@1 ${a.at1}% · r@3 ${a.at3}% · MRR ${a.mrr}` + (l ? `   | linked only: r@1 ${l.at1}% · r@3 ${l.at3}% · MRR ${l.mrr}` : ''));
}
console.log(`  blind benchmark identical across arms: ${inerte}  ${JSON.stringify(set1.control)}`);
console.log(`  decision by the pre-registered rule: ${decision}\n`);
if (process.argv.includes('--json')) writeFileSync(join(HERE, 'results.json'), JSON.stringify(out, null, 2) + '\n');
process.exit(0);
