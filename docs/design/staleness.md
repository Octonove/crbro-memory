# Design: shelf life, last verification and `possibly_stale`

Status: **implemented on branch `feat/staleness`** (written against 2.8.0;
section 13 lists where the implementation differs from the text below, and
section 14 the second iteration of how recall presents the warning). The
benchmark case that will judge it (`stale-unmarked`) is pre-registered in
[benchmarks/agentic/PREREGISTRO.md](../../benchmarks/agentic/PREREGISTRO.md)
in the same commit as this document, before any implementation or run.
Measured twice (Fifth and Sixth amendments, 2026-10-04): neither met its
pre-registered thresholds; the second iteration's result is in §14.

Origin: feedback from r/mcp, reviewed and approved by the maintainer:

1. a date of **last verification** per fact, and a way to reconfirm a fact when
   the agent checks it against its source;
2. a **shelf life by kind of data**, settable at save time like keywords:
   versions, prices, configuration, paths, ports, people in roles go stale
   fast; decisions and preferences slowly; with a prudent default;
3. a recall that **warns**: what is past its shelf life (counted from the last
   verification) comes back in a separate `possibly_stale` block, with its age
   and how to reconfirm or replace it, instead of mixed with what is current;
4. a new case in the agentic benchmark, `stale-unmarked`: a value that changed
   in the world and that nobody retired from memory.

## 1. What exists today, and the gap

| mechanism | what it knows | what it cannot say |
|---|---|---|
| `Fact.added` | when the line was first written | whether anyone looked at it since |
| `Fact.confirmations` (2.7) | how many sessions stored the same line | **when** the last one did |
| `status` superseded / retracted | someone retired it | nothing about a value that changed silently |
| recency weight in ranking | newer tellings win near-ties | an old line with no rival still wins, unflagged |
| `recall since=` | keep out entries older than a day | it hides, it does not warn, and it is opt-in |
| maintenance `expired_entries` (2.5) | the entry **names a day** that has passed | a port or a price names no day |

The failure the feedback points at is the one none of these catch: a fact that
was true, is no longer true, and was never retired because nobody told the
memory. Today recall serves it with `confidence: strong` and nothing else.
The agentic benchmark's `stale` tasks do not cover it either: there the old
value **was** retired, and the test is that it stays hidden.

## 2. Data model

All new fields are optional. A brain written by 2.8 is valid as it is, and no
migration rewrites it.

```ts
interface Fact {
  // ...existing fields...
  /**
   * ISO instant of the last time this line was checked against its source
   * and still held: crbro_revise status=verified, or the same text learned
   * again. Absent === never re-checked: the clock runs from `added`.
   */
  verified?: string;
  /**
   * How fast this kind of value goes stale, ONLY when the caller said so.
   * Absent === inferred at read time from kind and content (section 3), so
   * a better detector improves old facts too, and nothing is stored that
   * was not decided by someone.
   */
  shelf_life?: ShelfLife;
}

type ShelfLife = 'volatile' | 'normal' | 'durable' | 'permanent';

interface Neuron {
  // ...existing sidecars (entry_dates, entry_status, entry_source)...
  /**
   * Last verification of decisions, patterns, errors and debts, keyed by
   * entryId(text) like the other sidecars. Same reasons as entry_dates: the
   * arrays keep their element type and every reader keeps working.
   */
  entry_verified?: Record<string, string>;
}

interface Manifest {
  // ...
  /** First boot of a CRBRO that knows shelf life. See "legacy grace". */
  staleness_since?: string;
}
```

No field stores the inferred class or the computed age: both are derived at
read time from the neuron file recall already reads (section 5), so there is
nothing to keep in sync and no index change.

## 3. Classes, windows and defaults

Four values, chosen to be easy for a model to pick from the text alone:

| `shelf_life` | window (default) | meant for |
|---|--:|---|
| `volatile` | 90 days | versions, prices and plans, ports, hosts and IPs, URLs and paths, configuration values, who holds a role |
| `normal` | 365 days | any other fact |
| `durable` | 730 days | decisions, procedures (patterns), facts about how something is built that rarely moves |
| `permanent` | never | history: what happened on a day, a past incident, an id that cannot change |

**The windows are a policy choice, not a measurement.** Nothing in this
repository measures how long a port or a price stays true, and this document
does not pretend to. They are set so that `volatile` flags something within a
quarter and `normal` within a year; they can be changed per machine with
`CRBRO_SHELF_DAYS="volatile=90,normal=365,durable=730"`, and the whole feature
switched off with `CRBRO_STALENESS=0` (recall then answers exactly as 2.8).

### Default by kind

| kind | default class | settable? | clock |
|---|---|---|---|
| fact | inferred: `permanent` when the miner imported it or it is a dated record of something done (2.9.1, §15); else from content, `volatile` if a rule below fires, else `normal` | yes, `shelf_life` on crbro_learn | `verified ?? added` |
| decision | `durable` | no | `entry_verified[id] ?? date` |
| pattern | `durable` | no | `entry_verified[id] ?? entry_dates[id]` |
| preference | `permanent` | no | — |
| error | `permanent` | no | — |
| debt | `permanent` (maintenance already reviews debts by their revisit trigger) | no | — |
| map | out of scope (it has `updated`; see section 11) | — | — |

Preferences are never flagged: they change when the user says so, and a
recall that calls the user's own taste "possibly stale" is noise. Errors are
history. Only facts take the parameter, the same rule keywords follow:
facts are where values live, and one more parameter on every kind is one more
thing for a model to get wrong.

### Content detection (facts without `shelf_life`)

The default must work without the model's cooperation. The repository already
has the evidence that a parameter "expected on every fact" is often left out:
`keywords` needed a `keywords_missing` nag in the response to get filled in.
So an unmarked fact is classified from its text, by a small rule set in a new
module (`src/engine/shelf.ts`, pure, unit-tested), Spanish and English, the
same languages `dates.ts` reads:

