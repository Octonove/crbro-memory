#!/usr/bin/env node
// After `tsc`: stamp the compiled tree with what it is.
//
//   dist/build-id.json     the build id: version + a hash of every compiled
//                          .js file. Two installs of the same release hold the
//                          same bytes, so they compute the same id and share
//                          one daemon (the old id used the mtime of
//                          dist/server.js, and two installs ran two ~630 MB
//                          daemons). `check` lets the runtime notice a tree
//                          recompiled since (tsc --watch) and not trust it.
//   dist/mcp-surface.json  the answers to initialize, ping and tools/list,
//                          taken from the real server (src/daemon/surface.ts),
//                          so a proxy can give them at once.
//
//   node scripts/build-id.mjs [distDir] [--id-only]      (npm run build runs it)

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const idOnly = process.argv.includes('--id-only');
const dist = positional[0] ?? join(HERE, '..', 'dist');
const pkgFile = join(dist, '..', 'package.json');

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(full));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** sha256 over each compiled .js file's path (relative, forward slashes) and bytes, in path order. */
function hashTree(root) {
  const h = createHash('sha256');
  const files = jsFiles(root).map(f => ({ f, rel: relative(root, f).split(sep).join('/') }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const { f, rel } of files) {
    h.update(rel).update('\0').update(readFileSync(f)).update('\0');
  }
  return { hash: h.digest('hex'), files: files.length };
}

const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
const { hash, files } = hashTree(dist);
const build = `${pkg.version}-${hash.slice(0, 16)}`;
const check = { file: 'server.js', sha256: createHash('sha256').update(readFileSync(join(dist, 'server.js'))).digest('hex') };
writeFileSync(join(dist, 'build-id.json'), `${JSON.stringify({ build, version: pkg.version, hash, files, check }, null, 2)}\n`);
if (idOnly) { console.log(`build ${build} · ${files} files`); process.exit(0); }

// The surface, asked of the compiled server. Nothing on disk is opened: the
// engines are built, never started; CRBRO_PATH points at an empty temp folder
// all the same, so no import can reach a real brain.
const sandbox = mkdtempSync(join(tmpdir(), 'crbro-build-'));
process.env.CRBRO_PATH = join(sandbox, 'brain');
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.CRBRO_SEMANTIC = '0';
process.env.CRBRO_MOD = '0';
process.env.CRBRO_AUTOBACKUP = '0';
let code = 0;
try {
  const { computeSurface, SURFACE_FILE } = await import(pathToFileURL(join(dist, 'daemon', 'surface.js')).href);
  const surface = await computeSurface(build);
  writeFileSync(join(dist, SURFACE_FILE), `${JSON.stringify(surface)}\n`);
  console.log(`build ${build} · ${files} files · ${surface.tools.tools.length} tools in the surface`);
} catch (err) {
  console.error(`could not write the MCP surface: ${err?.stack || err}`);
  code = 1;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(code);
