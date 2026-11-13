// ─── The one page of crbro-memory view ───────────────────────────
//
// Self-contained: no external script, style, font or image, so the strict
// CSP of the viewer holds. Every piece of brain text reaches the DOM through
// textContent, never innerHTML. The token arrives once in the URL fragment
// (never sent to the server, never in a Referer), moves to sessionStorage,
// and leaves the address bar before anything else runs.

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--panel:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--accent:#2f5bd3;--accent-ink:#fff;--warn:#a15c00;--warn-bg:#fff4e0;--bad:#b42318;--bad-bg:#fdecea;--ok:#1b7f3b;--chip:#efeee9}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--ink:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#7d9bff;--accent-ink:#0e0e0d;--warn:#f0b257;--warn-bg:#2e2412;--bad:#ff8a80;--bad-bg:#3a1a17;--ok:#6fd38f;--chip:#2a2926}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--panel);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
header h1{font-size:17px;margin:0;font-weight:650}
#status{color:var(--muted);font-size:13px}
#searchForm{flex:1 1 260px;display:flex;gap:6px;min-width:0}
input,select,button,textarea{font:inherit;color:inherit}
input[type=search],input[type=text],select{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 10px;min-width:0}
#q{flex:1}
button{background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:6px 11px;cursor:pointer}
button:hover{border-color:var(--muted)}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
button.danger{color:var(--bad)}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
nav{display:flex;gap:4px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--panel);overflow-x:auto}
nav button{border:none;background:none;border-radius:6px}
nav button[aria-selected=true]{background:var(--chip);font-weight:600}
main{display:grid;grid-template-columns:minmax(260px,360px) 1fr;gap:16px;padding:16px;max-width:1400px;margin:0 auto}
@media (max-width:760px){main{grid-template-columns:1fr;padding:12px}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.filters>*{flex:1 1 110px}
ul.list{list-style:none;margin:0;padding:0;max-height:70vh;overflow:auto}
@media (max-width:760px){ul.list{max-height:40vh}}
ul.list li{padding:8px;border-radius:8px;cursor:pointer;border:1px solid transparent}
ul.list li:hover{background:var(--chip)}
ul.list li[aria-current=true]{border-color:var(--accent)}
.name{font-weight:600;overflow-wrap:anywhere}
.sub{color:var(--muted);font-size:12.5px}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:1px 8px;font-size:12px;margin:2px 4px 2px 0;color:var(--muted)}
.chip.stale,.chip.warn{background:var(--warn-bg);color:var(--warn)}
.chip.bad{background:var(--bad-bg);color:var(--bad)}
.chip.ok{color:var(--ok)}
h2{font-size:18px;margin:0 0 4px}
h3{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:18px 0 6px}
.summary{white-space:pre-wrap;border-left:3px solid var(--line);padding-left:10px;color:var(--muted)}
.entry{border-top:1px solid var(--line);padding:8px 0}
.entry .text{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0}
.actions{display:flex;flex-wrap:wrap;gap:6px}
.actions button{font-size:13px;padding:3px 9px}
.empty{color:var(--muted);padding:12px 0}
#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:8px;font-size:14px;display:none;max-width:90vw}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--ink);max-width:520px;width:calc(100% - 32px)}
dialog::backdrop{background:rgba(0,0,0,.45)}
.hidden{display:none!important}
.wide{grid-column:1/-1}
`;

const SCRIPT = String.raw`
(() => {
'use strict';
const KEY = 'crbro_view_token';
const m = /(?:^#|&)t=([0-9a-f]{64})(?:&|$)/.exec(location.hash);
if (m) { try { sessionStorage.setItem(KEY, m[1]); } catch (e) {} }
if (location.hash) history.replaceState(null, '', location.pathname);
let token = null;
try { token = sessionStorage.getItem(KEY); } catch (e) {}

const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const chip = (text, cls) => h('span', { class: 'chip' + (cls ? ' ' + cls : '') }, text);
const day = (s) => (typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : (s || ''));
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = 'none'; }, 3500); }

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit',
    headers: Object.assign({ 'X-CRBRO-Token': token || '' }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

function confirmDialog(title, text, okLabel) {
  return new Promise((resolve) => {
    const d = $('confirm');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOk').textContent = okLabel || 'Confirm';
    const done = (v) => { d.close(); resolve(v); };
    $('confirmOk').onclick = () => done(true);
    $('confirmCancel').onclick = () => done(false);
    d.oncancel = () => resolve(false);
    d.showModal();
  });
}

const state = { neurons: [], current: null, offset: 0, tab: 'neurons' };

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const s of document.querySelectorAll('[data-view]')) s.classList.toggle('hidden', s.dataset.view !== tab);
  if (tab === 'pending') loadPending();
  if (tab === 'review') loadReview();
}