| rule | fires on (examples) |
|---|---|
| version | `v2.3`, `Node 22`, `PostgreSQL 14`, `version 3.6`, `versión 5` |
| price | `29 €`, `$49`, `35 euros`, `per month`, `al mes`, `/mes`, `tarifa`, `price` |
| port / host | `port 8443`, `puerto 9090`, `:5432`, an IPv4, a hostname with a dot and a TLD |
| path / URL | `/etc/…`, `C:\…`, `~/…`, `https://…` |
| configuration | `KEY=value`, `set to`, `configurado a`, `flag`, `timeout`, `limit` with a number |
| person in role | `<role word> … is/es <Capitalised Name>`, role words such as contact, lead, manager, CEO, owner, responsable, contacto, encargado, jefe |

Rules are conservative on purpose: a false positive moves a current fact into
`possibly_stale` and costs a check; a false negative leaves a volatile value
unflagged — which is today's behaviour, not a regression. Before release the
detector is run over the repository's retrieval fixtures and the share of
facts it marks is **reported as measured**, not predicted here.

The class that applies is returned at save time (`shelf_life`,
`shelf_inferred: true`, `shelf_reason: "port"`), so a model that disagrees can
say otherwise in the same breath by learning the same text again with an
explicit value.

### Age, and the legacy grace

```
clock      = verified ?? added            (entry_verified / entry date for other kinds)
age_days   = floor((now − clock) / 1 day), never negative
stale      = class ≠ permanent and age_days > window(class)
```

- **No date, no flag.** A fact with no parseable `added` and no `verified`, or
  a pattern with no `entry_dates`, is never marked stale for lacking a date.
  It cannot prove it is old any more than it can prove it is recent.
- **Legacy grace.** The first boot of this version stamps
  `manifest.staleness_since`. A fact that has no `verified`, no explicit
  `shelf_life`, an inferred class other than `volatile`, and an `added` before
  that stamp, has its clock start near the stamp instead. The bulk of an old
  brain therefore does not turn "possibly stale" on upgrade day. *(Revised
  after review, see §13: starting every such line at the stamp itself only
  moved the flood to one later day; each line now starts up to half a window
  before the stamp, by a fixed share of a hash of its text.)* **Volatile facts get no grace**: a port saved five
  months ago deserves the warning on the first recall that serves it, which is
  exactly the case the feedback is about. *(Revised in 2.9.1, §15: in a
  brain that predates shelf life, inferred-volatile facts get the staggered
  grace too; a fact marked volatile by hand still gets none.)* Decisions and patterns get the same
  grace (they are `durable` by kind). The stamp is one field in a file boot
  already writes (`last_boot`); no neuron is touched.
- A recorded date in the future counts as age 0. A **check** dated more than
  a day ahead of this machine's clock counts as no check at all (§13): with
  "latest wins" it would otherwise pin the line as fresh until that day.

## 4. Marking at save time — `crbro_learn`

One new optional parameter, facts only, documented in its own `.describe()`
so the tool description stays short:

```ts
shelf_life: z.enum(['volatile', 'normal', 'durable', 'permanent']).optional()
  .describe('Facts only: how fast this value goes stale. volatile = versions, prices, ports, hosts, paths, config, who holds a role; durable = rarely moves; permanent = history that cannot change; normal otherwise. Omitted: inferred from the text, and returned.')
```

- New fact: stores `shelf_life` only if given. The response always carries the
  class that applies (`shelf_life`), plus `shelf_inferred: true` and
  `shelf_reason` when it was inferred.
- Exact-duplicate fact (the existing branch that merges keywords): a given
  `shelf_life` different from the stored one replaces it
  (`updated_in_place: true`). *(Revised, §13: such a call is an edit and does
  not reconfirm; only a bare repeat does, section 5.)*
- Ignored, with no error, for other kinds — the same as `rationale` today.

## 5. Reconfirming

Two paths, and only two. Reading is not checking: neither recall nor inspect
ever touches `verified`.

1. **`crbro_revise status=verified`.** The existing `status` enum gains a
   fourth value. With `facts` (ids or exact text) it stamps `verified = now`
   on **active** facts; with `entries` it stamps `entry_verified` on live
   decisions and patterns. A retired target is not verifiable and comes back
   in `unmatched` with the reason (reactivate it with `status active` first,
   if it holds again). `note` is ignored for this status. Response:
   `verified: [ids]`, `unmatched`. This is the call the `possibly_stale`
   block points at when the check says "still true".
2. **Learning the exact same text again**, with nothing else in the call,
   stamps `verified = now`, in the same branch that already merges keywords
   and counts `confirmations`. *(Revised, §13: a re-learn that also brings new
   keywords, a confidence or a class edits the line and does not reconfirm,
   and the `verify` op goes out once per line per session.)* The model
   that re-states a fact it just read from the source has, in effect, checked
   it. Exceptions: the **miner** never reconfirms (re-reading an old transcript
   is not a check — the same rule that keeps it out of `confirmations`), and a
   retired line is still refused with `skipped_retired`.

When the check says the value **changed**, nothing new is needed:
`crbro_learn` the new value with `supersedes=[id]`, as today.

`confirmations` stays what it is (a count of witnesses, local only). The two
fields answer different questions: how many times, and how recently.

## 6. How recall returns it

### Partition, not penalty

Ranking does not change. After `materializeResults` has picked the top
`limit` rows exactly as 2.8 does, each row is judged on its **winning entry**
(the best content chunk; the header chunk is identity and is never stale):

- winning entry current → the row stays in `results`;
- winning entry past its shelf life → the row moves, whole, to
  `possibly_stale`, keeping its rank order.

No backfill: the rows that move do not free slots for lower-ranked rows. Cost
stays bounded by `limit`, and the answer to "what does memory say about X"
never silently becomes a weaker line about something else. A row is never
re-headed with a current `also_matched` line either: the next-best line of a
neuron often does not answer the question, and promoting it would serve the
wrong answer with a clean bill of health.

Each `possibly_stale` row is the same object as a `results` row plus:

```json
{
  "age_days": 214,
  "last_verified": "2026-03-04",
  "shelf_life": "volatile",
  "shelf_inferred": true
}
```

`last_verified` is the day the clock runs from (the `verified` stamp, else the
entry date). The next step is said **once**, in `hint`, not per row:

