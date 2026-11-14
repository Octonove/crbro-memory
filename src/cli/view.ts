// ─── crbro-memory view ───────────────────────────────────────────
//
// A local page to see the memory, close pending items and review what may be
// stale — the answer to "I trust my CLAUDE.md because I can see it".
//
// Security model, in order of what a request meets:
//   · bound to 127.0.0.1 only, never another interface;
//   · the Host header must be 127.0.0.1:<port> or localhost:<port>, which
//     defeats DNS rebinding (a hostile page whose name resolves to 127.0.0.1
//     still sends its own name as Host);
//   · every /api request carries a fresh 32-byte token in a header; the page
//     gets it once through the URL fragment, which no request or Referer
//     carries, and keeps it in sessionStorage;
//   · no CORS headers at all, a request with a foreign Origin is refused, and
//     writes need Content-Type application/json, so a cross-site form cannot
//     even reach the token check;
//   · the API is a fixed list of operations, not a tool proxy: no credential
//     tool, no whole-neuron delete, no free-form arguments;
//   · a strict CSP with a per-response nonce; brain text only ever reaches
//     the DOM as text.
// Reads and writes are MCP tool calls to a server spawned over stdio, exactly
// like import: the daemon, when it is on, stays the single writer.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { waitForStop, parseArgs, randomToken, tokenMatches, hostAllowed, loopbackHosts, BASE_SECURITY_HEADERS, openBrowser } from './common.js';
import { spawnServer, type ToolCaller } from './mcpclient.js';
import { viewerPage, viewerCsp } from './viewer-page.js';

export const VIEW_HELP = `
  crbro-memory view [--port <n>] [--no-open]

  Open a local page to see and tidy the memory: neurons with filters, every
  entry with its date, status, verification and freshness, a search box
  (crbro_recall), open items to resolve or discard, possibly-stale entries to
  verify or retire, editing the text of an entry, merging one neuron into
  another (previews first) and removing one entry (asks first).

    --port <n>    Port on 127.0.0.1 (default: a free one picked by the system).
    --no-open     Print the link instead of opening the browser.

  Only this machine can reach it (127.0.0.1), and only with the one-time link
  printed below: it carries a random token that dies with the process.
  Ctrl+C stops the page and the CRBRO server it started.
`;

