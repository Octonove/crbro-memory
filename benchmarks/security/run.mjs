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
// Cada valor ensamblado queda anotado: un caso cuenta como cazado solo si
// NINGUNO de sus valores sobrevive en el texto redactado. Antes bastaba con
// que el texto cambiara, y una clave privada con la cabecera tachada y el
// cuerpo intacto contaba como cazada (G7).
let valores = [];
const G = (...p) => { const v = p.join(''); valores.push(v); return v; };   // ensambla el valor
const caso = (d, t) => { const c = { d, t, v: valores }; valores = []; return c; };
const SECRETOS = [
  caso('AWS access key', 'la clave es ' + G('AKIAIOSF', 'ODNN7EXAMPLE') + ', guárdala'),
  caso('AWS secret en prosa', 'el secret access key vale ' + G('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY')),
  caso('GitHub PAT', 'token ' + G('ghp_', '1234567890abcdefghijklmnopqrstuvwxyzAB') + ' para el push'),
  caso('GitHub fine-grained', 'usa ' + G('github_pat_11ABCDEFG0abcdefghijkl_', '1234567890abcdefghijklmnopqrstuvwxyz1234567890ABCD')),
  caso('OpenAI key', 'OPENAI_API_KEY=' + G('sk-proj-', 'abc123def456ghi789jkl012mno345pqr678stu901vwx234yz')),
  caso('Google API key', 'la clave web es ' + G('AIzaSy', 'C3xK9mP2qR7tV4wX1yZ8aB5cD6eF7gH8i')),
  caso('Slack token', G('xoxb-', '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx') + ' en el webhook'),
  caso('JWT', 'Authorization: Bearer ' + G('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')),
  caso('Postgres DSN', 'DATABASE_URL=postgres://' + G('admin:', 'S3cr3tP4ss') + '@db.example.com:5432/prod'),
  caso('Mongo DSN', 'mongodb+srv://' + G('user:', 'p4ssw0rd') + '@cluster0.abcde.mongodb.net/mydb'),
  caso('WordPress app password', 'application password: ' + G('abcd efgh ijkl ', 'mnop qrst uvwx')),
  caso('contraseña en prosa castellana', 'la contraseña de WP-Admin es ' + G('Muñoz2024', '$Reformas!') + ' no la pierdas'),
  caso('Stripe live', 'STRIPE_SECRET_KEY=' + G('sk_live_51', 'ABCdefGHIjklMNOpqrsTUVwxyz0123456789abcdefGHIJ')),
  caso('clave privada SSH (cabecera)', '-----BEGIN OPENSSH PRIVATE KEY-----\n' + G('b3BlbnNzaC1rZXkt', 'djEAAAAABG5vbmUAAAAEbm9uZQ')),
  caso('clave partida en dos frases', 'el token empieza por ghp_ y sigue con ' + G('1234567890', 'abcdefghijklmnopqrstuvwxyzAB')),
  caso('Twilio', G('ACb1234567890abcdef', '1234567890abcdef') + ' con su auth token ' + G('0123456789abcdef', '0123456789abcdef')),
  caso('SendGrid', G('SG.', 'aBcDeFgHiJkLmNoPqRsTuV.', 'wXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567')),
  caso('genérico API_KEY=', 'API_KEY=' + G('9f8e7d6c5b4a3928', '1706f5e4d3c2b1a0')),
  caso('base64 largo con pinta de clave', 'secret: ' + G('dGhpc2lzYXZlcnlsb25nc2Vj', 'cmV0dG9rZW5pbmJhc2U2NGZvcnRlc3Rpbmc=')),
  caso('basic auth en URL', 'curl https://' + G('apiuser:', '8f3kd9sldkfj') + '@api.example.com/v1/data'),
  caso('clave privada completa (cuerpo y END)', '-----BEGIN RSA PRIVATE KEY-----\n' + G('MIIEowIBAAKCAQEA', 'u1SU1LfVLPHCozMxH2Mo') + '\n' + G('4lgOEePzNm0tRgeL', 'ezV6ffAt0gunVTLw7onLRnrq0') + '==\n-----END RSA PRIVATE KEY-----\ny sigue la nota'),
  caso('PASS valor (sin dos puntos)', 'USER admin PASS ' + G('Xy7kk', '22Wq') + ' para el panel de pruebas'),
  caso('pass valor (minúsculas)', 'usuario admin pass ' + G('Xy7#k', 'k22w') + ' para el panel de pruebas'),
  caso('la contraseña valor (', 'la contraseña ' + G('Rf7kk', '22Wz') + ' (la del panel de pruebas)'),
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
  // Cebos para los patrones añadidos tras la primera corrida: cada uno roza
  // la forma de un patrón nuevo sin ser un secreto.
  'la clave del éxito es la constancia y el enfoque en el cliente',
  'el secret access key está guardado en la bóveda DPAPI, no aquí',
  'el secret key vive en el fichero /etc/ssl/private/server.pem del VPS',
  'el token empieza por gh y sigue con el resto que te dije por teléfono',
  'auth token caducado desde marzo, renuévalo en el panel de Twilio',
  // 2.11: cebos de las reglas sin separador (PASS / contraseña valor) y dos
  // formas reales que la 2.10 marcaba por error (valores inventados).
  'ACCESOS: SSH con CLAVE, no contrasena: key_filename=~/.ssh/id_ejemplo, host.ejemplo:65002',
  '(2) Reset contraseña = Supabase Auth built-in. (3) WELCOME = arreglado.',
  'pass userId42 to the helper function and return early',
  'PASS  tests/keychain.test.ts (12 tests) 40ms',
  'pass: completed en la última corrida del CI',
  'Decisión clave: mantener el plan de octubre',
  'Dato clave: 4-oct-2026 es la fecha de corte',
  'la contraseña debe tener al menos 12 caracteres y un símbolo',
  '-----BEGIN PUBLIC KEY----- es pública y puede ir en el repo',
];

let cazados = 0; const fallidos = [];
for (const s of SECRETOS) {
  const { text, found } = redact(s.t);
  const cazado = found.length > 0 && s.v.length > 0 && s.v.every(v => !text.includes(v));
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

if (process.argv.includes('--check')) {
  const { securityFailures, enforceGate } = await import('../gates.mjs');
  enforceGate(securityFailures({ caught: cazados, total: SECRETOS.length, falsePositives: falsosPos, innocents: INOCENTES.length }));
}

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
