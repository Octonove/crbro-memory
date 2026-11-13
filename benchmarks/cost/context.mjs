#!/usr/bin/env node
// What CRBRO costs in context, per call, on a brain shaped like a real one.
//
// The audit of 2026-11-13 measured these on the owner's brain (2.10.0):
// tools/list 44,434 characters, crbro_boot 21,527, crbro_recall with five
// results 12,937, crbro_context with no arguments 21,318, and an add_pending
// that echoed the whole context back. This script rebuilds a synthetic brain
// with the same shape — about 500 neurons with paragraph-long facts, 30 open
// items with long texts, 15 recently closed, three protocols that together
// weigh what the owner's do (~4,200 characters), long session summaries and a
// recall that hits five neurons with also_matched lines — and prints the size
// of each answer as a client receives it.
//
// Deterministic, offline, and never near a real brain: CRBRO_PATH, HOME and
// USERPROFILE point at a fresh folder under the OS temp dir, and the mod,
// automatic backups and the semantic layer are off.
//
// Usage: node benchmarks/cost/context.mjs [--dist <path to a built dist/>] [--json [--show-boot]]
// --dist measures another build (e.g. master's) with the same brain.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argDist = process.argv.indexOf('--dist');
const DIST = argDist > 0 ? resolve(process.argv[argDist + 1]) : join(HERE, '..', '..', 'dist');
const asJson = process.argv.includes('--json');

// ─── Sandbox: every path the server could reach lives here ──────────
const sandbox = mkdtempSync(join(tmpdir(), 'crbro-cost-context-'));
const root = join(sandbox, '.crbro');
Object.assign(process.env, {
  CRBRO_PATH: root, HOME: sandbox, USERPROFILE: sandbox,
  CRBRO_KEYS_DIR: join(sandbox, 'keys'), CRBRO_BACKUP_DIR: join(sandbox, 'backups'),
  CODEX_HOME: join(sandbox, 'codex'), CLAUDE_CONFIG_DIR: join(sandbox, 'claude'),
  CRBRO_MOD: '0', CRBRO_AUTOBACKUP: '0', CRBRO_SEMANTIC: '0',
});

// A tiny deterministic generator, so two builds measure the same brain.
let seed = 20261113;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const WORDS = ('servidor despliegue cliente plantilla factura copia bucket región certificado dominio ' +
  'proxy caché índice consulta tabla migración esquema rama revisión entrega presupuesto campaña ' +
  'artículo enlace imagen vídeo guion locución usuario permiso rol token webhook cola tarea ' +
  'informe métrica embudo conversión palabra clave página portada widget formulario pago').split(' ');
const sentence = n => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const paragraph = chars => {
  let t = '';
  while (t.length < chars) t += `${sentence(8 + Math.floor(rnd() * 8))}. `;
  return t.slice(0, chars).trimEnd() + '.';
};
const daysAgo = d => new Date(Date.now() - d * 86_400_000).toISOString();

// ─── Pre-seeded files: the working context and the diary ────────────
// Written before the server starts, the way a brain that has lived months
// already has them.
mkdirSync(join(root, 'prefrontal'), { recursive: true });
mkdirSync(join(root, 'hippocampus'), { recursive: true });
const open = Array.from({ length: 30 }, (_, i) => ({
  id: `p_open${String(i).padStart(2, '0')}`,
  text: `Pendiente ${i}: ${paragraph(180 + Math.floor(rnd() * 420))}`,
  added: daysAgo(2 + i * 3),
  status: 'open',
  ...(i % 6 === 0 ? { due: daysAgo(-10 - i).slice(0, 10) } : {}),
  ...(i % 5 === 0 ? { done_when: paragraph(90) } : {}),
}));
const closed = Array.from({ length: 15 }, (_, i) => ({
  id: `p_done${String(i).padStart(2, '0')}`,
  text: `Cerrado ${i}: ${paragraph(220 + Math.floor(rnd() * 300))}`,
  added: daysAgo(40 + i), closed: daysAgo(1 + i), status: 'done',
}));
writeFileSync(join(root, 'prefrontal', 'active_context.json'), JSON.stringify({
  last_session: '', active_topics: [], pending_tasks: open, recently_closed: closed, last_updated: daysAgo(1),
}));
for (let d = 1; d <= 20; d++) {
  const day = daysAgo(d).slice(0, 10);
  writeFileSync(join(root, 'hippocampus', `session_${day}.json`), JSON.stringify({
    session_id: `session_${day}`, date: daysAgo(d), duration_estimate: '2h',
    topics_touched: Array.from({ length: 8 }, (_, k) => `project_tema_${(d * 7 + k) % 480}`),
    summary: paragraph(1_500 + Math.floor(rnd() * 2_500)),
    key_facts_added: 6, decisions_made: 2, new_neurons_created: 1, synapses_updated: 4,
  }));
}

// ─── The server, spoken to over MCP like a client would ─────────────
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = await import(pathToFileURL(join(DIST, 'server.js')).href);
const [ct, st] = InMemoryTransport.createLinkedPair();
await createServer().connect(st);
const client = new Client({ name: 'cost-bench', version: '0.0.0' });
await client.connect(ct);
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const textOf = r => (r.content || []).map(c => c.text || '').join('');

await call('crbro_boot');   // creates the brain's manifest; the pre-seeded files stay

