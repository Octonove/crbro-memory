#!/usr/bin/env node
// Synthetic brain of realistic size, for measuring the index (size, memory,
// boot with a stale index) and the accent fix without touching anybody's
// real memory. Deterministic: the same seed writes the same brain.
//
// Shape, taken from the audit of a six-month brain (2026-11-13): ~500
// neurons, ~7,000 entries of mixed Spanish and English, median entry around
// 775 characters, a long tail of one- and two-entry neurons and a few giant
// neurons over 300 KB. About 70 % of the entries carry á, í, ú, ñ or ü.
//
// Usage:
//   node benchmarks/retrieval/synthetic-brain.mjs <dir> [--neurons 500] [--entries 7000] [--seed 7]
// Writes <dir>/cortex/*.json (plus what Brain.initialize creates) and prints
// a JSON summary, including how many entries and neurons contain each of the
// probe words (diseño, título, categoría, España).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const PROBES = ['diseño', 'título', 'categoría', 'España'];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    // mulberry32
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ES_SUBJ = ['La página de inicio', 'El menú lateral', 'El artículo del blog', 'La sección principal', 'El código de la búsqueda',
  'La configuración del servidor', 'El análisis técnico', 'La compañía de hosting', 'El último despliegue', 'La migración a Portugal',
  'El número de teléfono', 'La versión móvil', 'El público objetivo', 'La música de fondo', 'El año fiscal', 'La reunión del lunes',
  'El índice de búsqueda', 'La guía de estilo', 'El módulo de facturación', 'La integración con Stripe', 'El tráfico orgánico',
  'La campaña de anuncios', 'El niño del vecino', 'La cigüeña del logotipo', 'El pingüino de la mascota', 'La lingüística del texto',
  'El vídeo de presentación', 'La página de servicios', 'El texto SEO', 'El maquetado responsive'];
const ES_VERB = ['se cambió a', 'quedó pendiente de', 'depende de', 'se revisó junto con', 'falló por culpa de', 'se resolvió con',
  'se movió a', 'sigue usando', 'necesita', 'se documentó en', 'se comparó con', 'tarda más que', 'se migró desde'];
const ES_OBJ = ['la caché de Cloudflare', 'un plugin de WordPress', 'la API de facturación', 'el servidor de Hetzner', 'la base de datos MySQL',
  'el tema hijo', 'la cuenta de Google Ads', 'la imagen destacada', 'el menú lateral', 'la tipografía Inter', 'el formulario de contacto',
  'la política de privacidad', 'el calendario editorial', 'el sitemap', 'la página de servicios', 'el encabezado H1', 'la portada',
  'la sede de Lisboa', 'una tarea programada', 'la copia de seguridad diaria', 'el número de versión', 'la métrica de conversión'];
const ES_TAIL = ['porque el cliente lo pidió así.', 'tras varias pruebas en local.', 'y hay que vigilarlo la próxima semana.',
  'según la última auditoría.', 'sin cambios visibles para el usuario.', 'con un coste de unos 12 € al mes.',
  'y quedó anotado en el repositorio.', 'después de hablarlo con el equipo.', 'aunque todavía no está en producción.',
  'para no romper la compatibilidad.', 'y el rendimiento mejoró un 30 %.', 'según lo acordado en la reunión.'];
const EN_SUBJ = ['The landing page', 'The checkout flow', 'The cron job', 'The deploy script', 'The pre-commit hook', 'The e5-small model',
  'The crbro-memory daemon', 'The mcp-server process', 'The follow-up email', 'The analytics dashboard', 'The staging build',
  'The search index', 'The onboarding guide', 'The rate limiter', 'The image pipeline'];
const EN_VERB = ['was moved to', 'now depends on', 'broke because of', 'was rewritten with', 'still uses', 'was benchmarked against',
  'times out behind', 'was documented in', 'replaced'];
const EN_OBJ = ['the CDN cache', 'a WordPress plugin', 'the billing API', 'the Hetzner VPS', 'the MySQL database', 'the CI pipeline',
  'the Node 24 runtime', 'the sitemap generator', 'the login form', 'a nightly backup', 'the error tracker', 'the feature flag'];
const EN_TAIL = ['after a long debugging session.', 'and nobody noticed for a week.', 'as agreed with the client.',
  'which halved the response time.', 'pending a proper fix.', 'to keep the old URLs working.', 'per the last audit.'];
const DOMAINS = ['proyectos-web', 'infraestructura', 'marketing', 'contenido', 'finanzas', 'personal', 'desarrollo', 'clientes'];
const NAMES_A = ['Proyecto', 'Cliente', 'Web', 'Campaña', 'Servidor', 'Tienda', 'Blog', 'App', 'Informe', 'Guía'];
const NAMES_B = ['Alfa', 'Bravo', 'Cartagena', 'Madrid', 'Octonove', 'Reformas', 'Nube', 'Faro', 'Delta', 'Órbita', 'Ñandú', 'Lúmina',
  'Quasar', 'Norte', 'Sur', 'Atlas', 'Brisa', 'Cumbre', 'Duna', 'Eco'];

function pick(r, list) { return list[Math.floor(r() * list.length)]; }

/** Rare on purpose: each probe word sits in a few percent of the entries, as in a real brain. */
const PROBE_SENTENCES = [
  'El diseño de la cabecera se rehízo con más contraste.',
  'El título de la ficha cambió para mejorar el CTR.',
  'La categoría de productos se dividió en dos.',
  'La factura de España se emite con IVA del 21 %.',
];

