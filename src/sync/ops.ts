// ─── CRBRO Shared Memory: the operation log ──────────────────────
//
// Two people cannot share a neuron by copying the file back and forth: the
// last save wins and the other person's work vanishes. So nobody ever shares
// the neuron. Each person appends notes to their own log — "I added this
// fact", "I retracted that one" — and every machine rebuilds the neuron from
// all the logs it has.
//
// Nobody writes to anybody else's file, so there is nothing to collide. That
// is the whole trick, and it is what makes the merge automatic: no conflict
// can arise if no two writers touch the same bytes.

import { contentHash } from '../utils/hash.js';

/** Bumped only if the shape changes in a way older clients cannot read. */
export const OPS_VERSION = 1;

export type OpKind = 'neuron' | 'fact' | 'status' | 'decision' | 'pattern' | 'tag' | 'error' | 'map' | 'purge' | 'debt';

interface OpBase {
  v: number;
  op: OpKind;
  /** Neuron this applies to. */
  nid: string;
  /** Who wrote it. Not a security claim — anyone with push access can write any name. */
  by: string;
  /** ISO timestamp. Used for display and for keeping the earliest date, never to decide a winner. */
  at: string;
}

/** Announces a neuron. Its name/type/domain are only used if the receiver has no such neuron. */
export interface NeuronOp extends OpBase {
  op: 'neuron';
  name: string;
  ntype: string;
  domain: string;
}

export interface FactOp extends OpBase {
  op: 'fact';
  fid: string;
  text: string;
  conf: number;
  src?: string;
  /** Aliases indexed with the fact (1.15). Merged, never replaced, on the receiving side. */
  keys?: string[];
}

/**
 * A fact stopped being current. Only ever moves forward:
 * active → superseded → retracted, never back.
 */
export interface StatusOp extends OpBase {
  op: 'status';
  fid: string;
  to: 'superseded' | 'retracted';
  why?: string;
}

export interface DecisionOp extends OpBase {
  op: 'decision';
  did: string;
  text: string;
  why?: string;
}

export interface PatternOp extends OpBase {
  op: 'pattern';
  text: string;
}

export interface TagOp extends OpBase {
  op: 'tag';
  text: string;
}

/** A mistake plus its correction. Merged like patterns: plain set union. */
export interface ErrorOp extends OpBase {
  op: 'error';
  text: string;
}

/** A deliberate deferral with its revisit condition. Union, like errors. */
export interface DebtOp extends OpBase {
  op: 'debt';
  text: string;
}

/**
 * A full replacement of the neuron's system map. The newest `at` wins;
 * ties break on the content hash so every machine picks the same winner.
 * Older clients do not know this kind and skip it — the map simply does not
 * travel to them, which is a degradation, not a corruption.
 */
export interface MapOp extends OpBase {
  op: 'map';
  text: string;
}

/**
 * An entry was deliberately removed and must not come back from anyone's log.
 * Like retraction, a purge always wins, whatever the replay order. Today only
 * errors need it (facts already have StatusOp; the map clears through an
 * empty-text MapOp winning the LWW).
 */
export interface PurgeOp extends OpBase {
  op: 'purge';
  pkind: 'error' | 'debt';
  /** entryId() of the removed text. The text itself does not travel again. */
  key: string;
}

export type Op = NeuronOp | FactOp | StatusOp | DecisionOp | PatternOp | TagOp | ErrorOp | MapOp | PurgeOp | DebtOp;

/**
 * Same wording, same id, on every machine.
 *
 * Normalising first matters: one person's copy of a sentence may differ from
 * another's by a stray double space or a different Unicode composition, and
 * without this they would become two facts saying the same thing.
 */
export function normalizeText(text: string): string {
  return (text || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function entryId(text: string): string {
  return contentHash(normalizeText(text));
}

/** Serialise one operation as a single line. */
export function encodeOp(op: Op): string {
  return JSON.stringify(op);
}

/**
 * Parse a log. Unreadable lines are skipped rather than thrown, because a log
 * can be cut in half by a process dying mid-append or by a merge landing while
 * we read. One bad line must never cost the other nine hundred.
 */
export function decodeOps(content: string): { ops: Op[]; skipped: number } {
  const ops: Op[] = [];
  let skipped = 0;

  for (const line of (content || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as Op;
      if (!parsed || typeof parsed !== 'object' || !parsed.op || !parsed.nid) {
        skipped++;
        continue;
      }
      if (parsed.v > OPS_VERSION) {
        // Written by a newer CRBRO. Skipping is safer than half-understanding it.
        skipped++;
        continue;
      }
      ops.push(parsed);
    } catch {
      skipped++;
    }
  }

  return { ops, skipped };
}

/** Where a person's log for a neuron lives inside the space. */
export function opsRelPath(neuronId: string, author: string, device: string): string {
  return `neurons/${neuronId}/ops/${author}.${device}.jsonl`;
}