async function loadStatus() {
  try {
    const s = (await api('/api/status')).status || {};
    $('status').textContent = 'v' + (s.crbro_version || '?') + ' · ' + (s.total_neurons ?? '?') + ' neurons · ' + (s.total_sessions ?? '?') + ' day logs';
  } catch (e) { $('status').textContent = e.message; }
}

async function loadNeurons() {
  $('neuronList').replaceChildren(h('li', { class: 'empty' }, 'Loading…'));
  try {
    const r = await api('/api/neurons');
    state.neurons = r.neurons || [];
    const domains = [...new Set(state.neurons.map(n => n.domain))].sort();
    const sel = $('fDomain');
    const keep = sel.value;
    sel.replaceChildren(h('option', { value: '' }, 'All domains'), ...domains.map(d => h('option', { value: d }, d)));
    sel.value = domains.includes(keep) ? keep : '';
    renderNeurons();
  } catch (e) { $('neuronList').replaceChildren(h('li', { class: 'empty' }, e.message)); }
}

function renderNeurons() {
  const d = $('fDomain').value, t = $('fType').value, q = $('fText').value.trim().toLowerCase();
  const rows = state.neurons.filter(n => (!d || n.domain === d) && (!t || n.type === t) &&
    (!q || (n.name + ' ' + n.id).toLowerCase().includes(q)));
  $('neuronCount').textContent = rows.length + ' of ' + state.neurons.length;
  const list = $('neuronList');
  if (!rows.length) { list.replaceChildren(h('li', { class: 'empty' }, 'No neuron matches.')); return; }
  list.replaceChildren(...rows.slice(0, 1000).map(n => h('li', {
    tabindex: '0', 'aria-current': String(state.current === n.id),
    onclick: () => openNeuron(n.id), onkeydown: (ev) => { if (ev.key === 'Enter') openNeuron(n.id); },
  }, h('div', { class: 'name' }, n.name), h('div', { class: 'sub' }, n.type + ' · ' + n.domain + ' · heat ' + Number(n.heat || 0).toFixed(2) + ' · ' + (n.facts_count ?? 0) + ' facts'))));
}

const KIND_TITLES = { map: 'Map', error: 'Errors', debt: 'Debts', preference: 'Preferences', pattern: 'Patterns', decision: 'Decisions', fact: 'Facts' };

function freshnessChips(e) {
  const out = [];
  if (e.status) out.push(chip(e.status, 'bad'));
  if (e.stale_days !== undefined) out.push(chip('possibly stale · ' + e.stale_days + ' d', 'stale'));
  else if (e.freshness && e.freshness.state && e.freshness.state !== 'unverified') out.push(chip(e.freshness.state.replace(/_/g, ' ')));
  const v = e.verification;
  if (v && v.method && v.method !== 'none') out.push(chip('verified: ' + v.method + (v.at ? ' ' + day(v.at) : ''), 'ok'));
  else if (e.verified) out.push(chip('verified ' + day(e.verified), 'ok'));
  else out.push(chip('unverified'));
  if (e.temporal === 'historical') out.push(chip('historical'));
  if (e.shelf_life) out.push(chip('shelf: ' + e.shelf_life));
  return out;
}

