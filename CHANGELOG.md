# Changelog

All notable changes to CRBRO.

## [1.15.0] — 2026-09-03

### The model in the loop

Antonio asked the right question: why not use the model itself for the hard
cases? The caller of this memory is a language model at both ends — it saves,
and it asks — and it knows the synonyms a keyword index does not. 1.15 gives
it two places to put them, at zero disk and zero RAM:

- `crbro_learn` takes `keywords`: 2-5 words a future question may use that
  the text does not contain — synonyms, the other language, the generic name
  of the product named. Stored on the fact (`keys`), indexed with the line,
  never displayed, merged when the same line is saved again, carried through
  team spaces.
- `crbro_recall` takes `queries`: alternative phrasings searched together
  with `query` and fused by reciprocal rank (`SearchEngine.searchMany`). One
  phrasing behaves exactly as before.
- Boot's `memory_discipline` says both, so a fresh session does it unprompted.

Measured blind on the frozen set: the keywords were written by a model that
saw only the 48 fact texts, the rewrites by one that saw only the 62 queries.
Both files ship in `benchmarks/retrieval/`, so the runs reproduce.

| | recall@1 | recall@3 | with `also_matched` |
|---|--:|--:|--:|
| 1.14 keyword engine | 71% | 77% | 79% / 85% |
| + keywords | **83%** | **90%** | 85% / 94% |
| + keywords + rewrites | 85% | 90% | 92% / 98% |
| + keywords + rewrites + semantic layer | **90%** | **92%** | **96% / 98%** |

Rewrites alone barely move the keyword engine (71% / 79%): a blind rewrite
does not guess "Hetzner". Keywords at save time do, which is why they are the
lever — and why no embedding model was ever going to replace them.

### Also

- `CRBRO_SEMANTIC_MODEL` / `CRBRO_SEMANTIC_DTYPE` select the embedding model
  (any e5-family model transformers.js can load). The vector width is read
  from the model, and stored vectors of another model are ignored, never
  mixed. Added to measure bigger models — and the measurement says no:
  e5-base and e5-large score the same or worse than e5-small once fused with
  BM25 (75 / 85 vs 79 / 83 at recall@1 / @3) for 2–4× the disk, 0.8–1.2 GB
  of RAM and 2–6× the time per line. `benchmarks/retrieval/models.mjs`
  reproduces the model-only column.
- The RAM of the semantic layer is now documented: ~0.5 GB with the default
  model, measured, not estimated.
- The cost benchmark no longer counts the semantic runtime and models as
  brain size: 36.9 MB of brain, not 1.4 GB.
- 7 new tests (192 total). `INDEX_VERSION` 4: the search index is rebuilt
  once on the first start after upgrading.

## [1.14.0] — 2026-09-03

### The semantic layer — opt-in, measured

After 1.13 the blind retrieval benchmark had 8 misses left (counting
`also_matched`), every one a paraphrase no synonym table reasonably covers:
"alojadas" for a Hetzner VPS, "seguridad" for Wordfence, "proveedor de
email" for Mailchimp. That is what an embedding model is for — and 1.4
rejected one over a 472 MB download. The number was wrong: that was the
fp32 file. The int8 build of `Xenova/multilingual-e5-small` is 118 MB.

So it ships, but opt-in, and it stays opt-in for three measured reasons:
the runtime (transformers.js + onnxruntime) is ~380 MB of node modules,
the model is 118 MB, and a cold load takes ~13 s per process. Nothing is
installed, downloaded or loaded unless you run `npx crbro-memory semantic
install` **and** set `CRBRO_SEMANTIC=1`. Without both, `src/search/semantic.ts`
is dead code and recall is the 1.13 engine byte for byte (verified: the
benchmark prints identical numbers with the variable unset).

- `crbro-memory semantic install | build | status`. The runtime and the
  model live in one machine-level home (`~/.crbro/.semantic`), outside the
  package; the vectors live next to the search index (`.search/vectors.f32`
  + `vectors.meta.json`, float32, keyed by chunk id).
- Ids are content hashes, so re-indexing a neuron embeds only its new lines
  (20–45 ms each on a laptop, by length). `semantic build` embeds the whole
  brain once — the reference brain (5,129 chunks, 3,984 non-header lines)
  took three minutes, model load included.
- Fusion is reciprocal-rank (`RRF_K` 60): rank-based, so the two score scales
  never have to agree. Vector-only candidates below a cosine floor are
  dropped; headers are never surfaced by vector alone; a vector-only match
  is `strong` from cosine 0.86. Results the vectors ranked carry
  `semantic_score`.
- The model warms in the background after boot, off the critical path.
- Every failure — runtime missing, model download failing, a corrupt vector
  file — degrades to "no semantic layer", never to "no recall".

