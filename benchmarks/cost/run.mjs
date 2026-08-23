#!/usr/bin/env node
// La cifra en contra, publicada voluntariamente.
//
// No es una afirmación de venta: es el ancla de credibilidad, calcada de
// Ponytail admitiendo "caveman +7% tokens". CRBRO no es gratis — el boot
// inyecta contexto en cada sesión, el recall lee del índice, el cerebro
// ocupa disco. Se mide y se pone al lado de los beneficios, no escondido.
//
// Determinista, cero API. Uso: node benchmarks/cost/run.mjs [--json]

import { readFileSync, statSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist');

// Aproximación de tokens estándar: ~4 caracteres por token en inglés/español.
const toks = chars => Math.round(chars / 4);

// ─── 1. El contexto que inyecta el arranque ────────────────────────
// El bloque de protocolos que crbro_boot (y ahora cada subagente) añade.
const enforcement = join(HERE, '..', '..', '..', 'synthetica-decks', 'skills', 'zero-protocol.enforcement.txt');
let bootChars = 0;
if (existsSync(enforcement)) bootChars = readFileSync(enforcement, 'utf8').length;

// El hook de subagente inyecta el mismo bloque en CADA subagente.
const hookChars = bootChars;

// ─── 2. Latencia de recall (local, sin red) ────────────────────────
const { Brain } = await import(pathToFileURL(join(DIST, 'engine/brain.js')).href);
const { Cortex } = await import(pathToFileURL(join(DIST, 'engine/cortex.js')).href);
const { SearchEngine } = await import(pathToFileURL(join(DIST, 'search/index.js')).href);

const root = mkdtempSync(join(tmpdir(), 'crbro-cost-'));
const brain = new Brain(root);
await brain.initialize();
const cortex = new Cortex(brain);
const engine = new SearchEngine(brain);
await engine.init();
cortex.setIndexer(n => engine.indexNeuron(n));

// Sembrar 300 hechos variados para una latencia representativa.
for (let i = 0; i < 300; i++) {
  await cortex.learn(`Tema ${i % 40}`, 'fact',
    `Hecho ${i}: detalle específico número ${i * 7} sobre el sistema con id abc${i} y ruta /var/x/${i}.`);
}

const consultas = ['backup nocturno bucket', 'plantilla elementor widget', 'token despliegue',
  'cron a las tres', 'sitemap urls', 'cache purgar', 'cliente factura marzo', 'seo palabra clave'];
const t0 = process.hrtime.bigint();
let vueltas = 0;
for (let r = 0; r < 20; r++) for (const q of consultas) { await engine.search(q, { limit: 10 }); vueltas++; }
const msRecall = Number(process.hrtime.bigint() - t0) / 1e6 / vueltas;

// ─── 3. Tamaño del cerebro en disco (el real del usuario si existe) ─
function dirSize(d) {
  let total = 0;
  try {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      total += st.isDirectory() ? dirSize(p) : st.size;
    }
  } catch { /* no existe */ }
  return total;
}
const brainReal = join(homedir(), '.crbro');
const cortexReal = join(brainReal, 'cortex');
const neuronas = existsSync(cortexReal) ? readdirSync(cortexReal).filter(f => f.endsWith('.json')).length : 0;
const discoMB = existsSync(brainReal) ? (dirSize(brainReal) / 1e6).toFixed(1) : 'n/a';
const indiceMB = existsSync(join(brainReal, '.search'))
  ? (dirSize(join(brainReal, '.search')) / 1e6).toFixed(1) : 'n/a';

rmSync(root, { recursive: true, force: true });

const out = {
  contexto_por_sesion: { caracteres: bootChars, tokens_aprox: toks(bootChars),
    nota: 'lo que el boot añade al prompt de cada sesión (bloque de protocolos)' },
  contexto_por_subagente: { caracteres: hookChars, tokens_aprox: toks(hookChars),
    nota: 'el hook SubagentStart inyecta lo mismo en cada subagente que se lanza' },
  latencia_recall_ms: Number(msRecall.toFixed(2)),
  latencia_nota: 'búsqueda local en el índice, sin red, cerebro de 300 hechos',
  cerebro_real: { neuronas, disco_MB: discoMB, indice_busqueda_MB: indiceMB },
  frase_honesta: 'En una sesión sin memoria relevante, CRBRO añade estos tokens de contexto y esta latencia local; se amortiza cuando hay algo que recordar.',
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('\n══ El coste de CRBRO (la cifra en contra) ══');
  console.log(`  contexto/sesión     ~${toks(bootChars)} tokens (${bootChars} car.) — el bloque de protocolos del boot`);
  console.log(`  contexto/subagente  ~${toks(hookChars)} tokens — el hook inyecta lo mismo en cada subagente`);
  console.log(`  latencia de recall  ${msRecall.toFixed(2)} ms (local, sin red, 300 hechos)`);
  console.log(`  cerebro real        ${neuronas} neuronas · ${discoMB} MB en disco · índice ${indiceMB} MB`);
  console.log(`  ${out.frase_honesta}`);
  console.log('');
}
