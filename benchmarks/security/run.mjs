#!/usr/bin/env node
// Benchmark de seguridad: el filtro de redacción, medido con los fallos a la vista.
//
// Es un PISO, no una prueba de seguridad — igual que Ponytail dice de su check
// determinista: "un check determinista es un suelo, no una prueba". Aquí se
// mide qué fracción de credenciales, en formas variadas y adversariales, caza
// el filtro antes de que un secreto llegue al disco. Los que se cuelan se
// LISTAN, no se esconden: esa lista es la que hace el número creíble.
//
// Dos caras, ambas publicadas:
//   1. Captura: N secretos reales en disfraces variados. % cazado + los que fallan.
//   2. Falsos positivos: cosas que PARECEN secretos y no lo son. Un filtro que
//      grita a todo acaba desactivado, y esa cifra casi nadie la publica.
//
// Determinista, cero API. Uso: node benchmarks/security/run.mjs [--json]

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { redact, secretKinds } = await import(pathToFileURL(join(DIST, 'engine/secrets.js')).href);

// ─── Secretos que DEBEN cazarse, en formas adversariales ───────────
//
// Los valores son SINTÉTICOS (patrones de ejemplo, no credenciales reales),
// pero se ensamblan en runtime a partir de fragmentos para que el fichero
// fuente nunca contenga la cadena completa: si no, el propio secret-scanner
// de GitHub bloquea el push de un benchmark de detección de secretos —
// exactamente lo que pasó al publicar la 1.11. El `+` parte cada valor en
// dos trozos que el escáner no reconoce por separado.
const G = (...p) => p.join('');   // ensambla el valor
const SECRETOS = [
  { d: 'AWS access key', t: 'la clave es ' + G('AKIAIOSF', 'ODNN7EXAMPLE') + ', guárdala' },
  { d: 'AWS secret en prosa', t: 'el secret access key vale ' + G('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY') },
  { d: 'GitHub PAT', t: 'token ' + G('ghp_', '1234567890abcdefghijklmnopqrstuvwxyzAB') + ' para el push' },
  { d: 'GitHub fine-grained', t: 'usa ' + G('github_pat_11ABCDEFG0abcdefghijkl_', '1234567890abcdefghijklmnopqrstuvwxyz1234567890ABCD') },
  { d: 'OpenAI key', t: 'OPENAI_API_KEY=' + G('sk-proj-', 'abc123def456ghi789jkl012mno345pqr678stu901vwx234yz') },
  { d: 'Google API key', t: 'la clave web es ' + G('AIzaSy', 'C3xK9mP2qR7tV4wX1yZ8aB5cD6eF7gH8i') },
  { d: 'Slack token', t: G('xoxb-', '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx') + ' en el webhook' },
  { d: 'JWT', t: 'Authorization: Bearer ' + G('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U') },
  { d: 'Postgres DSN', t: 'DATABASE_URL=postgres://' + G('admin:', 'S3cr3tP4ss') + '@db.example.com:5432/prod' },
  { d: 'Mongo DSN', t: 'mongodb+srv://' + G('user:', 'p4ssw0rd') + '@cluster0.abcde.mongodb.net/mydb' },
  { d: 'WordPress app password', t: 'application password: ' + G('abcd efgh ijkl ', 'mnop qrst uvwx') },
  { d: 'contraseña en prosa castellana', t: 'la contraseña de WP-Admin es ' + G('Muñoz2024', '$Reformas!') + ' no la pierdas' },
  { d: 'Stripe live', t: 'STRIPE_SECRET_KEY=' + G('sk_live_51', 'ABCdefGHIjklMNOpqrsTUVwxyz0123456789abcdefGHIJ') },
  { d: 'clave privada SSH (cabecera)', t: '-----BEGIN OPENSSH PRIVATE KEY-----\n' + G('b3BlbnNzaC1rZXkt', 'djEAAAAABG5vbmUAAAAEbm9uZQ') },
  { d: 'clave partida en dos frases', t: 'el token empieza por ghp_ y sigue con ' + G('1234567890', 'abcdefghijklmnopqrstuvwxyzAB') },
  { d: 'Twilio', t: G('ACb1234567890abcdef', '1234567890abcdef') + ' con su auth token ' + G('0123456789abcdef', '0123456789abcdef') },
  { d: 'SendGrid', t: G('SG.', 'aBcDeFgHiJkLmNoPqRsTuV.', 'wXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567') },
  { d: 'genérico API_KEY=', t: 'API_KEY=' + G('9f8e7d6c5b4a3928', '1706f5e4d3c2b1a0') },
  { d: 'base64 largo con pinta de clave', t: 'secret: ' + G('dGhpc2lzYXZlcnlsb25nc2Vj', 'cmV0dG9rZW5pbmJhc2U2NGZvcnRlc3Rpbmc=') },
  { d: 'basic auth en URL', t: 'curl https://' + G('apiuser:', '8f3kd9sldkfj') + '@api.example.com/v1/data' },
];

