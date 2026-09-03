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

// ─── IA en el bucle (informativo, NO pre-registrado; 1.15) ──────────
// CRBRO_BENCH_KEYS=<json>: palabras clave por hecho ({id: orden del fixture, keys}).
// CRBRO_BENCH_ALTS=<json>: reformulaciones por consulta ({id: q<i>|d<i>, alts}),
// buscadas junto a la original con searchMany. Cada archivo lo escribe un
// modelo que NO ha visto la otra mitad del examen; el script no juzga eso.
const KEYS = process.env.CRBRO_BENCH_KEYS
  ? new Map(JSON.parse(readFileSync(process.env.CRBRO_BENCH_KEYS, 'utf8')).map(e => [e.id, e.keys])) : null;
const ALTS = process.env.CRBRO_BENCH_ALTS
  ? new Map(JSON.parse(readFileSync(process.env.CRBRO_BENCH_ALTS, 'utf8')).map(e => [e.id, e.alts])) : null;
const buscar = (q, id, opts) => (ALTS && ALTS.get(id)) ? engine.searchMany([q, ...ALTS.get(id)], opts) : engine.search(q, opts);

const textoPorEtiqueta = new Map();
let indice = 0;
for (const n of fixture.neurons) {
  for (const f of n.facts) {
    const keys = KEYS ? (KEYS.get(indice) || []) : undefined;
    await cortex.learn(n.name, 'fact', f.text, { domain: n.domain, keys });
    indice++;
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
const res = { motor: { at1: 0, at3: 0, mrr: 0 }, control: { at1: 0, at3: 0 }, fallos: [],
              // Informativo, NO pre-registrado (añadido en 1.13 junto a las
              // funciones que mide): el hecho esperado entre matching_content
              // y also_matched, y cuántos top-1 reales salen marcados "strong".
              conAlso: { at1: 0, at3: 0 }, top1Strong: 0 };
const scoresReales = [];

for (const [qi, q] of qs.queries.entries()) {
  const esperado = textoPorEtiqueta.get(q.expect_label);
  const hits = await buscar(q.query, 'q' + qi, { limit: 10 });
  if (hits[0]) scoresReales.push(hits[0].relevance_score);
  if (hits[0] && hits[0].confidence === 'strong') res.top1Strong++;

  // Acierto a nivel de HECHO: el chunk devuelto es el texto esperado.
  const pos = hits.findIndex(h => h.matching_content === esperado.text);
  if (pos === 0) res.motor.at1++;
  if (pos >= 0 && pos < 3) res.motor.at3++;
  if (pos >= 0) res.motor.mrr += 1 / (pos + 1);
  else res.fallos.push({ query: q.query, label: q.expect_label });

  const posAlso = hits.findIndex(h => h.matching_content === esperado.text
    || (h.also_matched || []).some(a => a.text === esperado.text));
  if (posAlso === 0) res.conAlso.at1++;
  if (posAlso >= 0 && posAlso < 3) res.conAlso.at3++;

  const c = substringSearch(q.query);
  const posC = c.findIndex(d => d.text === esperado.text);
  if (posC === 0) res.control.at1++;
  if (posC >= 0 && posC < 3) res.control.at3++;
}

// ─── Distractores: el precio de responder cuando no hay nada ───────
scoresReales.sort((a, b) => a - b);
const p25 = scoresReales[Math.floor(scoresReales.length * 0.25)] || 0;
let distConAlgo = 0, distConfiados = 0, distWeak = 0;
for (const [di, d] of qs.distractors.entries()) {
  const hits = await buscar(d, 'd' + di, { limit: 3 });
  if (hits.length > 0) {
    distConAlgo++;
    if (hits[0].relevance_score >= p25) distConfiados++;
    if (hits[0].confidence === 'weak') distWeak++;
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
  // No pre-registrado — informativo, añadido en 1.13 con las funciones que mide.
  informativo_1_13: {
    sinonimos: process.env.CRBRO_SYNONYMS === '0' ? 'off' : 'on',
    'con_also_matched recall@1': pct(res.conAlso.at1),
    'con_also_matched recall@3': pct(res.conAlso.at3),
    reales_top1_strong: `${res.top1Strong}/${N}`,
    distractores_marcados_weak: `${distWeak}/${distConAlgo}`,
  },
  ia_en_el_bucle_1_15: { keywords: KEYS ? 'on' : 'off', alternativas: ALTS ? 'on' : 'off' },
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
  console.log(`  [1.13, informativo] sinónimos ${out.informativo_1_13.sinonimos} · con also_matched recall@1 ${out.informativo_1_13['con_also_matched recall@1']} · recall@3 ${out.informativo_1_13['con_also_matched recall@3']} · top-1 reales "strong" ${out.informativo_1_13.reales_top1_strong} · distractores marcados "weak" ${out.informativo_1_13.distractores_marcados_weak}`);
  if (KEYS || ALTS) console.log(`  [1.15, IA en el bucle] keywords ${KEYS ? 'on' : 'off'} · alternativas ${ALTS ? 'on' : 'off'}`);
  if (res.fallos.length) {
    console.log(`  no encontradas en top-10 (${res.fallos.length}):`);
    for (const f of res.fallos.slice(0, 10)) console.log(`    · «${f.query}» → ${f.label}`);
  }
  console.log('');
}
