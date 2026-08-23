// ─── CRBRO Shared Memory: rebuilding a neuron from the logs ──────
//
// Everything hard about sharing memory lives in this file, and it is one pure
// function. Given whatever the neuron looks like locally plus every note
// anyone has written, produce the neuron. No disk, no network, no git.
//
// Three properties make the merge automatic, and every rule below is chosen to
// preserve them:
//   - order does not matter,
//   - applying the same note twice changes nothing,
//   - applying half the notes now and the rest later ends up the same.
// Anything that needed a clock, a "latest wins", or a tie-break on wall time
// would break them, which is why none of that is here.

import { now } from '../utils/fs.js';
import type { Neuron, Fact, Decision, FactStatus } from '../types/index.js';
import type { Op, FactOp, StatusOp, DecisionOp, MapOp, PurgeOp } from './ops.js';
import { normalizeText, entryId } from './ops.js';

/** Fields that disagreed and were left alone, so a human can look. */
export interface Divergence {
  field: string;
  mine: string;
  theirs: string;
  from: string;
}

export interface MergeReport {
  facts_added: number;
  facts_retracted: number;
  facts_superseded: number;
  decisions_added: number;
  patterns_added: number;
  errors_added: number;
  debts_added: number;
  /** Errors/debts removed by a purge op. Feeds the sync change-gate so a lone purge persists. */
  entries_removed: number;
  map_updated: boolean;
  tags_added: number;
  authors: string[];
  divergence: Divergence[];
}

/**
 * How far along a fact's life it is. Merging takes the maximum, so a fact
 * someone retracted can never come back to life because a stale log still
 * calls it active. Truth about what is no longer true only moves one way.
 */
const RANK: Record<FactStatus, number> = { active: 0, superseded: 1, retracted: 2 };
const BY_RANK: FactStatus[] = ['active', 'superseded', 'retracted'];

function rankOf(s: FactStatus | undefined): number {
  return RANK[s || 'active'] ?? 0;
}