> possibly_stale: these matched but are past their shelf life since last
> verified. Before relying on one, check it against its source (a file, the
> config, the user) when that is cheap: still true → crbro_revise
> status=verified facts=[entry_id]; changed → crbro_learn the new value with
> supersedes=[entry_id]. If you cannot check, say how old it is.

When `results` is empty and `possibly_stale` is not, the hint leads with
"Nothing current matched" so the block is not mistaken for no answer.

### `also_matched`

Previews keep their place under their row. A preview past its shelf life
carries `stale_days: N` (its age); nothing moves. They are pointers, not
answers, and splitting them out would cost more tokens than it saves.

### Filters and the rest of the payload

- `since` keeps its meaning (*recorded* on or after) and still filters on the
  indexed date; `verified` is not in the index. A reconfirmed old fact is not
  "new". Documented in the parameter, not changed.
- `kind`, `domain`, `queries` work as before; the partition runs after them.
- `sessions_matched` (day logs) is never partitioned: a day log is history.
- `fitToBudget` sees `possibly_stale` as part of the payload, so the token
  ceiling still holds.
- `outputSchema` gains `possibly_stale` (array of the row shape, loose) and
  `possibly_stale_count`.
- Kill switch: with `CRBRO_STALENESS=0` there is no partition and no new
  field.

### Server instructions

One sentence added after the recall paragraph: "A recall's possibly_stale
holds what may have changed since it was last checked: verify it against its
source before relying on it, then crbro_revise status=verified or crbro_learn
with supersedes." This is a product change and is measured as such: the
`after` run must still pass the four original thresholds (U5 in the
pre-registration).

## 7. inspect, boot, maintenance, consolidate

- **`crbro_inspect view=neuron`**: each entry row gains `verified` (day) when
  present, `shelf_life` when explicit, and `stale_days` when past its window —
  the same three facts recall shows, so the index of a neuron and a recall
  never disagree. `entries=[ids]` returns the same fields. `view=status` gains
  `staleness: { enabled, windows, since }`.
- **`crbro_boot`**: no per-entry staleness. Boot loads context for every topic
  at once; flagging old ports of projects nobody is touching today is the
  flood this design avoids. `memory_discipline` gains one line: "possibly_stale
  in a recall = verify before relying on it".
- **`crbro_maintenance`**: every run reports `stale_entries` (count) and
  `stale_sample` (the most overdue 10: neuron_id, entry_id, kind, shelf_life,
  inferred, last_verified, age_days, preview) with a note on how to reconfirm
  or supersede. Read-only like `expired_entries`; it never writes. The two
  reports can name the same entry (a fact that names a passed day and is
  also old); they answer different questions and are kept apart.
- **`crbro_consolidate`**: unchanged.
- **`move_to`, `merge_into`**: carry `verified`, `shelf_life` and the
  `entry_verified` key with the entry, like dates and keys today (`copyFact`
  already spreads every field; the sidecar needs the same handling as
  `entry_dates`).

## 8. Team spaces

The new fields must merge with meaning between machines.

- **`verified` travels as a new op kind**, `verify`
  (`{ op: 'verify', nid, eid, ekind: 'fact' | 'entry', at, by }`), emitted by
  `crbro_revise status=verified` and by a reconfirming re-learn on a shared
  neuron. Merge: **the latest `at` wins** over every machine's ops and the
  local value. A later check is newer evidence; there is nothing to vote on. A
  teammate's check restarts my clock too: the fact is shared, and so is the
  world it describes.
- **`shelf_life` travels in `FactOp`** as an optional `shelf` field, only
  when explicit. Merge: **the most volatile explicit value wins**
  (volatile < normal < durable < permanent). The costs are asymmetric: a
  needless warning costs one check; a missing one costs a wrong answer.
  Consequence: lengthening a shared fact's shelf life does not hold. *(Revised,
  §13: the first version of this text said it "stays local"; in fact the
  older, more volatile op stays in the append-only log and the next sync
  restores it on every machine, the one that lengthened it included. learn
  says so in `shared_warning`.)*
- **`entry_verified`** is rebuilt from `verify` ops with `ekind: 'entry'`, and
  pruned with the other sidecars when an entry leaves.
- **Compatibility.** `OPS_VERSION` stays 1, as in 2.0 when purge kinds were
  added: a 2.8 client reads the line (v ≤ 1), finds an op kind it does not
  know and skips it; it ignores the unknown `shelf` field on `FactOp`.
  Degradation (the verification does not reach that teammate), never
  corruption. A 2.8 client that rewrites a neuron keeps unknown fact fields,
  because it mutates the parsed objects in place.
- `confirmations` stays local, as documented in 2.7.

## 9. Compatibility with existing brains

- Every field is optional; absent fields mean "inferred" and "never
  re-checked". Nothing is written to a neuron until a learn or a revise
  touches it; the only new write at boot is one manifest field.
- Facts without dates are never flagged for lacking them.
- The legacy grace keeps an old brain from flipping to "possibly stale" on
  upgrade day, except for volatile facts, which are the point.
- The search index is untouched: no `INDEX_VERSION` bump, no rebuild. Shelf
  and verification are read from the neuron file that `materializeResults`
  already loads for every candidate row.
- An older CRBRO reading a newer brain ignores the fields and behaves as 2.8.

## 10. Risks