function sentence(r, english) {
  if (!english && r() < 0.72) return `${pick(r, ES_SUBJ)} ${pick(r, ES_VERB)} ${pick(r, ES_OBJ)} ${pick(r, ES_TAIL)}`;
  return `${pick(r, EN_SUBJ)} ${pick(r, EN_VERB)} ${pick(r, EN_OBJ)} ${pick(r, EN_TAIL)}`;
}

/** An entry whose length follows a skewed distribution with median ≈ 775 chars. */
function entryText(r, serial) {
  // Log-normal-ish target: exp(N(ln 775, 0.6)).
  const g = (r() + r() + r() + r() - 2) * 1.2;   // ≈ N(0, 0.69)
  const target = Math.max(60, Math.min(6000, Math.round(775 * Math.exp(0.6 * g / 0.69))));
  let out = `[${serial}] `;
  const english = r() < 0.3;   // about 30 % of entries carry no Spanish at all
  if (!english && r() < 0.2) out += pick(r, PROBE_SENTENCES) + ' ';
  while (out.length < target) out += sentence(r, english) + ' ';
  return out.trim();
}

function hashId(text) { return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12); }

function fold(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

export async function generateBrain(dir, { neurons = 500, entries = 7000, seed = 7, giants = 3, giantEntries = 420 } = {}) {
  const r = rng(seed);
  const here = dirname(fileURLToPath(import.meta.url));
  const { Brain } = await import(pathToFileURL(join(here, '..', '..', 'dist', 'engine', 'brain.js')).href);
  const brain = new Brain(dir);
  await brain.initialize();
  mkdirSync(brain.paths.cortex, { recursive: true });

  // How many entries each neuron gets: a few giants, then a long tail.
  const counts = [];
  let left = entries;
  for (let i = 0; i < giants; i++) { counts.push(giantEntries); left -= giantEntries; }
  const rest = neurons - giants;
  const weights = [];
  for (let i = 0; i < rest; i++) weights.push(Math.pow(r(), 3));   // most near 0: one- and two-entry neurons
  const sum = weights.reduce((a, b) => a + b, 0);
  let assigned = 0;
  for (let i = 0; i < rest; i++) {
    const n = Math.max(1, Math.round(weights[i] / sum * (left - rest)) + 1);
    counts.push(n); assigned += n;
  }
  // Adjust to the exact total on the largest non-giant neurons.
  let diff = left - assigned;
  for (let i = giants; diff !== 0 && i < counts.length; i = i + 1 >= counts.length ? giants : i + 1) {
    if (diff > 0) { counts[i]++; diff--; } else if (counts[i] > 1) { counts[i]--; diff++; }
  }

  const probe = Object.fromEntries(PROBES.map(p => [p, { entries: 0, neurons: new Set() }]));
  let serial = 0, chars = 0, conAcento = 0;
  const lengths = [];
  const day = Date.parse('2026-03-01T00:00:00Z');
  const usedIds = new Set();
  for (let i = 0; i < counts.length; i++) {
    const name = `${pick(r, NAMES_A)} ${pick(r, NAMES_B)} ${i}`;
    const id = `project_${fold(name).replace(/[^a-z0-9]+/g, '_')}`;
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    const facts = [], decisions = [], patterns = [], errors = [], entryDates = {};
    for (let k = 0; k < counts[i]; k++) {
      const text = entryText(r, ++serial);
      lengths.push(text.length); chars += text.length;
      if (/[áíúñüÁÍÚÑÜ]/.test(text)) conAcento++;
      for (const p of PROBES) if (fold(text).includes(fold(p))) { probe[p].entries++; probe[p].neurons.add(id); }
      const added = new Date(day + Math.floor(r() * 250) * 86_400_000).toISOString();
      const roll = r();
      if (roll < 0.8) facts.push({ text, confidence: 0.9, added, source: 'synthetic', id: hashId(text) });
      else if (roll < 0.88) decisions.push({ text, date: added, rationale: '' });
      else if (roll < 0.95) { patterns.push(text); entryDates[hashId(text)] = added; }
      else { errors.push(text); entryDates[hashId(text)] = added; }
    }
    const neuron = {
      id, name, domain: pick(r, DOMAINS), type: 'project',
      created: new Date(day).toISOString(), last_accessed: new Date(day).toISOString(), access_count: 1,
      heat: Math.round(r() * 1000) / 1000, summary: `Notas sobre ${name}.`,
      facts, decisions, patterns, preferences: [], connections: [], tags: ['sintético'],
      errors, debts: [], entry_dates: entryDates,
    };
    writeFileSync(join(brain.paths.cortex, `${id}.json`), JSON.stringify(neuron, null, 2));
  }
  lengths.sort((a, b) => a - b);
  return {
    dir, neurons: usedIds.size, entries: serial, chars,
    median_entry_chars: lengths[Math.floor(lengths.length / 2)],
    entries_with_a_i_u_n_u_accent: conAcento,
    probes: Object.fromEntries(Object.entries(probe).map(([k, v]) => [k, { entries: v.entries, neurons: v.neurons.size }])),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) { console.error('usage: synthetic-brain.mjs <dir> [--neurons N] [--entries N] [--seed N]'); process.exit(2); }
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
  const out = await generateBrain(dir, { neurons: opt('neurons', 500), entries: opt('entries', 7000), seed: opt('seed', 7) });
  console.log(JSON.stringify(out, null, 2));
}
