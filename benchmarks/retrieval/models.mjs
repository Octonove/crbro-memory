// Uso: CRBRO_SEMANTIC=1 [CRBRO_SEMANTIC_MODEL=<modelo>] node benchmarks/retrieval/models.mjs
// Mide el modelo SOLO (sin BM25) sobre el fixture: recall a nivel de hecho,
// cosenos, tiempos y RAM. Requiere el runtime instalado (semantic install);
// el modelo se descarga la primera vez. Resultados en README.md de esta carpeta.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SemanticIndex, semanticModel } from '../../dist/search/semantic.js';

const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const qs = JSON.parse(readFileSync(new URL('./queries.json', import.meta.url), 'utf8'));
const facts = [];
for (const n of fixture.neurons) for (const f of n.facts) facts.push({ id: 'f' + facts.length, text: f.text, label: f.label, neuron: n.name });
const byLabel = new Map(facts.map(f => [f.label, f]));
const queries = qs.queries;
const distractors = (qs.distractors || qs.distractores || []).map(d => (typeof d === 'string' ? d : d.query));
console.log(`claves queries.json: ${Object.keys(qs).join(', ')} · hechos ${facts.length} · consultas ${queries.length} · distractores ${distractors.length}`);

const dir = mkdtempSync(path.join(os.tmpdir(), 'crbro-model-'));
const idx = new SemanticIndex(dir);
const mb = () => Math.round(process.memoryUsage().rss / 1048576);
const rss0 = mb();
let t = performance.now();
await idx.upsert([facts[0]]);
const cold = performance.now() - t;
t = performance.now();
await idx.upsert(facts.slice(1));
const perLine = (performance.now() - t) / (facts.length - 1);
const rss1 = mb();

let r1 = 0, r3 = 0; const realTop = []; const fallos = [];
t = performance.now();
for (const q of queries) {
  const hits = await idx.query(q.query, 3);
  const exp = byLabel.get(q.expect_label);
  const pos = hits.findIndex(h => h.id === exp.id);
  if (pos === 0) r1++;
  if (pos >= 0) r3++;
  if (pos !== 0) fallos.push(`${q.query} (pos ${pos})`);
  realTop.push(hits[0].score);
}
const perQuery = (performance.now() - t) / queries.length;
const disTop = [];
for (const d of distractors) { const hits = await idx.query(d, 1); disTop.push(hits[0].score); }
const st = a => { const s = [...a].sort((x, y) => x - y); return s.length ? `min ${s[0].toFixed(3)} · med ${s[Math.floor(s.length / 2)].toFixed(3)} · max ${s[s.length - 1].toFixed(3)}` : 'n/a'; };
const pct = n => Math.round(100 * n / queries.length) + '%';

console.log(`\nMODELO ${semanticModel()} · dim ${idx['dim']} · vectores ${idx.count()}`);
console.log(`  solo vectores: recall@1 ${pct(r1)} · recall@3 ${pct(r3)}`);
console.log(`  cosenos top-1 reales: ${st(realTop)}`);
console.log(`  cosenos top-1 distractores: ${st(disTop)}`);
console.log(`  carga en frío + 1ª línea ${(cold / 1000).toFixed(1)} s · ${perLine.toFixed(0)} ms/línea · ${perQuery.toFixed(0)} ms/consulta · RAM +${rss1 - rss0} MB (RSS ${rss1} MB)`);
console.log(`  fallos @1 (${fallos.length}):`);
for (const f of fallos) console.log(`    · ${f}`);
rmSync(dir, { recursive: true, force: true });
