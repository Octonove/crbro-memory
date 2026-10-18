import { redact } from './secrets.js';
import { latestOf } from './shelf.js';
import type { Fact, Neuron, SourceReference, Verification } from '../types/index.js';

export type VerificationInput = { method: 'source' | 'user'; reference?: SourceReference };
export type EvidenceDescription = Pick<Fact, 'reference' | 'temporal' | 'verification'>;

function safeText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f]/.test(value)) {
    throw new Error('Invalid source reference text.');
  }
  return redact(value.trim()).text;
}

/** Solo valida y redacta datos. Nunca abre archivos, URLs ni procesos. */
export function sanitizeReference(value: unknown): SourceReference {
  if (!value || typeof value !== 'object') throw new Error('Invalid source reference.');
  const r = value as Record<string, unknown>;
  if (r.kind !== 'file' && r.kind !== 'url' && r.kind !== 'person') throw new Error('Invalid reference kind.');
  const clean = safeText(r.value);
  if (r.kind === 'url') {
    let url: URL;
    try { url = new URL(String(r.value)); } catch { throw new Error('Invalid reference URL.'); }
    const secretKey = /token|secret|password|passwd|api.?key|authorization|credential|signature|^sig$|access.?key/i;
    const unsafeParams = (params: URLSearchParams) => [...params].some(([key, value]) =>
      secretKey.test(key) || redact(value).found.length > 0);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || clean !== String(r.value).trim()
      || unsafeParams(url.searchParams) || unsafeParams(new URLSearchParams(url.hash.slice(1)))) {
      throw new Error('Unsafe reference URL: credentials or secret parameters are not allowed.');
    }
  }
  return {
    kind: r.kind, value: clean,
    ...(r.field !== undefined ? { field: safeText(r.field) } : {}),
    ...(r.project !== undefined ? { project: safeText(r.project) } : {}),
  };
}

export function readReference(value: unknown): SourceReference | undefined {
  try { return sanitizeReference(value); } catch { return undefined; }
}

export function sanitizeTemporal(value: unknown): Fact['temporal'] {
  if (value === undefined || value === 'current' || value === 'historical') return value;
  throw new Error('Invalid temporal value.');
}

export function makeVerification(evidence: VerificationInput | undefined, at: string): Verification {
  if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid verification date.');
  if (evidence === undefined) return { method: 'unspecified', at };
  if (!evidence || (evidence.method !== 'source' && evidence.method !== 'user')) throw new Error('Invalid verification method.');
  const reference = evidence.reference === undefined ? undefined : sanitizeReference(evidence.reference);
  if (evidence.method === 'source' && !reference) throw new Error('Source verification requires a reference.');
  return { method: evidence.method, at, ...(reference ? { reference } : {}) };
}

export function readVerification(value: unknown): Verification | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Verification;
  if (typeof v.at !== 'string' || !latestOf(undefined, v.at)) return undefined;
  try {
    if (v.method === 'unspecified') return { method: 'unspecified', at: v.at };
    return makeVerification(v as VerificationInput, v.at);
  } catch { return undefined; }
}

type Check = { verified?: string; verification?: Verification; verification_invalidated_at?: string };

/** Fecha y evidencia forman una unidad: una fecha legacy nueva no hereda una fuente vieja. */
export function mergeCheck(a: Check, b: Check): Check {
  const invalidated = latestOf(a.verification_invalidated_at, b.verification_invalidated_at);
  const cutoff = invalidated ? Date.parse(invalidated) : -Infinity;
  const candidates: Array<{ at: string; verification?: Verification }> = [];
  for (const c of [a, b]) {
    if (typeof c.verified === 'string' && latestOf(undefined, c.verified)) candidates.push({ at: c.verified });
    const v = readVerification(c.verification);
    if (v) candidates.push({ at: v.at, verification: v });
  }
  candidates.sort((x, y) => Date.parse(x.at) - Date.parse(y.at)
    || compare(JSON.stringify(x.verification || null), JSON.stringify(y.verification || null))
    || compare(x.at, y.at));
  const chosen = candidates.filter(c => Date.parse(c.at) > cutoff).at(-1);
  return {
    ...(invalidated ? { verification_invalidated_at: invalidated } : {}),
    ...(chosen ? { verified: chosen.at, ...(chosen.verification ? { verification: chosen.verification } : {}) } : {}),
  };
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Unión estable de metadatos sin fecha propia. Current gana para no ocultar caducidad. */
export function mergeFactEvidence(target: Fact, other: Partial<Fact>): void {
  const check = mergeCheck(target, other);
  const resetTime = (f: Partial<Fact>) => Date.parse(latestOf(undefined, f.verification_invalidated_at) || '') || 0;
  const a = resetTime(target), b = resetTime(other);
  const metadata = a === b ? [target, other] : [a > b ? target : other];
  const references = metadata.map(f => readReference(f.reference))
    .filter((r): r is SourceReference => !!r).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  if (references.length) target.reference = references.at(-1)!;
  else delete target.reference;
  const temporal = metadata.map(f => f.temporal);
  if (temporal.includes('current')) target.temporal = 'current';
  else if (temporal.includes('historical')) target.temporal = 'historical';
  else delete target.temporal;
  if (check.verification_invalidated_at) target.verification_invalidated_at = check.verification_invalidated_at;
  if (check.verified) target.verified = check.verified;
  else if (check.verification_invalidated_at) delete target.verified;
  if (check.verification) target.verification = check.verification;
  else delete target.verification;
}

export function mergeEntryEvidence(target: Neuron, source: Neuron, live: Set<string>): void {
  const dates: Record<string, string> = {};
  const evidence: Record<string, Verification> = {};
  for (const k of [...live].sort()) {
    const check = mergeCheck(
      { verified: target.entry_verified?.[k], verification: target.entry_verification?.[k] },
      { verified: source.entry_verified?.[k], verification: source.entry_verification?.[k] },
    );
    if (check.verified) dates[k] = check.verified;
    if (check.verification) evidence[k] = check.verification;
  }
  if (Object.keys(dates).length) target.entry_verified = dates; else delete target.entry_verified;
  if (Object.keys(evidence).length) target.entry_verification = evidence; else delete target.entry_verification;
}

/** Proyección para recall/inspect; no modifica el historial ni inventa fuentes legacy. */
export function describeEvidence(neuron: Neuron, id: string, kind: string, text: string): EvidenceDescription {
  const f = kind === 'fact' ? neuron.facts.find(f => f.id === id || f.text === text) : undefined;
  const check = mergeCheck(f || { verified: neuron.entry_verified?.[id], verification: neuron.entry_verification?.[id] }, {});
  const reference = readReference(f?.reference);
  const temporal = f?.temporal === 'current' || f?.temporal === 'historical' ? f.temporal : undefined;
  return {
    ...(reference ? { reference } : {}), ...(temporal ? { temporal } : {}),
    ...(check.verified ? { verification: check.verification || { method: 'unspecified', at: check.verified } } : {}),
  };
}