function entryActions(neuronId, e, after) {
  const acts = [];
  if (e.kind === 'map') return acts;
  if (!e.status && ['fact', 'decision', 'pattern'].includes(e.kind)) {
    acts.push(h('button', { onclick: async () => {
      try { await api('/api/verify', { neuron: neuronId, id: e.id, kind: e.kind }); toast('Marked as checked and still true.'); after(); } catch (err) { toast(err.message); }
    } }, 'Verify'));
  }
  if (!e.status) {
    acts.push(h('button', { onclick: async () => {
      if (!(await confirmDialog('Retire this entry?', 'It stays in the file but leaves recall (reversible with crbro_revise status=active).', 'Retire'))) return;
      try { await api('/api/retire', { neuron: neuronId, id: e.id, kind: e.kind }); toast('Retired.'); after(); } catch (err) { toast(err.message); }
    } }, 'Retire'));
  }
  acts.push(h('button', { class: 'danger', onclick: async () => {
    if (!(await confirmDialog('Remove this entry for good?', 'It is deleted from the neuron after a quarantine copy (crbro_forget). This is for what must not exist on disk at all; to mark something as no longer true, use Retire.', 'Remove'))) return;
    try { await api('/api/remove', { neuron: neuronId, id: e.id }); toast('Removed (a copy is in quarantine).'); after(); } catch (err) { toast(err.message); }
  } }, 'Remove'));
  return acts;
}

function renderEntry(neuronId, e, after) {
  const text = h('div', { class: 'text' }, e.preview ?? e.text ?? '');
  const more = (e.chars && e.preview && e.chars > e.preview.length - 1) ? h('button', { onclick: async () => {
    try {
      const r = await api('/api/entry?neuron=' + encodeURIComponent(neuronId) + '&id=' + encodeURIComponent(e.id));
      text.textContent = r.entry ? (r.entry.text + (r.entry.rationale ? '\n\nWhy: ' + r.entry.rationale : '')) : text.textContent;
      more.remove();
    } catch (err) { toast(err.message); }
  } }, 'Show full') : null;
  return h('div', { class: 'entry' },
    h('div', { class: 'sub' }, (e.kind !== 'map' ? 'id ' + e.id + ' · ' : '') + (day(e.added) || 'undated')),
    h('div', {}, ...freshnessChips(e)),
    text,
    h('div', { class: 'actions' }, more, ...entryActions(neuronId, e, after)));
}

async function openNeuron(id, keepOffset) {
  state.current = id;
  if (!keepOffset) state.offset = 0;
  renderNeurons();
  const box = $('detail');
  box.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  try {
    const r = await api('/api/neuron?id=' + encodeURIComponent(id) + '&offset=' + state.offset + ($('fRetired').checked ? '&retired=1' : ''));
    const n = r.neuron;
    const reload = () => openNeuron(id, true);
    const groups = {};
    for (const e of n.entries || []) (groups[e.kind] = groups[e.kind] || []).push(e);
    const pag = n.entries_pagination || {};
    box.replaceChildren(
      h('h2', {}, n.name),
      h('div', { class: 'sub' }, n.id + ' · ' + n.type + ' · ' + n.domain + ' · heat ' + Number(n.heat || 0).toFixed(2) + ' · created ' + day(n.created)),
      n.tags && n.tags.length ? h('div', {}, ...n.tags.map(t => chip(t))) : null,
      n.summary ? h('p', { class: 'summary' }, n.summary) : null,
      n.connections && n.connections.length ? h('div', { class: 'sub' }, 'Connected to: ', ...n.connections.slice(0, 30).map(c => h('button', { onclick: () => openNeuron(c.target_id) }, c.target_name || c.target_id))) : null,
      ...['map', 'error', 'debt', 'preference', 'pattern', 'decision', 'fact'].filter(k => groups[k]).flatMap(k => [
        h('h3', {}, KIND_TITLES[k] + ' (' + groups[k].length + (n.counts && n.counts[k] > groups[k].length ? ' of ' + n.counts[k] : '') + ')'),
        ...groups[k].map(e => renderEntry(n.id, e, reload)),
      ]),
      (n.entries || []).length ? null : h('div', { class: 'empty' }, 'No live entries.'),
      h('div', { class: 'actions' },
        state.offset > 0 ? h('button', { onclick: () => { state.offset = Math.max(0, state.offset - 50); openNeuron(id, true); } }, 'Previous') : null,
        pag.has_more ? h('button', { onclick: () => { state.offset += (n.entries || []).length; openNeuron(id, true); } }, 'Next (' + (pag.total - state.offset - (n.entries || []).length) + ' more)') : null),
    );
    if (window.matchMedia('(max-width:760px)').matches) box.scrollIntoView({ behavior: 'smooth' });
  } catch (e) { box.replaceChildren(h('div', { class: 'empty' }, e.message)); }
}

