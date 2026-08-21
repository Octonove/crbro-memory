// ─── CRBRO Content Hashing ───────────────────────────────────────
// Stable, content-derived IDs for facts and index chunks.
//
// Why content-derived and not random or positional:
//  - Random (Math.random) collides. Measured on the reference brain: 59%
//    collision inside a single 287-fact neuron with a 3-char suffix.
//  - Positional (#f0, #f1) is only correct while facts are strictly
//    append-only, and superseding breaks that premise.
// A content hash needs no backfill: the same text always yields the same id,
// so 1,183 existing neuron files stay untouched and still resolve.

import { createHash } from 'node:crypto';

/**
 * Short, stable hash of a piece of content. 12 hex chars ≈ 48 bits,
 * which is ample for per-neuron uniqueness.
 */
export function contentHash(text: string, length: number = 12): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, length);
}

/**
 * ID for an indexed chunk: neuron id + hash of the chunk text.
 * Editing a fact changes its id, which is what lets reindexing notice.
 */
export function chunkId(neuronId: string, text: string): string {
  return `${neuronId}#${contentHash(text)}`;
}

/**
 * ID for a fact inside its neuron. Same hash, no prefix — facts are
 * addressed relative to the neuron that holds them.
 */
export function factId(text: string): string {
  return contentHash(text);
}

/**
 * Short id for a pending task. Prefixed so it reads as an id in a list.
 */
export function pendingId(text: string): string {
  return `p_${contentHash(text, 6)}`;
}
