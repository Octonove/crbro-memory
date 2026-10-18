import type { Neuron } from '../types/index.js';
import { isDatedRecord } from '../engine/shelf.js';
import { mergeCheck, readReference } from '../engine/evidence.js';
import { factId } from '../utils/hash.js';

/** Etiquetas epistemológicas, no otra puntuación ni una afirmación de verdad. */
export function entryQuality(neuron: Neuron | null, id: string | undefined, kind: string | undefined,
  text: string, stale?: { stale: boolean; age_days?: number }) {
  const fact = kind === 'fact' ? neuron?.facts?.find(f => (f.id || factId(f.text)) === id || f.text === text) : undefined;
  const check = mergeCheck(fact || {
    verified: id ? neuron?.entry_verified?.[id] : undefined,
    verification: id ? neuron?.entry_verification?.[id] : undefined,
  }, {});
  const verification = check.verification;
  const legacyDate = check.verified;
  const method = verification?.method || (legacyDate ? 'legacy' : 'none');
  const historical = fact?.temporal === 'historical' || (fact?.temporal !== 'current' &&
    ((fact?.source === 'miner' && !verification) || isDatedRecord(text)));
  const reference = readReference(fact?.reference) || verification?.reference;
  return {
    temporal: historical ? 'historical' as const : 'current_claim' as const,
    verification: verification || { method, ...(legacyDate ? { at: legacyDate } : {}) },
    freshness: {
      state: historical ? 'historical' : stale?.stale ? 'stale' : !legacyDate && !verification ? 'unverified'
        : verification && verification.method !== 'unspecified' ? 'within_window' : 'unattributed_check',
      ...(stale?.age_days !== undefined ? { age_days: stale.age_days } : {}),
    },
    ...(reference ? { reference } : {}),
  };
}