async function search(ev) {
  ev.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  setTab('search');
  const box = $('searchResults');
  box.replaceChildren(h('div', { class: 'empty' }, 'Searching…'));
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    const row = (x, stale) => h('div', { class: 'entry' },
      h('div', {}, h('button', { onclick: () => { setTab('neurons'); openNeuron(x.neuron_id); } }, x.name || x.neuron_id), ' ',
        x.matched_kind ? chip(x.matched_kind) : null, x.confidence ? chip(x.confidence, x.confidence === 'weak' ? 'warn' : 'ok') : null,
        stale ? chip('possibly stale', 'stale') : null, x.matched_added ? chip(day(x.matched_added)) : null),
      h('div', { class: 'text' }, x.matching_content || x.last_known || ''));
    const rows = (r.results || []).map(x => row(x, false));
    const stale = (r.possibly_stale || []).map(x => row(x, true));
    box.replaceChildren(h('h2', {}, 'Results for “' + q + '”'),
      ...(rows.length ? rows : [h('div', { class: 'empty' }, r.no_answer ? 'Nothing really matches.' : 'No results.')]),
      ...(stale.length ? [h('h3', {}, 'Possibly stale'), ...stale] : []));
  } catch (e) { box.replaceChildren(h('div', { class: 'empty' }, e.message)); }
}

async function loadPending() {
  const box = $('pendingBox');
  box.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  try {
    const r = await api('/api/pending');
    const open = (r.open || []);
    const act = (t, action, label, ask) => h('button', { onclick: async () => {
      if (ask && !(await confirmDialog('Discard this item?', 'It is dropped without being recorded as done.', 'Discard'))) return;
      try { await api('/api/pending', { action, id: t.id }); toast(action === 'resolve' ? 'Closed.' : 'Discarded.'); loadPending(); } catch (e) { toast(e.message); }
    } }, label);
    box.replaceChildren(
      h('h2', {}, 'Open items (' + open.length + ')'),
      ...(open.length ? open.map(t => h('div', { class: 'entry' },
        h('div', { class: 'sub' }, (t.id || '') + (t.added ? ' · added ' + day(t.added) : '') + (t.due ? ' · due ' + t.due : '') + (t.project ? ' · project ' + t.project : '')),
        h('div', { class: 'text' }, t.text),
        t.done_when ? h('div', { class: 'sub' }, 'Done when: ' + t.done_when) : null,
        t.id ? h('div', { class: 'actions' }, act(t, 'resolve', 'Resolve'), act(t, 'discard', 'Discard', true)) : null)) : [h('div', { class: 'empty' }, 'Nothing open.')]),
      ...((r.closed || []).length ? [h('h3', {}, 'Recently closed'), ...r.closed.map(t => h('div', { class: 'entry' }, h('div', { class: 'sub' }, 'closed ' + day(t.closed)), h('div', { class: 'text' }, t.text)))] : []));
  } catch (e) { box.replaceChildren(h('div', { class: 'empty' }, e.message)); }
}

