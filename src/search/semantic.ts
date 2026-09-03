// ─── CRBRO Semantic layer — opt-in ───────────────────────────────
//
// BM25 has no synonyms. The blind benchmark says where that bites: after the
// 1.13 ranking fixes and the synonym table, the misses that remain are pure
// vocabulary — "alojadas" for a fact about a Hetzner VPS, "seguridad" for a
// fact about Wordfence, "proveedor de email" for one about Mailchimp. No
// table closes those; an embedding model does.
//
// It is OPT-IN and stays that way, for three measured reasons:
//   - the model is a 118 MB download (Xenova/multilingual-e5-small, int8 —
//     the 470 MB figure that got it rejected in 1.4 was the fp32 file);
//   - the runtime (transformers.js + onnxruntime) is ~380 MB of node modules
//     that most users never need, and a cold load takes ~13 s per process;
//   - a first pass over the reference brain (5,124 chunks) takes about a
//     minute and a half at ~18 ms per line.
// So nothing here is installed, downloaded or loaded unless the user runs
// `npx crbro-memory semantic install` AND sets CRBRO_SEMANTIC=1. Without
// both, this file is dead code and recall is exactly the 1.13 engine.
//
// Design:
//   - The runtime lives in ONE machine-level home (~/.crbro/.semantic), not
//     in the package: `npm install` puts it there and the model cache sits
//     next to it. Brains are per-user, the model is per-machine.
//   - Vectors are keyed by chunk id, which is a content hash: a fact that
//     did not change is never embedded twice, so re-indexing a neuron costs
//     only its NEW lines.
//   - Fusion with BM25 is reciprocal-rank (RRF): rank-based, so the two
//     score scales never have to agree.
//   - Every failure degrades to "no semantic layer", never to "no recall".

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SEMANTIC_MODEL = 'Xenova/multilingual-e5-small';
export const SEMANTIC_DTYPE = 'q8';
export const SEMANTIC_DIM = 384;
const BATCH = 16;
/** e5 models are trained with these prefixes; without them quality drops. */
const QUERY_PREFIX = 'query: ';
const PASSAGE_PREFIX = 'passage: ';
/** Longer passages are truncated by the tokenizer anyway; cap the work. */
const MAX_CHARS = 2000;

export function semanticEnabled(): boolean {
  const v = (process.env.CRBRO_SEMANTIC || '').toLowerCase();
  return v === '1' || v === 'on' || v === 'true';
}

/** Where the runtime and the model cache live. Machine-level, not brain-level. */
export function semanticHome(): string {
  return process.env.CRBRO_SEMANTIC_HOME || path.join(os.homedir(), '.crbro', '.semantic');
}

/** Resolve the transformers.js entry point inside the semantic home, or null. */
export function resolveRuntime(): string | null {
  try {
    const req = createRequire(path.join(semanticHome(), 'package.json'));
    return req.resolve('@huggingface/transformers');
  } catch {
    return null;
  }
}

export function semanticStatus(): { installed: boolean; enabled: boolean; home: string; model: string } {
  return {
    installed: resolveRuntime() !== null,
    enabled: semanticEnabled(),
    home: semanticHome(),
    model: `${SEMANTIC_MODEL} (${SEMANTIC_DTYPE})`,
  };
}

interface Meta {
  model: string;
  dtype: string;
  dim: number;
  ids: string[];
}

export interface SemanticHit {
  id: string;
  /** Cosine similarity, both vectors normalised. */
  score: number;
}

export class SemanticIndex {
  private ids: string[] = [];
  private pos = new Map<string, number>();
  private vectors = new Float32Array(0);
  private extractor: any = null;
  private loading: Promise<any> | null = null;
  private dirty = false;
  /** Set once the runtime or the model failed to load: never retried in-process. */
  private broken: string | null = null;

  constructor(private dir: string) {}

  private metaPath(): string { return path.join(this.dir, 'vectors.meta.json'); }
  private dataPath(): string { return path.join(this.dir, 'vectors.f32'); }

  count(): number { return this.ids.length; }
  has(id: string): boolean { return this.pos.has(id); }
  ready(): boolean { return this.broken === null && resolveRuntime() !== null; }
  whyNot(): string | null { return this.broken; }

  /**
   * Start loading the model in the background. A cold load takes ~13 s on a
   * laptop; paying it at the first recall of the session is the worst place.
   * Boot is not delayed — the first query simply awaits whatever is left.
   */
  warm(): void {
    if (!this.ready() || this.extractor) return;
    void this.model().catch(() => { /* reported by whyNot() */ });
  }

  /** Load the stored vectors, if any. Never throws. */
  async load(): Promise<void> {
    try {
      const meta = JSON.parse(await fs.readFile(this.metaPath(), 'utf8')) as Meta;
      if (meta.model !== SEMANTIC_MODEL || meta.dim !== SEMANTIC_DIM) return;
      const buf = await fs.readFile(this.dataPath());
      const expected = meta.ids.length * SEMANTIC_DIM * 4;
      if (buf.byteLength !== expected) return;
      this.vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      this.ids = meta.ids;
      this.pos = new Map(meta.ids.map((id, i) => [id, i]));
    } catch {
      // No vectors yet, or unreadable: start empty. Embedding is incremental.
    }
  }

