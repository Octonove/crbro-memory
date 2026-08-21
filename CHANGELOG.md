# Changelog

All notable changes to CRBRO.

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

The miner wrote straight through to disk without notifying the search engine,
and the index was only persisted during a full rebuild or consolidation. Result:
106 of 1,183 neurons were searchable. Indexing is now wired into the cortex
itself, so every write reaches the index whoever made it, with a debounced flush
to disk.

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