const MAX_BODY = 64 * 1024;
const REF_RE = /^[\s\S]{1,300}$/;
const PENDING_ID_RE = /^p_[A-Za-z0-9]{4,32}$/;
const ENTRY_KINDS = new Set(['fact', 'decision', 'pattern', 'preference', 'error', 'debt']);

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function send(res: http.ServerResponse, status: number, body: string, headers: Record<string, string>): void {
  res.writeHead(status, { ...BASE_SECURITY_HEADERS, 'Content-Length': String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  send(res, status, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) throw new HttpError(413, 'body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
}

const str = (v: unknown, what: string, re: RegExp = REF_RE): string => {
  if (typeof v !== 'string' || !re.test(v)) throw new HttpError(400, `invalid ${what}`);
  return v;
};

/** One tool call; an isError answer becomes a 4xx with the tool's own message. */
async function tool(caller: ToolCaller, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await caller.call(name, args);
  if (!r.ok) throw new HttpError(400, r.text.slice(0, 500) || `${name} failed`);
  if (r.data === null) throw new HttpError(400, r.text.slice(0, 500) || `${name} answered without data`);
  return r.data;
}

/** The fixed API. Each route is one or two tool calls with validated arguments. */
export async function handleApi(caller: ToolCaller, method: string, pathname: string, query: URLSearchParams, body: () => Promise<any>): Promise<unknown> {
  const get = method === 'GET', post = method === 'POST';
  switch (pathname) {
    case '/api/status': {
      if (!get) break;
      const d = await tool(caller, 'crbro_inspect', { view: 'status' });
      return { status: d.status ?? d };
    }
    case '/api/neurons': {
      if (!get) break;
      const all: any[] = [];
      let offset = 0, total = 0;
      for (let guard = 0; guard < 1000; guard++) {
        const d = await tool(caller, 'crbro_inspect', { view: 'neurons', limit: 100, offset });
        const page = d.neurons ?? d;
        const rows: any[] = Array.isArray(page.neurons) ? page.neurons : [];
        total = page.total ?? rows.length;
        all.push(...rows);
        offset += rows.length;
        if (!rows.length || offset >= total) break;
      }
      return { total, neurons: all };
    }
    case '/api/neuron': {
      if (!get) break;
      const id = str(query.get('id'), 'id');
      const offset = Math.max(0, Math.min(1_000_000, Number(query.get('offset') || 0) || 0));
      const d = await tool(caller, 'crbro_inspect', {
        view: 'neuron', neuron: id, limit: 50, offset, include_superseded: query.get('retired') === '1',
      });
      const n = d.neuron ?? d;
      // crbro_inspect leaves fields at their default out of each row (2.11):
      // the page shows them, so they are filled back in here.
      if (Array.isArray(n.entries)) {
        n.entries = n.entries.map((e: any) => ({
          ...e,
          verification: e.verification ?? { method: 'none' },
          freshness: e.freshness ?? { state: 'unverified' },
        }));
      }
      return { neuron: n };
    }
    case '/api/entry': {
      if (!get) break;
      const neuron = str(query.get('neuron'), 'neuron');
      const id = str(query.get('id'), 'id');
      const d = await tool(caller, 'crbro_inspect', { view: 'neuron', neuron, entries: [id] });
      const n = d.neuron ?? d;
      return { entry: Array.isArray(n.entries) ? n.entries[0] ?? null : null };
    }
    case '/api/search': {
      if (!get) break;
      const q = str(query.get('q'), 'query', /^[\s\S]{1,500}$/);
      const d = await tool(caller, 'crbro_recall', { query: q, limit: 10, scope: 'all' });
      return { results: d.results ?? [], possibly_stale: d.possibly_stale ?? [], no_answer: d.no_answer ?? undefined };
    }
    case '/api/pending': {
      if (get) {
        const d = await tool(caller, 'crbro_context', { scope: 'all' });
        const open = (d.pending_tasks || []).map((t: any) => (typeof t === 'string' ? { id: '', text: t } : t));
        return { open, closed: d.recently_closed || [] };
      }
      if (!post) break;
      const b = await body();
      const id = str(b?.id, 'pending id', PENDING_ID_RE);
      if (b?.action !== 'resolve' && b?.action !== 'discard') throw new HttpError(400, 'action must be resolve or discard');
      const d = await tool(caller, 'crbro_context', { scope: 'all', [b.action === 'resolve' ? 'resolve_pending' : 'discard_pending']: id });
      const hit = b.action === 'resolve' ? d.resolved : d.discarded;
      if (Array.isArray(hit) && hit.length === 0) throw new HttpError(404, 'no open item with that id');
      return { ok: true };
    }
    case '/api/stale': {
      if (!get) break;
      const d = await tool(caller, 'crbro_maintenance', { dry_run: true });
      return {
        stale: d.stale_sample ?? [], stale_count: d.stale_entries ?? 0,
        expired: d.expired_sample ?? [], expired_count: d.expired_entries ?? 0,
      };
    }
    case '/api/verify':
    case '/api/retire': {
      if (!post) break;
      const b = await body();
      const neuron = str(b?.neuron, 'neuron');
      const id = str(b?.id, 'entry id');
      const kind = str(b?.kind, 'kind');
      if (!ENTRY_KINDS.has(kind)) throw new HttpError(400, 'invalid kind');
      const verify = pathname === '/api/verify';
      if (verify && !['fact', 'decision', 'pattern'].includes(kind)) throw new HttpError(400, 'only facts, decisions and patterns are verified');
      let target = id;
      if (kind !== 'fact' && !verify) {
        // Retiring a decision, pattern, error or debt goes by its exact text.
        const d = await tool(caller, 'crbro_inspect', { view: 'neuron', neuron, entries: [id] });
        const entry = (d.neuron ?? d).entries?.[0];
        if (!entry?.text) throw new HttpError(404, 'entry not found');
        target = entry.text;
      }
      const args: Record<string, unknown> = { neuron, [kind === 'fact' ? 'facts' : 'entries']: [target] };
      if (verify) { args.status = 'verified'; args.evidence = { method: 'user' }; } else { args.status = 'superseded'; args.note = 'Retired from crbro-memory view.'; }
      const d = await tool(caller, 'crbro_revise', args);
      if (Array.isArray(d.unmatched) && d.unmatched.length) throw new HttpError(409, 'nothing matched: the entry may have changed or be retired already');
      return { ok: true };
    }
    case '/api/edit': {
      // Change the text of one entry. A fact is replaced with `supersedes`, which retires the
      // old one in the same call; the other kinds are written new and the old text retired
      // after, so a failure between the two leaves both and never neither.
      if (!post) break;
      const b = await body();
      const neuron = str(b?.neuron, 'neuron');
      const id = str(b?.id, 'entry id');
      const text = str(b?.text, 'text', /^[\s\S]{1,4000}$/).trim();
      if (!text) throw new HttpError(400, 'invalid text');
      const d = await tool(caller, 'crbro_inspect', { view: 'neuron', neuron, entries: [id] });
      const n = d.neuron ?? d;
      const entry = n.entries?.[0];
      if (!entry?.text) throw new HttpError(404, 'entry not found');
      // A full read says `active` for a live fact; anything else (superseded, retracted) is retired.
      if (entry.status && entry.status !== 'active') throw new HttpError(409, 'this entry is retired: bring it back before editing it');
      if (entry.kind === 'map') throw new HttpError(400, 'the map is rewritten as a whole with crbro_map');
      if (!ENTRY_KINDS.has(entry.kind)) throw new HttpError(400, 'invalid kind');
      if (text === entry.text) throw new HttpError(400, 'nothing changed');
      const neuronId = String(n.id ?? neuron);
      const args: Record<string, unknown> = { neuron_id: neuronId, type: entry.kind, content: text };
      if (entry.kind === 'fact') {
        args.supersedes = [id];
        if (Array.isArray(entry.keys) && entry.keys.length) args.keywords = entry.keys;
      }
      if (entry.kind === 'decision' && entry.rationale) args.rationale = entry.rationale;
      const added = await tool(caller, 'crbro_learn', args);
      if (entry.kind === 'fact') {
        if (Array.isArray(added.supersedes_unmatched) && added.supersedes_unmatched.length) {
          throw new HttpError(409, 'the new text was saved but the old entry could not be retired (it may have changed): retire it by hand');
        }
      } else {
        const r = await tool(caller, 'crbro_revise', { neuron: neuronId, entries: [entry.text], status: 'superseded', note: 'Replaced by an edit in crbro-memory view.' });
        if (Array.isArray(r.unmatched) && r.unmatched.length) throw new HttpError(409, 'the new text was saved but the old one could not be retired: retire it by hand');
      }
      return { ok: true };
    }
    case '/api/merge': {
      // Union one neuron into another and delete the source (crbro_forget merge_into). Two steps:
      // without confirm it only says what would move; the source's copy stays in quarantine.
      if (!post) break;
      const b = await body();
      const source = str(b?.source, 'source neuron');
      const target = str(b?.target, 'target neuron');
      const read = async (ref: string) => {
        const d = await tool(caller, 'crbro_inspect', { view: 'neuron', neuron: ref, limit: 1 });
        const n = d.neuron ?? d;
        return { id: String(n.id ?? ref), name: String(n.name ?? ref), counts: n.counts ?? {} };
      };
      const from = await read(source);
      const into = await read(target);
      if (from.id === into.id) throw new HttpError(400, 'pick a different neuron to merge into');
      if (b?.confirm !== true) return { preview: { from, into } };
      const r = await tool(caller, 'crbro_forget', { neuron: from.id, merge_into: into.id });
      return { ok: true, message: r.message, backup: r.backup ?? undefined, undo: `crbro_forget restore:true neuron="${from.id}"` };
    }
    case '/api/remove': {
      if (!post) break;
      const b = await body();
      const neuron = str(b?.neuron, 'neuron');
      const id = str(b?.id, 'entry id');
      const d = await tool(caller, 'crbro_forget', { neuron, facts: [id] });
      if (!d.removed) throw new HttpError(409, 'nothing matched: the entry may already be gone');
      return { ok: true, backup: d.backup ?? undefined };
    }
    default:
      throw new HttpError(404, 'not found');
  }
  throw new HttpError(405, 'method not allowed');
}

export interface Viewer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export async function startViewer(opts: { caller: ToolCaller; port?: number; token?: string; log?: (line: string) => void }): Promise<Viewer> {
  const token = opts.token ?? randomToken();
  const log = opts.log ?? (() => undefined);
  let port = 0;

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, loopbackHosts(port))) {
        return sendJson(res, 421, { error: 'Host not allowed: open the link printed by crbro-memory view.' });
      }
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const method = req.method || 'GET';
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
        const nonce = randomBytes(16).toString('base64');
        return send(res, 200, method === 'HEAD' ? '' : viewerPage(nonce), {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': viewerCsp(nonce),
        });
      }
      if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
      // A browser always says where a request comes from. Ours is same-origin.
      const origin = req.headers.origin;
      if (origin !== undefined && !hostAllowed(origin.replace(/^http:\/\//i, ''), loopbackHosts(port))) {
        return sendJson(res, 403, { error: 'cross-origin request refused' });
      }
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) {
        return sendJson(res, 403, { error: 'cross-site request refused' });
      }
      const presented = req.headers['x-crbro-token'];
      if (!tokenMatches(Array.isArray(presented) ? presented[0] : presented, token)) {
        return sendJson(res, 401, { error: 'missing or wrong token: open the link printed by crbro-memory view' });
      }
      const payload = await handleApi(opts.caller, method, url.pathname, url.searchParams, () => readBody(req));
      sendJson(res, 200, payload);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.maxHeadersCount = 50;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/#t=${token}`;
  return {
    url, port, token,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

/** CLI entry: resolves with the exit code once the page is stopped. */
export async function main(argv: string[], deps: { connect?: () => Promise<ToolCaller>; onReady?: (v: Viewer) => void; signal?: AbortSignal } = {}): Promise<number> {
  const a = parseArgs(argv, { port: 'number', 'no-open': 'boolean' });
  if (a.flags.help) { console.log(VIEW_HELP); return 0; }
  const port = a.flags.port as number | undefined;
  if (port !== undefined && port > 65535) a.errors.push('--port must be 0-65535 (0 = any free port)');
  if (a.positionals.length) a.errors.push(`unexpected argument: ${a.positionals[0]}`);
  if (a.errors.length) {
    console.error(`  ❌ ${a.errors.join('; ')}`);
    console.error('     Usage: crbro-memory view [--port <n>] [--no-open]   (--help for more)');
    return 2;
  }
  let caller: ToolCaller | null = null;
  let viewer: Viewer | null = null;
  try {
    caller = await (deps.connect ? deps.connect() : spawnServer());
    viewer = await startViewer({ caller, port, log: line => console.error(`  [view] ${line}`) });
  } catch (err) {
    await caller?.close();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ view: ${/EADDRINUSE/.test(msg) ? `port ${port} is in use; pick another with --port, or leave it out` : msg}`);
    return 1;
  }
  console.log('');
  console.log('  🧠 CRBRO memory viewer — this machine only (127.0.0.1)');
  console.log(`     ${viewer.url}`);
  console.log('     The link carries a one-time token: do not share it. Ctrl+C to stop.');
  console.log('');
  if (!a.flags['no-open']) openBrowser(viewer.url);
  deps.onReady?.(viewer);
  await waitForStop(deps.signal);
  await viewer.close();
  await caller.close();
  console.log('  Viewer stopped.');
  return 0;
}