  async persist(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(this.dir, { recursive: true });
    const meta: Meta = { model: SEMANTIC_MODEL, dtype: SEMANTIC_DTYPE, dim: SEMANTIC_DIM, ids: this.ids };
    const tmpMeta = this.metaPath() + '.tmp';
    const tmpData = this.dataPath() + '.tmp';
    await fs.writeFile(tmpData, Buffer.from(this.vectors.buffer, this.vectors.byteOffset, this.vectors.byteLength));
    await fs.writeFile(tmpMeta, JSON.stringify(meta));
    await fs.rename(tmpData, this.dataPath());
    await fs.rename(tmpMeta, this.metaPath());
    this.dirty = false;
  }

  /** Load transformers.js from the semantic home and build the extractor. */
  private async model(): Promise<any> {
    if (this.extractor) return this.extractor;
    if (this.broken) throw new Error(this.broken);
    if (!this.loading) {
      this.loading = (async () => {
        const entry = resolveRuntime();
        if (!entry) {
          this.broken = 'transformers.js is not installed: run `npx crbro-memory semantic install`.';
          throw new Error(this.broken);
        }
        const mod: any = await import(pathToFileURL(entry).href);
        const tf = mod.pipeline ? mod : mod.default;
        tf.env.cacheDir = path.join(semanticHome(), 'models');
        tf.env.allowLocalModels = true;
        tf.env.allowRemoteModels = true;
        this.extractor = await tf.pipeline('feature-extraction', SEMANTIC_MODEL, { dtype: SEMANTIC_DTYPE });
        return this.extractor;
      })().catch(err => {
        this.broken = this.broken || `semantic model failed to load: ${err instanceof Error ? err.message : String(err)}`;
        this.loading = null;
        throw err;
      });
    }
    return this.loading;
  }

  private async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const extractor = await this.model();
    const prefix = kind === 'query' ? QUERY_PREFIX : PASSAGE_PREFIX;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map(t => prefix + t.slice(0, MAX_CHARS));
      const res = await extractor(batch, { pooling: 'mean', normalize: true });
      // res.data is a flat typed array of batch × dim.
      const flat: Float32Array = res.data instanceof Float32Array ? res.data : Float32Array.from(res.data);
      for (let j = 0; j < batch.length; j++) {
        out.push(flat.slice(j * SEMANTIC_DIM, (j + 1) * SEMANTIC_DIM));
      }
    }
    return out;
  }

  /**
   * Embed the entries whose id is not stored yet. Ids are content hashes, so
   * an unchanged line is never embedded twice.
   */
  async upsert(entries: Array<{ id: string; text: string }>): Promise<number> {
    const nuevos = entries.filter(e => e.text && !this.pos.has(e.id));
    if (nuevos.length === 0) return 0;
    const vecs = await this.embed(nuevos.map(e => e.text), 'passage');
    // The base offset is captured once: ids.push inside the loop would
    // otherwise move it with every vector. Found as a RangeError, silently
    // swallowed upstream — which is why the first benchmark run showed no
    // change at all. Measure the effect, not the artefact.
    const base = this.ids.length;
    const grown = new Float32Array((base + nuevos.length) * SEMANTIC_DIM);
    grown.set(this.vectors, 0);
    for (let i = 0; i < nuevos.length; i++) {
      grown.set(vecs[i], (base + i) * SEMANTIC_DIM);
      this.pos.set(nuevos[i].id, base + i);
      this.ids.push(nuevos[i].id);
    }
    this.vectors = grown;
    this.dirty = true;
    return nuevos.length;
  }

  /** Drop vectors for ids that left the index. */
  remove(ids: Iterable<string>): number {
    const gone = new Set<string>();
    for (const id of ids) if (this.pos.has(id)) gone.add(id);
    if (gone.size === 0) return 0;
    const keepIds: string[] = [];
    const keep = new Float32Array((this.ids.length - gone.size) * SEMANTIC_DIM);
    let k = 0;
    for (let i = 0; i < this.ids.length; i++) {
      if (gone.has(this.ids[i])) continue;
      keep.set(this.vectors.subarray(i * SEMANTIC_DIM, (i + 1) * SEMANTIC_DIM), k * SEMANTIC_DIM);
      keepIds.push(this.ids[i]);
      k++;
    }
    this.ids = keepIds;
    this.vectors = keep;
    this.pos = new Map(keepIds.map((id, i) => [id, i]));
    this.dirty = true;
    return gone.size;
  }

  /** The k nearest chunks to the question, by cosine. */
  async query(text: string, k: number): Promise<SemanticHit[]> {
    if (this.ids.length === 0) return [];
    const [q] = await this.embed([text], 'query');
    const scores = new Float32Array(this.ids.length);
    for (let i = 0; i < this.ids.length; i++) {
      let dot = 0;
      const off = i * SEMANTIC_DIM;
      for (let d = 0; d < SEMANTIC_DIM; d++) dot += q[d] * this.vectors[off + d];
      scores[i] = dot;
    }
    const idx = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, k);
    return idx.map(i => ({ id: this.ids[i], score: Math.round(scores[i] * 1000) / 1000 }));
  }
}
