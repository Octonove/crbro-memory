// Prints the CHANGELOG.md section of one version (the lines under
// "## [X.Y.Z] ..." up to the next "## ["), for the GitHub release notes.
// Exits 1 when the section is missing or empty, so a release cannot go out
// without notes.
//
//   node scripts/changelog-section.mjs 2.11.0 > notes.md

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (process.argv[2] || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error('usage: node scripts/changelog-section.mjs <version>');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const start = lines.findIndex(l => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  console.error(`The CHANGELOG.md section for ${version} is empty`);
  process.exit(1);
}
console.log(body);