| risk | how it is contained | what would show it failed |
|---|---|---|
| **Flooding with warnings** — every recall half "possibly stale", users learn to ignore the block | per-recall cost bounded by `limit`; legacy grace for non-volatile facts (2.9.1: for inferred-volatile ones too in a brain that predates shelf life, and dated records and miner lines are history, §15); conservative detector; preferences and errors never flagged; kill switch | maintenance `stale_entries` on a brain after upgrade, reported as measured. *Not* U5: the twelve original facts are seeded fresh and none can pass its window, so U5 cannot see false warnings (§13, limits of the benchmark) |
| **Agents stop answering** — a stale row read as "no answer" | rows are moved, not hidden; the hint says "nothing current matched" and how to proceed; the original `memory` + `stale` thresholds must still pass | U5 in the pre-registration |
| **Hedging instead of checking** — "it was 14, maybe" | the hint names the cheap checks first; the scorer counts a hedged old value apart from a bare one | `hedged` outcome in `stale-unmarked` |
| **Ranking cost** | none by construction: the partition runs after ranking, on rows already materialised; one map lookup per row | the deterministic retrieval benchmarks must give identical numbers with the feature on (they run on fresh fixtures) |
| **Token cost** | moved rows replace rows, they do not add to them; four short fields per moved row; one hint sentence | the cost columns of the agentic results, before vs after |
| **Tool descriptions over 1,000 characters** (recall is at 999 today) | the new behaviour is described in parameter `.describe()`s, the hint and the instructions; recall's description is rewritten to 962 characters by dropping two clauses that live elsewhere (the default of five is in `limit`, "before crbro_learn" is in learn's own description, `matched_neurons` in the output schema); learn 957 → 930, revise 841 → 932, measured on the candidate texts | `tests/tool.definitions.test.ts` |
| **False freshness** — `verified` only means someone said they checked | documented; the miner can never set it; a re-learn that edits the line (keywords, class, confidence) does not set it; a check dated in the future is ignored; a teammate's check is visible as a `verify` op with its author | — |
| **Detector false positives on prose** | rules require a number or a role pattern next to the trigger word; unit tests with negatives | detector share on fixtures, reported before release |

## 11. Out of scope

- Maps: a map has `updated` and is replaced whole; a stale map is a real
  problem, but a different design (it is prose, not a value).
- Automatic verification: CRBRO never reads the user's files or network to
  check a fact. It says what is old; the agent decides whether to check.
- Per-neuron or per-domain windows.
- Changing ranking by age beyond the existing recency weight.

## 12. How it will be judged

- Deterministic tests (to be written with the implementation): detector rules
  and negatives; age and grace arithmetic; recall partition and hint; revise
  `status=verified` on facts, entries, retired targets; re-learn reconfirms,
  miner does not; sync merge of `verify` ops (latest wins) and `shelf` (most
  volatile wins) in both replay orders; a 2.8-shaped brain loads and recalls
  unchanged with the feature on; descriptions under 1,000.
- The agentic case `stale-unmarked`, pre-registered with its thresholds before
  any run, measured on the 2.8.0 build (`before`) and on this branch
  (`after`) with the same harness: see the amendment of 2026-10-04 in
  [PREREGISTRO.md](../../benchmarks/agentic/PREREGISTRO.md).

## 13. Implementation notes

Where the code on this branch differs from, or adds to, the text above:

- **`age_counted_from`.** Section 6 says `last_verified` is "the day the clock
  runs from (the verified stamp, else the entry date)". Under the legacy grace
  those two are different days, and reporting the grace stamp as a
  verification would claim a check nobody made. So `last_verified` is always
  the real verified-or-recorded day, `age_days` counts from the clock, and a
  row under grace also carries `age_counted_from` (the stamp's day).
- **No stamp yet.** A recall on a brain that has not booted this version yet
  (no `staleness_since`) treats the stamp as "now": full grace, never a flood.
  Volatile facts are judged as usual.
- **Protocol neurons are never judged** (recall, inspect), as maintenance's
  reviews already skip them: their facts are standing instructions, not values
  about the world.
- **Counts.** `total_results` counts the rows left in `results`; `returned`
  adds `possibly_stale`; `possibly_stale` and `possibly_stale_count` appear
  only when the block is not empty, so a fresh answer carries no new field.
- **revise status=verified** also returns `retired_targets: [{ target, id,
  status }]` beside `unmatched`, which is where "comes back with the reason"
  lives. `entries` accept the entry id as well as the exact text (the hint
  points at `entry_id`). Preferences, errors and debts are unmatched: they
  never go stale, so there is nothing to reconfirm.
- **Detector share, measured** (`detectShelf` over the retrieval fixtures):
  25 of 48 facts of `fixture.json` (a project brain of versions, prices and
  hosts), 3 / 494, 3 / 494 and 0 / 494 in the three personal-prose haystacks.
- **Descriptions, measured on the final text:** recall 964, learn 968, revise
  946 characters (learn 973 after the review changes below).
- **Retrieval benchmark** (`node benchmarks/retrieval/run.mjs`, keyword engine)
  gives, with the feature on, the numbers published for the keyword engine
  (measured on 2.7.2): recall@1 77%, recall@3 83%, MRR 0.806. The ranking does
  not read shelf life at all; the partition happens in the server.

### Changes after review (2026-10-04, before the `after` run)

Two reviews of the implementation (compatibility and teams; benchmark
integrity). What was changed in the code, each with a test:

- **A check from the future no longer sticks.** A `verify` op (or a stored
  `verified`) dated more than a day ahead of this machine's clock counts as no
  check: `latestOf` ignores it in every merge (materialize, `unionNeuron`) and
  the age runs from the recorded date. Before, a teammate with a clock set to
  2099 pinned the line as fresh until 2099 and no real check could replace it.
- **Lengthening a shared fact's class is said, not promised.** The text that
  said it "stays local" was wrong (§8). `crbro_learn` now returns
  `shared_warning` when a less volatile explicit class replaces a more
  volatile one on a shared neuron.
- **The legacy grace is staggered.** Starting every old line at the stamp only
  delayed the flood to one day (365 days after the stamp for normal facts, 730
  for decisions and patterns). Now each line's clock starts
  `min(stamp - recorded, window/2 x share)` before the stamp, where `share` is
  a fixed value in [0, 1) from an FNV-1a hash of the line's text
  (`spreadOf`): deterministic, the same on every machine, nothing stored. On
  the stamp day nothing is due (at most half a window has elapsed); an old
  brain's lines come due spread evenly over the second half of the first
  window. The rule keeps no "oldest first" order: before the stamp nobody
  checked any of them, so the order among them carries no information.
- **The daemon fingerprint** includes `CRBRO_STALENESS` and `CRBRO_SHELF_DAYS`
  (normalized, and only when they differ from the defaults), so a client that
  switched the feature off is not served by a daemon that has it on.
- **One `verify` op per line per session.** Re-learning the same fact again
  and again in one session stamped and emitted every time; on a shared neuron
  each one was a line in the team's log, which is never compacted.
- **Legacy facts with two hashes.** The first share names a fact without id
  by `entryId(text)` (normalized), learn and revise name its check by
  `factId(text)` (raw); with a double space or non-NFC text they differ and
  the check was dropped on the teammate. Materialize now resolves both.
- **The stamp does not drift.** `updateManifest` wrote the whole cached
  manifest and could erase `staleness_since` (a cache older than the first
  boot of this version); it now keeps the earliest stamp of disk and cache,
  and boot restores one that an older CRBRO dropped while this process knew it.
- **The best match is never hidden behind another entity.** When the
  top-ranked row moves to `possibly_stale`, `results[0]` is a lower-ranked
  row, sometimes about something else (reproduced on the benchmark brain: a
  question about Pelícano's price showed another product's 49 € at the head of
  `results`). Every row now carries `rank` when anything moved, and the hint
  opens with "The best match (rank 1) moved to possibly_stale; results holds
  lower-ranked rows that may be about something else."
- **A re-learn that edits is not a check.** `keywords_hint` asks the agent to
  call learn again with the same text to add keywords, and that call stamped
  `verified`: an old line left `possibly_stale` without anyone looking at the
  source. Now only a bare repeat (no new keywords, class or confidence)
  reconfirms. The learn description says "a bare repeat counts as
  re-verified" (973 characters).

Deviations from the tables above that the first version of this section left
out:

- **Detector rules broader than the table in §3.** `port` accepts the number
  up to 20 characters after the word (`el puerto se movió al 2299`).
  `config` also fires on a snake_case key followed by a number
  (`memory_limit de 512M`), on `fijado/establecido en` plus a number, and on
  `max`, `máximo`, `mínimo`, `retries`, `umbral` and similar within 25
  characters of a number. `es` was taken off the list of versioned products
  (it fired on Spanish "es 3"). Known false positives of the broad `config`
  rule: "Antonio entrena como máximo 3 días por semana." and "Prefiere un
  máximo de 2 reuniones al día." come out volatile. Left as is for now (a
  false positive costs one check); a technical context (a key or a unit)
  would be the next restriction to try.