Measured on the frozen blind set (48 queries, 14 distractors):

| | recall@1 | recall@3 | MRR | distractors at a hit's score |
|---|--:|--:|--:|--:|
| 1.13 lexical | 71% | 77% | 0.744 | 2 / 14 |
| vectors alone | 60% | 83% | — | — |
| **1.14 fused, floor 0.84** | **79%** | **83%** | **0.813** | **0 / 14** |

With `also_matched`: 88% / 92%. Honest caveats, also in `benchmarks/README.md`:
the floor (0.84) was chosen by sweeping it on this same set — 0.80 gives
75/79, 0.85 gives 69/77, 0.86 gives 77/79, so the curve is not monotonic and
48 queries is a small sample; and e5-small compresses cosines into
~0.82–0.92 for everything, related or not, which is why the floor sits so
close to the distractors' ceiling (0.841). And the model does not understand
the question: queries sharing no concrete word with the stored line land in
a flat 0.80–0.84 band with near-random ordering (7 lines × 8 such questions,
measured) — the gain is tolerance to vocabulary variation and entities, not
paraphrase, which is exactly why the floor exists.

### Also

- `upsert` had an offset bug that threw a `RangeError` swallowed upstream,
  so the first fused benchmark run showed no change at all. Measure the
  effect, not the artefact.
- 5 new tests (185 total); the four that need the model are skipped where
  the runtime is not installed — no test suite should download 500 MB. Their
  assertions rest on measured cosines, after a first draft that guessed one
  and had it backwards.

## [1.13.0] — 2026-09-03

### Retrieval — the right neuron now answers with the right line

The blind benchmark had 13 misses. Reading them one by one: only 5 were
vocabulary gaps. 3 were the neuron's *header* chunk (its name, boosted ×2)
speaking for the neuron, and 5 were the right neuron answering with a sibling
fact. Fixes, each measured on the frozen set and each in its own commit:

- **The header never wins** while a live content chunk matched. It still
  ranks the neuron; it no longer *is* the answer. 56% → 60% recall@1.
- **`also_matched`** on the top three results: the neuron's next best lines,
  so one topic can answer with more than one sentence. Fact-level recall@3
  73% → 79% when they count.
- **A bilingual synonym table** (`src/search/synonyms.ts`, ~180 everyday
  agency/dev pairs, ES↔EN). A synonym counts as the *same* query term, so
  coverage stays honest. 60% → **71%** recall@1, 73% → **77%** recall@3,
  MRR 0.676 → **0.744**; distractors scoring like a real hit 4 → 2. Off with
  `CRBRO_SYNONYMS=0`. The caveat is in `benchmarks/README.md`: the table was
  written by someone who had seen the benchmark's misses, so it is a
  vocabulary table, not a blind result — the overfit pairs were left out on
  purpose, and it is measured both ways.
- **`confidence` on every result** — `strong` when the line covers at least
  half the question (two terms or more), `weak` otherwise. Labels 10 of the
  11 distractors that return something as weak; also calls 18 of 48 real
  hits weak, which is the price and is published. `matched_terms` and
  `query_terms` come with it.

### Dated errors, debts, patterns and preferences

`type:error` and `type:debt` were bare strings, so recall answered
`matched_added: ""` for every one of them and "prefer the more recent" could
not apply to the one ledger where it matters most. A sidecar `entry_dates`
(keyed by the same content hash the purge ops use) dates them now — the
arrays, the team-log format and brains written before 1.13 are untouched.
Dates travel through spaces in the op's `at`; the earliest wins, like facts.

### Implicit synapses

The reference brain had **14 synapses for 1,145 neurons**: only
`crbro_connect` created them and nobody calls it, so the connectivity share
of heat (25%) weighed nothing and the global map had no bridges. Consolidate
now links the neurons written in the same session — strength 0.3, type
`temporal`, capped at six topics, never overwriting a context somebody wrote
by hand. `synapses_updated` finally means what it says (it used to be the
total count); `total_synapses` is reported alongside.

### Tool definitions a client can read

- Every tool is registered with a **title** and **MCP annotations**
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
  Nine tools are read-only; four can destroy (`maintenance` with archive or
  purge, `map` which replaces whole, `secret` remove, `forget`).
- The seven readers with a stable shape declare an **outputSchema** and
  return `structuredContent` (`status`, `neurons`, `recall`, `connections`,
  `sessions`, `hot_topics`, `audit`).
- Descriptions rewritten to say what the tool does, when to use it over its
  siblings, its side effects and what it returns — and nothing else. The
  discipline of using the memory well moved to **`memory_discipline`**,
  returned once by `crbro_boot`, instead of being repeated in every
  definition. Measured with a real `tools/list`: 25.1k → **21.7k characters**
  of description + input schema (~5.4k tokens), paid on every request by
  clients that load all tools. The README now says so; 1.12 measured 6.3k
  and did not.
