#!/usr/bin/env node
// Banco de recuperación en castellano (2.11).
//
// Mide lo que el banco de 48 hechos no ve: palabras con á, í, ú, ñ, ü (con y
// sin tilde en la consulta), compuestos con guion, paráfrasis (también en
// modo searchMany con frases alternativas), entradas largas con la respuesta
// al final, preguntas sin respuesta y una neurona gorda del mismo dominio
// (320 entradas) que comparte vocabulario con casi todas las consultas.
//
// Honestidad: lo escribió el mismo ingeniero que hizo los cambios, así que
// NO es a ciegas. Se congeló en git antes de medir los cambios de ranking.
//
// Uso:
//   node benchmarks/retrieval/es/run.mjs [--json] [--check] [--semantic]
// --check: solo léxico, compara con baseline.json (puerta de CI).
// --semantic: además, el brazo con la capa semántica si el runtime está
//   instalado (CRBRO_SEMANTIC_HOME); si no, lo dice y lo salta.

import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', '..', 'dist');
const imp = p => import(pathToFileURL(join(DIST, p)).href);
const CHECK = process.argv.includes('--check');
const JSON_OUT = process.argv.includes('--json');
const ARM = process.argv.includes('--arm') ? process.argv[process.argv.indexOf('--arm') + 1] : null;

// ─── Brazo hijo: un proceso por brazo, para que CRBRO_SEMANTIC se lea limpio ──
if (ARM) {
  process.env.CRBRO_SEMANTIC = ARM === 'semantic' ? '1' : '0';
  process.env.CRBRO_AUTOBACKUP = '0';
  process.env.CRBRO_MOD = '0';
  console.log(JSON.stringify(await runArm()));
  process.exit(0);
}

const arms = ['lexical'];
let semanticNote = null;
if (process.argv.includes('--semantic') && !CHECK) {
  const { resolveRuntime } = await imp('search/semantic.js');
  if (resolveRuntime()) arms.push('semantic');
  else semanticNote = 'semantic runtime not installed (CRBRO_SEMANTIC_HOME): semantic arm skipped';
}
const out = { arms: {} };
for (const arm of arms) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--arm', arm], { encoding: 'utf8', env: process.env, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`arm ${arm} failed:\n${r.stderr}`);
  out.arms[arm] = JSON.parse(r.stdout.trim().split('\n').pop());
}
if (semanticNote) out.note = semanticNote;

if (CHECK) {
  const base = JSON.parse(readFileSync(join(HERE, 'baseline.json'), 'utf8'));
  const m = out.arms.lexical;
  const fails = [];
  // One query of tolerance on each recall figure: the gate is for regressions, not for noise from a tie.
  if (m.answerable.at1 < base.at1 - 1) fails.push(`recall@1 ${m.answerable.at1}/${m.answerable.n} < baseline ${base.at1}`);
  if (m.answerable.at3 < base.at3 - 1) fails.push(`recall@3 ${m.answerable.at3}/${m.answerable.n} < baseline ${base.at3}`);
  if (m.by_type.acento.at1 < base.acento_at1) fails.push(`accent recall@1 ${m.by_type.acento.at1} < baseline ${base.acento_at1}`);
  if (m.by_type.compuesto.at1 < base.compuesto_at1) fails.push(`compound recall@1 ${m.by_type.compuesto.at1} < baseline ${base.compuesto_at1}`);
  if (m.long_part_shown < base.long_part_shown) fails.push(`long entries shown at the matching part ${m.long_part_shown} < baseline ${base.long_part_shown}`);
  if (m.unanswerable.no_answer < base.no_answer) fails.push(`no_answer on unanswerable ${m.unanswerable.no_answer} < baseline ${base.no_answer}`);
  if (m.unanswerable.top1_strong > base.unanswerable_strong) fails.push(`unanswerable marked strong ${m.unanswerable.top1_strong} > baseline ${base.unanswerable_strong}`);
  if (m.fat_neuron_top1_wrong > base.fat_neuron_top1_wrong) fails.push(`fat neuron wrongly first ${m.fat_neuron_top1_wrong} > baseline ${base.fat_neuron_top1_wrong}`);
  if (fails.length) { console.error(`Spanish retrieval gate FAILED:\n${fails.map(f => `- ${f}`).join('\n')}`); process.exitCode = 1; }
}

