// Preflight local. Sólo informa rutas/cuentas, nunca valores ni fragmentos.
// --local-keychain compara en memoria con secretos reales: opt-in, jamás en CI.
// --git-only <repo> revisa candidatos Git de otro repo, sin pack npm.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const gitOnly = argv.indexOf('--git-only');
const root = gitOnly >= 0 ? path.resolve(argv[gitOnly + 1] || '') : base;
if (!existsSync(path.join(root, '.git'))) throw Error('Expected a repository root.');
const files = new Map();
const blocked = [];
const add = (file, label) => {
  const full = path.resolve(file);
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Candidate outside repository.');
  const normalized = rel.replaceAll('\\', '/');
  if (/(^|\/)(\.env(?:\.[^/]+)?|\.npmrc|keys\.dpapi|secrets\.enc[^/]*|id_rsa|id_ed25519|[^/]*service[-_]?account[^/]*\.json)$/i.test(normalized)
      && !/\.example$/.test(normalized)) blocked.push({ file: normalized, reason: 'private-file-name', surface: label });
  if (!existsSync(full)) return;
  if (lstatSync(full).isSymbolicLink()) { blocked.push({ file: normalized, reason: 'symlink-review-required', surface: label }); return; }
  files.set(full, { file: normalized, surface: label });
};
const listed = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
for (const file of listed.split('\0').filter(Boolean)) add(path.join(root, file), 'git-candidate');
let npmCount = null, bundleCount = null;
if (gitOnly < 0) {
  const raw = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const pack = JSON.parse(raw)[0]; npmCount = pack.files.length;
  for (const f of pack.files) {
    if (!/^(?:(?:dist|bin|hooks|mods)\/|(?:README\.md|SECURITY\.md|LICENSE|package\.json)$)/.test(f.path)) {
      blocked.push({ file: f.path, reason: 'outside-npm-allowlist', surface: 'npm' });
    }
    add(path.join(root, f.path), 'npm');
  }
  const staging = path.join(root, 'build', 'mcpb');
  if (existsSync(staging)) {
    bundleCount = 0;
    const walk = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else { bundleCount++; add(full, 'mcpb-staging'); }
      }
    };
    walk(staging);
  }
}
let compared = 0, tooShort = 0;
if (argv.includes('--local-keychain')) {
  // Importa sólo el broker: no arranca el cerebro ni hace sync. No escribe.
  const { listSecrets, getSecret } = await import('../dist/engine/keychain.js');
  const values = new Set();
  for (const { name } of listSecrets()) {
    if (!/TOKEN|SECRET|PASS|API.?KEY|PRIVATE.?KEY|CREDENTIAL/i.test(name)) continue;
    const value = getSecret(name);
    if (!value) throw Error('A listed credential could not be read.');
    if (value.length < 4) { tooShort++; continue; }
    compared++;
    for (const variant of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString('base64')]) {
      values.add(variant);
    }
  }
  for (const [full, meta] of files) {
    const bytes = readFileSync(full);
    if ([...values].some(value => bytes.includes(Buffer.from(value)))) blocked.push({ ...meta, reason: 'matches-local-credential' });
  }
  values.clear();
}
console.log(JSON.stringify({ root, candidates: files.size, npm_files: npmCount, mcpb_staging_files: bundleCount,
  credentials_compared: compared, short_credentials_not_compared: tooShort, blocked,
  limits: 'Checks current candidate files and raw/JSON/URL/base64 forms of selected local credentials; not past Git history, every encoding, or proof against all secrets.' }, null, 2));
if (blocked.length || tooShort) process.exitCode = 1;