- Glama's four Behavior 2/5 scores (`status`, `context`, `global_map`,
  `sessions`) were all "does not say whether it reads or writes". They do now,
  in both the prose and the annotations.

### Housekeeping

- `Dockerfile` + `.dockerignore`, so a registry that builds servers in a
  sandbox (Glama) does not have to infer one.
- GitHub Releases created for every tag since 1.9.0; Glama listed "no stable
  releases" and still showed v1.4.0 because the repo had tags but no
  releases.
- The retrieval benchmark prints an extra, clearly labelled *informative*
  line for the 1.13 features (also_matched, confidence, synonyms on/off);
  the pre-registered metrics are untouched.
- 25 new tests (180 total): ranking rules, dated entries end to end, implicit
  synapses, and the tool definitions as a real MCP client sees them.

## [1.12.0] — 2026-08-24

### Changed — subagent injection is now opt-in, because we measured it

The 1.11 SubagentStart hook injected the behavioral-protocol block into every
spawned subagent by default. Then we benchmarked it properly — three runs
with verified-clean controls, blind judges and pre-registered thresholds —
and the pre-registered kill criterion fired:

- Frontier models scored a perfect ceiling on every measurable agentic probe
  with AND without the block. There is nothing for injection to add.
- Small models on single-shot tasks were HARMED by it: scope discipline went
  from 10/10 bare to 0/10 injected, and a shorter variant did not fix it —
  the failure mode is the block's presence, not its wording.
- In agentic mode the only differential behavior was against: 2/5 small-model
  agents WITH the block deleted a failing test suite, replaced it with tests
  built to pass, and reported success. 0/5 without it.

So: `install-hooks` now installs the machinery inert, and
`install-hooks --inject` (or `CRBRO_SUBAGENT_INJECT=full`) enables it
knowingly. `CRBRO_SUBAGENT_MATCHER` still scopes by agent_type. The full
data, pre-registrations and the runs that produced them are published in the
card repo's `benchmarks/` — including every result that went against us.

## [1.11.1] — 2026-08-24

### Fixed — the four known misses, closed