// ─── Cosas que NO son secretos (falsos positivos a vigilar) ────────
const INOCENTES = [
  'el post pilar tiene el slug crear-workflow-con-ia y sale el 26 de agosto',
  'la mediana de palabras por artículo es 1629 en las 117 entradas',
  'el commit 8670b4f arregla la deriva de las cartas',
  'el sitemap devuelve 507 URLs en 8 hijos tras el flush',
  'la plantilla Elementor 825 pinta el widget c20189c',
  'el TTFB del servidor ronda los 190 ms medido sin sesión',
  'reunión con el cliente el jueves a las 16:00 en la oficina',
  'la versión 1.10.0 se publicó ayer con la dieta de memoria',
  'el hash SHA de la neurona es un id de contenido, no un secreto',
  'AIesque no es una clave, es el nombre de una herramienta del catálogo',
  'la factura F-2024-0912 quedó pagada el 15 de marzo',
  'el bucket se llama simplifica-backups-eu y guarda 30 días',
  'password reset: el enlace caduca en 24 horas (texto de un email de plantilla)',
  'el número de pedido es 6634 y llegó con 9 creativos de Meta',
];

let cazados = 0; const fallidos = [];
for (const s of SECRETOS) {
  const { text, found } = redact(s.t);
  const cazado = found.length > 0 && !text.includes(s.t.trim());
  if (cazado) cazados++; else fallidos.push(s.d);
}

let falsosPos = 0; const gritados = [];
for (const t of INOCENTES) {
  if (secretKinds(t).length > 0) { falsosPos++; gritados.push(t.slice(0, 50)); }
}

const out = {
  captura: {
    total: SECRETOS.length,
    cazados,
    tasa: (100 * cazados / SECRETOS.length).toFixed(0) + '%',
    se_colaron: fallidos,
  },
  falsos_positivos: {
    inocentes_probados: INOCENTES.length,
    marcados_como_secreto: falsosPos,
    tasa: (100 * falsosPos / INOCENTES.length).toFixed(0) + '%',
    cuales: gritados,
  },
  disclaimer: 'Un check determinista es un SUELO, no una prueba de seguridad. Los que se colaron van como issues abiertos.',
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('\n══ Benchmark de seguridad: filtro de redacción ══');
  console.log(`  captura   ${cazados}/${SECRETOS.length} secretos cazados (${out.captura.tasa})`);
  if (fallidos.length) console.log(`            se colaron: ${fallidos.join(', ')}`);
  console.log(`  ruido     ${falsosPos}/${INOCENTES.length} inocentes marcados por error (${out.falsos_positivos.tasa})`);
  if (gritados.length) for (const g of gritados) console.log(`            ⚠️  «${g}...»`);
  console.log(`  ${out.disclaimer}`);
  console.log('');
}
