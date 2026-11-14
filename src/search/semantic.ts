// ─── CRBRO Semantic layer — opt-in ───────────────────────────────
//
// BM25 has no synonyms. The blind benchmark says where that bites: after the
// 1.13 ranking fixes and the synonym table, the misses that remain are pure
// vocabulary — "alojadas" for a fact about a Hetzner VPS, "seguridad" for a
// fact about Wordfence, "proveedor de email" for one about Mailchimp. No
// table closes those; an embedding model does.
//
// Costs, measured: the model is a 118 MB download (Xenova/multilingual-e5-small,
// int8), the runtime (transformers.js + onnxruntime) ~380 MB of node modules,
// the loaded model ~0.5 GB of RAM, a cold load ~13 s per process, and a first
// pass over the reference brain (5,129 chunks, 3,984 lines) three minutes.
// Until 1.15 that made it opt-in. Since 1.16 `npx crbro-memory init` installs
// it by default (the author's call: the best recall out of the box) and the
// layer is ON whenever the runtime is present. `init --no-semantic` skips the
// install; CRBRO_SEMANTIC=0 turns it off; CRBRO_SEMANTIC=1 forces it on.
// Without the runtime this file is dead code and recall is exactly the
// keyword engine.
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
import { promises as fs, existsSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

/**
 * The default model, and the one the benchmarks measure. CRBRO_SEMANTIC_MODEL
 * swaps in another transformers.js feature-extraction model of the e5 family
 * (same "query: " / "passage: " prefixes, mean pooling). The vector width is
 * read from the model's first output; stored vectors of a different model are
 * ignored, never mixed.
 */
export const SEMANTIC_MODEL_DEFAULT = 'Xenova/multilingual-e5-small';
export const SEMANTIC_DTYPE_DEFAULT = 'q8';
/**
 * The runtime `semantic install` puts in the semantic home, pinned to an
 * exact version (2.11; it was the floating range `@3`, so every install could
 * pull a different release of a package that runs install scripts).
 */
export const SEMANTIC_RUNTIME = '@huggingface/transformers@3.8.1';
/**
 * The default model, pinned by content (2.11). The Hub revision is a moving
 * `main`; these are the SHA-256 of the files the benchmarks were measured
 * with (downloaded 2026-09-03). A model whose files differ is refused, never
 * used: the layer reports why and recall stays keyword-only. Only checked for
 * the default model and dtype; CRBRO_SEMANTIC_MODEL users pick their own.
 */
export const SEMANTIC_MODEL_FILES: Readonly<Record<string, { sha256: string; bytes: number }>> = {
  'config.json': { sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1', bytes: 658 },
  'tokenizer.json': { sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39', bytes: 17_082_730 },
  'tokenizer_config.json': { sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b', bytes: 443 },
  'onnx/model_quantized.onnx': { sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193', bytes: 118_308_185 },
};

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve()).on('error', reject);
  });
  return h.digest('hex');
}

/**
 * Check the cached files of the default model against SEMANTIC_MODEL_FILES.
 * Returns null when they match (or the model is not the default one), else
 * what is wrong.
 */
export async function verifyModelFiles(home: string = semanticHome()): Promise<string | null> {
  if (semanticModel() !== SEMANTIC_MODEL_DEFAULT || semanticDtype() !== SEMANTIC_DTYPE_DEFAULT) return null;
  const dir = path.join(home, 'models', ...SEMANTIC_MODEL_DEFAULT.split('/'));
  // Each file is hashed once per version of it: one whose size and date are
  // those of the last successful check is not read again. Hashing the 135 MB
  // cost ~140 ms at every process start, before the first semantic answer.
  const marca = path.join(dir, VERIFIED_FILE);
  let vistos: Record<string, { size: number; mtime: number; sha256: string }> = {};
  try { vistos = JSON.parse(await fs.readFile(marca, 'utf8')) || {}; } catch { /* first check */ }
  let nuevos = false;
  for (const [rel, want] of Object.entries(SEMANTIC_MODEL_FILES)) {
    const file = path.join(dir, ...rel.split('/'));
    let st;
    try { st = await fs.stat(file); } catch { return `model file missing: ${rel} (run \`npx crbro-memory semantic install\`)`; }
    const mismatch = `model file ${rel} does not match the pinned hash; refusing to use it (delete ${dir} and run \`npx crbro-memory semantic install\`)`;
    if (st.size !== want.bytes) return mismatch;
    const v = vistos[rel];
    if (v && v.size === st.size && v.mtime === st.mtimeMs && v.sha256 === want.sha256) continue;
    if ((await sha256Of(file)) !== want.sha256) return mismatch;
    vistos[rel] = { size: st.size, mtime: st.mtimeMs, sha256: want.sha256 };
    nuevos = true;
  }
  if (nuevos) { try { await fs.writeFile(marca, JSON.stringify(vistos)); } catch { /* checked again next time */ } }
  return null;
}
/** Where verifyModelFiles remembers the files it already hashed. */
const VERIFIED_FILE = '.crbro-verified.json';
export function semanticModel(): string { return process.env.CRBRO_SEMANTIC_MODEL || SEMANTIC_MODEL_DEFAULT; }
export function semanticDtype(): string { return process.env.CRBRO_SEMANTIC_DTYPE || SEMANTIC_DTYPE_DEFAULT; }
/**
 * Passages per forward pass. The int8 model quantises its activations per
 * tensor, so a vector computed inside a batch depends on its batch-mates:
 * the same fact gets a slightly different vector depending on what it was
 * embedded with (cosine 0.997 on average and 0.994 at worst against the same
 * text alone, measured on 300 facts) — enough to cross the 0.84 floor. Since
 * 2.5 every learn embeds only its new lines, one at a time, and that is what
 * the floor was tuned on, so the first full pass does the same (2.7.2). It
 * costs 1.6x the time of batches of 16, once. CRBRO_SEMANTIC_BATCH overrides.
 */
function batchSize(): number {
  const n = Number(process.env.CRBRO_SEMANTIC_BATCH);
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : 1;
}
/** e5 models are trained with these prefixes; without them quality drops. */
const QUERY_PREFIX = 'query: ';
const PASSAGE_PREFIX = 'passage: ';
/** Longer passages are truncated by the tokenizer anyway; cap the work. */
const MAX_CHARS = 2000;
/** A background pass is committed in slices of this many passages (2.11). */
const UPSERT_SLICE = 64;
/** ...and saved this often while it runs, so a process that leaves keeps what it did. */
const UPSERT_SAVE_MS = 30_000;

/** Off when CRBRO_SEMANTIC says so, forced on when it says so, else on exactly when the runtime is installed. */
export function semanticEnabled(): boolean {
  const mode = semanticMode();
  if (mode === 'disabled') return false;
  if (mode === 'forced') return true;
  return resolveRuntime() !== null;
}

export type SemanticMode = 'auto' | 'forced' | 'disabled';

export function semanticMode(): SemanticMode {
  const v = (process.env.CRBRO_SEMANTIC || '').toLowerCase();
  if (v === '0' || v === 'off' || v === 'false') return 'disabled';
  if (v === '1' || v === 'on' || v === 'true') return 'forced';
  return 'auto';
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

export function semanticStatus(): {
  installed: boolean; enabled: boolean; mode: SemanticMode; model_downloaded: boolean; home: string; model: string;
} {
  return {
    installed: resolveRuntime() !== null,
    enabled: semanticEnabled(),
    mode: semanticMode(),
    model_downloaded: existsSync(path.join(semanticHome(), 'models', ...semanticModel().split('/'))),
    home: semanticHome(),
    model: `${semanticModel()} (${semanticDtype()})`,
  };
}

interface Meta {
  model: string;
  dtype: string;
  dim: number;
  ids: string[];
  /** Byte length of vectors.f32 this meta was written with (2.11). */
  bytes?: number;
}

export interface SemanticHit {
  id: string;
  /** Cosine similarity, both vectors normalised. */
  score: number;
}

export class SemanticIndex {
  private ids: string[] = [];
  /** Vector width, read from the first embedding (384 for e5-small). */
  private dim = 0;
  private pos = new Map<string, number>();
  private vectors = new Float32Array(0);
  private extractor: any = null;
  private loading: Promise<any> | null = null;
  private dirty = false;
  /** Set once the runtime or the model failed to load: never retried in-process. */
  private broken: string | null = null;
  /** Upserts run one at a time: two overlapping ones would both extend the same array. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Bumped on every change of the vectors, so a write knows whether it caught up. */
  private version = 0;
  /**
   * Queries waiting for the model (2.11). A background pass (thousands of
   * passages after an upgrade split long entries into parts) pauses between
   * passages while any is waiting: a recall used to queue behind it, ~2 s
   * each, for the minutes the pass lasted.
   */
  private foreground = 0;
  private foregroundWaiters: Array<() => void> = [];
  /** Passages a running pass still has to embed. */
  private left = 0;

  /** A large pass is running: more than one slice of passages still to embed. */
  backfilling(): boolean { return this.left > UPSERT_SLICE; }

  /**
   * Something in the foreground (a search, a query) is running: background
   * passages wait until every hold is released. Returns the release.
   */
  hold(): () => void {
    this.foreground++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.foreground--;
      if (this.foreground === 0) {
        const w = this.foregroundWaiters;
        this.foregroundWaiters = [];
        for (const f of w) f();
      }
    };
  }

  /**
   * allowDownload: only `semantic install` may fetch the model from the Hub
   * (2.11). A server never downloads during a query: a missing model makes
   * the layer report why and recall stays keyword-only.
   */
  constructor(private dir: string, private options: { allowDownload?: boolean } = {}) {}

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
      // Vectors of another model or another quantisation are not comparable.
      if (meta.model !== semanticModel() || (meta.dtype && meta.dtype !== semanticDtype()) || !(meta.dim > 0)) return;
      const buf = await fs.readFile(this.dataPath());
      const expected = meta.ids.length * meta.dim * 4;
      // A torn pair (a crash between the two renames) does not match: start
      // empty and let the index refill what is missing (2.11).
      if (buf.byteLength !== expected || (meta.bytes !== undefined && meta.bytes !== buf.byteLength)) return;
      this.vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      this.ids = meta.ids;
      this.dim = meta.dim;
      this.pos = new Map(meta.ids.map((id, i) => [id, i]));
    } catch {
      // No vectors yet, or unreadable: start empty. Embedding is incremental.
    }
  }

  async persist(): Promise<void> {
    if (!this.dirty) return;
    // What is written is this moment's pair; a vector added while the files
    // are written keeps the layer dirty for the next write.
    const version = this.version;
    const vectors = this.vectors;
    const meta: Meta = { model: semanticModel(), dtype: semanticDtype(), dim: this.dim, ids: [...this.ids], bytes: vectors.byteLength };
    await fs.mkdir(this.dir, { recursive: true });
    const tmpMeta = this.metaPath() + '.tmp';
    const tmpData = this.dataPath() + '.tmp';
    await fs.writeFile(tmpData, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
    await fs.writeFile(tmpMeta, JSON.stringify(meta));
    await fs.rename(tmpData, this.dataPath());
    await fs.rename(tmpMeta, this.metaPath());
    if (this.version === version) this.dirty = false;
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
        tf.env.allowRemoteModels = this.options.allowDownload === true;
        if (!this.options.allowDownload) {
          const wrong = await verifyModelFiles();
          if (wrong) { this.broken = wrong; throw new Error(wrong); }
        }
        this.extractor = await tf.pipeline('feature-extraction', semanticModel(), { dtype: semanticDtype() });
        if (this.options.allowDownload) {
          const wrong = await verifyModelFiles();
          if (wrong) { this.extractor = null; this.broken = wrong; throw new Error(wrong); }
        }
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
    const BATCH = batchSize();
    for (let i = 0; i < texts.length; i += BATCH) {
      // Background work gives way to a query that is waiting (2.11).
      while (kind === 'passage' && this.foreground > 0) await new Promise<void>(r => this.foregroundWaiters.push(r));
      const batch = texts.slice(i, i + BATCH).map(t => prefix + t.slice(0, MAX_CHARS));
      const res = await extractor(batch, { pooling: 'mean', normalize: true });
      // res.data is a flat typed array of batch × dim.
      const flat: Float32Array = res.data instanceof Float32Array ? res.data : Float32Array.from(res.data);
      const dim = flat.length / batch.length;
      if (!this.dim) this.dim = dim;
      else if (dim !== this.dim) throw new Error(`semantic model returned ${dim}-wide vectors, the index holds ${this.dim}`);
      for (let j = 0; j < batch.length; j++) {
        out.push(flat.slice(j * this.dim, (j + 1) * this.dim));
      }
    }
    return out;
  }

  /**
   * Embed the entries whose id is not stored yet. Ids are content hashes, so
   * an unchanged line is never embedded twice.
   */
  async upsert(entries: Array<{ id: string; text: string }>): Promise<number> {
    const run = this.queue.then(() => this.upsertNow(entries));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async upsertNow(entries: Array<{ id: string; text: string }>): Promise<number> {
    const nuevos = entries.filter(e => e.text && !this.pos.has(e.id));
    if (nuevos.length === 0) return 0;
    // In slices, each one usable at once and the whole saved every half
    // minute (2.11): a pass of thousands used to land all at the end, so a
    // process that left halfway — a classic session — kept nothing, and the
    // next one started over.
    let guardado = Date.now();
    this.left = nuevos.length;
    try {
      for (let i = 0; i < nuevos.length; i += UPSERT_SLICE) {
        const tramo = nuevos.slice(i, i + UPSERT_SLICE);
        const vecs = await this.embed(tramo.map(e => e.text), 'passage');
        this.append(tramo, vecs);
        this.left = Math.max(0, nuevos.length - i - tramo.length);
        if (this.left > 0 && Date.now() - guardado > UPSERT_SAVE_MS) {
          await this.persist().catch(() => undefined);
          guardado = Date.now();
        }
      }
    } finally {
      this.left = 0;
    }
    return nuevos.length;
  }

  private append(tramo: Array<{ id: string }>, vecs: Float32Array[]): void {
    // The base offset is captured once: ids.push inside the loop would
    // otherwise move it with every vector. Found as a RangeError, silently
    // swallowed upstream — which is why the first benchmark run showed no
    // change at all. Measure the effect, not the artefact.
    const base = this.ids.length;
    const need = (base + tramo.length) * this.dim;
    // Room grows by half each time (2.11): a pass that added 64 vectors at a
    // time reallocated and copied the whole array each slice — tens of MB
    // every couple of seconds, and the collector paid for it in pauses.
    let store = this.vectors.buffer.byteLength / 4 >= need && this.vectors.byteOffset === 0
      ? new Float32Array(this.vectors.buffer)
      : null;
    if (!store) {
      store = new Float32Array(Math.max(need, Math.ceil((this.vectors.length || 0) * 1.5), 256 * this.dim));
      store.set(this.vectors, 0);
    }
    for (let i = 0; i < tramo.length; i++) {
      store.set(vecs[i], (base + i) * this.dim);
      this.pos.set(tramo[i].id, base + i);
      this.ids.push(tramo[i].id);
    }
    this.vectors = store.subarray(0, need);
    this.version++;
    this.dirty = true;
  }

  /** Every id holding a vector (to compare with the index: B14). */
  idList(): readonly string[] { return this.ids; }

  /** Drop vectors for ids that left the index. */
  remove(ids: Iterable<string>): number {
    const gone = new Set<string>();
    for (const id of ids) if (this.pos.has(id)) gone.add(id);
    if (gone.size === 0) return 0;
    const keepIds: string[] = [];
    const keep = new Float32Array((this.ids.length - gone.size) * this.dim);
    let k = 0;
    for (let i = 0; i < this.ids.length; i++) {
      if (gone.has(this.ids[i])) continue;
      keep.set(this.vectors.subarray(i * this.dim, (i + 1) * this.dim), k * this.dim);
      keepIds.push(this.ids[i]);
      k++;
    }
    this.ids = keepIds;
    this.vectors = keep;
    this.pos = new Map(keepIds.map((id, i) => [id, i]));
    this.version++;
    this.dirty = true;
    return gone.size;
  }

  /** The k nearest chunks to the question, by cosine. */
  async query(text: string, k: number): Promise<SemanticHit[]> {
    if (this.ids.length === 0) return [];
    const release = this.hold();
    let q: Float32Array;
    try {
      [q] = await this.embed([text], 'query');
    } finally {
      release();
    }
    const scores = new Float32Array(this.ids.length);
    for (let i = 0; i < this.ids.length; i++) {
      let dot = 0;
      const off = i * this.dim;
      for (let d = 0; d < this.dim; d++) dot += q[d] * this.vectors[off + d];
      scores[i] = dot;
    }
    const idx = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, k);
    return idx.map(i => ({ id: this.ids[i], score: Math.round(scores[i] * 1000) / 1000 }));
  }
}
