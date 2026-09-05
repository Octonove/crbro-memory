// ─── Empaquetar CRBRO como extensión de escritorio (.mcpb) ────────
//
// Un .mcpb es el instalador de un clic de Claude Desktop: un zip con el
// servidor, sus dependencias y un manifest.json. Existe porque la ruta de
// hoy para un usuario no técnico es instalar Node, encontrar la ventana de
// ajustes correcta, editar un JSON a mano y reiniciar la aplicación del
// todo. Diez pasos con cinco formas de fallar en silencio.
//
// Tres decisiones que este script toma a propósito:
//
//  1. El bundle NO envuelve `npx -y crbro-memory`. Eso volvería a depender
//     del Node del sistema y de la red, que es justo el problema que
//     venimos a quitar. Se empaqueta dist/ y node_modules de producción, y
//     arranca con el Node que Claude Desktop ya trae.
//  2. La lista de herramientas del manifiesto se saca del servidor VIVO por
//     tools/list, no de una copia a mano. La política del directorio exige
//     que las descripciones coincidan con lo que hacen; si se escriben dos
//     veces, acaban divergiendo.
//  3. No se toca CRBRO_SEMANTIC. Sin variable, la capa semántica se activa
//     sola solo si el usuario instaló su runtime aparte, así que el bundle
//     no descarga nada de ningún tercero. Con `init` metido aquí, el
//     paquete descargaría 500 MB de Hugging Face en el primer arranque, que
//     ni es lo que espera quien hace doble clic ni encaja con un formato
//     cuya definición dice "empaqueta todas las dependencias".
//
// Uso:  npm run mcpb        → build/crbro-memory-<versión>.mcpb

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = path.join(RAIZ, 'build', 'mcpb');
const pkg = JSON.parse(readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
const REPO = 'https://github.com/Octonove/crbro-memory';

const paso = (n, txt) => console.log(`\n[${n}] ${txt}`);
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: RAIZ, stdio: 'inherit', shell: process.platform === 'win32', ...opts });

// ── 1. Compilar ───────────────────────────────────────────────────
paso(1, 'Compilando TypeScript');
run('npm', ['run', 'build']);

// ── 2. Preparar la carpeta de montaje ─────────────────────────────
paso(2, `Montando en ${path.relative(RAIZ, STAGING)}`);
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });
cpSync(path.join(RAIZ, 'dist'), path.join(STAGING, 'dist'), { recursive: true });
for (const f of ['README.md', 'LICENSE', 'package-lock.json']) {
  cpSync(path.join(RAIZ, f), path.join(STAGING, f));
}
cpSync(path.join(RAIZ, 'mcpb', 'icon.png'), path.join(STAGING, 'icon.png'));

// package.json recortado: solo lo que el runtime necesita para resolver deps.
writeFileSync(path.join(STAGING, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, private: true, type: pkg.type,
  main: 'dist/index.js', license: pkg.license, dependencies: pkg.dependencies,
}, null, 2) + '\n');

// ── 3. Dependencias de producción, sin scripts de instalación ─────
paso(3, 'Instalando dependencias de producción');
run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: STAGING });

// ── 4. Las 15 herramientas, preguntándoselas al servidor ──────────
paso(4, 'Leyendo tools/list del servidor recién compilado');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const os = await import('node:os');
const tmp = path.join(os.tmpdir(), `crbro-mcpb-${Date.now()}`);
process.env.CRBRO_PATH = tmp;              // nunca el cerebro real del autor
process.env.CRBRO_SEMANTIC = '0';
const { createServer } = await import(pathToFileURL(path.join(RAIZ, 'dist', 'server.js')).href);
const [ct, st] = InMemoryTransport.createLinkedPair();
await createServer().connect(st);
const cliente = new Client({ name: 'build-mcpb', version: pkg.version });
await cliente.connect(ct);
const tools = (await cliente.listTools()).tools;
await cliente.close();
rmSync(tmp, { recursive: true, force: true });