if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
else {
  console.log('\n══ Banco en castellano (tildes, compuestos, paráfrasis, largas, sin respuesta, neurona gorda) ══');
  for (const [arm, m] of Object.entries(out.arms)) {
    console.log(`  [${arm}] respondibles ${m.answerable.n}: recall@1 ${m.answerable.at1} · recall@3 ${m.answerable.at3} · MRR ${m.answerable.mrr}` +
      ` · searchMany (paráfrasis) recall@1 ${m.many.at1}/${m.many.n}`);
    console.log(`  [${arm}] por tipo: ${Object.entries(m.by_type).map(([t, v]) => `${t} ${v.at1}/${v.n}@1 ${v.at3}/${v.n}@3`).join(' · ')}`);
    console.log(`  [${arm}] largas con el tramo que casó: ${m.long_part_shown}/${m.long_n} · neurona gorda primera sin serlo: ${m.fat_neuron_top1_wrong} · en top-3: ${m.fat_neuron_top3}`);
    console.log(`  [${arm}] sin respuesta ${m.unanswerable.n}: no_answer ${m.unanswerable.no_answer} · filas medias ${m.unanswerable.avg_rows} · top-1 strong ${m.unanswerable.top1_strong} · caracteres medios ${m.unanswerable.avg_chars}`);
    console.log(`  [${arm}] respondibles marcadas strong en top-1: ${m.answerable.top1_strong}/${m.answerable.n}`);
  }
  if (out.note) console.log(`  ${out.note}`);
  console.log('');
}