async function loadReview() {
  const box = $('reviewBox');
  box.replaceChildren(h('div', { class: 'empty' }, 'Checking the brain (read-only)…'));
  try {
    const r = await api('/api/stale');
    const row = (s, label) => h('div', { class: 'entry' },
      h('div', {}, h('button', { onclick: () => { setTab('neurons'); openNeuron(s.neuron_id); } }, s.neuron_id), ' ', chip(s.kind), chip(label, 'stale'),
        s.last_verified ? chip('last checked ' + day(s.last_verified)) : null),
      h('div', { class: 'text' }, s.preview || s.text || ''),
      h('div', { class: 'actions' }, ...entryActions(s.neuron_id, { id: s.entry_id, kind: s.kind }, loadReview)));
    const stale = r.stale || [], expired = r.expired || [];
    box.replaceChildren(
      h('h2', {}, 'Possibly stale (' + (r.stale_count ?? stale.length) + ')'),
      h('p', { class: 'sub' }, 'Past their shelf life since last checked; the most overdue are listed. Verify what still holds, retire what does not.'),
      ...(stale.length ? stale.map(s => row(s, (s.age_days ?? '?') + ' d old')) : [h('div', { class: 'empty' }, 'Nothing past its shelf life.')]),
      h('h3', {}, 'Named a date that has passed (' + (r.expired_count ?? expired.length) + ')'),
      ...(expired.length ? expired.map(s => row(s, 'date passed')) : [h('div', { class: 'empty' }, 'None.')]));
  } catch (e) { box.replaceChildren(h('div', { class: 'empty' }, e.message)); }
}

if (!token) {
  document.body.replaceChildren(h('main', {}, h('div', { class: 'panel' }, h('h2', {}, 'No access token'),
    h('p', {}, 'Open the link that crbro-memory view printed in the terminal. The token lives only in this tab.'))));
  return;
}
for (const b of document.querySelectorAll('nav button')) b.addEventListener('click', () => setTab(b.dataset.tab));
$('searchForm').addEventListener('submit', search);
for (const id of ['fDomain', 'fType']) $(id).addEventListener('change', renderNeurons);
$('fText').addEventListener('input', renderNeurons);
$('fRetired').addEventListener('change', () => { if (state.current) openNeuron(state.current); });
loadStatus();
loadNeurons();
})();
`;

const BODY = `
<header>
  <h1>CRBRO memory</h1>
  <span id="status">…</span>
  <form id="searchForm" role="search"><input id="q" type="search" placeholder="Search the memory (crbro_recall)" aria-label="Search"><button class="primary" type="submit">Search</button></form>
</header>
<nav role="tablist">
  <button role="tab" data-tab="neurons" aria-selected="true">Neurons</button>
  <button role="tab" data-tab="search" aria-selected="false">Search</button>
  <button role="tab" data-tab="pending" aria-selected="false">Open items</button>
  <button role="tab" data-tab="review" aria-selected="false">Needs review</button>
</nav>
<main data-view="neurons">
  <section class="panel" aria-label="Neurons">
    <div class="filters">
      <select id="fDomain" aria-label="Domain"><option value="">All domains</option></select>
      <select id="fType" aria-label="Type"><option value="">All types</option><option>project</option><option>tech</option><option>lang</option><option>person</option><option>domain</option><option>process</option><option>protocol</option></select>
      <input id="fText" type="text" placeholder="Filter by name" aria-label="Filter by name">
    </div>
    <div class="sub"><span id="neuronCount"></span> · <label><input id="fRetired" type="checkbox"> show retired entries</label></div>
    <ul id="neuronList" class="list"></ul>
  </section>
  <section class="panel" id="detail" aria-live="polite"><div class="empty">Pick a neuron to see its entries.</div></section>
</main>
<main data-view="search" class="hidden"><section id="searchResults" class="panel wide"></section></main>
<main data-view="pending" class="hidden"><section id="pendingBox" class="panel wide"></section></main>
<main data-view="review" class="hidden"><section id="reviewBox" class="panel wide"></section></main>
<dialog id="confirm"><h2 id="confirmTitle"></h2><p id="confirmText"></p><div class="actions"><button id="confirmCancel" type="button">Cancel</button><button id="confirmOk" class="primary" type="button">Confirm</button></div></dialog>
<div id="toast" role="status"></div>
`;

/** The page, with `nonce` on its one style and one script. */
export function viewerPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>CRBRO memory</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>${BODY}<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

/** The CSP the page is served with: nothing external, nothing inline without the nonce, no framing, no forms. */
export function viewerCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