// Three protocols weighing what the owner's do together (~4,200 characters).
for (const [name, n] of [['Zero Protocol', 4], ['Review Protocol', 3], ['Release Protocol', 3]]) {
  for (let k = 0; k < n; k++) await call('crbro_learn', { topic: name, type: 'fact', content: paragraph(380 + k * 20) });
}

// ~500 neurons. Facts are paragraphs (the owner's median is 775 characters),
// one in ten neurons carries a decision, and five share the words the recall
// below looks for, with several entries each so also_matched has lines.
const TOTAL = 495;
for (let i = 0; i < TOTAL; i++) {
  const topic = `Tema ${i} ${pick(WORDS)}`;
  const facts = 1 + (i % 3);
  for (let k = 0; k < facts; k++) {
    await call('crbro_learn', { topic, type: 'fact', content: paragraph(500 + Math.floor(rnd() * 700)), keywords: [pick(WORDS), pick(WORDS)] });
  }
  if (i % 10 === 0) await call('crbro_learn', { topic, type: 'decision', content: paragraph(300), rationale: paragraph(120) });
}
for (let h = 0; h < 5; h++) {
  const topic = `Kestrel nodo ${h}`;
  for (let k = 0; k < 4; k++) {
    await call('crbro_learn', {
      topic, type: 'fact',
      content: `Kestrel ${h}.${k}: el despliegue del servicio kestrel usa el puerto ${8000 + h * 10 + k}. ${paragraph(600 + k * 350)}`,
      keywords: ['kestrel', 'puerto', 'despliegue'],
    });
  }
}
await call('crbro_consolidate', { summary: paragraph(900) });   // heat, hot topics, today's log

// ─── Measure ────────────────────────────────────────────────────────
const sum = arr => arr.reduce((a, b) => a + b, 0);
const listed = await client.listTools();
const tools = listed.tools;
const paramDescChars = sum(tools.map(t => sum(Object.values(t.inputSchema?.properties ?? {})
  .map(p => JSON.stringify(p.description ?? '').length - 2))));
const toolsList = {
  total: JSON.stringify(listed).length,
  descriptions: sum(tools.map(t => (t.description || '').length)),
  inputSchema: sum(tools.map(t => JSON.stringify(t.inputSchema ?? {}).length)),
  input_param_descriptions: paramDescChars,
  outputSchema: sum(tools.map(t => JSON.stringify(t.outputSchema ?? {}).length)),
};

const boot = await call('crbro_boot');
const bootBody = JSON.parse(textOf(boot));
const bootParts = Object.fromEntries(Object.entries(bootBody)
  .map(([k, v]) => [k, JSON.stringify(v).length]).sort((a, b) => b[1] - a[1]));

const recall = await call('crbro_recall', { query: 'kestrel despliegue puerto' });
const recallBody = JSON.parse(textOf(recall));
const ctxRead = await call('crbro_context');
const ctxAdd = await call('crbro_context', { add_pending: `Revisar el puerto de kestrel: ${paragraph(200)}` });
// Last, because it binds this connection to a project: the boot of a session
// opened in a repo, which is how the owner's 21,527 characters were measured.
const bootProject = await call('crbro_boot', { project: 'C:/code/kestrel' });

const out = {
  ...(process.argv.includes('--show-boot') ? { boot_body: bootBody } : {}),
  dist: DIST,
  tools_list: toolsList,
  boot: { text: textOf(boot).length, parts: bootParts },
  boot_with_project: textOf(bootProject).length,
  ...(process.argv.includes('--show-boot') ? { boot_project_body: JSON.parse(textOf(bootProject)) } : {}),
  ...(process.argv.includes('--show-boot') ? { recall_body: recallBody } : {}),
  recall_5: {
    text: textOf(recall).length,
    structured: recall.structuredContent ? JSON.stringify(recall.structuredContent).length : 0,
    results: (recallBody.results || []).length + (recallBody.possibly_stale || []).length,
    with_also_matched: (recallBody.results || []).filter(r => r.also_matched?.length).length,
  },
  context_read: textOf(ctxRead).length,
  context_add: textOf(ctxAdd).length,
};

await client.close();
rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const f = n => n.toLocaleString('en-US');
  console.log(`\n== CRBRO context cost (synthetic brain, ${TOTAL + 5 + 3} neurons) ==`);
  console.log(`  dist                 ${out.dist}`);
  console.log(`  tools/list           ${f(toolsList.total)} chars  (descriptions ${f(toolsList.descriptions)}, inputSchema ${f(toolsList.inputSchema)} of which param descriptions ${f(toolsList.input_param_descriptions)}, outputSchema ${f(toolsList.outputSchema)})`);
  console.log(`  crbro_boot           ${f(out.boot.text)} chars (with project=C:/code/kestrel: ${f(out.boot_with_project)})`);
  console.log(`    biggest parts      ${Object.entries(bootParts).slice(0, 8).map(([k, v]) => `${k} ${f(v)}`).join(', ')}`);
  console.log(`  crbro_recall (5)     ${f(out.recall_5.text)} chars text + ${f(out.recall_5.structured)} structuredContent (${out.recall_5.results} rows, ${out.recall_5.with_also_matched} with also_matched)`);
  console.log(`  crbro_context read   ${f(out.context_read)} chars`);
  console.log(`  crbro_context add    ${f(out.context_add)} chars`);
  console.log('');
}
