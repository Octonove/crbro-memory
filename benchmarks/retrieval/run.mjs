#!/usr/bin/env node
// Benchmark de recuperación: ¿lo guardado se encuentra?
//
// Metodología (las lecciones honestas del benchmark de Ponytail, aplicadas):
// - Las consultas las escribió alguien que SOLO vio una etiqueta de una línea
//   por hecho, jamás el texto guardado. Si quien escribe la consulta vio el
//   texto, BM25 acierta por fuga de vocabulario y el benchmark es teatro.
// - 14 consultas-distractor sobre temas que NO están guardados: una memoria
//   que devuelve algo con confianza cuando no hay nada es el modo de fallo
//   silencioso, y se mide, no se esconde.
// - Brazo de control: búsqueda por subcadena ingenua, para demostrar qué
//   aporta (o no) el motor real.
// - Determinista: mismo resultado en cada ejecución, cero coste de API.
//
// El fixture y las consultas se congelan en git ANTES de medir: el historial
// es el pre-registro. Editar las consultas después de ver los números es
// exactamente lo que este montaje existe para impedir.
//
// Uso: node benchmarks/retrieval/run.mjs [--json]

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');

const fixture = JSON.parse(readFileSync(join(HERE, 'fixture.json'), 'utf8'));
const qs = JSON.parse(readFileSync(join(HERE, 'queries.json'), 'utf8'));

const { Brain } = await import(pathToFileURL(join(DIST, 'engine/brain.js')).href);
const { Cortex } = await import(pathToFileURL(join(DIST, 'engine/cortex.js')).href);
const { SearchEngine } = await import(pathToFileURL(join(DIST, 'search/index.js')).href);

// ─── Montar el cerebro desde el fixture ────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'crbro-bench-'));
const brain = new Brain(root);
await brain.initialize();
const cortex = new Cortex(brain);
const engine = new SearchEngine(brain);
await engine.init();
cortex.setIndexer(n => engine.indexNeuron(n));

const textoPorEtiqueta = new Map();
for (const n of fixture.neurons) {
  for (const f of n.facts) {
    await cortex.learn(n.name, 'fact', f.text, { domain: n.domain });
    textoPorEtiqueta.set(f.label, { text: f.text, neuron: n.name });
  }
}

// ─── Brazo de control: subcadena ingenua ───────────────────────────
const todos = [];
for (const n of fixture.neurons) for (const f of n.facts) todos.push({ neuron: n.name, text: f.text });
function substringSearch(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 3);
  return todos
    .map(d => ({ ...d, score: terms.filter(t => d.text.toLowerCase().includes(t)).length }))
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ─── Medición ──────────────────────────────────────────────────────
const res = { motor: { at1: 0, at3: 0, mrr: 0 }, control: { at1: 0, at3: 0 }, fallos: [] };
const scoresReales = [];

for (const q of qs.queries) {
  const esperado = textoPorEtiqueta.get(q.expect_label);
  const hits = await engine.search(q.query, { limit: 10 });
  if (hits[0]) scoresReales.push(hits[0].relevance_score);

  // Acierto a nivel de HECHO: el chunk devuelto es el texto esperado.
  const pos = hits.findIndex(h => h.matching_content === esperado.text);
  if (pos === 0) res.motor.at1++;
  if (pos >= 0 && pos < 3) res.motor.at3++;
  if (pos >= 0) res.motor.mrr += 1 / (pos + 1);
  else res.fallos.push({ query: q.query, label: q.expect_label });

  const c = substringSearch(q.query);
  const posC = c.findIndex(d => d.text === esperado.text);
  if (posC === 0) res.control.at1++;
  if (posC >= 0 && posC < 3) res.control.at3++;
}

// ─── Distractores: el precio de responder cuando no hay nada ───────
scoresReales.sort((a, b) => a - b);
const p25 = scoresReales[Math.floor(scoresReales.length * 0.25)] || 0;
let distConAlgo = 0, distConfiados = 0;
for (const d of qs.distractors) {
  const hits = await engine.search(d, { limit: 3 });
  if (hits.length > 0) {
    distConAlgo++;
    if (hits[0].relevance_score >= p25) distConfiados++;
  }
}

rmSync(root, { recursive: true, force: true });

// ─── Informe ───────────────────────────────────────────────────────
const N = qs.queries.length, D = qs.distractors.length;
const pct = x => (100 * x / N).toFixed(0) + '%';
const out = {
  queries: N,
  motor: {
    'recall@1': pct(res.motor.at1),
    'recall@3': pct(res.motor.at3),
    mrr: (res.motor.mrr / N).toFixed(3),
  },
  control_subcadena: { 'recall@1': pct(res.control.at1), 'recall@3': pct(res.control.at3) },
  distractores: {
    total: D,
    devuelven_algo: distConAlgo,
    con_confianza_de_acierto: distConfiados,
    nota: 'confianza = score del top-1 >= percentil 25 de los scores de consultas reales',
  },
  fallos: res.fallos,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('\n══ Benchmark de recuperación (consultas a ciegas) ══');
  console.log(`  consultas: ${N} · distractores: ${D} · hechos en el cerebro: ${todos.length}`);
  console.log(`  motor BM25    recall@1 ${out.motor['recall@1'].padStart(4)} · recall@3 ${out.motor['recall@3'].padStart(4)} · MRR ${out.motor.mrr}`);
  console.log(`  control       recall@1 ${out.control_subcadena['recall@1'].padStart(4)} · recall@3 ${out.control_subcadena['recall@3'].padStart(4)}   (subcadena ingenua)`);
  console.log(`  distractores  ${distConAlgo}/${D} devuelven algo · ${distConfiados}/${D} con score de nivel "acierto"`);
  if (res.fallos.length) {
    console.log(`  no encontradas en top-10 (${res.fallos.length}):`);
    for (const f of res.fallos.slice(0, 10)) console.log(`    · «${f.query}» → ${f.label}`);
  }
  console.log('');
}