- **The detector share is in-sample.** The rules were widened after reviewing
  what they caught on `fixture.json`, and the 25 of 48 reported above was
  measured on that same fixture afterwards.
- **Recall's description** also lost the clause "Retired entries never
  surface" to stay under 1,000 characters; revise's description already says
  retired lines leave recall.

Limits of the agentic benchmark, to be said with any result:

- **U5 cannot detect a flood of warnings.** The twelve original facts are
  seeded with today's date, so none can pass its window; no task has an old
  value that is still true. A detector that flagged every old line would pass
  the benchmark exactly as well. The cost of false warnings (turns,
  abstentions, hedging on true values) is not measured.
- **u3 and u4 match the detector's own examples.** The rules and the four
  task texts were written by the same author in the same commit, and the table
  in §3 lists `PostgreSQL 14` and `puerto 9090`. That u3 and u4 are flagged
  without a mark shows the detector recognises its own examples, not that it
  generalises.
- **Denied writes in `after`.** The `possibly_stale` hint tells the agent to
  call `crbro_revise` or `crbro_learn` after checking; the cells only allow
  boot, recall and inspect, so those calls are denied and cost turns. They are
  counted from `tool_calls` when the results are published.
- Planned for the next amendment, pre-registered before it is measured: old
  but still-true controls (a volatile fact 200 days old whose value matches
  the file), a mixed query with an unrelated old row, and unmarked tasks
  written by someone else.

## 14. Iteration 2: how the warning reaches the agent

Status: implemented on `feat/staleness` and **measured: not met** (see
"Result" at the end of this section). It was judged by the Sixth amendment of
the pre-registration (a second `stale-unmarked` case, its tasks and
thresholds committed before this change, its `before` run on 2.8.0 committed
before this change too). One iteration, then 2.9.0 ships with whatever that
run says.

### Why

The Fifth amendment's `after` runs showed the detection working and the
behaviour unchanged: recall moved all four rows to `possibly_stale`, and in 48
`after` cells no agent with CRBRO opened a file. Three candidate causes, none
measured on its own:

