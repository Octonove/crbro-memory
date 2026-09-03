// ─── CRBRO Shared Memory: spaces ─────────────────────────────────
//
// A space is one shared project, or a few. Physically it is a directory that
// happens to be a git repository, holding nothing but everyone's notes. The
// cortex itself is never in it: reading a neuron updates its access count, so
// putting the cortex under git would produce a commit every time somebody
// asked a question. On the reference brain one neuron had been read 420 times.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readJSON, writeJSON, fileExists, now } from '../utils/fs.js';
import { contentHash } from '../utils/hash.js';
import { secretKinds } from '../engine/secrets.js';
import { applyOps, type MergeReport } from './materialize.js';
import { decodeOps, encodeOp, entryId, opsRelPath, OPS_VERSION, type Op } from './ops.js';
import type { Emitter } from '../engine/cortex.js';
import { git, gitAvailable, initSpace, cloneSpace, syncSpace, type GitResult } from './git.js';
import type { Brain } from '../engine/brain.js';
import type { Cortex } from '../engine/cortex.js';
import type { Neuron } from '../types/index.js';

export interface Identity {
  author: string;
  device: string;
}

export interface SpaceConfig {
  v: number;
  name: string;
  created_by: string;
  created: string;
  branch: string;
}

export interface ShareReport {
  dry_run: boolean;
  neuron_id: string;
  space: string;
  ops_to_emit: number;
  blocked: Array<{ where: string; kind: string }>;
  skipped_preferences: number;
  confirm_token?: string;
}

export interface SyncReport {
  space: string;
  state: 'ok' | 'offline' | 'no_git' | 'auth' | 'conflict' | 'not_joined';
  neurons_touched: string[];
  merged: MergeReport[];
  pushed: boolean;
  message: string;
}

/**
 * Who this machine is. Not a security claim — anyone with push access to the
 * repository can write any name — just a label so a fact says where it came
 * from. Never leaves the machine except inside the notes it signs.
 */
export async function getIdentity(brain: Brain, author?: string): Promise<Identity> {
  const p = path.join(brain.paths.root, 'identity.json');
  const existing = await readJSON<Identity>(p);
  if (existing && existing.author && !author) return existing;

  const id: Identity = {
    author: (author || existing?.author || 'me').toLowerCase().replace(/[^a-z0-9_-]/g, ''),
    device: existing?.device || contentHash(`${now()}:${Math.random()}`, 6),
  };
  await writeJSON(p, id);
  return id;
}

export function spaceDir(brain: Brain, name: string): string {
  return path.join(brain.paths.shared, name);
}

export async function readSpace(brain: Brain, name: string): Promise<SpaceConfig | null> {
  return readJSON<SpaceConfig>(path.join(spaceDir(brain, name), 'space.json'));
}