/** The earlier of two ISO dates. Empty strings lose. */
function earliest(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function applyOps(
  base: Neuron | null,
  ops: Op[],
  fallback?: { id: string }
): { neuron: Neuron; report: MergeReport } {
  const report: MergeReport = {
    facts_added: 0,
    facts_retracted: 0,
    facts_superseded: 0,
    decisions_added: 0,
    patterns_added: 0,
    errors_added: 0,
    debts_added: 0,
    entries_removed: 0,
    map_updated: false,
    tags_added: 0,
    authors: [],
    divergence: [],
  };

  const neuronOp = ops.find(o => o.op === 'neuron');
  const id = base?.id || neuronOp?.nid || fallback?.id || '';

  // Start from what we already have. If we have nothing, the announcement
  // gives us a name; if we do have it, ours stands and any disagreement is
  // reported rather than resolved. Overwriting someone's local name because a
  // teammate spelled it differently is not a merge, it is a stomp.
  const neuron: Neuron = base
    ? { ...base, facts: [...base.facts], decisions: [...base.decisions], patterns: [...base.patterns], preferences: [...base.preferences], tags: [...base.tags], connections: [...base.connections], errors: [...(base.errors || [])], debts: [...(base.debts || [])], map: base.map ? { ...base.map } : undefined }
    : {
        id,
        name: neuronOp && neuronOp.op === 'neuron' ? neuronOp.name : id,
        domain: neuronOp && neuronOp.op === 'neuron' ? neuronOp.domain : 'general',
        type: (neuronOp && neuronOp.op === 'neuron' ? neuronOp.ntype : 'project') as Neuron['type'],
        created: now(),
        last_accessed: now(),
        access_count: 0,
        heat: 0.5,
        summary: '',
        facts: [],
        decisions: [],
        patterns: [],
        preferences: [],
        connections: [],
        tags: [],
        errors: [],
        debts: [],
      };

  if (base && neuronOp && neuronOp.op === 'neuron') {
    if (neuronOp.name && base.name && normalizeText(neuronOp.name) !== normalizeText(base.name)) {
      report.divergence.push({ field: 'name', mine: base.name, theirs: neuronOp.name, from: neuronOp.by });
    }
    if (neuronOp.domain && base.domain && neuronOp.domain !== base.domain && base.domain !== 'general') {
      report.divergence.push({ field: 'domain', mine: base.domain, theirs: neuronOp.domain, from: neuronOp.by });
    }
  }

  // ─── Facts: union by id, then the furthest-along status ───────
  const byFid = new Map<string, Fact>();
  for (const f of neuron.facts) {
    byFid.set(f.id || '', f);
  }
  // Facts stored before ids existed: index them by their text so an incoming
  // note about the same sentence lands on the same fact instead of duplicating.
  const byText = new Map<string, Fact>();
  for (const f of neuron.facts) {
    byText.set(normalizeText(f.text), f);
  }

  const statusOps: StatusOp[] = [];

  for (const op of ops) {
    if (op.op === 'fact') {
      const fo = op as FactOp;
      const existing = byFid.get(fo.fid) || byText.get(normalizeText(fo.text));
      if (existing) {
        // Same fact from two people. Keep the earliest date so provenance
        // reflects who knew it first, and the higher confidence.
        existing.id = existing.id || fo.fid;
        existing.added = earliest(existing.added, fo.at);
        existing.confidence = Math.max(existing.confidence ?? 1, fo.conf ?? 1);
        continue;
      }
      const fact: Fact = {
        text: fo.text,
        confidence: fo.conf ?? 1,
        added: fo.at,
        source: `team:${fo.by}`,
        id: fo.fid,
        status: 'active',
      };
      neuron.facts.push(fact);
      byFid.set(fo.fid, fact);
      byText.set(normalizeText(fo.text), fact);
      report.facts_added++;
    } else if (op.op === 'status') {
      statusOps.push(op as StatusOp);
    }
  }

  // Status is applied after every fact exists, so a note retracting a fact
  // works no matter which log it arrived in or in what order.
  for (const so of statusOps) {
    const target = byFid.get(so.fid);
    if (!target) continue;
    const antes = rankOf(target.status);
    const despues = Math.max(antes, rankOf(so.to));
    if (despues === antes) continue;
    target.status = BY_RANK[despues];
    target.revised = so.at;
    if (so.why) target.revision_note = so.why;
    if (target.status === 'retracted') report.facts_retracted++;
    else report.facts_superseded++;
  }

  // ─── Decisions: union by (id, author) ────────────────────────
  // Two people can reach the same decision for different reasons, and both
  // reasons are worth keeping. Keying on the pair means neither is lost.
  const seenDecision = new Set<string>();
  for (const d of neuron.decisions) {
    seenDecision.add(`${(d as Decision & { id?: string }).id || normalizeText(d.text)}|${(d as Decision & { by?: string }).by || ''}`);
  }
  for (const op of ops) {
    if (op.op !== 'decision') continue;
    const dop = op as DecisionOp;
    const key = `${dop.did}|${dop.by}`;
    if (seenDecision.has(key)) continue;
    seenDecision.add(key);
    neuron.decisions.push({
      text: dop.text,
      date: dop.at,
      rationale: dop.why || '',
      id: dop.did,
      by: dop.by,
    } as Decision);
    report.decisions_added++;
  }

  // ─── Patterns and tags: plain set union ──────────────────────
  for (const op of ops) {
    if (op.op === 'pattern') {
      if (!neuron.patterns.some(p => normalizeText(p) === normalizeText(op.text))) {
        neuron.patterns.push(op.text);
        report.patterns_added++;
      }
    } else if (op.op === 'tag') {
      if (!neuron.tags.some(t => normalizeText(t) === normalizeText(op.text))) {
        neuron.tags.push(op.text);
        report.tags_added++;
      }
    } else if (op.op === 'error') {
      if (!neuron.errors) neuron.errors = [];
      if (!neuron.errors.some(e => normalizeText(e) === normalizeText(op.text))) {
        neuron.errors.push(op.text);
        report.errors_added++;
      }
    } else if (op.op === 'debt') {
      if (!neuron.debts) neuron.debts = [];
      if (!neuron.debts.some(d => normalizeText(d) === normalizeText(op.text))) {
        neuron.debts.push(op.text);
        report.debts_added++;
      }
    }
  }

  // ─── Purges: a deliberate removal always wins ────────────────
  // Applied after the unions so order cannot matter: an error purged by
  // anyone stays gone even if another log re-adds it in the same replay.
  const purgados = { error: new Set<string>(), debt: new Set<string>() };
  for (const op of ops) {
    if (op.op === 'purge') {
      const po = op as PurgeOp;
      if (po.pkind === 'error' || po.pkind === 'debt') purgados[po.pkind].add(po.key);
    }
  }
  if (purgados.error.size > 0 && neuron.errors && neuron.errors.length > 0) {
    const antes = neuron.errors.length;
    neuron.errors = neuron.errors.filter(e => !purgados.error.has(entryId(e)));
    report.entries_removed += antes - neuron.errors.length;
  }
  if (purgados.debt.size > 0 && neuron.debts && neuron.debts.length > 0) {
    const antes = neuron.debts.length;
    neuron.debts = neuron.debts.filter(d => !purgados.debt.has(entryId(d)));
    report.entries_removed += antes - neuron.debts.length;
  }

  // ─── The map: last writer wins, deterministically ────────────
  // A map is a whole-document replacement, so union makes no sense. The
  // newest `at` wins; a timestamp tie breaks on the content hash, so every
  // machine replaying the same logs lands on the same winner.
  // A missing or non-string timestamp is worth nothing: it loses against any
  // real date. Without this, String(undefined) = "undefined" outranked every
  // ISO date and a single malformed log line froze the team's map forever.
  // Ordinal comparison on purpose — ISO dates order correctly byte by byte,
  // and localeCompare depends on each machine's ICU, which would break the
  // byte-identical convergence this file promises.
  const ts = (v: unknown): string => (typeof v === 'string' ? v : '');
  const antesDe = (a: string, b: string): boolean => a < b;

  let ganador: MapOp | null = null;
  for (const op of ops) {
    if (op.op !== 'map') continue;
    const mo = op as MapOp;
    if (!ganador) { ganador = mo; continue; }
    const a = ts(mo.at), b = ts(ganador.at);
    if (antesDe(b, a) || (a === b && entryId(mo.text) > entryId(ganador.text))) ganador = mo;
  }
  if (ganador) {
    const local = neuron.map;
    const ganAt = ts(ganador.at);
    const localAt = local ? ts(local.updated) : '';
    const gana = !local
      || antesDe(localAt, ganAt)
      || (ganAt === localAt && entryId(ganador.text) > entryId(local.text));
    if (gana) {
      if (normalizeText(ganador.text) === '') {
        // An empty map op is the tombstone: whoever cleared the map last
        // clears it everywhere, and a stale copy cannot resurrect it.
        if (local) {
          delete neuron.map;
          report.map_updated = true;
        }
      } else if (!local || normalizeText(local.text) !== normalizeText(ganador.text)) {
        neuron.map = { text: ganador.text, updated: ganAt, by: ganador.by };
        report.map_updated = true;
      }
    }
  }

  // Deterministic order, so two machines holding the same knowledge produce
  // byte-identical files. Without this, every sync would look like a change.
  neuron.facts.sort((a, b) => {
    const d = String(a.added || '').localeCompare(String(b.added || ''));
    return d !== 0 ? d : String(a.id || '').localeCompare(String(b.id || ''));
  });
  neuron.decisions.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  neuron.patterns.sort();
  neuron.tags.sort();
  if (neuron.errors) neuron.errors.sort();
  if (neuron.debts) neuron.debts.sort();

  report.authors = [...new Set(ops.map(o => o.by).filter(Boolean))].sort();

  return { neuron, report };
}