// ─────────────────────────────────────────────────────────────────────
async function runArm() {
  const fixture = JSON.parse(readFileSync(join(HERE, 'fixture.json'), 'utf8'));
  const qs = JSON.parse(readFileSync(join(HERE, 'queries.json'), 'utf8'));
  const { Brain } = await imp('engine/brain.js');
  const { SearchEngine } = await imp('search/index.js');
  const { factId } = await imp('utils/hash.js');

  const holder = mkdtempSync(join(tmpdir(), 'crbro-bench-es-'));
  const brain = new Brain(join(holder, 'brain'));
  await brain.initialize();
  mkdirSync(brain.paths.cortex, { recursive: true });
  const day = '2026-06-01T10:00:00.000Z';
  const neuron = (id, name, domain, facts) => ({
    id, name, domain, type: id.split('_')[0] === 'tech' ? 'tech' : id.startsWith('process_') ? 'process' : 'project',
    created: day, last_accessed: day, access_count: 1, heat: 0.5, summary: '',
    facts: facts.map(text => ({ text, confidence: 0.9, added: day, source: 'bench', id: factId(text) })),
    decisions: [], patterns: [], preferences: [], connections: [], tags: [], errors: [], debts: [],
  });
  const write = n => writeFileSync(brain.paths.neuron(n.id), JSON.stringify(n, null, 2));

  const expected = new Map();   // "id#i" or "long:id" -> { neuron, eid, snippet }
  for (const n of fixture.neurons) {
    write(neuron(n.id, n.name, n.domain, n.facts));
    n.facts.forEach((t, i) => expected.set(`${n.id}#${i}`, { neuron: n.id, eid: factId(t) }));
  }
  // Long entries: ~4,000 characters of filler, the answer at the end.
  for (const [k, l] of fixture.long.entries()) {
    let text = '';
    for (let i = 0; text.length < 3800; i++) text += fixture.filler[(i * 3 + k) % fixture.filler.length] + ' ';
    text += l.answer;
    write(neuron(l.id, l.name, l.domain, [text]));
    expected.set(`long:${l.id}`, { neuron: l.id, eid: factId(text) });
  }
  // The fat neuron: 320 entries in the same domain and vocabulary.
  const clientes = ['Atlas', 'Brisa', 'Cumbre', 'Duna', 'Faro', 'Norte', 'Órbita', 'Sierra'];
  const cosas = ['la página de inicio', 'el diseño de la cabecera', 'la ficha de producto', 'el menú', 'la categoría de blog', 'el formulario',
    'la versión móvil', 'el servidor', 'las facturas', 'el certificado', 'las copias', 'el equipo', 'la app', 'el título de la portada'];
  const hechos = ['se revisó con el cliente', 'quedó pendiente de aprobación', 'se cambió tras la reunión', 'se documentó en la wiki',
    'tiene una incidencia abierta', 'se migró al nuevo tema', 'se presupuestó aparte', 'se probó en staging'];
  const gordos = [];
  for (let i = 0; i < 320; i++) {
    gordos.push(`En la web de ${clientes[i % clientes.length]}, ${cosas[(i * 7) % cosas.length]} ${hechos[(i * 5) % hechos.length]} (nota ${i + 1}); ` +
      `${cosas[(i * 11 + 3) % cosas.length]} ${hechos[(i * 3 + 1) % hechos.length]}.`);
  }
  write(neuron('project_notas_webs', 'Notas generales de webs', 'proyectos-web', gordos));
  const FAT = 'project_notas_webs';
  // And the 1,482 facts of the existing haystack (other areas of life, by
  // construction): so an unanswerable question meets the partial matches a
  // real brain offers, not an empty room.
  const pajar = new Map();
  for (const f of ['haystack-1.json', 'haystack-2.json', 'haystack-3.json']) {
    for (const n of JSON.parse(readFileSync(join(HERE, '..', f), 'utf8')).neurons) {
      const id = 'project_hay_' + n.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const prev = pajar.get(id) || { name: n.name, domain: n.domain || 'general', facts: [] };
      prev.facts.push(...n.facts.map(x => x.text));
      pajar.set(id, prev);
    }
  }
  for (const [id, n] of pajar) write(neuron(id, n.name, n.domain, [...new Set(n.facts)]));

  const engine = new SearchEngine(brain);
  await engine.init();
  await engine.awaitEmbeddings?.();

  const isHit = (r, e) => r.neuron_id === e.neuron && (r.entry_id === e.eid);
  const res = { answerable: { n: 0, at1: 0, at3: 0, mrr: 0, top1_strong: 0 }, many: { n: 0, at1: 0 }, by_type: {},
    long_n: 0, long_part_shown: 0, fat_neuron_top1_wrong: 0, fat_neuron_top3: 0, misses: [] };
  for (const q of qs.queries) {
    const e = expected.get(q.expect);
    const { results } = await engine.searchManyWithStats([q.q], { limit: 5 });
    const pos = results.findIndex(r => isHit(r, e));
    const t = (res.by_type[q.type] ||= { n: 0, at1: 0, at3: 0 });
    t.n++; res.answerable.n++;
    if (pos === 0) { t.at1++; res.answerable.at1++; }
    if (pos >= 0 && pos < 3) { t.at3++; res.answerable.at3++; }
    if (pos >= 0) res.answerable.mrr += 1 / (pos + 1); else res.misses.push(q.q);
    if (results[0]?.confidence === 'strong' && pos === 0) res.answerable.top1_strong++;
    if (results[0]?.neuron_id === FAT) res.fat_neuron_top1_wrong++;
    if (results.slice(0, 3).some(r => r.neuron_id === FAT)) res.fat_neuron_top3++;
    if (q.snippet) {
      res.long_n++;
      if (pos >= 0 && results[pos].matching_content.slice(0, 1200).includes(q.snippet)) res.long_part_shown++;
    }
    if (q.alts) {
      const many = await engine.searchManyWithStats([q.q, ...q.alts], { limit: 5 });
      res.many.n++;
      if (many.results[0] && isHit(many.results[0], e)) res.many.at1++;
    }
  }
  res.answerable.mrr = Math.round(res.answerable.mrr / res.answerable.n * 1000) / 1000;

  const un = { n: 0, no_answer: 0, rows: 0, chars: 0, top1_strong: 0 };
  for (const q of qs.unanswerable) {
    const r = await engine.searchManyWithStats([q], { limit: 5 });
    un.n++;
    if (r.no_answer) un.no_answer++;
    un.rows += r.results.length;
    un.chars += JSON.stringify(r.results).length;
    if (r.results[0]?.confidence === 'strong') un.top1_strong++;
  }
  res.unanswerable = { n: un.n, no_answer: un.no_answer, avg_rows: Math.round(un.rows / un.n * 10) / 10,
    avg_chars: Math.round(un.chars / un.n), top1_strong: un.top1_strong };
  rmSync(holder, { recursive: true, force: true });
  return res;
}
