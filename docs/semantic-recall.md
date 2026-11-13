# Semantic recall

The keyword engine has no synonyms, and the blind benchmark shows exactly where that bites: paraphrases — *"where are the sites hosted"* for a fact about a Hetzner VPS. Keywords written at save time close most of that gap for free (above); a small embedding model closes a little more on a small brain and a lot more on a big one. Since 1.16 `npx crbro-memory init` installs it by default, once per machine, and the layer is on wherever its runtime is present. What it costs, measured: ~500 MB on disk (runtime ~380 MB + model 118 MB), ~0.5 GB of RAM while a server runs, ~13 s of model load per process (in the background) and a one-time embedding pass. Skip it with `init --no-semantic`; turn it off any time with `CRBRO_SEMANTIC=0` in the server's env.

```bash
npx crbro-memory init                 # installs it (skip with --no-semantic)
npx crbro-memory semantic status      # runtime, model, on or off, and why
npx crbro-memory semantic build       # embed an existing brain once (a 4k-line brain: ~3 min in batches; 2.7.2 embeds one line at a time, 1.6x that)
```

Every new line is embedded when it is saved (ids are content hashes, so nothing is embedded twice), the model warms in the background after boot, and `crbro_recall` fuses both rankings by reciprocal rank. Results the vectors ranked carry `semantic_score`; a vector-only match is `strong` from cosine 0.86. With `CRBRO_SEMANTIC=0`, or without the runtime, no vectors are read and no model is loaded: recall is the keyword engine byte for byte.

The model is `multilingual-e5-small` and stays so on purpose. `CRBRO_SEMANTIC_MODEL` accepts any e5-family model, and `e5-base` and `e5-large` were measured on the same benchmark: the large one is the better model alone (71% vs 63% recall@1) but fused with the keyword engine it scored the same or worse when measured in 1.16 (75% / 85% vs 79% / 83%) for 4× the disk, 1.2 GB of RAM and 6× the time per line. The table is in [`benchmarks/README.md`](https://github.com/Octonove/crbro-memory/blob/master/benchmarks/README.md).

What it buys on the frozen benchmark, and what it does not, is in the table above and in [`benchmarks/README.md`](https://github.com/Octonove/crbro-memory/blob/master/benchmarks/README.md) — including the fact that the 0.84 cosine floor was chosen on that same set. One limit worth knowing before you install 500 MB: the model does not understand the question. Queries that share no concrete word with the stored line ("which machine serves the pages" for a fact about a Hetzner VPS) land in a flat 0.80–0.84 cosine band with near-random ordering — measured, and the reason the floor exists. What it adds is tolerance to vocabulary variation and to entities, which is where the benchmark gain comes from.

## Measuring retrieval

`eval` is there so you can tell a fix from a feeling. Write
`~/.crbro/.eval/queries.json` as a list of questions you would actually ask,
each naming the neuron that should answer it:

```json
[
  { "query": "how we deploy the api",
    "expect_neuron": "project_octochat",
    "expect_contains": "Cloud Run" }
]
```

Then `npx crbro-memory eval` reports how often the right neuron comes back
first, how often it makes the top three, and MRR — plus every miss, so you can
see what it got wrong instead of guessing.