export async function listSpaces(brain: Brain): Promise<string[]> {
  try {
    const entries = await fs.readdir(brain.paths.shared, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

// ─── Creating and joining ────────────────────────────────────────

export async function createSpace(
  brain: Brain,
  name: string,
  remote: string,
  author: string,
  branch = 'main'
): Promise<{ ok: boolean; message: string; detail?: string }> {
  if (!gitAvailable()) {
    return { ok: false, message: 'git is not installed, and it is what carries the shared memory. Install it and try again.' };
  }
  const dir = spaceDir(brain, name);
  if (await fileExists(path.join(dir, 'space.json'))) {
    return { ok: false, message: `The space "${name}" already exists on this machine.` };
  }

  const id = await getIdentity(brain, author);
  const pushed = await initSpace(dir, remote, branch);

  const cfg: SpaceConfig = { v: 1, name, created_by: id.author, created: now(), branch };
  await writeJSON(path.join(dir, 'space.json'), cfg);
  await fs.mkdir(path.join(dir, '.local'), { recursive: true });

  git(['add', '-A', '.'], dir);
  git(['commit', '-q', '-m', `CRBRO space "${name}"`], dir);
  const again = git(['push', 'origin', `HEAD:${branch}`], dir, 30_000);

  if (!pushed.ok && !again.ok) {
    return {
      ok: false,
      message: 'The space was created locally but could not reach the remote. Check the URL and that you have push access.',
      detail: (again.stderr || pushed.stderr).slice(0, 300),
    };
  }

  return {
    ok: true,
    message: `Space "${name}" created and pushed. Anyone you invite to ${remote} can now join it.`,
  };
}

export async function joinSpace(
  brain: Brain,
  name: string,
  remote: string,
  author: string,
  branch = 'main'
): Promise<{ ok: boolean; message: string; detail?: string }> {
  if (!gitAvailable()) {
    return { ok: false, message: 'git is not installed, and it is what carries the shared memory. Install it and try again.' };
  }
  const dir = spaceDir(brain, name);
  if (await fileExists(path.join(dir, 'space.json'))) {
    return { ok: false, message: `You are already in the space "${name}".` };
  }

  await getIdentity(brain, author);
  await fs.mkdir(brain.paths.shared, { recursive: true });
  const r = cloneSpace(dir, remote, branch);
  if (!r.ok) {
    return {
      ok: false,
      message: r.reason === 'auth'
        ? 'Cloned nothing: no access to that repository. Ask to be added as a collaborator.'
        : 'Could not clone the space. Check the URL and your connection.',
      detail: r.stderr.slice(0, 300),
    };
  }

  await fs.mkdir(path.join(dir, '.local'), { recursive: true });
  return { ok: true, message: `Joined "${name}". Run a sync to pull in what the others already know.` };
}

// ─── Sharing a neuron ────────────────────────────────────────────

function neuronOps(neuron: Neuron, id: Identity): Op[] {
  const at = now();
  const ops: Op[] = [
    { v: OPS_VERSION, op: 'neuron', nid: neuron.id, by: id.author, at,
      name: neuron.name, ntype: neuron.type, domain: neuron.domain },
  ];

  for (const f of neuron.facts || []) {
    if (!f.text) continue;
    const fid = f.id || entryId(f.text);
    ops.push({ v: OPS_VERSION, op: 'fact', nid: neuron.id, by: id.author,
      at: f.added || at, fid, text: f.text, conf: f.confidence ?? 1, src: f.source,
      ...(f.keys?.length ? { keys: f.keys } : {}) });
    if (f.status === 'superseded' || f.status === 'retracted') {
      ops.push({ v: OPS_VERSION, op: 'status', nid: neuron.id, by: id.author,
        at: f.revised || at, fid, to: f.status, why: f.revision_note });
    }
  }

  for (const d of neuron.decisions || []) {
    if (!d.text) continue;
    ops.push({ v: OPS_VERSION, op: 'decision', nid: neuron.id, by: id.author,
      at: d.date || at, did: entryId(d.text), text: d.text, why: d.rationale });
  }
  // Dated entries carry their own date in `at`, so the team sees when a
  // pattern, error or debt was really recorded, not when it was shared.
  const fecha = (text: string) => neuron.entry_dates?.[entryId(text)] || at;
  for (const p of neuron.patterns || []) {
    if (p) ops.push({ v: OPS_VERSION, op: 'pattern', nid: neuron.id, by: id.author, at: fecha(p), text: p });
  }
  for (const t of neuron.tags || []) {
    if (t) ops.push({ v: OPS_VERSION, op: 'tag', nid: neuron.id, by: id.author, at, text: t });
  }
  for (const e of neuron.errors || []) {
    if (e) ops.push({ v: OPS_VERSION, op: 'error', nid: neuron.id, by: id.author, at: fecha(e), text: e });
  }
  for (const d of neuron.debts || []) {
    if (d) ops.push({ v: OPS_VERSION, op: 'debt', nid: neuron.id, by: id.author, at: fecha(d), text: d });
  }
  if (neuron.map && neuron.map.text) {
    ops.push({ v: OPS_VERSION, op: 'map', nid: neuron.id, by: id.author,
      at: neuron.map.updated || at, text: neuron.map.text });
  }

  // Preferences are deliberately absent and there is no op for them. They are
  // the smallest field in a real brain and the likeliest to hold a key — on
  // the reference brain, one of eighteen was an API key. Excluding them costs
  // nothing and removes a whole class of leak by construction.
  return ops;
}

/**
 * Look at what would be sent. Credentials block the share outright rather than
 * being redacted: silently sending someone a mangled version of a fact is
 * worse than refusing and saying where the problem is.
 */
export async function prepareShare(
  brain: Brain,
  cortex: Cortex,
  neuronRef: string,
  spaceName: string
): Promise<ShareReport | { error: string }> {
  const cfg = await readSpace(brain, spaceName);
  if (!cfg) return { error: `No such space: "${spaceName}". Create it or join it first.` };

  const neuron = (await cortex.peek(neuronRef)) || (await cortex.findByName(neuronRef));
  if (!neuron) return { error: `Neuron not found: "${neuronRef}".` };

  const blocked: Array<{ where: string; kind: string }> = [];
  const revisar = (where: string, text: string) => {
    for (const kind of secretKinds(text || '')) blocked.push({ where, kind });
  };
  (neuron.facts || []).forEach((f, i) => revisar(`facts[${i}]`, f.text));
  (neuron.decisions || []).forEach((d, i) => revisar(`decisions[${i}]`, d.text));
  (neuron.patterns || []).forEach((p, i) => revisar(`patterns[${i}]`, p));
  (neuron.errors || []).forEach((e, i) => revisar(`errors[${i}]`, e));
  (neuron.debts || []).forEach((d, i) => revisar(`debts[${i}]`, d));
  if (neuron.map?.text) revisar('map', neuron.map.text);

  const ops = neuronOps(neuron, await getIdentity(brain));

  return {
    dry_run: true,
    neuron_id: neuron.id,
    space: spaceName,
    ops_to_emit: ops.length,
    blocked,
    skipped_preferences: (neuron.preferences || []).length,
    confirm_token: blocked.length === 0
      ? contentHash(`${neuron.id}:${spaceName}:${ops.length}`, 8)
      : undefined,
  };
}

export async function commitShare(
  brain: Brain,
  cortex: Cortex,
  neuronRef: string,
  spaceName: string,
  token: string
): Promise<{ ok: boolean; message: string; ops?: number }> {
  const prep = await prepareShare(brain, cortex, neuronRef, spaceName);
  if ('error' in prep) return { ok: false, message: prep.error };
  if (prep.blocked.length > 0) {
    return { ok: false, message: 'Still blocked: remove the credentials first with crbro_forget.' };
  }
  if (!prep.confirm_token || prep.confirm_token !== token) {
    return { ok: false, message: 'That confirmation is stale. Run the dry run again and use the new token.' };
  }

  const neuron = (await cortex.peek(prep.neuron_id))!;
  const id = await getIdentity(brain);
  const dir = spaceDir(brain, spaceName);
  const rel = opsRelPath(neuron.id, id.author, id.device);
  const abs = path.join(dir, rel);

  await fs.mkdir(path.dirname(abs), { recursive: true });
  const ops = neuronOps(neuron, id);
  await fs.appendFile(abs, ops.map(encodeOp).join('\n') + '\n', 'utf-8');

  // Remember locally that this neuron belongs to a space, so future writes
  // keep flowing without anyone having to share it again. A neuron that was
  // unshared earlier loses its tombstone here, so re-sharing works.
  await removeUnshared(brain, neuron.id);
  await markShared(brain, neuron.id, spaceName);

  return { ok: true, message: `"${neuron.id}" is now shared in "${spaceName}".`, ops: ops.length };
}

// ─── Which neurons are shared ────────────────────────────────────

interface SharedMap { [neuronId: string]: string }

function sharedMapPath(brain: Brain): string {
  return path.join(brain.paths.root, 'shared-map.json');
}

export async function sharedMap(brain: Brain): Promise<SharedMap> {
  return (await readJSON<SharedMap>(sharedMapPath(brain))) || {};
}

export async function markShared(brain: Brain, neuronId: string, space: string): Promise<void> {
  const m = await sharedMap(brain);
  m[neuronId] = space;
  await writeJSON(sharedMapPath(brain), m);
}

// ─── Unsharing ───────────────────────────────────────────────────
//
// Tombstones live in their own file, not in shared-map.json: the SharedMap
// type stays a plain id → space dictionary, and a sync that finds the
// neuron's directory in the space still knows to leave it alone.

function unsharedPath(brain: Brain): string {
  return path.join(brain.paths.root, 'unshared.json');
}

/** Neuron ids this machine stopped following. */
export async function unsharedList(brain: Brain): Promise<string[]> {
  const raw = await readJSON<unknown>(unsharedPath(brain));
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

async function addUnshared(brain: Brain, neuronId: string): Promise<void> {
  const lista = await unsharedList(brain);
  if (!lista.includes(neuronId)) lista.push(neuronId);
  await writeJSON(unsharedPath(brain), lista);
}

async function removeUnshared(brain: Brain, neuronId: string): Promise<void> {
  const lista = await unsharedList(brain);
  if (!lista.includes(neuronId)) return;
  await writeJSON(unsharedPath(brain), lista.filter(id => id !== neuronId));
}

/**
 * Stop following a neuron in its space. Local only: no more notes go out and
 * the next sync ignores its directory. What was already sent stays in the
 * remote and in every teammate's brain — a log is append-only by design.
 * The ref falls back to the literal string as an id, so a neuron that has
 * already been forgotten can still be unshared.
 */
export async function unshareNeuron(
  brain: Brain,
  cortex: Cortex,
  neuronRef: string
): Promise<{ ok: boolean; neuron_id: string | null; space: string | null; message: string }> {
  const neuron = (await cortex.peek(neuronRef)) || (await cortex.findByName(neuronRef));
  const id = neuron?.id || neuronRef;

  const m = await sharedMap(brain);
  const space = m[id];
  if (!space) {
    return { ok: false, neuron_id: id, space: null, message: `"${id}" is not shared in any space.` };
  }

  delete m[id];
  await writeJSON(sharedMapPath(brain), m);
  await addUnshared(brain, id);

  return {
    ok: true,
    neuron_id: id,
    space,
    message: `"${id}" is no longer followed in "${space}": nothing more goes out and the next sync ` +
      'ignores it. Notes already sent stay in the remote and in your teammates\' brains.',
  };
}

/**
 * Leave a space: one last sync so pending notes go out, then the local copy
 * of the space is removed and its neurons stop being followed. The local
 * neurons and the remote repository are untouched. The ids are NOT
 * tombstoned — re-joining should follow them again.
 */
export async function leaveSpace(
  brain: Brain,
  cortex: Cortex,
  name: string
): Promise<{ ok: boolean; message: string; synced_before_leaving: SyncReport['state'] | 'skipped'; neurons_unshared: number }> {
  const cfg = await readSpace(brain, name);
  if (!cfg) {
    return { ok: false, message: `You are not in a space called "${name}".`, synced_before_leaving: 'skipped', neurons_unshared: 0 };
  }

  // Offline or no access are not failures here: the point is to leave, and
  // what could not be pushed is reported, not blocking.
  let synced: SyncReport['state'] | 'skipped' = 'skipped';
  try {
    synced = (await syncSpaceNow(brain, cortex, name, 10_000)).state;
  } catch {
    synced = 'offline';
  }

  // maxRetries: the space is a git repository, and on Windows its pack files
  // are read-only; Node retries after fixing the mode, but only if asked.
  await fs.rm(spaceDir(brain, name), { recursive: true, force: true, maxRetries: 3 });

  const m = await sharedMap(brain);
  let neurons_unshared = 0;
  for (const [nid, space] of Object.entries(m)) {
    if (space === name) {
      delete m[nid];
      neurons_unshared++;
    }
  }
  if (neurons_unshared > 0) await writeJSON(sharedMapPath(brain), m);

  const aviso = synced === 'ok'
    ? 'Your pending notes went out first.'
    : synced === 'offline' || synced === 'auth'
    ? `Your pending notes could not be pushed (${synced}); they are gone with the local copy.`
    : 'No final sync was possible.';

  return {
    ok: true,
    message: `Left "${name}". ${aviso} ${neurons_unshared} neuron(s) are no longer followed; ` +
      'your local copies are untouched and the remote repository was not modified.',
    synced_before_leaving: synced,
    neurons_unshared,
  };
}

/** Append one note for a neuron that is already shared. Silent if it is not. */
export async function emitOps(brain: Brain, neuronId: string, make: (id: Identity) => Op[]): Promise<void> {
  const m = await sharedMap(brain);
  const space = m[neuronId];
  if (!space) return;

  const dir = spaceDir(brain, space);
  if (!(await fileExists(path.join(dir, 'space.json')))) return;

  const id = await getIdentity(brain);
  const abs = path.join(dir, opsRelPath(neuronId, id.author, id.device));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const ops = make(id);
  if (ops.length === 0) return;
  await fs.appendFile(abs, ops.map(encodeOp).join('\n') + '\n', 'utf-8');
}

// ─── Sync ────────────────────────────────────────────────────────

async function readAllOps(dir: string, neuronId: string): Promise<Op[]> {
  const opsDir = path.join(dir, 'neurons', neuronId, 'ops');
  let files: string[];
  try {
    files = await fs.readdir(opsDir);
  } catch {
    return [];
  }
  const all: Op[] = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const raw = await fs.readFile(path.join(opsDir, f), 'utf-8');
      all.push(...decodeOps(raw).ops);
    } catch { /* unreadable log: skip it, keep the rest */ }
  }
  return all;
}

export async function syncSpaceNow(
  brain: Brain,
  cortex: Cortex,
  spaceName: string,
  timeoutMs = 30_000
): Promise<SyncReport> {
  const base: SyncReport = {
    space: spaceName, state: 'ok', neurons_touched: [], merged: [], pushed: false, message: '',
  };

  const cfg = await readSpace(brain, spaceName);
  if (!cfg) return { ...base, state: 'not_joined', message: `You are not in a space called "${spaceName}".` };
  if (!gitAvailable()) return { ...base, state: 'no_git', message: 'git is not installed on this machine.' };

  const dir = spaceDir(brain, spaceName);
  const id = await getIdentity(brain);
  const { pulled, pushed } = syncSpace(dir, id.author, cfg.branch || 'main', timeoutMs);

  if (!pulled.ok) {
    const state = (pulled.reason === 'offline' || pulled.reason === 'timeout') ? 'offline'
      : pulled.reason === 'auth' ? 'auth'
      : pulled.reason === 'conflict' ? 'conflict' : 'offline';
    return {
      ...base,
      state,
      message: state === 'offline'
        ? 'No connection. Your memory is intact and whatever you saved will go out next time.'
        : state === 'auth'
        ? 'No access to that repository. Ask to be added as a collaborator.'
        : 'The shared logs need a hand: someone edited them outside CRBRO.',
    };
  }

  // Rebuild every shared neuron from everyone's notes.
  let neuronIds: string[] = [];
  try {
    neuronIds = (await fs.readdir(path.join(dir, 'neurons'), { withFileTypes: true }))
      .filter(e => e.isDirectory()).map(e => e.name);
  } catch { /* nothing shared yet */ }

  // Neurons this machine stopped following: no merge, no markShared.
  const fuera = new Set(await unsharedList(brain));

  for (const nid of neuronIds) {
    if (fuera.has(nid)) continue;
    const ops = await readAllOps(dir, nid);
    if (ops.length === 0) continue;

    const local = await cortex.peek(nid);
    const { neuron, report } = applyOps(local, ops, { id: nid });

    const cambio = report.facts_added + report.facts_retracted + report.facts_superseded +
      report.decisions_added + report.patterns_added + report.tags_added +
      report.errors_added + report.debts_added + report.entries_removed +
      (report.map_updated ? 1 : 0);
    if (cambio > 0 || !local) {
      await cortex.replaceFromSync(neuron);
      base.neurons_touched.push(nid);
      base.merged.push(report);
    }
    await markShared(brain, nid, spaceName);
  }

  base.pushed = !!pushed?.ok;
  const nuevos = base.merged.reduce((n, m) => n + m.facts_added, 0);
  base.message = base.neurons_touched.length === 0
    ? 'Up to date. Nothing new from anyone.'
    : `${nuevos} new fact(s) across ${base.neurons_touched.length} shared neuron(s).`;
  if (!base.pushed && pushed) {
    base.message += ' Your own notes could not be pushed this time; they will go with the next sync.';
  }
  return base;
}

/** Sync every space. Used at boot and at consolidation, with a short budget. */
export async function syncAll(brain: Brain, cortex: Cortex, timeoutMs = 5_000): Promise<SyncReport[]> {
  const out: SyncReport[] = [];
  for (const name of await listSpaces(brain)) {
    try {
      out.push(await syncSpaceNow(brain, cortex, name, timeoutMs));
    } catch {
      out.push({ space: name, state: 'offline', neurons_touched: [], merged: [], pushed: false,
        message: 'Sync failed; local memory is untouched.' });
    }
  }
  return out;
}

/**
 * Wire a Cortex so writes to shared neurons reach the team log.
 *
 * Exported as one function on purpose. The indexer had exactly this shape and
 * was wired only inside the MCP server, so the miner — which builds its own
 * Cortex — silently never indexed anything. One entry point means the next
 * caller cannot forget.
 */
export function attachSync(brain: Brain, cortex: Cortex): void {
  const emitter: Emitter = async (neuronId, change) => {
    await emitOps(brain, neuronId, id => {
      const comun = { v: OPS_VERSION, nid: neuronId, by: id.author, at: change.at };
      if (change.kind === 'fact') {
        return [{ ...comun, op: 'fact', fid: change.fid, text: change.text,
                  conf: change.conf, src: change.src,
                  ...(change.keys?.length ? { keys: change.keys } : {}) } as Op];
      }
      if (change.kind === 'status') {
        return [{ ...comun, op: 'status', fid: change.fid, to: change.to, why: change.why } as Op];
      }
      if (change.kind === 'decision') {
        return [{ ...comun, op: 'decision', did: entryId(change.text),
                  text: change.text, why: change.why } as Op];
      }
      if (change.kind === 'error') {
        return [{ ...comun, op: 'error', text: change.text } as Op];
      }
      if (change.kind === 'map') {
        return [{ ...comun, op: 'map', text: change.text } as Op];
      }
      if (change.kind === 'error_purge') {
        return [{ ...comun, op: 'purge', pkind: 'error', key: change.key } as Op];
      }
      if (change.kind === 'debt') {
        return [{ ...comun, op: 'debt', text: change.text } as Op];
      }
      if (change.kind === 'debt_purge') {
        return [{ ...comun, op: 'purge', pkind: 'debt', key: change.key } as Op];
      }
      if (change.kind === 'decision_purge') {
        return [{ ...comun, op: 'purge', pkind: 'decision', key: change.key } as Op];
      }
      if (change.kind === 'pattern_purge') {
        return [{ ...comun, op: 'purge', pkind: 'pattern', key: change.key } as Op];
      }
      return [{ ...comun, op: 'pattern', text: change.text } as Op];
    });
  };
  cortex.setEmitter(emitter);
}

export type { GitResult };
