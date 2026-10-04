# Design: shelf life, last verification and `possibly_stale`

Status: **implemented on branch `feat/staleness`** (written against 2.8.0;
section 13 lists where the implementation differs from the text below). The
benchmark case that will judge it (`stale-unmarked`) is pre-registered in
[benchmarks/agentic/PREREGISTRO.md](../../benchmarks/agentic/PREREGISTRO.md)
in the same commit as this document, before any implementation or run.

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
| fact | inferred from content: `volatile` if a rule below fires, else `normal` | yes, `shelf_life` on crbro_learn | `verified ?? added` |
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
  that stamp, has its clock start at the stamp instead. The bulk of an old
  brain therefore does not turn "possibly stale" on upgrade day; it ages from
  then like anything new. **Volatile facts get no grace**: a port saved five
  months ago deserves the warning on the first recall that serves it, which is
  exactly the case the feedback is about. Decisions and patterns get the same
  grace (they are `durable` by kind). The stamp is one field in a file boot
  already writes (`last_boot`); no neuron is touched.
- A clock in the future (a teammate's skewed `at`) counts as age 0.

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
  (`updated_in_place: true`), and the line is **reconfirmed** (section 5).
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
2. **Learning the exact same text again** stamps `verified = now`, in the same
   branch that already merges keywords and counts `confirmations`. The model
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
  Consequence, documented like keyword unions today: lengthening a shared
  fact's shelf life stays local.
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
| **Flooding with warnings** — every recall half "possibly stale", users learn to ignore the block | per-recall cost bounded by `limit`; legacy grace for non-volatile facts; conservative detector; preferences and errors never flagged; kill switch | maintenance `stale_entries` on a brain after upgrade, reported as measured; a regression in the benchmark's `memory` tasks, whose facts are fresh and must never be flagged (U5) |
| **Agents stop answering** — a stale row read as "no answer" | rows are moved, not hidden; the hint says "nothing current matched" and how to proceed; the original `memory` + `stale` thresholds must still pass | U5 in the pre-registration |
| **Hedging instead of checking** — "it was 14, maybe" | the hint names the cheap checks first; the scorer counts a hedged old value apart from a bare one | `hedged` outcome in `stale-unmarked` |
| **Ranking cost** | none by construction: the partition runs after ranking, on rows already materialised; one map lookup per row | the deterministic retrieval benchmarks must give identical numbers with the feature on (they run on fresh fixtures) |
| **Token cost** | moved rows replace rows, they do not add to them; four short fields per moved row; one hint sentence | the cost columns of the agentic results, before vs after |
| **Tool descriptions over 1,000 characters** (recall is at 999 today) | the new behaviour is described in parameter `.describe()`s, the hint and the instructions; recall's description is rewritten to 962 characters by dropping two clauses that live elsewhere (the default of five is in `limit`, "before crbro_learn" is in learn's own description, `matched_neurons` in the output schema); learn 957 → 930, revise 841 → 932, measured on the candidate texts | `tests/tool.definitions.test.ts` |
| **False freshness** — `verified` only means someone said they checked | documented; the miner can never set it; a teammate's check is visible as a `verify` op with its author | — |
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
  946 characters.
- **Retrieval benchmark** (`node benchmarks/retrieval/run.mjs`, keyword engine)
  gives, with the feature on, the numbers published for the keyword engine
  (measured on 2.7.2): recall@1 77%, recall@3 83%, MRR 0.806. The ranking does
  not read shelf life at all; the partition happens in the server.
