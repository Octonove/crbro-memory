// ─── Comprobar que el .mcpb arranca solo ──────────────────────────
//
// Que `mcpb pack` termine sin error solo dice que el zip está bien hecho.
// Lo que rompe de verdad un bundle es que le falte una dependencia o que el
// punto de entrada no arranque fuera del repositorio, y eso no se ve hasta
// que alguien hace doble clic. Así que aquí se desempaqueta en una carpeta
// temporal, se lanza `node dist/index.js` como proceso aparte —igual que
// hará Claude Desktop con su propio Node— y se habla MCP de verdad por
// stdio contra un cerebro vacío.
//
// Uso:  npm run mcpb:verify

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
const BUNDLE = path.join(RAIZ, 'build', `${pkg.name}-${pkg.version}.mcpb`);

if (!existsSync(BUNDLE)) {
  console.error(`No existe ${path.relative(RAIZ, BUNDLE)}. Ejecuta antes: npm run mcpb`);
  process.exit(1);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'crbro-verify-'));
const destino = path.join(tmp, 'ext');
const cerebro = path.join(tmp, 'brain');
let fallos = 0;
const comprobar = (ok, txt, detalle = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${txt}${detalle ? ' · ' + detalle : ''}`);
  if (!ok) fallos++;
};

try {
  console.log(`\nDesempaquetando ${path.basename(BUNDLE)}`);
  // Ruta del bundle RELATIVA: con shell en Windows, una ruta con espacios se
  // parte en dos argumentos y el CLI la rechaza. El destino va en la carpeta
  // temporal del sistema, que no los tiene.
  execFileSync('npx', ['--yes', '@anthropic-ai/mcpb@2.1.2', 'unpack', path.posix.join('build', path.basename(BUNDLE)), destino], {
    cwd: RAIZ, stdio: 'pipe', shell: process.platform === 'win32',
  });

  const manifest = JSON.parse(readFileSync(path.join(destino, 'manifest.json'), 'utf8'));
  console.log('\nContenido del paquete');
  comprobar(manifest.version === pkg.version, 'la versión del manifiesto es la del proyecto', manifest.version);
  comprobar(existsSync(path.join(destino, 'dist', 'index.js')), 'trae el punto de entrada');
  comprobar(existsSync(path.join(destino, 'node_modules')), 'trae node_modules',
    existsSync(path.join(destino, 'node_modules')) ? readdirSync(path.join(destino, 'node_modules')).length + ' paquetes' : '');
  comprobar(existsSync(path.join(destino, 'icon.png')), 'trae el icono');
  comprobar(!JSON.stringify(manifest).includes('npx'), 'no depende de npx ni de la red al arrancar');
  comprobar(Array.isArray(manifest.privacy_policies) && manifest.privacy_policies.length > 0,
    'declara política de privacidad', (manifest.privacy_policies || []).join(' '));

  console.log('\nArrancándolo como lo hará Claude Desktop');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const transporte = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(destino, 'dist', 'index.js')],
    env: { ...process.env, CRBRO_PATH: cerebro, CRBRO_SEMANTIC: '0' },
    stderr: 'pipe',
  });
  const cliente = new Client({ name: 'verify-mcpb', version: pkg.version });
  await cliente.connect(transporte);

  const tools = (await cliente.listTools()).tools;
  comprobar(tools.length === manifest.tools.length,
    `sirve las ${manifest.tools.length} herramientas del manifiesto`, `${tools.length} vivas`);
  const nombresVivos = new Set(tools.map(t => t.name));
  const desajuste = manifest.tools.filter(t => !nombresVivos.has(t.name)).map(t => t.name);
  comprobar(desajuste.length === 0, 'el manifiesto no anuncia herramientas que no existen',
    desajuste.join(', ') || 'ninguna');

  const cuerpo = (r) => JSON.parse(r.content[0].text);
  const boot = cuerpo(await cliente.callTool({ name: 'crbro_boot', arguments: {} }));
  comprobar(boot.status === 'ok' || boot.status === 'initialized', 'crbro_boot crea el cerebro', boot.status);
  comprobar(existsSync(cerebro), 'el cerebro se escribe donde dice CRBRO_PATH');

  await cliente.callTool({ name: 'crbro_learn', arguments: {
    topic: 'Prueba del paquete', type: 'fact',
    content: 'El bundle .mcpb arranca con el Node de Claude Desktop y sin instalar nada.',
    keywords: ['extensión', 'instalación'],
  } });
  const recall = cuerpo(await cliente.callTool({ name: 'crbro_recall', arguments: { query: 'instalación extensión' } }));
  comprobar(recall.total_results > 0 && recall.results[0].matching_content.includes('.mcpb'),
    'guarda y recupera un hecho de punta a punta');

  const estado = cuerpo(await cliente.callTool({ name: 'crbro_inspect', arguments: { view: 'status' } }));
  comprobar(estado.crbro_version === pkg.version, 'informa de su versión', estado.crbro_version);
  comprobar(estado.semantic && estado.semantic.enabled === false,
    'la capa semántica queda apagada, no descarga nada');

  await cliente.close();
} catch (err) {
  comprobar(false, 'excepción durante la comprobación', err instanceof Error ? err.message : String(err));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fallos === 0
  ? '\n✅ El paquete arranca solo y responde. Listo para instalar con doble clic.\n'
  : `\n❌ ${fallos} comprobación(es) fallidas.\n`);
process.exit(fallos === 0 ? 0 : 1);
