# Changelog

All notable changes to CRBRO.

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