1. **The order to check came last.** It sat at the end of `hint`, after the
   generic advice every recall carries ("weak: verify. Newer wins on
   conflict…"), in a field that comes after the rows.
2. **The old value looked like an answer.** A `possibly_stale` row carried the
   stored line as `matching_content`, the same key a current answer uses, next
   to `confidence: strong`. The only difference was a block name and an age.
3. **The prompt asks for the bare value** ("solo con el dato y nada más").
   "If you cannot check, say how old it is" competes with that, and checking
   was never framed as the way to answer the question.

### What changes

Presentation only. Detection, windows, grace, ranking and the partition are
untouched; a recall with nothing stale is byte-for-byte what it was.

- **`stale_warning` opens the answer.** When anything moved to
  `possibly_stale`, the first key of the payload (before `query` and
  `results`) is one or two sentences: how many rows, whether the best match is
  one of them, the youngest age, "Do not answer with it as current. Check it
  first (its next_step says where); if you cannot, say it may be out of date,
  even in a short answer."
- **A stale row is a last-known value, not content.** Each `possibly_stale`
  row now leads with `warning` ("last known value, unverified for N days
  (since DAY): may have changed"), then `next_step`, then the stored line as
  **`last_known`**, which replaces `matching_content` in that block. Then the
  rest of the row as before (`neuron_id`, `name`, `entry_id`, `rank`, …,
  `age_days`, `last_verified`, `shelf_life`, `shelf_inferred`). The rename
  breaks no released client: `possibly_stale` has never shipped. `results`
  rows keep `matching_content`.
- **`next_step` names what to open, when the line names it.**
  `src/engine/source.ts` (`namedSources`, pure) finds the files, paths, dotfiles
  and URLs a line cites (`config/app.yml`, `.env.production`, `precios.json`,
  `/etc/…`, `C:\…`, `https://…`), and rejects ratios and units (`km/h`, `24/7`,
  `€/mes`, `and/or`), product names (`Node.js`) and bare hosts (a host is the
  value, not where it came from). With a source: "Before answering, open X
  (named in this entry) and answer with what it says now." Without one:
  "Before answering, look for the current value where it lives: the project's
  files or config if you can read them, or the user." Both end with "If you
  cannot check, say this value is from DAY and may be out of date; do not
  state it as current." CRBRO still never reads the disk to check (§11).
- **The hint gives the order first.** The stale part now follows the
  "Nothing current matched" / "The best match (rank 1) moved" lead directly,
  before the generic advice, and says: do not answer with one as current;
  check it first; then revise or learn; if you cannot check, say it may be out
  of date (replacing "say how old it is").
- **The same sentence everywhere the agent reads.** The server instructions
  ("A row in a recall's possibly_stale is a last-known value that may have
  changed: before answering with it, check it where it lives … never state it
  as current"), boot's `memory_discipline`, and recall's description
  ("possibly_stale as last_known with a next_step: check before answering with
  one, or say it may be out of date").
- **Saving says where a value came from.** `crbro_learn`'s description ("A
  value that can change names its source (file, key, URL, person).") and its
  `content` parameter ask that a changeable value carry its source, so a later
  `next_step` has something to point at. To stay under 1,000 characters the
  learn description lost "(one call does both)" after `supersedes` (the
  lifecycle text in boot still says it), "and totals", and two clauses were
  tightened. Measured on the built server: recall 993, learn 983, revise 946.
- `outputSchema`: `stale_warning` (optional string); the `possibly_stale` item
  requires `warning`, `next_step`, `last_known`, `neuron_id`, `age_days`,
  `last_verified`, `shelf_life`, `shelf_inferred` (loose, as before).

### Considered and not done

- **A separate text block before the JSON.** Tools with an `outputSchema`
  return the serialized `structuredContent` as their text content; a second
  block would be a shape no other tool has. Key order does the same job in
  one block, and the same order holds in `structuredContent`.
- **Hiding the old value.** When checking is impossible, the agent needs it to
  say "last known X, may be out of date"; hiding it would turn the case into
  an abstention and lose what the memory does know.
- **Dropping `confidence: strong` from stale rows.** It is the match quality,
  not a claim that the value holds; it stays, after the warning.

### What the author of this change knew

Said here because the next `after` run is not blind in the sense the Fifth
amendment's dated note used:

- The brief for this iteration contained the Sixth amendment's summary of its
  tasks — subjects, old and current values, ages, which stored lines name a
  source and which file holds each current value — and the per-task outcomes
  of the `before` runs on 2.8.0. While locating the Pelícano tasks in
  `tasks.json`, a search also printed the prompts and expected values of the
  new tasks. The new case's seed block and world files were not opened.
- Two parts of this change touch that knowledge directly. `namedSources` was
  one of the ideas in the brief, but the author knew one judged task stores a
  line that names its file. "Even in a short answer" answers a cause the
  author knew is in every prompt (the suffix). Neither was tuned against a
  model answer: no model was run on this build before the commit.
- The unit tests use subjects and values that are not in any benchmark task,
  with three echoes (corrected 2026-10-04, after review and before the
  `after` run): a negative example in `tests/staleness.framing.test.ts`
  ("Lo dijo Antonio en la reunión del lunes", next to an `api.example.com`
  line) echoes how w4's stored line gives its source; `tarifas.json` in the
  same file is close to w2's `tarifas.csv`; and the examples in
  `src/engine/source.ts` and in this section name `.env.production`, w4's
  world file. All three are in comments, tests or docs: none of them is in
  any text the server sends to the agent, and `namedSources` is generic.

### Limits

- The Sixth amendment's `after` run is the measurement, published as it came
  out, with no second run (result below).
- `next_step` can only name what the line names. A line saved without its
  source gets the general step; the learn text asks for sources, which helps
  lines saved from now on, not the ones already stored.
- The causes above are not separated: if the run improves, it does not say
  which of the changes did it.
- **What this change can reach in the Sixth amendment's tasks** (dated
  2026-10-04, written after review and before the `after` run, from a
  model-free check: the case brain seeded as `run.mjs` seeds it, this build,
  `crbro_recall` called with each task's prompt). Only **w2** (160 days,
  `volatile`) and **w4** (300 days, `volatile`) reach `possibly_stale`, with
  `stale_warning`; among the secondary tasks, k2 (180 days, `volatile`) too.
  **w1** (230 days), **w3** (270) and **w5** (130) carry no mark and are
  inferred `normal`; **w6** (200) is marked `normal`. All four are under the
  365-day window, so recall serves them in `results` as current values, with
  no warning: this change cannot affect 12 of the 18 judged `crbro` cells per
  model, and U1 (≥ 14/18) and U2 (≤ 1/18) can only pass if the agent opens
  the file on its own, which no `crbro` cell did in the `before-b` runs (0 of
  24 per model). The amendment assumed (its line on ages "between 90 and 365
  days") that unmarked lines would be inferred `volatile`, as u3 and u4 were;
  these are not, and it flagged only w6. `namedSources` fires on no judged
  row: the one line that names its file (w1, `config/notificaciones.yml`) is
  never flagged, and w2 and w4 get the general `next_step`. Nothing in
  detection, the windows or the inference rules is changed for this: doing it
  now would be tuning on tasks already seen. The `after` run goes ahead as
  pre-registered, and its results are also given per task, split into flagged
  (w2, w4) and unflagged (w1, w3, w5, w6) — a description, not a new
  threshold.

### Result (2026-10-04)

Build `a2bffef` (this change plus the dated note above, `dirty: false`),
one `after-b` run per model, Claude Code 2.1.270, n=3, canaries clean, no
leaks, no API errors. On the judged tasks (w1–w6, 18 `crbro` cells per
model), against the 2.8.0 `before-b`:

| `crbro` | haiku before → after | sonnet before → after |
|---|---|---|
| correct | 0 → 1 | 0 → 0 |
| old value, no warning | 14 → 9 | 18 → 12 |
| old value, with a warning | 0 → 0 | 0 → 6 |
| abstains | 4 → 8 | 0 → 0 |
| `baseline` correct | 4 → 6 | 10 → 9 |

U1, U2 and U3 fail in both models; U4 and U5 pass. The claim is not made.
As the note above predicted, every change is on the two flagged rows: there
the old value given as current went 5 → 0 (haiku: abstains; the one correct
answer is the one cell that opened a file) and 6 → 0 (sonnet: answers with a
warning). The four unflagged rows gave the same answers before and after.
So the presentation changes what the agent *says* about a flagged value; it
does not make it *check*, and the detector missed four of six values that
changed. On the old-but-true controls, sonnet stays 6/6 and now adds "may be
out of date" to the volatile one; haiku abstains on it, as on 2.8.0. Full
tables, per task, in the pre-registration.

## 15. 2.9.1: the noise a real brain showed

### What was measured

On 2026-10-04, the 2.9.0 code (`factStaleness` and `entryStaleness` from
`dist/`, run by a read-only script that never loaded `Brain` and wrote
nothing) was run over one real personal brain with the stamp set to that
day. Only counts are reported here; no text from that brain is in this
repository.

- 4,858 active entries; **810 flagged on the first day (17 %)**, every one an
  inferred-`volatile` fact and none graced. By rule: url 347, host 135,
  version 123, price 66, path 55, port 54, config 30.
- Read by hand, most of them were not values that may have changed. 336
  were notes a miner had imported — agent checklists of the shape
  "- x Navigate to https://…" — and a large share of the rest were **dated
  records of something done**, of the shapes "FIX <what> (<dd-mmm-yyyy>)",
  "FASE <n> completada (<mmm yyyy>)", "<yyyy-mm-dd>: VERIFICADO que …",
  "RECHAZO <store> v<x.y.z> (<dd mmm yyyy>)". They do not go stale: they tell what happened, and
  they carry their own date.
- The statements of state that should warn (a service on a localhost port,
  a plan's yearly price, a minimum version) were a minority, buried.

### What changes

1. **A miner line never warns.** A fact with `source: "miner"` and no
   explicit `shelf_life` is `permanent`, inferred, with
   `shelf_reason: "miner"`. An imported note is a copy of something written
   elsewhere, at some other time; it was never this memory's claim about the
   present. An explicit `shelf_life` still wins, and the same text learned by
   a session is judged by its content as before. Once a session has said a
   miner line too — learn's duplicate branch sets `verified`, or adds a
   second confirmation — it is no longer only an imported note and is judged
   by its text from then on (`source` stays `"miner"`; the decision reads
   `verified` and `confirmations`, which already travel in a team's log).
2. **A dated record of something done is history.** An unmarked fact whose
   head reads as one is `permanent`, inferred, `shelf_reason: "history"`. The
   rule, in full in `src/engine/shelf.ts` (`isDatedRecord`), works on the
   line's *head* — its text up to the first sentence end or line break:
   - the head names a date (2026-06-18, 18/06/2026, 18-jun-2026, 18 de junio
     de 2026, jun 2026, June 18, 2026; a day and a month without a year
     count);
   - it has a word of finished action: a Spanish participle (completado,
     implementada, resueltos, desplegado, publicado, verificado, corregido,
     migrado, creado, añadido, rechazado, medido…), an unambiguous Spanish
     preterite ("desplegó", "migró", "se publicó"), an English past form
     (fixed, deployed, released, completed, verified, migrated, checked…), or
     an event noun (fix, hotfix, rechazo, incidente, outage, release,
     ejecución);
   - and nothing in the head turns it back into a statement of state: a
     date that opens a period ("desde el 18-sep", "since", "a partir de",
     "as of", "from", "hasta", "a 4-oct"); a word of the future or of a
     deadline (will, planned, previsto, programado, pendiente, caduca,
     expires, vence, renews, next, "para el <date>", "by <date>" — "tarea
     programada" and "scheduled task" name a kind of job and do not count);
     a word of the present (actualmente, currently, current, actual, ahora,
     now, todavía, still, vigente, último, last, latest); or a verb of state
     *before* the first finished-action word ("la API corre en el puerto
     8443, desplegada el 2026-06-18" is a port that also says when it went
     up);
   - and, when the head carries a changeable value (a volatile rule fires on
     it once its dates are blanked), nothing in it says that the value holds
     (added after review, below): a verb of state anywhere in the head, or
     pasa a, queda, sigue, devuelve, responde, abierto, becomes, returns —
     quoted titles and asides in parentheses aside; a check (verificado,
     comprobado, confirmado, probado, medido, detectado, verified, checked…)
     with a value other than a bare domain *before* it ("Puerto 9443
     verificado el …", "Plan: $499/año (confirmado …)"); a move (migrado,
     desplegado, instalado, migrated, deployed…) followed within four words
     by a/al/en/to/into/on/at and a port, host, URL or path ("se migró el
     panel al puerto 9443", "Deployed to https://…"); or a schedule ("diaria
     03:00", "cada lunes", "every day").

   Words that bring a new current value without telling an event —
   actualizado, cambiado, configurado, renovado, updated, changed, set — are
   deliberately not finished-action words. Cerrado, aprobado, completo (as an
   adjective outside a kind of work: "FASE 4 COMPLETA" and "Auditoría
   completa" are events), medida, closed, approved and complete also describe
   a state, so they count only in a head with no changeable value: "Tanda
   CERRADA el 21-sep-2026" is a record, "Presupuesto aprobado (…): 1.200 € al
   mes" and "Lista completa de precios (…)" are not. A line without a date is
   never history, however past its verbs: it cannot show its age. A numeric
   date glued to a word or a path ("/api/v1/12/24") is not a date, nor is
   the English modal "may" after a number ("Node 18 may be removed"); an
   abbreviated month with a period ("jun. 2026", "Sept. 18") does not end
   the head.

   Both sides are pinned in `tests/staleness.noise.test.ts` with invented
   examples: records that become history, and dated statements of state
   that stay volatile ("Desde el 18-sep el panel escucha en el puerto 9443",
   "A 4-oct el precio es 35 €", "Comprobado el 4-oct-2026: cuesta 35 €",
   "2026-06-18: VERIFICADO que el puerto es 9443", "Migrado el panel al
   puerto 9443 (18-sep-2026)", "Fix (4-oct-2026): el webhook apunta a
   https://…", "Since 2026-09-18 … port 9443 (migrated)", "… renovado el
   2026-01-03; caduca el 2027-01-03", "Último despliegue: v2.2.0, publicado
   el …"). `recordVerdict` returns the rule that decided, for diagnosis.
3. **Legacy brains: inferred-volatile facts get the grace too.**
   `StalenessContext.legacy` is true when the brain predates shelf life:
   its manifest is not stamped yet, its `created` cannot be read, or the
   stamp came more than a minute after `created` (`initialize()` writes both
   in the same call; an upgrade stamps at the first boot of a new version,
   days or months later). There an unmarked line that the detector infers
   volatile, never verified and recorded before the stamp, starts its clock
   up to half a window (45 days) before the stamp, by the same fixed share
   of its text hash as every other graced line: on upgrade day nothing
   volatile is past its window, and the old lines come due spread over days
   46–91. A fact **marked** volatile by hand gets no grace, and neither does
   any line in a brain born stamped (a seeded, synced or imported old line
   there still warns at once — the agentic benchmark's seeded brains keep
   their 2.9.0 behaviour). Nothing new is stored: the decision is read from
   `created` and `staleness_since`, both already in the manifest
   (`stalenessContextOf`).
4. **`view=status` says the version the process runs.** `crbro_version` is
   read once, when the server module loads (`src/version.ts`). When the
   package on disk says another version — npx replaced the files under a
   running process, which on 2026-10-04 made an old process report the new
   version while it ran the old code — status adds `installed_version` and a
   `version_note` asking to restart the client. The version the MCP
   `initialize` reports is the running one too.

No tool, parameter or description changes; `shelf_reason` gains two values
(`history`, `miner`), visible in the `crbro_learn` response. Recall does not
show them: a permanent fact is never in `possibly_stale`, and its rows carry
no `shelf_reason`.

### Measured after the change

The same read-only pass, this branch's `dist/`, the brain's own `created`
(it predates shelf life; its manifest was not stamped yet), stamp = the day
of the run. The brain had changed by a few lines since the first pass.

| | flagged on the stamp day | +60 days | +91 days |
|---|--:|--:|--:|
| 2.9.0 | 806 of 4,860 | — | — |
| fix 2 alone (no legacy grace) | 695 | — | — |
| 2.9.1 (fixes 1–3) | 0 | 289 | 1,318 |
| fix 2 alone, after review | 701 | — | — |
| 2.9.1 after review | 0 | 302 | 1,353 |

851 facts read as history before the review, **816 after it**: the review's
state vetoes moved 43 lines back to a volatile class and its other changes
(the "es" of a domain is no longer a verb, an abbreviated month no longer
ends the head) moved 8 in. Read one by one, about 38 of the 43 are
statements of state ("… ya sirve la versión nueva", "los sitemaps devuelven
404", "la confirmación de email YA ESTÁ ACTIVADA", "solo queda publicada …
en https://…") and about 5 are records with a side clause, which now warn
(Limits). Of the 806 lines 2.9.0 flagged on the stamp day, 105 never warn
again (all history) and 701 are postponed by the grace. **The grace postpones; it does not reduce.**
Every inferred-volatile line comes due within one volatile window of the
stamp, as designed, and by then more lines have crossed 90 days than on
upgrade day. Of what is left, the largest group is still the imported
checklists, and **none of them carries `source: "miner"`**: the miner has
stamped its lines only since 1.5.x, these were mined before that and are
stored with `source: "session"`, so fix 1 does not reach them. They need
either a one-off re-marking of that brain or a rule for the shape of agent
checklists; neither is in this change, which keeps to the source the miner
writes.

On this repository's own texts — the retrieval fixtures and haystacks and
the agentic tasks, 2,425 strings (2,579 counted after review, the same
files read more widely; still one change, and none between the reviewed
and the final rule) — the history rule fires once (a migration
record in the retrieval set, `normal` before, so none of the volatile counts reported
for 2.9.0 moves), and no agentic task changes class. A model-free probe that seeds the agentic
benchmark's two unmarked blocks as `benchmarks/agentic/run.mjs` does (same
ageing, same T0) and runs each task's recall gives byte-identical output on
2.9.0 and on 2.9.1 after review: the same class for every fact and the same
11 rows in `possibly_stale`. Those brains are born stamped and their aged
lines carry `verified`, so the legacy grace does not reach them either.

The precision of fix 2 was checked by reading a random sample of the lines
it classifies on that brain: they were records (published posts, finished
phases, runs of scheduled tasks, fixes, verifications). The misses seen go
the safe way: a record with "pendiente" or "todavía" in its head stays
where 2.9.0 put it.

### Limits

- **The head decides.** "Migrado a Hetzner (3-oct-2026). El host es
  10.0.0.5." is history whole: details after the first sentence are not
  judged, and the record's own date is what tells the reader how old that
  host is. Equally, a head that is a statement of state is not rescued by a
  record later in the line.
- **A dated check of a value is the value.** "2026-06-18: VERIFICADO que el
  puerto es 9443" and "Puerto 9443 verificado el 2026-09-18" keep warning; a
  dated check with no changeable value in its head ("2026-08-11: VERIFICADO
  que la copia restaura sin errores") is history. A bare domain before the
  check does not count as the value: it is usually the site that was
  checked, so "Auditoría de garza.example.com verificada el …" is history.
- **A version is not a place.** "Instalado Node 20.11.0 en el servidor
  (3-oct-2026)" and "Migrado a PostgreSQL 16 el 3-oct-2026" are records of
  an upgrade and do not warn; a move to a port, host, URL or path does.
- **The state vetoes cost some records.** A record whose head also states
  something in a side clause ("FIX … (16-jun-2026): … los elementos son …")
  warns: on the brain below about 5 of the 43 lines the review fixes moved
  back to a state class were records of this kind. The miss is in the safe
  direction.
- **Lines the miner imports from project documents never warn**, READMEs with
  ports and URLs included, until a session says the same line. That is what
  fix 1 asks for; it is a limit for anyone who mines living documentation.
- Spanish and English only, like the rest of the detector. The word lists
  are short on purpose; a record they miss stays where 2.9.0 put it.
- Lines imported before the miner stamped its source are not recognised
  (above).
- `legacy` is read from `created`: a brain whose manifest was recreated
  after the upgrade (a restore that rewrote `created`) loses the grace for
  its volatile lines — the 2.9.0 behaviour, not a new failure.
