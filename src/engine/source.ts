// ─── CRBRO Named sources ─────────────────────────────────────────
//
// Where a stored line says its value came from, when it says so: a file, a
// path or a URL written in the line itself ("según config/app.yml", "in
// .env.production", "from https://…/pricing"). Recall uses it to tell the
// agent WHAT to open before answering with a possibly_stale row, instead of a
// generic "check its source". Pure and conservative: a line that names no
// file, path or URL gets no source, and the next step falls back to "look
// where this kind of value lives, or say it may be out of date".
//
// It never reads the disk or the network: CRBRO says where to look, the agent
// looks (docs/design/staleness.md §11, §14).

/** File extensions that mark a bare word as a file name: config, docs, data, code. */
const EXT = [
  'ya?ml', 'json5?', 'jsonc', 'toml', 'ini', 'env', 'cfg', 'conf', 'config', 'properties', 'xml', 'plist',
  'md', 'mdx', 'txt', 'rst', 'adoc', 'csv', 'tsv', 'xlsx?', 'ods', 'sql', 'prisma', 'graphql',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'php', 'cs', 'swift',
  'sh', 'ps1', 'bat', 'lock', 'gradle', 'tf', 'tfvars', 'hcl', 'nix', 'dockerfile',
].join('|');

/** Opens a token: start, whitespace or an opening quote/bracket. */
const OPEN = '(?:^|[\\s(\\[{`"\'«“‘])';
/** Closes a token: end, whitespace, a closing quote/bracket or sentence punctuation. */
const CLOSE = '(?=$|[\\s)\\]}`"\'»”’,;:!?]|\\.(?:\\s|$))';

const PATTERNS: RegExp[] = [
  // URLs: https://example.com/pricing
  new RegExp(`${OPEN}(https?:\\/\\/[^\\s)\\]}\`"'»”’<>]+?)${CLOSE}`, 'giu'),
  // Windows paths: C:\app\config.ini
  new RegExp(`${OPEN}([A-Za-z]:\\\\[^\\s"'\`»”’<>]+?)${CLOSE}`, 'gu'),
  // Paths with a separator: config/app.yml, ./src/x.ts, ~/.ssh/config, /etc/nginx/nginx.conf
  new RegExp(`${OPEN}((?:~|\\.{1,2})?\\/?(?:[\\w.@-]+\\/)+[\\w.@-]*[\\w])${CLOSE}`, 'gu'),
  // Bare file names with a known extension: precios.json, docker-compose.yml, .env.production
  new RegExp(`${OPEN}(\\.?[\\w-]+(?:\\.[\\w-]+)*\\.(?:${EXT}))${CLOSE}`, 'giu'),
  // Dotfiles and well-known extensionless files: .env, .env.local, .npmrc, Dockerfile, Makefile
  new RegExp(`${OPEN}((?:\\.(?:env|npmrc|nvmrc|yarnrc|editorconfig|htaccess|gitignore|dockerignore|tool-versions|python-version|node-version)(?:\\.[\\w-]+)*|Dockerfile|Makefile|Procfile|Caddyfile|Gemfile|Jenkinsfile))${CLOSE}`, 'gu'),
];

/** Product names that look like file names: "Node.js 22" names a runtime, not a file. */
const PRODUCT_JS = /^(?:node|next|nuxt|vue|react|express|nest|three|d3|chart|socket\.io|ember|backbone|alpine|solid|svelte|deno|bun|moment|day|p5|anime|pixi|babylon|leaflet|ckeditor|tiptap|quill)\.(?:js|ts)$/i;

/**
 * A path match must look like a file or a directory someone could open, not
 * a ratio or a unit: "km/h", "24/7", "€/mes", "and/or", "TCP/IP" are not
 * sources. Kept: anything rooted (/, ~/, ./, ../), anything with a file
 * extension in its last segment, and multi-segment paths of plain names.
 */
function plausiblePath(p: string): boolean {
  if (/^(?:~|\.{1,2})?\//.test(p)) return p.split('/').filter(Boolean).length >= 2 || /^(?:~|\.{1,2})\//.test(p);
  const segs = p.split('/');
  if (segs.some(s => s === '')) return false;
  if (segs.every(s => /^\d+$/.test(s))) return false;        // 24/7, 1/2
  const last = segs[segs.length - 1];
  if (new RegExp(`\\.(?:${EXT})$`, 'i').test(last)) return true;
  // Two plain segments with no extension ("and/or", "TCP/IP", "input/output")
  // are words more often than folders; three or more read as a tree.
  return segs.length >= 3 && segs.every(s => /^[\w.@-]+$/.test(s));
}

/**
 * The files, paths and URLs a line names, in order of appearance, without
 * duplicates; at most `max`. Empty when it names none.
 */
export function namedSources(text: string, max = 3): string[] {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const found: Array<{ at: number; value: string }> = [];
  for (const [i, re] of PATTERNS.entries()) {
    re.lastIndex = 0;
    for (const m of raw.matchAll(re)) {
      const value = m[1].replace(/[.,;:]+$/, '');
      if (!value) continue;
      if (i === 2 && !plausiblePath(value)) continue;
      found.push({ at: (m.index ?? 0) + m[0].indexOf(m[1]), value });
    }
  }
  found.sort((a, b) => a.at - b.at);
  for (let k = found.length - 1; k >= 0; k--) if (PRODUCT_JS.test(found[k].value)) found.splice(k, 1);
  const out: string[] = [];
  for (const { value } of found) {
    // A shorter match inside one already kept (the file name of a path, the
    // path of a URL) adds nothing.
    if (out.some(o => o.includes(value))) continue;
    for (let k = out.length - 1; k >= 0; k--) if (value.includes(out[k])) out.splice(k, 1);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}