The 1.11.0 security benchmark shipped listing four credential shapes the
filter let through. All four are now caught, each with an anchored,
unambiguous pattern and a near-miss innocent added to the benchmark to prove
it does not overfire: AWS secret keys stated in prose (exactly 40 base64
chars, mixed case + digit required), Spanish prose passwords with a qualifier
("la contraseña de X es ..."), credentials dictated in two pieces ("empieza
por ... y sigue con ..."), and Twilio SIDs/auth tokens. Capture: 45% → 80% →
**100% on the frozen adversarial set**, still 0% false positives (19
innocents). A frozen-set 100% is a floor, not a guarantee — the set grows.

### Docs

- README now leads with the measured numbers — including the unflattering
  ones (recall@3 69%, ~753 boot tokens) — plus the features 1.9–1.11 added
  (living maps, error ledger, debt ledger, subagent hook) and the corrected
  tool count (23).
- Two retrieval folds (participle gender, verb person) were tried against the
  blind benchmark: one changed nothing, one made recall worse. Neither ships;
  the ablation is documented in `tokenize.ts` so nobody retries it blind.

## [1.11.0] — 2026-08-24

### Added — deliberate deferrals, and integrity for subagents

- **`crbro_learn` accepts `type: "debt"`** — the twin of `type: "error"`. An
  error is "did X wrong, fixed it so"; a debt is "skipped X on purpose — here
  is the ceiling, revisit when Y". The graveyard of the unbuilt: when someone
  re-proposes a dead idea, recall serves the decision with its reason. Debts
  travel through shared spaces like errors (set union, purge on forget), and
  `crbro_maintenance` flags the ones that never named a revisit condition — a
  deferral without a trigger quietly becomes permanent.
- **A `SubagentStart` hook** (`hooks/crbro-subagent.mjs`, wired by
  `npx crbro-memory install-hooks`). SessionStart context never reaches
  Task-spawned subagents, so until now every subagent ran without the
  behavioral protocols the session booted with — the anti-hallucination and
  verification rules governed the orchestrator while the agents doing the
  unsupervised work ran bare. The hook reads the same protocol neurons
  `crbro_boot` reads (one source of truth), and is hardened to never block a
  session: BOM-safe, stdin-independent by default, fail-open scoping, embedded
  fallback, always exit 0.

### Fixed

- **Stronger secret detection.** A fresh benchmark found the redaction filter
  caught only 45% of credentials in varied forms — it let database DSNs,
  passwords in prose and `API_KEY=` through. Five patterns added (connection
  strings, generic labelled keys, prose passwords, SendGrid, fine-grained
  GitHub PATs); capture is now 80% with 0% false positives, and the four that
  still slip are documented as known issues.
- **`redact()` no longer eats legitimate prose** when two patterns match the
  same span (e.g. "la clave es AIza… guárdala en la bóveda" kept the "guárdala
  en la bóveda"). Left-to-right cursor pass instead of a right-to-left one with
  stale offsets. This was latent since the first vendor patterns; the new
  patterns made it common.
- **`loadProtocols()` and the subagent hook filter retired facts.** Correcting
  a protocol via `supersedes` used to inject both the old and new wording into
  every session (and every subagent). Active facts only now.
- **A lone purge persists across a sync.** Forgetting an error or debt when no
  other change touched the neuron left it live on teammates' machines until an
  unrelated write happened to flush it — a credential forgotten inside an error
  did not disappear from their recall. The merge report now counts removals so
  the sync change-gate fires.

### Benchmarks

New `benchmarks/`: retrieval (recall@3 69% with blind paraphrased queries — the
honest price of no semantic search), security (the filter, failures listed),
and cost (the tokens CRBRO adds, published on purpose). All deterministic, no
API, run in CI. What is NOT measured, and why, is in `benchmarks/LIMITS.md`.

## [1.10.0] — 2026-08-23

### Added — the memory diet

A memory gains weight the same way a codebase does: not from what is
needed, but from what nobody paused to not write. Measured on the
reference brain: 3,621 active facts with a healthy 93-character median,
but a heavy tail — 10% over 1,500 characters, and the heaviest neuron
holding 293 facts with 1,407 near-duplicate pairs. Session summaries
retelling the same thing with variations, every version as loud as the
others on recall.

- **`crbro_learn` now warns about near-duplicates.** A new fact that
  closely resembles an active one (Dice ≥ 0.8) is stored anyway — the
  brain never refuses knowledge — but the response names the older fact,
  its id and the fix: retire it with `supersedes` or `crbro_revise`.
  Warn-only by design: blind similarity is how "sprint_2" and "sprint_3"
  become one thing, so nothing is ever merged or refused automatically,
  and nothing already stored is compressed — durable memory is not
  ephemeral prose; a fact that loses its "why" is worse than a long one.
  A fact properly superseded in the same call does not re-trigger the
  warning, so idempotent retries stay quiet.
- **The save ladder, in the tool description and the card**: does it
  already exist → does it update something (`supersedes`) → is it
  structure (`crbro_map`) → is it derivable from the repo → would it
  survive losing half its words. The first "yes" decides.

## [1.9.1] — 2026-08-23

### Fixed

- **`Brain.initialize()` zeroed a living brain.** It overwrote the manifest
  and the prefrontal files unconditionally — and it is public API, the
  documented first call for any script using the engine directly. Two
  maintenance scripts did exactly that on the reference brain and its next
  boot reported 0 neurons while 1,186 sat intact on disk. `initialize()` is
  now idempotent: an existing brain is returned as found, and only missing
  pieces are created.
- **Boot self-heals the counters.** The manifest is derived data; the cortex
  on disk is the truth. Boot now recounts neurons, synapses and sessions
  from the directory listings and corrects the manifest when they disagree,
  so this whole class of damage fixes itself on the next start.

## [1.9.0] — 2026-08-23

### Fixed — a correction now actually corrects

Found live, on a real brain: `crbro_revise` marked a fact as superseded,
answered "they no longer appear in recall" — and the retired fact came back
as the FIRST recall result, outscoring the very fact that corrected it. The
wrong version of anything tends to be longer than its correction, so it
matches more terms and wins.

The root cause was worse than the symptom. Removing a neuron's chunks from
the search index relied on an Orama `where` filter over a plain string field
with an empty term: a query that matches nothing and throws nothing. So
"re-index this neuron" removed zero chunks, re-inserted under the same ids
(duplicates silently swallowed), and reported success. Every revision and —
far worse — every `crbro_forget` of sensitive text left the old content
fully searchable.

Three layers now close it for good:

- The engine keeps its own ledger of which chunk ids belong to which neuron
  (it inserted them; it remembers them), and removal walks that ledger
  instead of trusting a filter that never worked. The ledger is rebuilt from
  the stored index on boot, so removal keeps working after a load-from-disk.
- A hydration guard: before recall returns a fact, it checks the neuron on
  disk still holds it as active. If not, the result is dropped and the
  neuron is quietly re-indexed — so even an index poisoned by an older
  version cannot serve retired knowledge, and heals itself as it is used.
- `INDEX_VERSION` 2 → 3: every existing index rebuilds once on next boot,
  which purges whatever the old removal left behind.

Also fixed in the same sweep:

- **Domain-filtered recall returned nothing at all.** The same Orama `where`
  clause, the same silent no-match — `crbro_recall` with a `domain` filter
  has been returning zero results since chunk search shipped. Filtering now
  happens on our side of the query.
- **`supersedes` failed silently.** Passing free text that matched no fact
  returned `superseded: 0` with no complaint, and the writer walked away
  believing the old version was retired. `crbro_learn` now returns
  `supersedes_unmatched` plus a warning telling you exactly how to finish
  the job, and `crbro_revise` warns when some of its targets matched nothing.

### Added — the error ledger and the living map

Born from a real complaint after a full day's work on one system: the brain
held the *chronicle* (what happened, what was fixed, in what order) but not
the *map* (which template serves what, which plugin does what, which trap
costs an hour) — so the next session re-discovered everything. And the
mistakes made along the way were prose, impossible to check before
repeating the same task.

- **`crbro_learn` accepts `type: "error"`** — a mistake plus how it was
  corrected, in one entry. Errors are a separate ledger from patterns so
  "check my known errors before doing this again" is a question the brain
  can answer. They merge across a team like patterns: plain set union.
- **`crbro_map`** — ONE living document per neuron: where the system lives,
  what serves what, the traps. Reading takes just the neuron name; writing
  replaces the map whole, because append-only maps rot the same way facts
  did. Recall results now carry `has_map: true` when their neuron keeps a
  map, so the next session knows to read it before touching the system.
- Maps and errors travel through shared spaces. Errors union like patterns.
  A map is a whole-document replacement, so the newest write wins, with a
  deterministic tie-break on the content hash — two machines replaying the
  same logs always land on the same map, and a stale copy can never
  resurrect an older version. Older clients simply skip the new note kinds:
  a degradation, not a corruption.
- `crbro_forget` sweeps errors and the map too — deleted means deleted,
  from the neuron and from the index. And on shared neurons the deletion
  now travels: forgotten facts retract, forgotten errors carry a purge
  note that always wins, and a cleared map emits the empty-map tombstone —
  so the next sync can no longer resurrect what the user asked to destroy.

### Hardened — an adversarial review before shipping

Twenty-three reviewer and verifier agents went over the diff, each claim
proven or refuted by an executed test. What they caught, fixed here:

- A log line with a missing timestamp beat every real date in the map's
  last-writer-wins (`String(undefined)` sorts after any ISO date) — one
  malformed note could freeze a team's map forever. Timestamps are
  normalised and compared ordinally, so convergence no longer depends on
  each machine's locale.
- `crbro_map` resolved names in the opposite order to every other tool, so
  writing by exact neuron id could land the map on a near-miss neuron while
  every reader resolved the real one. Same order everywhere now.
- A neuron whose best-scoring chunk had been retired vanished from that
  recall entirely, even when it still held live knowledge that matched.
  Results now fall back to the neuron's next valid chunk, and every kind —
  not just facts — is verified against the neuron before being served.
- `crbro_share` never scanned the map or the error ledger for credentials,
  and the first share of a neuron did not carry them at all. Both fixed;
  `crbro_audit` covers the new fields too.
- Two processes writing the same file shared one fixed temp name, so
  concurrent writers could rename a torn JSON into place. Each writer now
  renames only bytes it wrote entirely.

## [1.8.0 – 1.8.2] — 2026-08-22

### Added

- **`crbro_secret`** — credentials brokered to the OS keychain (Windows
  DPAPI / macOS Keychain / libsecret). The brain stores only the pointer;
  the value never touches a neuron file.

### Fixed

- macOS `security` returns hex for any non-printable byte — values are now
  stored base64 (1.8.1).
- `crbro_status` reported `1.0.0` on every install: it was echoing the brain
  FORMAT version, frozen since 1.0.0, instead of the running package
  version (1.8.2).
- DPAPI is called through the .NET API, with a probe that actually encrypts
  instead of assuming it can (1.8.2).

## [1.7.0] — 2026-08-21

### Added — shared memory for a team

Two people on the same project can now keep their assistants in step. A
**space** is one or more projects shared through a private git repository the
user owns: no server to run, no account to create, no bill. Three tools —
`crbro_space`, `crbro_share`, `crbro_sync` — and after the one-time setup it
runs at the start and end of every session without anyone asking.

**Why it merges without conflicts.** Nobody shares a neuron. Each person
appends notes to a log only they write to — "I added this fact", "I retracted
that one" — and every machine rebuilds the project from all the logs it has.
Two writers never touch the same bytes, so there is nothing to collide over,
and rejoining after a week apart is the same operation as syncing after a
minute. Fact ids are content hashes, so the same sentence written by two people
is one fact, and merging is a set union: order does not matter, replaying
changes nothing, and applying half now and half later ends up the same.

Retraction is the one thing that always wins. Status only moves forward —
active, then superseded, then retracted — so a fact somebody marked as untrue
cannot be resurrected by a stale copy that still calls it current.

**What never travels.** Every project not explicitly shared. Preferences, at
any setting, because that is the field most likely to hold a key. And the
cortex itself is never in the repository: reading a neuron bumps its access
count, so a cortex under git would commit every time somebody asked a question
— one neuron on the reference brain had been read 420 times.

**Credentials block the share.** `crbro_share` always runs as a dry run first,
reports exactly what would be sent, and refuses outright if it finds a
credential, naming where it is. It does not redact and send the rest: quietly
handing someone a mangled fact is worse than refusing.

**Offline is a normal answer.** Local memory works either way, and pending
notes go out on the next sync.

Two Windows details that are not optional and are handled at space creation:
git's line-ending conversion is disabled per repository (it was on at system
level on the machine this was built against, and with union merging a rewritten
line ending turns one line into two), and the first commit is pushed before
anyone can clone (otherwise two people start unrelated histories and each keeps
half the memory without noticing).

### Fixed — wiring that could be forgotten

The search indexer was wired only inside the MCP server, so the miner — which
builds its own `Cortex` — never indexed anything, and 1.5.2 had to fix that
after the fact. The sync layer would have had the same shape, so it ships as a
single `attachSync(brain, cortex)` that every entry point calls. One place to
get right.

## [1.6.1] — 2026-08-21

Two holes in the credential filtering that shipped hours earlier in 1.6.0.
Both found by checking it against a real brain instead of trusting the tests.

### Fixed — the WordPress pattern caught none of them

It required a digit AND a letter inside every one of the six four-character
groups, to keep ordinary prose from matching. Random groups satisfy that about
half the time, so six in a row is roughly 1.6% — and it caught **0 of the 3**
real application passwords sitting in the reference brain, because real ones
contain all-letter and all-digit groups. Anchored to the label that always
accompanies them instead: **3 of 3, and 0 false positives across 4,288 facts.**

### Fixed — the audit only looked at facts

`crbro_audit` scanned `facts` and nothing else, so a neuron could be reported
clean while a key sat in `preferences[0]`. On the reference brain that hid
**7 more findings** in decisions and patterns. It now scans facts, decisions,
patterns and preferences, and reports the count per field. `crbro_forget`
reaches all four as well — those entries had no way of being removed at all.

## [1.6.0] — 2026-08-21

### Fixed — two editors at once lost facts, silently

Every write read the whole neuron, changed it in memory and saved it back, so
whoever saved last erased whatever the other had added in between. No error,
either side. Measured: two processes storing 40 facts each into one neuron
asked for 80 and kept **42**. With CRBRO registered at user level — which the
README recommends — two editors open at once is the normal case.

Writes are now serialised per neuron with an advisory lock, and every
read-modify-write goes through it. Same test after the fix: **80 of 80**.
Abandoned locks are broken after ten seconds and swept during maintenance, so a
process dying mid-write cannot wedge a neuron.

### Added — credentials are filtered before they reach the disk

A memory stores whatever the assistant hands it, and assistants handle
credentials all day. On the reference brain, five were sitting in the cortex —
a cloud API key, a password in plain text, three WordPress application
passwords — and all five were in the search index too, so a recall could hand
them back.

`crbro_learn` now replaces credentials with a marker naming what they were:
`the deploy token is [REDACTED: npm token] and expires in January` keeps the
knowledge and drops the liability. Detection favours precision over recall — a
false positive would quietly corrupt real knowledge — so it matches
vendor-prefixed tokens, private key blocks, JWTs and explicitly labelled
passwords, and leaves ordinary prose alone.

Two new tools for what is already stored:

- **`crbro_audit`** lists which neurons hold credentials and of what kind,
  never the values.
- **`crbro_forget`** removes facts for good. It is the only destructive
  operation in CRBRO, so it copies the whole neuron to `.quarantine/` first and
  never edits in place. For knowledge that merely stopped being true, use
  `crbro_revise` instead, which keeps the history.

### Added — searching in the singular finds the plural

Asking about "facturas" now finds the fact that says "factura", and the other
way round. Deliberately not a stemmer and not a synonym table: a stemmer
mangles the Spanish `-ción` family, and a synonym table is guesswork that pulls
in wrong results. Number agreement is mechanical and cannot invent a meaning
that was not there. Both forms count as one term, so query coverage stays
honest.

### Added — maintenance can clear the miner's leftovers

Early versions recorded `Referenced in: <file>` for every technology spotted.
That says a word appeared in a file, which is not knowledge; on the reference
brain it was 708 of 4,273 facts, with 48 neurons made of nothing else. Every
run now reports how many there are; `purge_boilerplate: true` removes them.

### Added — CI runs on Windows

The two most expensive defects this product has had were Windows-specific, and
the suite had never run there. It now runs on Ubuntu and Windows, and there are
tests for concurrent writes and for credential handling — neither of which had
a single case before.

## [1.5.2] — 2026-08-21

Six defects found by auditing 1.5.1 against the reference brain. No format
change; upgrading needs nothing.

### Fixed — the index could fall behind for good

`init()` rebuilt only when the index file was missing, its version had changed
or its JSON was corrupt. Never because it had simply fallen behind. So a lost
flush — or a second client writing neurons while this one held a stale index —
left those facts invisible to `crbro_recall` indefinitely. Measured on the
reference brain: the index was 5h37m behind the newest neuron, and searching a
term saved that afternoon returned nothing. It now compares the index against
the newest neuron and rebuilds when the cortex has moved on.

### Fixed — the miner still did not reach the index

`setIndexer` was called in exactly one place, the MCP server. `Miner` builds its
own `Brain` and `Cortex` in its own process, so everything it learned stayed
unsearchable until someone ran a full rebuild. It now wires its own indexer and
flushes before exiting.

### Fixed — `dry_run` was not dry

`crbro_maintenance({dry_run: true})` called `heatEngine.recalculate()` before any
guard, and that writes. A simulation rewrote all 1,183 neuron files plus
`hot_topics.json`.

### Fixed — heat recalculation rewrote every neuron, always

`recalculate()` wrote each neuron whether or not its heat had changed. Between
two consecutive runs, not one of 1,183 changes. Beyond the churn, every rewrite
is a window in which a concurrent write from another client is lost. It now
writes only when the value actually moved.

### Fixed — `crbro_consolidate` reported a number that meant nothing

`facts_saved` returned the total neuron count, so it answered the same figure
whether the session had stored one fact or thirty — and it is the only number
the assistant sees when closing a session. It now reports what was really
written, and `topics_touched` in the session log is no longer hardcoded to
empty, which is why 65 of 70 session logs had no topics attached.

### Fixed — topics differing only by a number were merged

The near-miss matching added in 1.5.1 used bigram similarity, which is blind to
a single differing digit: `sprint_2` against `sprint_3` scores 0.857 and
`old_topic_1` against `old_topic_11` scores 0.952, both above the threshold. So
learning about "Sprint 3" filed the knowledge under "Sprint 2". A number in a
topic name is usually the whole point of the name, so a candidate that disagrees
on the numbers is no longer treated as a near-miss.

### Fixed — accented topic names produced mangled ids

`toSnakeCase` deleted accented letters instead of folding them, so "búsqueda"
became `bsqueda` and "técnico" became `tcnico`. On the reference brain 82 of
1,183 ids were mangled, and the tool description asks the model to pass
`neuron_id` back — which nobody can guess. Accents are now folded to their base
letter. Neurons already stored under a mangled name stay reachable: `findByName`
tries the correct slug first and falls back to the old one.

## [1.5.1] — 2026-08-21

Housekeeping only, no behaviour change. The 1.5.0 build carried a handful of
neuron names from the brain it was debugged against inside compiled comments.
They were only names, never any stored knowledge, but a published package is no
place for them. Replaced with generic examples.

## [1.5.0] — 2026-08-21

Retrieval rewrite. Everything you had saved is preserved: no neuron file is
modified by upgrading, and the search index is rebuilt automatically on first
run (~1 second for 1,200 neurons).

### Fixed — the more you saved, the less findable it became

The index treated each neuron as a single document with every fact concatenated
into one field. Orama ranks with BM25, which divides by document length, so on a
real brain — median neuron 90 characters, largest 342,302 — the most valuable
neuron scored near zero for any single term while a 90-character scrap outranked
it. Saving more about a topic actively made that topic harder to retrieve.

Now every fact, decision, pattern and preference is its own document, plus a
header document per neuron carrying the name and tags. Scoring runs per query
term, normalises each term against its own best hit, and weights by how much of
the query a chunk covers. A neuron wins by holding one chunk that answers the
question, not by being short.

Measured on a 1,183-neuron brain: the query that used to miss the top ten now
returns the right neuron first, in 3 ms.

### Fixed — recall never showed you what matched

`matching_content` returned the neuron's `summary`, falling back to the first
200 characters of the concatenated facts. Since summaries are almost always
empty, in practice it returned the *oldest* fact in the neuron regardless of the
query. Results now carry the chunk that actually matched, plus `matched_kind`
and `matched_added` so you can prefer recent knowledge when two facts disagree.

### Fixed — fuzzy matching drowned the ranking

`tolerance: 2` applied an edit distance of two to every term. On the reference
brain a single common term matched 1,166 of 1,183 documents — the ranking was
noise. Search is now exact, with one edit of slack retried only for terms of
five characters or more that find nothing at all.

### Fixed — most of the brain was never indexed

The index was only persisted during a full rebuild or consolidation, and the
cortex never told it about a write. Result: 106 of 1,183 neurons were
searchable. Indexing is now wired into the cortex itself, with a debounced
flush to disk.

(Corrected in 1.5.2: this section originally claimed every write reached the
index "whoever made it". That was not true of the miner, which builds its own
Cortex in its own process and was never given an indexer.)

### Fixed — writes landed in the wrong neuron

`findByName` fell back to substring containment in either direction, so a
two-word topic resolved to any long neuron id that happened to contain it, and a
short name like "SEO" was swallowed by a sixty-character id that merely
mentioned it. Knowledge written
into the wrong neuron is recalled attributed to the wrong neuron, and no amount
of index tuning repairs it. Matching is now exact, or a genuine near-miss above
a high similarity threshold; otherwise it returns null and a new neuron is
created. A wrong guess is worse than a new neuron.

`create()` also no longer overwrites an existing neuron when two names slugify
to the same id, and the manifest counter only increments on a real creation.

### Fixed — maintenance could swallow the whole brain

`crbro_maintenance` archived every neuron with heat below 0.05 untouched for 90
days, into a directory that is not indexed, not searchable and has no restore
path. On the reference brain that was **1,028 of 1,183 neurons** — one routine
call away from losing 87% of the memory. Heat decays with time, so an old brain
looks identical to a worthless one.

Archiving is now opt-in (`archive: true`). Every run reports
`archivable_neurons` so you can see the number before deciding.

### Added — `crbro_revise`

Facts were append-only: nothing could ever stop being true. A note written three
weeks ago carried exactly the same weight as a correction written today, so
stale answers kept resurfacing alongside current ones.

Facts now have an optional lifecycle — `active`, `superseded`, `retracted` —
and `crbro_revise` retires them. Superseded facts vanish from recall but stay in
the neuron file, so nothing is lost and the correction is auditable.
`crbro_learn` also accepts `supersedes` so a replacement is a single call.

Fact ids are content hashes: deterministic, collision-free, and requiring no
migration of existing files.

### Added — open items that can actually be closed

`resolve_pending` matched by exact string equality. Real pending notes run to
hundreds of characters with quotes and paths inside, and nothing ever reproduced
one byte-for-byte, so items accumulated forever and were repeated back long
after they were done. Items now have short ids (`p_ab12cd`) and can be closed by
id or by a fragment of their text. `crbro_boot` returns `open_items` and
`recently_closed`, with an explicit note that an item can be finished without
anyone closing it here — verify before repeating it back.

### Added — `reindex` and `eval` CLI commands

`npx crbro-memory reindex` rebuilds the index. `npx crbro-memory eval` scores
retrieval against your own query set, so improvements can be measured instead of
felt.

### Changed — the miner enriches, it does not invent

The miner created a neuron per detected topic, which produced roughly a thousand
junk neurons on the reference brain: a passing mention of a board game became a
"language", and a markdown heading like "Findings" became a neuron that then
attracted unrelated writes.
They were tiny, so they outranked real knowledge, and they poisoned name
resolution. The miner now only writes into neurons that already exist, tags its
facts `source: 'miner'`, and no longer records contentless "Referenced in:
<file>" notes — those were 708 of 4,273 facts.

### Changed — smaller payloads

`crbro_boot` emitted the full protocol text twice, once inside
`active_protocols[].instructions` and again in `protocol_enforcement`: 1,407 of
2,713 tokens spent saying the same thing twice. Now once.

`crbro_neuron` paginates facts (newest first) instead of serialising the whole
neuron — the largest on the reference brain came to 528,836 characters, more
than most models can hold.

### Migration

Automatic. The v2 index lives in `.search/chunks.index.json`; the old
`orama.index.json` is ignored and deleted after the first successful rebuild
(it was 25 MB of dead weight). All new fields on facts and pending items are
optional, so files written by 1.4.0 load unchanged, and downgrading simply
rebuilds the old index.

Reading a pre-v2 index was the one thing that could not be left alone: Orama's
`load()` does not throw on a schema mismatch, it silently replaces the live
schema, so search would have failed permanently on every boot with no way to
recover. Hence the version stamp and the separate filename.

## [1.4.0]

CRBRO goes fully free — license engine removed, MCP Registry publication.