// El manifiesto solo admite nombre y descripción. Se toma la primera frase:
// sigue siendo exacta y el listado se lee de un vistazo.
const primeraFrase = (d) => {
  const corte = d.search(/\.\s/);
  const frase = corte > 0 ? d.slice(0, corte + 1) : d;
  return frase.length > 220 ? frase.slice(0, 217).trimEnd() + '…' : frase;
};
console.log(`    ${tools.length} herramientas: ${tools.map(t => t.name.replace('crbro_', '')).join(' ')}`);

// ── 5. El manifiesto ──────────────────────────────────────────────
paso(5, 'Escribiendo manifest.json');
const manifest = {
  manifest_version: '0.3',
  name: pkg.name,
  display_name: 'CRBRO — Persistent Memory',
  version: pkg.version,
  description: 'Persistent memory for Claude: facts, decisions and system maps kept as JSON files on your own machine.',
  long_description:
    'CRBRO gives Claude a memory that survives the conversation. What you save is written as plain JSON files under a folder on your computer, ' +
    'organised as topics with facts, decisions, patterns, mistakes and living system maps, and searched back with a fact-level index. ' +
    'Nothing is uploaded: there is no account, no server and no telemetry. Knowledge can be corrected instead of only piled up, so a fact that ' +
    'stopped being true is retired rather than competing with its replacement. Start any session by calling crbro_boot.',
  author: { name: 'Octonove', url: 'https://github.com/Octonove' },
  repository: { type: 'git', url: REPO },
  homepage: REPO,
  documentation: `${REPO}#readme`,
  support: `${REPO}/issues`,
  icon: 'icon.png',
  license: pkg.license,
  privacy_policies: [`${REPO}#privacy`],
  keywords: ['memory', 'knowledge', 'notes', 'local-first', 'productivity'],
  server: {
    type: 'node',
    entry_point: 'dist/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/dist/index.js'],
      env: { CRBRO_PATH: '${user_config.brain_path}' },
    },
  },
  tools: tools.map(t => ({ name: t.name, description: primeraFrase(t.description) })),
  tools_generated: false,
  user_config: {
    brain_path: {
      type: 'directory',
      title: 'Brain folder',
      description: 'Where your memory is stored. Leave empty to use ~/.crbro in your home folder. Pick a synced folder only if you understand that two machines writing at once can conflict.',
      required: false,
    },
  },
  compatibility: {
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: { node: '>=18.0.0' },
  },
};
writeFileSync(path.join(STAGING, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// ── 6. Validar y empaquetar ───────────────────────────────────────
// El empaquetador se invoca con npx y versión fijada, NO como devDependency:
// arrastra @inquirer/prompts → external-editor → tmp, con dos avisos de
// seguridad altos sin arreglo publicado, y el CI corre npm audit. Una
// herramienta que solo se usa al empaquetar no tiene por qué ponernos en rojo.
paso(6, 'Validando y empaquetando');
// Rutas RELATIVAS a propósito: la carpeta del proyecto lleva un espacio y,
// al pasar por el intérprete de Windows, una ruta absoluta se parte en dos
// argumentos y el CLI se queja de sobra de parámetros.
const salidaRel = path.posix.join('build', `${pkg.name}-${pkg.version}.mcpb`);
const salida = path.join(RAIZ, 'build', `${pkg.name}-${pkg.version}.mcpb`);
run('npx', ['--yes', '@anthropic-ai/mcpb@2.1.2', 'validate', 'build/mcpb/manifest.json']);
run('npx', ['--yes', '@anthropic-ai/mcpb@2.1.2', 'pack', 'build/mcpb', salidaRel]);

const mb = (statSync(salida).size / 1048576).toFixed(2);
console.log(`\n✅ ${path.relative(RAIZ, salida)} · ${mb} MB · ${tools.length} herramientas · v${pkg.version}`);
console.log('   Instalar a mano: doble clic en el fichero con Claude Desktop abierto.');
if (!existsSync(path.join(STAGING, 'node_modules'))) {
  console.error('   ⚠️  node_modules no está en el paquete: el servidor no arrancaría.');
  process.exit(1);
}
