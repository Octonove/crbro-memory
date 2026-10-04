# Changelog

All notable changes to CRBRO.

## [Unreleased]

Shelf life, less noise: what 2.9.0 flagged on a real brain was mostly not a
value that may have changed. Design and measurements in
[`docs/design/staleness.md`](docs/design/staleness.md) §15. Still 15 tools;
no parameter or description changes.

- **The noise it answers.** Run read-only over one real personal brain, 2.9.0
  flagged 810 of 4,858 active entries (17 %) on the first day, every one an
  inferred-`volatile` fact, none graced. 336 were notes a miner had imported
  (agent checklists with URLs) and a large share of the rest were dated
  records of something done. The statements of state that should warn were a
  minority among them.
- **A miner line never warns.** A fact with `source: "miner"` and no explicit
  `shelf_life` is `permanent`, inferred, `shelf_reason: "miner"`. An explicit
  `shelf_life` still wins. Lines mined before the miner stamped its source
  (1.5.x) are stored with `source: "session"` and are not reached by this.
- **A dated record of something done is history.** An unmarked fact whose
  first sentence names a date (2026-06-18, 18/06/2026, 18-jun-2026, jun 2026,
  June 18, 2026…) and a finished action (completado, desplegado, publicado,
  verificado, corregido, migrado, rechazado…, "se publicó", fixed, deployed,
  released, completed, verified… or an event noun: fix, hotfix, rechazo,
  incidente, release) is `permanent`, inferred, `shelf_reason: "history"`.
  Not when that sentence opens a period with its date ("desde el 18-sep",
  "since", "as of", "a partir de", "a 4-oct"), looks ahead (will, planned,
  programado, pendiente, caduca, expires, renews, "para el <date>"), speaks of
  the present (actualmente, currently, ahora, último, last, latest), or states
  something before the action ("la API corre en el puerto 8443, desplegada el
  …"). Actualizado, cambiado, configurado, updated, changed and set are not
  finished actions: they bring a new current value. A line with no date is
  never history. Only the first sentence is judged; that and the other
  limits are in the design doc.
- **The legacy grace reaches inferred-volatile facts.** In a brain that
  predates shelf life — manifest not stamped yet, or stamped more than a
  minute after `created` — an unmarked, never-verified line the detector
  infers volatile and recorded before the stamp starts counting up to 45 days
  before the stamp, staggered by its text hash like every other graced line:
  nothing volatile is flagged on upgrade day, and those lines come due spread
  over days 46–90. A fact marked volatile by hand gets no grace, and in a
  brain born with shelf life (created and stamped together) nothing changes.
  Read from `created` and `staleness_since`; nothing new is stored.
  **Measured on the same brain:** 806 flagged on the stamp day with 2.9.0,
  695 with the history rule alone, 0 with all of 2.9.1; 289 at +60 days and
  1,318 at +91. The grace postpones, it does not reduce: the imported
  checklists that fix 1 cannot see are still the largest group.
- **`view=status` says the version that runs.** `crbro_version` is read once,
  when the server loads, not from disk on every call: a process whose files
  npx replaced reported the new version while it ran the old code. When the
  package on disk says another version, status adds `installed_version` and a
  `version_note` (restart the client to load it).

## [2.9.0] — 2026-10-04

Shelf life: what may have changed since it was last checked comes apart.
From community feedback (r/mcp); design in
[`docs/design/staleness.md`](docs/design/staleness.md). Still 15 tools: every
change is a parameter or a field on an existing one.

- **The gap it closes.** A value that changed in the world and that nobody
  retired from memory — a port, a price, a version, who holds a role — came
  back from `crbro_recall` with `confidence: strong` and nothing else.
  `confirmations` counted how many sessions said a line, never when one last
  looked; `since` hides old lines, it does not warn; maintenance's
  `expired_entries` only sees a line that names a day.
- **A last verification per fact.** `Fact.verified` (ISO instant) and, for
  decisions and patterns, the `entry_verified` sidecar keyed like
  `entry_dates`. Two ways to set it, and only two: `crbro_revise
  status=verified` (a fourth value of the existing enum; `facts` by id or exact
  text, `entries` for decisions and patterns by text or entry id) when the
  agent checked a line against its source and it still holds, and a session
  learning the exact same fact again with nothing else in the call
  (`reconfirmed: true`). A re-learn that also brings keywords, a confidence or
  a class is an edit, not a check — the server itself asks for that re-learn
  to add keywords — and leaves `verified` alone. One `verify` op per line per
  session, however often it is repeated. The miner never reconfirms, a retired
  line is not verifiable (it comes back in `unmatched` and `retired_targets`),
  reading — recall, inspect — never touches it, and a check dated more than a
  day ahead of this machine's clock counts as no check (it would otherwise win
  every "latest" merge and keep the line fresh until that day).
- **A shelf life by kind of data.** `volatile` 90 days (versions, prices,
  ports, hosts, paths and URLs, configuration values, people in roles),
  `normal` 365, `durable` 730 (decisions and patterns), `permanent` never
  (preferences, errors, debts, history). The windows are a policy choice, not
  a measurement; `CRBRO_SHELF_DAYS="volatile=90,normal=365,durable=730"`
  changes them per machine. `crbro_learn` takes `shelf_life` for facts (stored
  only when given; a different value on the same text replaces it,
  `updated_in_place`) and always returns the class that applies, with
  `shelf_inferred` and `shelf_reason` when it was read from the text. An
  unmarked fact is classified at read time by a small, conservative detector
  (`src/engine/shelf.ts`, Spanish and English; every rule needs a number, a
  path or URL shape, or a role-and-name pattern next to its trigger word), so
  a better detector improves old facts too. Measured on the repository's
  retrieval fixtures: it marks 25 of the 48 facts of the project fixture (a
  brain of versions, prices and hosts) and 3, 3 and 0 of the 494 facts of each
  personal-prose haystack.
- **Recall that warns.** After the ranking — which does not change — a row
  whose winning entry is past its shelf life since last verified moves, whole
  and in rank order, to `possibly_stale`, with `age_days`, `last_verified`,
  `shelf_life` and `shelf_inferred` (and `age_counted_from` when the legacy
  grace applies). When anything moved, every row carries its `rank`, and if
  the top-ranked row is the one that moved the hint opens with "The best match
  (rank 1) moved to possibly_stale", so the first row of `results` is not
  taken for the answer to the question when it may be about something else.
  No backfill and no re-heading with an `also_matched` line;
  an old `also_matched` preview keeps its place and carries `stale_days`. The
  next step is said once, in `hint` (check it against its source; still true
  → `crbro_revise status=verified`, changed → `crbro_learn` with
  `supersedes`; if you cannot check, say how old it is), led by "Nothing
  current matched" when every row moved. `total_results` counts current rows,
  `returned` adds the stale ones, `possibly_stale_count` is there when the
  block is. `since` still filters on when a line was recorded: a reconfirmed
  old line is not new. Day logs are never partitioned, protocol neurons are
  never judged. With the feature on, the deterministic retrieval benchmark
  gives the numbers published for the keyword engine (recall@1 77%, recall@3
  83%, MRR 0.806).
- **No flood on upgrade.** The first boot of this version stamps
  `manifest.staleness_since` (one field in a file boot already writes; no
  neuron is touched). A fact never verified, with no explicit class, not
  volatile and older than the stamp starts counting near it; decisions and
  patterns likewise. Not from the stamp itself, which would only delay the
  flood: every old line would cross its window on the same day. Each line's
  clock starts up to half a window before the stamp, by a fixed share drawn
  from a hash of its text and never before its real date, so nothing is due on
  the stamp day and an old brain's lines come due spread over the second half
  of the first window. A manifest write from a process whose cache predates
  the stamp keeps it, and boot restores one an older CRBRO dropped, so the
  stamp does not drift. Volatile facts get no grace: a port saved months ago
  is exactly the case. A line with no parseable date is never flagged.
  `CRBRO_STALENESS=0` turns everything off and recall answers as in 2.8.
- **Everywhere else the same three facts.** `crbro_inspect view=neuron` shows
  `verified`, an explicit `shelf_life` and `stale_days` per entry (index and
  `entries=[ids]`); `view=status` reports `staleness: { enabled, windows,
  since }`. `crbro_maintenance` reports `stale_entries` and `stale_sample` (the
  ten most overdue), read-only; `repair` drops `entry_verified` keys whose
  entry is gone. Boot's `memory_discipline` and the server instructions gain
  one sentence each on what `possibly_stale` means.
- **Team spaces.** A check travels as a new `verify` op (latest `at` wins,
  order-independent); an explicit `shelf_life` travels as `shelf` on the fact
  op (the most volatile explicit value wins, so a shared fact's class can be
  shortened but not lengthened: the next sync restores the more volatile value
  from the log, and `crbro_learn` warns in `shared_warning`). A check on a fact
  stored before ids existed lands on the teammate even when its text has a
  double space or is not NFC (both text hashes are accepted). `OPS_VERSION`
  stays 1: a 2.8 client skips the new
  kind and ignores the new field — the check does not reach it, nothing is
  corrupted. `move_to`, `merge_into` and restore carry the stamps; `forget`
  prunes them.
- **Compatibility.** Every new field is optional; a 2.8 brain loads and
  recalls as it is, and nothing is written to a neuron until a learn or a
  revise touches it. No index change, no `INDEX_VERSION` bump: shelf life and
  verification are read from the neuron file recall already loads for every
  row. Tool descriptions stay under 1,000 characters (recall 993, learn 983,
  revise 946, with the second iteration below). With the optional daemon, `CRBRO_STALENESS` and
  `CRBRO_SHELF_DAYS` are part of the configuration fingerprint (only when they
  differ from the defaults, so existing fingerprints do not move): a client
  that switched the feature off is never served by a daemon that has it on.
- **The agentic benchmark: measured, and not met.** A new pre-registered
  case, `stale-unmarked` (fifth amendment of
  `benchmarks/agentic/PREREGISTRO.md`): four values that changed in the world
  and that nobody retired, two marked volatile and two left to the detector,
  with the current value in a file both arms can read. Measured on
  2026-10-04 with Claude Code 2.1.270, n=3, the 2.8.0 build (`before`) against
  this branch (`after`, two runs per model: the four new tasks alone, then
  all 16). With CRBRO the agent answers **0 of 12** correctly in every run,
  before and after, in haiku and in sonnet. Old value given without a
  warning: haiku 11 before, 9 and 10 after; sonnet 12 before, 11 and 12 after;
  one sonnet answer gave it with a warning (`hedged`). Without memory the
  agent reads the file and gets 3 and 6 (before) and 1-6 (after) of 12.
  U1, U2 and U3 fail in every `after` run; U4 passes in three of four by one
  or two cells, which is noise at n=12; U5 passes (the 12 original tasks
  keep 4/4 thresholds: 24/24, 0 retired values, controls 6/6). The claim
  "CRBRO warns and the agent checks" is **not** made. Why, from the cells:
  recall flags all four rows correctly (checked without a model on the same
  brain), but in 48 `after` cells no agent with CRBRO opened a file — the
  warning arrives and does not change what the agent does on these tasks.
  No cell tried `crbro_revise` or `crbro_learn`. Cost per CRBRO cell on these
  tasks: haiku $0.0121 → $0.0149 / $0.0151 at the same turns (3.1 → 3.0),
  sonnet $0.0263 → $0.0270 / $0.0274 with fewer turns (3.6 → 3.1). Canaries
  clean, no leaks, no API errors. Before the `after` runs, a dated note in
  the pre-registration recorded that `before` ran after the implementation
  commit (in separate clones of 2.8.0 and of the frozen harness), the
  `CRBRO_MOD=0` deviation and the review changes. Results:
  `benchmarks/results/agentic-2026-10-04-*.json`.
- **Second iteration: the warning comes first, and says what to open.**
  Presentation only (detection, windows, ranking and the partition are
  unchanged; an answer with nothing stale is the same as before). When
  anything moved to `possibly_stale`, the answer now opens with
  `stale_warning`, before `query` and `results`: do not answer with it as
  current, check it first, and if you cannot, say it may be out of date, even
  in a short answer. Each `possibly_stale` row leads with `warning` ("last
  known value, unverified for N days (since DAY): may have changed") and
  `next_step`, and carries the stored line as `last_known` instead of
  `matching_content` (the block has never been released, so no client
  breaks; `results` rows are unchanged). `next_step` names the file, path or
  URL the line itself cites, found by a small pure detector
  (`src/engine/source.ts`, which leaves out units like `km/h`, product names
  like `Node.js` and bare hosts); otherwise it says to look where the value
  lives — the project's files or config, or the user — and, if that is not
  possible, to say the value is from that day and may be out of date. The
  hint puts this first, before the generic advice. The server instructions,
  boot's `memory_discipline` and recall's description say the same, and
  `crbro_learn` (description and `content`) asks that a value that can change
  name where it came from. Design and what its author knew of the benchmark
  tasks when writing it: `docs/design/staleness.md` §14.
- **Second iteration, measured: not met.** Sixth amendment of
  `benchmarks/agentic/PREREGISTRO.md`: a second `stale-unmarked` case
  (`stale-unmarked-b`, six fictitious values that changed, 130-300 days old,
  two marked volatile, one marked normal, three unmarked), its tasks,
  thresholds and 2.8.0 `before` run committed before the product change,
  then one `after` run per model on the branch, 2026-10-04, Claude Code
  2.1.270, n=3. With CRBRO the agent answers **1 of 18** correctly (haiku,
  0 before) and **0 of 18** (sonnet, 0 before). Old value given without a
  warning: haiku 14 → 9, sonnet 18 → 12; with a warning: sonnet 0 → 6;
  abstentions: haiku 4 → 8. Without memory the agent reads the file and
  gets 6 and 9 of 18. U1, U2 and U3 fail in both models; U4 passes in both;
  U5 passes (the 12 original tasks: 24/24, 0 retired values, controls 6/6).
  The claim "CRBRO warns and the agent checks" is **not** made. Why, from
  the cells and from a model-free check dated before the run: recall flagged
  only two of the six rows (the two marked volatile); the other four,
  unmarked or marked normal and under 365 days, are served as current, and
  their answers did not change. On the two flagged rows the old value given
  as current went from 5 to 0 (haiku, which now abstains) and from 6 to 0
  (sonnet, which now gives it with a warning). An agent with CRBRO opened a
  file in 1 of 48 cells. Secondary, deciding nothing: without the answer-
  format suffix the flagged question is answered with a warning (both
  models) and the unflagged one with the old value; on old values that are
  still true sonnet stays 6/6 but warns on the volatile one, and haiku
  abstains on it as it did on 2.8.0. Cost per CRBRO cell on the judged tasks:
  haiku $0.0114 → $0.0129, sonnet $0.0268 → $0.0272. Before measuring, a
  review correction (a disclosure sentence in §14) and the dated note on
  what the change could reach were committed outside the harness; the
  pre-registration copies that note with the results. Canaries clean, no
  leaks, no API errors, no reruns. Results:
  `benchmarks/results/agentic-2026-10-04-*-before-b.json` and
  `…-after-b.json`.
- **Both iterations at a glance** (with CRBRO; correct · old value without a
  warning): first case, 12 cells — haiku 0 → 0 · 11 → 9 and 10, sonnet
  0 → 0 · 12 → 11 and 12; second case, 18 cells — haiku 0 → 1 · 14 → 9,
  sonnet 0 → 0 · 18 → 12.

## [2.8.0] — 2026-10-04

Open items in sight, for whoever installs CRBRO, not only for its author.

- **On by default where Claude Code is, and said out loud.** `crbro_boot`
  installs the mod on its own, once per server process (once per daemon),
  when `~/.claude` exists: the same install as `install-mod` with the
  language on auto. The boot that does it carries `mod_notice`, a sentence the
  assistant passes on — what was installed, that it shows up in *new* Claude
  Code sessions, and how to remove it — handed to up to three server
  processes, once each, within a week, since the first may be a background
  run nobody reads. After an update of CRBRO, a boot that finds the installed
  files different from the package (SHA-256, line endings aside) refreshes
  them without touching `settings.json`, and says so; an older CRBRO on the
  same machine never takes back a newer one's files, and two builds of one
  version do not rewrite each other. The way out is easy and final:
  `uninstall-mod` leaves a mark in `~/.claude/crbro-mods/state.json` and the
  mod is never put back on its own, by any client (`install-mod` lifts it);
  taking the folder out of `CLAUDE_CODE_PLUGIN_DIRS` by hand counts as a no
  too, and is said once with the way back; `CRBRO_MOD=0` turns the automatic
  part off for the client whose env sets it, and a daemon started without it
  never serves that client. It never fails the boot (files copied without
  blocking, 1.5 s at most, every error caught), leaves a `settings.json` that
  does not parse untouched and does not retry the same failure until that
  file or the package changes, or a day goes by, installs nothing beside
  another `crbro-pending` already in the list or when only the environment
  sets `CLAUDE_CODE_PLUGIN_DIRS` (writing it to `settings.json` would hide
  those plugins; said once), and two sessions starting at once take turns
  through an exclusive lock file. `settings.json` is written only if it is
  still what was read, with its line endings, and checked after writing:
  every key kept, the path listed once. SECURITY.md has a section on it.
- **The open items above the prompt.** `npx crbro-memory install-mod` adds
  `crbro-pending`, a Claude Code mod: the newest open item of the brain drawn
  whole above the prompt — a short `Label:` apart, `(1) … (2) …` steps one per
  line, its age green, amber or red — with ‹ › through the rest, compact/read
  all, *See all* and *Hide*. `/pending` (alias `/pendientes`) shows every item
  as a card, with a filter that ignores accents, *Work on this* (the item
  written into the prompt, not sent), *Done* and *Discard* behind a yes/no,
  and what was closed lately. It started as a mod the author kept in his own
  `~/.claude`, reading his brain file by hand and speaking only Spanish.
- **It asks CRBRO, not the disk.** The list comes from `crbro_context` with no
  arguments, which only reads, on whichever MCP server has that tool —
  `crbro` in a standard install, any other name found from the session's tool
  list or from the first CRBRO tool the model calls. Only when no server is
  reachable does it read `<CRBRO_PATH or ~/.crbro>/prefrontal/active_context.json`,
  resolving `CRBRO_PATH` exactly as the server does, and the pane says which
  of the two it read. *Done* and *Discard* always go through the server; the
  mod never writes the brain.
- **English and Spanish.** English by default and Spanish complete, every
  string in one table. `install-mod --lang en|es` stores the choice in the
  mod's own setting (a row in `/config` too); `auto` follows `CRBRO_LANG`,
  then `LC_ALL` / `LC_MESSAGES` / `LANG`, then the system locale.
- **Sturdy with any brain, not only its author's.** A colon makes a label only
  when it ends a word, so a path, a URL or a time stays whole; an item with
  no id reads without a dangling one; the pane draws 40 cards at most and
  cuts a line at 2,000 characters, so a large brain never gets it unmounted;
  *Work on this* adds to what was typed instead of replacing it; a CRBRO tool
  call waits at most 1.5 s for the band to catch up; a language picked in
  `/config` applies on reload; a terminal too narrow for the pane says so.
- **Installed with the same care as the hooks.** The mod is copied to
  `~/.claude/crbro-mods/crbro-pending` and that folder is added once to
  `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, with `;` on
  Windows and `:` elsewhere. A file with a BOM is read, one that does not
  parse is left alone, the write is atomic — through a symlink to its target,
  with its permission bits and its indentation kept — and a second run
  changes nothing. A folder in that list holding a plugin named
  `crbro-pendientes` — the hand-made copy — is replaced in place and named,
  and its folder is left on disk. Any other copy (another `crbro-pending` in
  the list, or one in `~/.claude/mods`) is pointed out and never touched.
  `uninstall-mod` removes the entry (and the variable, and an `env` block,
  when they end up empty), puts back the `crbro-pendientes` folder it had
  replaced if it is still there, and deletes its own folder, nothing else.
  Folders that only the shell's `CLAUDE_CODE_PLUGIN_DIRS` lists are named,
  never merged in silence.
- **Verified like the hooks.** `install-mod --verify`, and `install-hooks
  --verify` too, compare the installed copy with the package file by file by
  SHA-256 and check that `settings.json` lists it; a file the package does
  not ship, or a second copy Claude Code would also load, is a difference
  too. Exit 1 on any.
- **Requirement.** Mods need Claude Code 2.1.286 or later, and are drawn in the
  CLI and in the desktop app's Code tab — not in Claude Desktop chat, Codex,
  Cursor or the VS Code extension. A new session picks the mod up.
- **Package.** `mods/` ships; the mod's tests, `tsconfig.json` and generated
  types do not (`mods/crbro-pending/.npmignore`). The mod's tests run under
  `claude plugin test`, the installer's in the vitest suite, which leaves
  `mods/` to the former.
- **A new tour at the top of the README.** `docs/crbro-tour.gif` replaces the
  August demo: memory across sessions, corrections that replace old facts,
  secrets kept out, the guard, the compaction checkpoint and the band.
  `docs/pending-band.gif` shows the band and `/pending` at work. Both are drawn
  by code with made-up data; every figure on screen is one this README states.

## [2.7.2] — 2026-10-03

The first run of the agentic benchmark, what it fixed in the server's
instructions, and recall re-measured on a bigger exam and a bigger brain.

- **A fresh session does not ask again what memory already holds.** Measured
  for the first time with a real agent (`benchmarks/agentic/`, haiku and
  sonnet, Claude Code 2.1.270, n=3): with CRBRO 24/24 on questions whose answer
  lived only in memory, 0 retired values given; without it 0/24, and sonnet
  invented 4 answers. The run found two faults in the server's instructions,
  fixed before the run that is published: an agent that recalled, found
  nothing and answered "I don't know" although the answer was in the question,
  and — after the first wording of the fix — an agent that skipped recall.
  The instructions now say to recall even when it thinks it knows, and that
  only an answer stated in the current message outranks memory.
- **`crbro_learn` asks for keywords.** A fact saved without them is stored and
  the answer carries `keywords_missing: true` and a one-line `keywords_hint`
  to call again with 2-5 of them: they merge into the same fact. Keywords are
  the largest measured lever on recall; on the author's brain a quarter of
  all facts carry them (65-80% of those saved since September).
- **Rare words weigh more.** Each query term was normalised against its own
  best hit, so a word found in a third of the brain counted as much as the one
  word that names the thing. Terms are now weighted by rarity (BM25 idf).
  Chosen on a tuning set only (`benchmarks/retrieval/dev.json`); on the
  original 48-question exam the keyword engine goes from 71% to 77% at rank 1,
  and inside a 1,482-fact haystack from 42% to 54%. On the new 96-question
  exam it does not move (49%). `CRBRO_IDF=0` turns it off.
- **The same fact always gets the same vector.** The int8 embedding model
  quantises per batch, so a line embedded with others got a slightly
  different vector than alone (cosine 0.994 at worst). The first full pass now
  embeds one line at a time, as every learn does since 2.5; it costs 1.6× the
  time, once. No benchmark moved. `CRBRO_SEMANTIC_BATCH` overrides.
- **The drop of the semantic layer is traced.** 79% → 73% at rank 1 between
  2.4 and 2.5 came from two commits: the recency tie-break (−2, an artefact:
  the benchmark's facts are learned in the same second) and embedding only the
  new lines of a neuron, one at a time, after the cosine floor had been tuned
  on vectors computed in batches (−4). No bug in the search logic. The floor
  stays at 0.84: swept on the tuning set, 0.80-0.84 is flat.
- **Benchmarks.** `retrieval/dev.json` (48 questions + 10 distractors, for
  tuning), `retrieval/test2.json` (96 + 20, a second blind exam) and three
  haystack files (1,482 facts in 114 unrelated topics), frozen before any
  measurement; `run.mjs` reads them through `CRBRO_BENCH_QUERIES` and
  `CRBRO_BENCH_HAYSTACK`. A longer stopword list was measured and does not
  ship: it tied once rarity weighting was on.

## [2.7.1] — 2026-10-03

`crbro postmortem`, run on a week of real sessions, put three false
candidates at the top. Fixed, each with a test:

- **A correction opens the message.** The patterns are tested on the first
  160 characters only, and a message over 1,200 characters (a brief or a
  scheduled prompt that says "si algo sale mal, se informa") is never a
  correction. «eso no» counts only when it opens a sentence: "entiendo que eso
  no interfiere" and "para eso no?" were being read as corrections.
- **The desktop app's resume line is not the person.** "Alcancé mi límite de
  uso mientras trabajabas… Continúa donde lo dejaste" arrives as a human
  prompt with no flag; it was showing up as the same request asked three
  times. It joins the not-a-request list, shared with the compaction hook so a
  checkpoint does not keep it as the last request either. Only the Spanish
  wording has been seen; other languages are not guessed.
- **A long session reports its active hours.** "Over 398.6 h" was the time
  between the first and the last line of a session resumed for 17 days. Now
  pauses over 30 minutes are breaks: "38.7 h of activity spread over 17 days".
- The `install-hooks --verify` test that compares CRLF with LF builds both
  files itself; on a Windows checkout with `core.autocrlf` the package hooks
  were already CRLF and the case failed in CI.

## [2.7.0] — 2026-10-02

What a session leaves behind: where it was when it compacted, what it cost,
what went wrong in it, and which lessons are not about one project any more.
Everything new that touches Claude Code's files is opt-in or read-only.

- **Compact without losing the thread (opt-in, Claude Code).**
  `install-hooks --compact` wires `hooks/crbro-lifecycle.mjs` into `PreCompact`
  and `SessionStart`. Before a compaction it writes a mechanical checkpoint —
  last two requests, last state of the task list, open items, folder and git
  remote — to `<brain>/checkpoints/<session_id>.json`, redacted with the
  brain's own patterns (each text redacted whole, then cut), written
  atomically, pruned after seven days and left out of `crbro backup`. Lines
  the client writes as a user turn — a background task's
  `<task-notification>`, another agent's message (`origin.kind` other than
  `human`), `<command-message>`, configuration commands such as `/model` —
  are not taken for requests; the hook and `postmortem` share the same list,
  and a test keeps them equal. The remote loses user, password, query and
  fragment. After the compaction the session starts with a "Resuming after
  compaction" block built from it, capped at 1,500 characters. No model call, no `git` process, never
  blocks. `uninstall-hooks --compact` undoes it, including putting back the
  `install-boot` entry it replaced.
- **The session start says where it is.** The same hook fills the folder into
  the boot notice — `call crbro_boot … with project="<folder>"` — so
  `project_neurons` is used, and adds a `Project: <folder> · git: <remote>`
  line. With `--no-boot` (a hand-written notice of the user's) it still prints
  `pass project="<folder>" to crbro_boot`. The static notice `install-boot`
  writes asks for `project=<name of the working folder or repo>`.
- **The same lesson in two projects is a lesson about neither.** Storing an
  exact fact again used to answer "already there" and forget it had been told
  twice; it now counts it (`confirmations` on the fact, absent means 1) at
  most once per session — a retry or the re-save after a compaction is the
  same witness, and the miner re-reading a file does not count — and
  `crbro_learn` returns the count.
  `crbro_inspect view=neuron` shows it when above 1. `crbro_consolidate`
  returns `promotion_candidates` — at most five lessons (facts, patterns,
  errors) of the projects this session touched that are the same, or almost
  (the near-duplicate rule `crbro_learn` already used, plus: a near copy must
  carry the same numbers), in two or more project neurons — each with a
  suggested `tech_` or `process_` target. Only the user's own lessons take
  part: a teammate's or the miner's line is never proposed, so promotion
  cannot rewrite a third party's text as the user's own lesson. Nothing is
  promoted by itself. It
  reuses the cortex read the trigger index already makes; the comparison is
  bounded by inverted indexes on numbers and distinctive words (measured on a
  synthetic 1,200-neuron, 30,000-lesson brain: ~0.1 s, against 4 s for a
  plain rare-word probe on templated text).
- **Recall says when a line is not yours.** Each result, and each of its
  `also_matched` lines, carries `origin` only when it is not the user's own:
  `team:<space>` with `by` (a teammate's, through a shared space; plain
  `team` when the neuron is no longer shared) or `miner`. Read from what the
  entry already holds — a fact's `source`, a decision's or map's `by` — plus
  a new optional `entry_source` sidecar (keyed like `entry_dates`) that the
  sync now fills for teammates' patterns, errors and debts and `crbro_learn`
  fills for the miner. `by` is self-declared in the shared log, so a synced
  line keeps its mark even when it carries this machine's own author name.
  `forget` and `maintenance repair` prune `entry_source` keys whose entry is
  gone. Brains without the sidecar are valid as they are, but patterns,
  errors and debts a teammate contributed that were materialised before 2.7
  carry no origin (facts and decisions do). Recall reads one small file only
  when a teammate's line is in the answer.
- **`crbro_boot project=<folder or repo>`.** Optional. Puts the neurons whose
  name, system map or fact keywords name the project first in `hot_topics`
  and lists them in `project_neurons` (at most 5), from the index already in
  memory. Without it, boot does exactly what it did.
- **`crbro usage`: what each model took, in tokens.** Reads Claude Code's
  session logs (`~/.claude/projects/<project>/<session>.jsonl`, plus
  `<session>/subagents/**` and `<session>/subagents/workflows/**`) and sums
  input, output, cache-write and cache-read tokens per model and per session,
  the main conversation apart from its subagents. `--days N` (7 by default,
  0 = all), `--session`, `--project`, `--json`. Only `message.model`,
  `message.usage`, the message and request ids, `isSidechain` and
  `timestamp` are read; lines that cannot carry usage are dropped as raw
  bytes before decoding. One response is logged as several lines sharing a
  message id with a growing output count, so lines are merged per id (largest
  value wins) instead of summed — summing counts a response three or four
  times — and the merge is report-wide: a resumed or forked session copies
  the earlier responses into its own log, and each is charged once, to the
  oldest session holding it. With `--days`, a response counts only if its own
  timestamp is inside the window. No prices: they are not in the log.
- **`crbro postmortem`: candidate lessons from past sessions.** Deterministic
  signals over the same logs: the user correcting the assistant at least twice
  (fixed Spanish and English phrases: «no,», «te dije», «otra vez», «eso no»,
  «mal», "that's wrong", "I said"…), the same tool failing three times in a row,
  the same request repeated in a session or across sessions, and very long
  sessions. Each candidate cites session and line. The same line opening
  several sessions — what a scheduled task or a saved template looks like —
  is ranked last: on the machine it was tried on, 37 of 42 cross-session
  repeats in two weeks were that kind. It reads what the person typed and
  tool names only — never a tool's input or result, only the
  result's `is_error` — redacts everything it prints, and stores nothing:
  saving a lesson is `crbro_learn`, after the user says yes. `--max N`, `--json`.
- Both share one streaming reader (`src/utils/transcripts.ts`): 1 MB chunks,
  lines over 16 MB skipped without being assembled, torn and foreign lines
  counted and skipped. Measured on one Windows machine with a warm disk cache:
  the whole history (589 sessions, 5,371 files, the largest 275 MB) in about
  7 s for `usage`; one 275 MB session and its 388 subagent logs through both
  commands in 1.2 s, peaking at 186 MB resident.
- **`install-hooks --verify`.** SHA-256 of every hook copied into
  `~/.claude/crbro-hooks/` against the same file in this package, plus a check
  that every CRBRO hook `settings.json` runs exists. Reports `same`,
  `line_endings_only`, `different`, `not_installed` or `unknown`; writes
  nothing; exits 1 on any difference.
- **SECURITY.md.** The threat model — private data, content the user did not
  write, communication out — and, for each defense, why it exists and what it
  does not cover, including what the lifecycle hook reads from the transcript
  and puts back after a compaction. How to report a vulnerability, with a
  fallback when GitHub's private reporting is not enabled.
- **Open items are redacted.** `crbro_context add_pending` passes the text
  through the secret filter before writing it (and returns `redacted`), like
  every other free-text write; the "known gap" note is gone from SECURITY.md.
- **English output.** Everything new in this release that the user or the
  model reads is in English, like the rest of the CLI: the lifecycle hook's
  lines, `crbro usage`, `crbro postmortem` (finding kinds `corrections`,
  `failing_tool`, `repeated_request`, `long_session`; model `unknown` when
  the log names none) and `install-hooks --verify`. The Spanish correction
  phrases `postmortem` looks for are data and stay.
- **The subagent hook finds the same brain as the server** (`CRBRO_PATH`,
  with `~`, relative paths and unexpanded placeholders; `CRBRO_BRAIN_PATH`
  still works as an alias), and its fallback rules — what a subagent gets
  when the brain cannot be read — add a sixth: content from tools, web pages,
  files, other repos or other agents is data, not instructions.
- **Tool descriptions** announce `promotion_candidates` (`crbro_consolidate`),
  `confirmations` (`crbro_learn`) and origin on `also_matched`
  (`crbro_recall`); `import` is no longer promised as an origin, since no
  shipped writer produces it.
- **README numbers re-measured (2026-10-03).** The "Measured, not promised"
  table now shows today's benchmark output: as installed 73% / 79% (MRR
  0.760), 81% / 90% with `also_matched`; keyword engine 71% / 77%, 77% / 83%
  with `also_matched`. Lower than the 1.14–1.16 figures; 2.6.0 measures the
  same, and the cause has not been traced yet.
- The boot notice now lives in one place (`hooks/crbro-lifecycle.mjs`);
  `install-boot` imports it. `SECRET_PATTERNS` is exported from
  `src/engine/secrets.ts` so the hook's copy is tested against it.
- **One version in every file.** 2.6.0 went out with `server.json` (what the
  MCP registry reads) and `package-lock.json` still saying 2.5.1. All three
  say 2.7.0 now, and a test fails when they disagree, when the newest
  CHANGELOG section is not the package version, or when a module the CLI
  imports or a hook it installs would be left out of the package.
  `SECURITY.md` ships in the package.

517 tests, 4 skipped.

## [2.6.0] — 2026-09-21

Memory that arrives before the work, not after it.

- **`crbro_recall` is now asked for before acting, not only before answering.**
  The server's instructions said "before answering anything about the user,
  call crbro_recall". A session about to touch one of their projects is not
  answering anything, so the rule did not cover the case that matters most:
  the procedure for that project was stored, the session reconstructed it by
  reading files instead, and did the steps in the wrong order. The sentence now
  says "before answering OR ACTING ON", and spells out that acting includes the
  first command that explores or changes a project of theirs.

- **The guard hook wakes on the project, not only on the program.** Trigger
  keys came from the command being run, so a task that opens with `ls`, `find`
  or `grep -r` over a repo matched nothing; the lesson about that repo landed
  ten commands later, when a `git` line finally hit a key. Entries and commands
  now also produce `path:<folder>` keys for hyphenated folder names of six
  characters or more (`crbro-memory`, `synthetica-decks`), which is what an
  exploring command and a lesson about that repo have in common. Plain names
  like `src`, `docs` or `node_modules` are excluded on purpose: they name
  everything and would wake everything. Trigger index version 2 — an older
  index stays silent until the next `crbro_consolidate` rewrites it.

## [2.5.1] — 2026-09-20

Two things found by using 2.5.0 on the brain it was built from, the same night.

- **A neuron missing from the index is indexed, whatever its date says.** The
  catch-up added in 2.5.0 goes by file dates: what changed since the index was
  written gets re-indexed. But an index file written by a process that never
  saw a neuron is *newer* than that neuron and does not contain it — and no
  date would ever bring it back. That is exactly what a 2.4 server still
  running does to a brain compacted under it: its next persist writes its own
  in-memory index over the new one, and the digest neuron disappears from
  recall. Every neuron has at least a header chunk, so "no chunks at all" means
  "not indexed", and the catch-up now indexes it.
- **The guard ignores bare flags.** `curl -s` and `grep -n` are not actions, and
  lessons that merely mentioned them spoke before every unrelated `curl`. A
  flag only makes a key where it changes what the program does to your files
  (`rm -rf`, `node --check`, `python -m`…). Heredoc bodies and `npm run <script>`
  were already handled in 2.5.0.

And one for whoever installs behind an antivirus: `npx crbro-memory` failing
with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` is not CRBRO and not npm — it is a web
shield (Avast, in the case that found it) re-signing HTTPS with a root that
Windows trusts and Node does not. The README now says what to set.

420 tests.

## [2.5.0] — 2026-09-20

An audit of one real brain — 1,200 neurons, 97 sessions, five months of daily
use — and of the machine it runs on, and what they showed. Nothing here was designed from a whiteboard: every
item started as a number that looked wrong.

### The brain had no backup

1,200 neurons on one disk, and the only folder called "backups" held config
files. `crbro_forget` quarantines what it removes, but nothing protected the
brain from a bad write, a wrong merge or a dead disk.

```bash
npx crbro-memory backup            # one gzipped file, keeps the newest 7
npx crbro-memory backup list
npx crbro-memory backup restore FILE   # into a NEW folder, never over the live brain
```

`crbro_consolidate` makes one a day on its own and says so (`backup`). The copy
leaves out, on purpose, the quarantine (it holds credentials that were forgotten
deliberately), the machine token, the licence cache, the search index and the
semantic runtime. The folder is a *sibling of the brain it belongs to*
(`~/.crbro` → `~/.crbro-backups/brain`), not a fixed path under home: rotation
keeps the newest N of whatever shares a folder, so two brains in one folder
would rotate each other out — and the test suite would have rotated a real
user's backups. `CRBRO_BACKUP_DIR` points it at a synced folder, which is the
only thing that survives the disk; `CRBRO_AUTOBACKUP=0` turns the daily copy off.

### 1,199 of 1,200 neurons had no summary

The field exists since 1.0 and nothing ever asked for it. `crbro_consolidate`
now names the large neurons the session touched that still have none
(`missing_summaries`, 25+ entries, three at most) with the call that writes it.

### Half the ledgers had no date

Patterns, preferences, errors and debts are dated since 1.13; everything older
answers `matched_added: ""`, so "prefer the more recent" had nothing to stand on
in exactly the ledgers where it matters — 249 of 457 entries.

`crbro_maintenance backfill_dates:true` dates them **from the date stated in
their own text** ("Hallazgo (2026-08-30): …", "el 14-sep-2026 …", six
languages), to the day, inside the window [neuron created, first stamp on this
brain]. A day-precision value (`2026-08-30`) is a recovered date; a full instant
is a `learn()` stamp — the value says how it was obtained. The obvious fallback,
the neuron's `created`, was measured and thrown away: for the entries with no
date in their text the window had a median of **117 days**. That is not a date.
128 of 249 are recovered; 121 are counted and stay undated. Nothing is guessed.

### No date ever touched the ranking

Two tellings of one thing competed as equals, and which one spoke for the
neuron was an accident of file order. Recall now lifts a chunk's *lexical*
score by at most 4% for recency (today 4%, a month 3.2%, four months 2%, a year
1%, undated 0), before semantic fusion — RRF scores sit ~1.6% apart per rank,
so a lift applied after fusion would sort by date instead of breaking ties.
On 115 queries over a copy of the reference brain it changed the top neuron 3
times, all three exact score ties. The blind benchmark is unchanged
(71% / 77% / 0.744). `CRBRO_RECENCY=0` turns it off.

### Recall can be narrowed

`crbro_recall since` — a day (`"2026-09-01"`) or a span (`"7d"`, `"2w"`, `"3m"`)
— and `kind` (`["error"]` before repeating a mistake, `["decision"]` for what
was agreed). An undated entry cannot prove it is recent: `since` leaves it out
and counts it in `undated_skipped`. The filter is echoed back as it was
understood, and an empty filtered answer says to drop the filter before
concluding nothing is stored.

### Maintenance notices what nobody was looking at

All three are read-only reports in every run; acting on them is a judgement.

- **`expired_entries`** — live, dated entries whose text names a day that was
  still ahead when they were written and has since passed. Two dates and today,
  no keyword list. A two-day margin absorbs the gap between UTC stamps and the
  local dates people write, which alone was 232 of 277 flags; what is left (45)
  is scheduled posts and deadlines.
- **`split_candidates`** — neurons with 80+ live entries, with the
  non-overlapping word groups their own text suggests. Words common across the
  brain are dropped: the first proposal for the largest neuron was
  "verificado (180)", a habit of speech, not a subtopic.
- **`compact_groups`** — see below.

### Splitting a neuron without rebirthing its entries

`crbro_revise move_to` moves entries of any kind (by id or exact text) to
another neuron, created if missing, **with their dates, keys and retirement**.
learn + forget could always split a neuron, at the cost of every moved entry
being reborn today. Union first, removal second — a crash in between leaves an
entry in both places, never in neither — the source is quarantined, and the two
neurons get a `hierarchy` synapse. Refused on a shared source.

### 766 of 1,200 neurons were born on one day

A transcript miner that made a neuron out of every checklist line: one line
each, no tags, no links, 482 repeating a text another one has. Recall gives one
result per neuron, so three identical lines took the top three places of an
answer.

`crbro_maintenance compact:true` folds each such burst — 25+ one-line neurons
born the same day in one domain, no tags, links, summary or map, not shared,
30+ days old — into one digest neuron (tag `digest`) in a single pass: every
source quarantined, union in memory, one write, one reindex. Identical lines
are kept once, dates travel, and the source's name, the only context a one-line
neuron had, becomes the search keys of its line. A lone one-fact neuron is
somebody's note and is never touched. A digest earns no breadth bonus in
ranking: twenty lines of a pile matching "verify" put the pile above the
project that answered. On a restored copy of the reference brain: 754 neurons
folded in 6.8 s, 1,200 → 447, 0 integrity issues, real queries unchanged.
Run `dry_run` first and read the samples.

### Memory at the moment of action (opt-in)

Recall only answers when somebody asks, and nobody asks "have I broken this
before?" one second before `firebase deploy`. The same deploy mistake was in
the error ledger twice, recorded by sessions that never recalled it.

```bash
npx crbro-memory install-hooks --guard
npx crbro-memory guard "firebase deploy --only hosting"   # what it would say
```

The server derives a command → lesson lookup from the error, debt and pattern
ledgers (backticked commands, known programs with their next word, scripts by
name) and writes it to `.search/triggers.json` at every consolidate and
maintenance run — 119 KB for 256 lessons. A Claude Code `PreToolUse` hook reads
that one file before a Bash or PowerShell call and adds the matching lessons as
`additionalContext`: three at most, errors first, newest first, once per
session each. It never blocks, never asks, and exits 0 on any failure. Opt-in,
like every injection this project has not measured.

### One process owns the brain (opt-in)

Every client used to start its own CRBRO. On the audited machine that was
Claude Code, Claude Desktop and Codex: three copies of a 40 MB index, three
loads of the embedding model, three in-memory indexes each written over the
others' when its client closed — so a line saved in one chat could be invisible
in the next — and two of the three were running a different build from the
third, writing the same brain.

```bash
npx crbro-memory daemon on        # every client of this brain, the next time it starts
npx crbro-memory daemon status    # who is running, how many conversations, how much it holds
npx crbro-memory daemon off | stop
```

In daemon mode what a client launches is a **proxy**: it loads no index and no
model (55 MB), finds the daemon or starts it detached, proves who it is, and
from then on copies lines. The daemon builds the engines once and gives every
connection its own MCP server over them, and its own session scope, so each
conversation consolidates what *it* wrote.

Measured on a copy of the reference brain (447 neurons, 5,180 vectors, the
semantic layer on, three clients, Windows 11 —
[`benchmarks/daemon/`](benchmarks/daemon/results.json)):

| | classic | daemon |
|---|---|---|
| memory, three clients | 2,153 MB | **1,140 MB** (975 daemon + 3 × 55) |
| second and third client ready | ~1,780 ms | **~330 ms** |
| a line saved by one client, recalled by another | after that client's next boot | **at once** |

The first client costs the same either way (~6 s: somebody has to load the
index), and a single client gains nothing: this is for people who keep several
assistants open on one brain.

The rule the design answers to: **losing the daemon may cost speed, never the
memory.**

- A client that cannot reach or start a daemon serves itself in-process —
  CRBRO exactly as it was.
- A daemon that dies mid-conversation is replaced under the client's feet: the
  proxy kept the client's `initialize`, replays it on the replacement and
  swallows the second answer; calls that were in flight get a JSON-RPC error
  ("call it again") instead of a silence that hangs until a timeout. Three
  losses in a minute and the proxy stops trusting daemons and serves itself.
- The endpoint (a named pipe on Windows, a unix socket in `.daemon/`
  elsewhere) is *derived* from the brain path and the build, never configured:
  clients of the same brain on the same build find each other, and a client on
  another build gets its own daemon — so you are served by the code you
  launched, and an upgrade kills nothing: the old daemon exits when idle
  (20 min, `CRBRO_DAEMON_IDLE_MIN`).
- Both sides prove knowledge of a token kept in `<brain>/.daemon/` with an HMAC
  over a fresh nonce, and the daemon goes first: a process that merely took the
  pipe's name learns nothing from a client. `.daemon/` never travels in a
  backup.
- The switch is a flag inside the brain, so every client flips together;
  `CRBRO_DAEMON=0` keeps one process out, `=1` forces one in.

Two things in the engine had to change for a process that serves everyone, and
both help classic mode too. `crbro_boot` calls `init()` on every boot, which
used to reload or rebuild the whole index; an index already in memory now
**catches up with the files that changed** instead. And a freshly loaded index
catches up from its own file's timestamp — which closed a hole the end-to-end
test found by killing a daemon on purpose: a line written inside the one second
of slack `isStale()` allows, by a process killed before its 5-second persist
debounce, stayed invisible to recall for good.

It was reviewed before it shipped, adversarially: three reviewers with one
parcel each (lifecycle, trust, shared state) and, for every finding, a skeptic
told to refute it. Fourteen findings survived, nine of them reproduced, and
each is now a test in `tests/daemon.review.test.ts`. The ones worth knowing:

- a client that sent its last `crbro_learn` and closed stdin at once lost the
  write *and* the answer — the proxy let go the moment stdin ended. It now
  leaves only when every call it accepted has been answered and written out;
- a recall that arrived while the index was being rebuilt answered from a
  fraction of the brain, in silence. Readers and writers now wait for a rebuild;
- the catch-up listed the cortex, awaited, and then removed whatever was not in
  the listing — including a neuron learned in between;
- re-indexing a neuron threw away the vector of every line and paid for it
  again, which the catch-up turned into "re-embed everything anyone read";
- `crbro daemon off` was undone in 200 ms by the first proxy that noticed its
  daemon gone; they now ask again whether daemons are wanted;
- `crbro daemon status` deleted the state file of a live daemon that was merely
  slow to answer, orphaning it; only a pid the system says is gone loses its file;
- a daemon started by one client inherited *that client's* `CRBRO_BACKUP_DIR`
  and `CRBRO_SEMANTIC` for everybody: clients whose settings differ from the
  daemon's now serve themselves, so their settings keep meaning what they said;
- something else holding the pipe's name made every client wait 12 s per start;
  the daemon now says why it could not take its endpoint and the proxy stops
  waiting at once. On unix, a start lock and an inode check keep a slow starter
  from unlinking a live daemon's socket.

Off by default in 2.5. `benchmarks/daemon/e2e.mjs` runs the whole story with
real processes on a throwaway brain: detached spawn, the daemon outliving the
client that started it, a hard kill under another client, the replacement.

### Two experiments, pre-registered

- **Synapses in the ranking: discarded.** Hypothesis, the one mechanism, arms,
  data and the decision rule were committed before any code. 633 known-item
  queries on a copy of the reference brain, 339 on neurons that have synapses:
  recall@3 moved by 0.15 points at most; the rule asked for +1.0. The mechanism
  was removed from the engine rather than left asleep behind a variable.
  [`benchmarks/synapse-activation/`](benchmarks/synapse-activation/RESULTADO.md).
- **The agentic benchmark: built, not run.** `LIMITS.md` designed it and left
  it unbuilt. [`benchmarks/agentic/`](benchmarks/agentic/PREREGISTRO.md) holds
  12 frozen tasks (4 memory, 4 with a retired value as a trap, 4 controls where
  CRBRO must not win), a tested scorer, four thresholds, and a runner that
  isolates every cell and aborts on a contaminated arm. No figure from it
  exists anywhere until a results file is committed.

### Fixed

- **The brain path was resolved at import, not at construction.** `brain.ts`
  kept `resolveBrainDir()` in a module constant, so whatever imported `Brain`
  before `CRBRO_PATH` was set bound every later `new Brain()` to `~/.crbro`.
  Found the hard way: a new test wrote a fake neuron into a live brain. It is
  resolved when a Brain is built, and the test setup now sandboxes
  `CRBRO_PATH`, `HOME` and `USERPROFILE`, so a test that forgets the variable —
  or deletes it in its `afterAll` — cannot reach a real brain.

419 tests: 415 run everywhere, 4 need the semantic runtime. Baseline before this release: 312.

## [2.4.0] — 2026-09-10

### The memory was installed and never woke up

Registering the MCP server does not call it. The tools appear, the brain sits on
disk, and unless something runs `crbro_boot` at the start of a conversation the
assistant answers from nothing — which looks exactly like a memory that does not
work. Every "CRBRO doesn't remember" report so far has been this, and the
install instructions were the cause: they said *"start any session with
crbro_boot"*, which is a thing you do once, by hand, and then forget.

```bash
npx crbro-memory install-boot
```

It wires the start into whichever clients it finds, merging into the config and
never rewriting it:

- **Claude Code** — `SessionStart` in `~/.claude/settings.json`, a command whose
  stdout enters the session and tells the model to boot first. Claude Code
  cannot invoke an MCP tool from a hook, so the instruction is the mechanism.
- **Codex** — `SessionStart` in `~/.codex/hooks.json`: an `mcp_tool` step that
  calls `crbro_boot` directly **and** the same printed instruction behind it.
  Not redundancy — the hook can fire before the MCP server has finished
  starting, and then the direct call is lost with nothing to catch it. That is
  the failure that started this release.

Tools without session hooks (Cursor, Windsurf, Antigravity) get the exact line
to paste into their always-on rules file, printed by the command.

Idempotent, and it recognises a hook you wrote yourself — including one that
points at a file instead of naming `crbro_boot`, which is how the first draft of
this command managed to install a second hook next to an existing one and boot
the brain twice. Five tests run the real CLI against a throwaway home and pin
each of these: the merge, the two Codex layers, the hand-written hook left
alone, two runs changing nothing, and no client found reporting instead of
writing.

## [2.3.1] — 2026-09-09

### The read tools were unreachable from Claude Code

`crbro_recall`, `crbro_inspect` and `crbro_map` — the three that carry an
`outputSchema`, and most of what the memory is for — never arrived. The client
rejected them before the first call:

```
Tool 'crbro_inspect' has an invalid outputSchema: JSON Schema declares an
unsupported dialect ("$schema": "http://json-schema.org/draft-07/schema#").
The default validator supports JSON Schema 2020-12 only.
```

The server starts, the tools register, `tools/list` answers — and they are
dropped on arrival. Nothing in the logs says so, which is why it went unnoticed:
writes kept working, so the memory looked alive while half of it was gone.

It came from the SDK, not from the schemas. Its Zod converter defaults to
`target: 'draft-7'`, that default is hardcoded, and `registerTool` exposes no
way to change it — so everything went out stamped as draft-07, and a client
validating with an Ajv built for 2020-12 refuses it.

The label was the whole problem. Checked against the real `tools/list` output,
not one schema uses anything that differs between the two dialects: no
`definitions`, no `$ref`, no tuple `items`, no boolean `exclusiveMinimum`. They
were valid 2020-12 already.

So the label comes off on the way out, rather than being rewritten to 2020-12:
with no `$schema` a validator applies the dialect it can actually run, and
claiming 2020-12 would mean vouching for output the SDK generates, not us. The
day the SDK switches, this becomes a no-op instead of a conflict. Two tests pin
it — no schema declares a dialect, and every tool still ships with its shape
intact, so the fix cannot fail silently if the SDK moves its internals.

## [2.3.0] — 2026-09-09

### Credentials, without going through a model

The keychain broker landed earlier and closed the wrong half of the problem. A
secret was refused entry to the brain and then had somewhere to go — but the
only door was `crbro_secret`, an MCP tool, so the value had to be typed into a
conversation with a model to get anywhere. For a module whose first sentence is
that credentials never touch the brain, routing every one of them through a chat
transcript was the wrong last mile.

`crbro secret` is that door, from the terminal:

```bash
npx crbro-memory secret set GITHUB_TOKEN
npx crbro-memory secret list
npx crbro-memory secret get GITHUB_TOKEN
npx crbro-memory secret remove GITHUB_TOKEN --yes
npx crbro-memory secret status
```

The value is read from **stdin, never from `argv`**, and that is the whole point:
an argument is written to the shell history and is visible in the process table,
where anything else running on the machine can read it while the command runs. On
a terminal the input is read with the echo off, so it never reaches the scrollback
either. Piped, it is read whole with one trailing newline stripped — which is what
`Get-Content`, `cat` and every password manager CLI produce.

`get` writes the raw value to stdout so it composes, and warns on stderr when
stdout is a terminal, because printing a credential to the screen is almost never
what was meant. `remove` requires `--yes`. `set` refuses an empty value before it
touches the store.

Nothing here changes where a secret lives: still the operating system's own
store, still outside the brain, still sealed per machine and unreadable from a
backup.

## [2.2.0] — 2026-09-07

### The diary is searchable

Session summaries carry the narrative — what was done, when, in what order,
why a thing was left half-way — and none of it was reachable by content:
"what did we do about Glama on Thursday" had no answer unless someone had
saved it as a fact. Every session log is in the search index now, as
paragraphs of up to 700 characters, and `crbro_recall` returns the days that
mention the question in a list of its own, `sessions_matched`: session id,
date, the paragraph that matched as a 300-character preview, an entry id, and
the same lexical `confidence` rule the neuron results use (a session never
gains confidence from the semantic layer).

A list of its own, on purpose. Session chunks are separated before results
are grouped by neuron, so a long narrative can never outrank the fact that
answers, and the neuron ranking is untouched: the retrieval benchmark stays
at 71% / 77% (79% / 85% with `also_matched`). Session chunks are lexical
only — the words a day was described with are the words it is asked about —
and stay out of the vector index.

`crbro_inspect view=sessions session=<id>` reads one log whole; consolidate
indexes the day it just logged, so tomorrow's recall can point at today; a
rebuild indexes the whole diary. Index format 7, rebuilt once on the first
boot — 4.4–4.7 seconds on a brain of 1,148 neurons and 84 sessions. Three diary
questions on that brain answered in 7–27 ms with the right days.

What the diary must not change, pinned before shipping by two refutation
passes: a fact still wins. The one-edit slack that finds a fact spelled right
when the question has a typo is now decided on neuron hits alone, so a day
log that repeats the typo verbatim no longer switches it off. Several
phrasings rank the day they all point at first, by accumulated coverage, in
the same order whichever phrasing comes first. A domain-scoped recall still
lists the days — logs have no domain. Nothing is cut in silence:
`sessions_total` says how many days mention it when three are shown, and a
question only the diary answers gets a hint that points at the day, not at
rephrasing. `crbro_forget session` takes the log's lines out of the index
with it, now and on disk; the quarantine copy keeps the text.
`crbro_inspect view=sessions session=` accepts the id with or without its
prefix, like forget, and refuses anything that is not a day id — a relative
path used to be read back as a log. A log written by another process is
picked up on the next boot, not only on maintenance.

The consolidate note and the parameter text said session logs were not
searched. They are now, and both say what is still true: a hit in a log is a
paragraph of narrative; the facts belong in `crbro_learn`, where they come
back as facts with their topic and date. Twelve new tests, 305 in total.

## [2.1.2] — 2026-09-07

### A lock that Windows sometimes refuses is still a lock

The per-neuron write lock is a file created with the exclusive flag: one
creator wins, everyone else sees EEXIST and waits. On Windows the loser can
see EPERM or EBUSY instead — the holder is unlinking the lock at the very
instant the next writer tries to create it — and that was thrown as a real
error. In CI, two writers interleaving on one neuron hit it about one run in
five; on a desk it is two clients saving into the same topic at once. Both
codes are now a reason to wait and try again, under the same deadline as
before. No write is lost, and the concurrency suite runs clean on Windows.

## [2.1.1] — 2026-09-07

### The summary is stored whole again

2.1.0 cut a session summary at 3,000 characters. The reason it was there —
boot re-reading three summaries in full — had been solved in the same release
by reading only their first 240 characters, so the cut only ever lost the tail
of what the caller wrote. It is gone. The response now carries
`summary_chars` and, past 3,000, a note with the fact that still matters:
session logs are not searched by recall, so what lives only in a summary is
invisible to it. The facts belong in `crbro_learn`.

### Initiative, in the two places Claude Desktop reads

A field test in Claude Desktop passed everything except initiative: in a new
conversation the model did not boot the memory on its own, and asked whether
semantic recall was on it answered that it had no way to know — although
`view=status` reports exactly that. Claude Desktop does not read the
`instructions` a server returns at initialize
([anthropics/claude-code#43749](https://github.com/anthropics/claude-code/issues/43749)),
so the two levers it does honour carry the message now: `crbro_recall`'s
description says to call it before answering anything about the user, their
projects, preferences or past work, and `crbro_inspect`'s says `view=status`
answers questions about CRBRO itself. `instructions` are set as well, for the
clients that read them — Claude Code among them.

## [2.1.0] — 2026-09-07

### A memory you query, not one you dump

2.0.3 put a ceiling on every read. 2.1 removes the reason the ceiling was
being hit: reads that returned everything when the caller needed one thing.
Every figure below is the text a Claude Code session actually reads
(`content[0].text`; that client does not pass `structuredContent` to the
model), measured on the same 1,145-neuron brain, 2.0.3 → 2.1.0.

**`crbro_inspect view=neuron` is an index by default.** Header, counts,
connections, and every entry — map first, then errors, debts, preferences,
patterns, decisions and the long tail of facts — as an id, a kind, a date and a
160-character preview, 25 per page with `limit`/`offset`. Retired entries are
hidden and counted in `entries_pagination.hidden_retired`; with
`include_superseded=true` they come back with `revised` and `retired_note`.
`entries=[ids or exact text]` returns just those in full and names what it
could not find; `detail=full` is the old whole-neuron read, still budgeted.
The 307-fact neuron: 5,904 tokens shortened in 2.0.3 (66,952 whole in 2.0.2)
→ 1,887 for the complete index.

**`crbro_recall` hands you the handle.** Every result and every `also_matched`
line carries `entry_id` — stamped on each chunk at index time, so a decision
whose chunk is "text — rationale" still resolves to the decision's own id. The
default is five ranked results, down from ten (the metric is recall@3);
`matched_neurons` and `has_more` say how many neurons matched before the cut,
so five never reads as "only five". A hit longer than 1,200 characters comes
back as its opening with `content_truncated` and `content_chars`; the
`also_matched` lines are 300-character previews with their own ids. The
~90-token hint that repeated on every call is one line. Ten results:
6,242 → 3,941 tokens; five, the default: about 2,000.

**`crbro_boot` carries headlines.** The last three sessions come as their
opening 240 characters with `summary_truncated` and `summary_chars` beside
them; `hot_topics` are ten rows with the day, not twenty with the
millisecond; `active_context` no longer repeats `open_items` and
`recently_closed`, which boot already serves at the top level, capped at 12
and 8 with `_total` when there are more. The protocol block,
`memory_discipline` and `retired_tools` are untouched. 4,989 → 2,758 tokens.

**`crbro_inspect view=sessions` honours `offset` and caps each summary at
3,000 characters, declared** — except `limit=1`, which returns one log whole:
that is the door boot points at.

**`crbro_consolidate` caps the summary at 3,000 characters, after redacting.**
The card asks for a line; the field was taking whole reports, median 6,829
characters on the reference brain, re-read at every later boot. Credentials
are redacted before the cut so none is left half-written on disk; the
response returns `summary_truncated: {kept_from_this_call, sent}` with the
reason, and the parameter now says where the facts belong: in `crbro_learn`.

**Compact JSON on the wire.** Responses were pretty-printed; the indentation
was 4–27% of what the model paid, depending on the view (12% of boot, 27% of
`global_map`). `view=global_map`: 2,111 → 1,549 tokens.

`memory_discipline` teaches the habit in one sentence and dropped a
371-character lifecycle paragraph already carried by learn, revise and forget.
The search index is format 6 and rebuilds itself once on the first boot.
Brains on disk are untouched; a client that wants the 2.0 shape passes
`detail=full`. Eighteen new or adapted tests, 293 in total; the retrieval
benchmark is unchanged at 71% / 77% (79% / 85% with `also_matched`), now
matching hits by `entry_id`.

## [2.0.3] — 2026-09-07

### The brain outgrew what a tool result can carry

Nothing in the server had changed; the brain had. On a 1,145-neuron brain a
single `crbro_inspect view=neuron` came back at ~132,000 tokens, `view=sessions`
at ~84,000 and `crbro_boot` at ~20,000 — against a client that caps one tool
result at 25,000. The transcripts show what that looks like from the outside:
264 dumps of one neuron and 154 of boot written to a file instead of read,
1 on 3 September, 11 on the 6th, 4 on the 7th. A memory that answers with
"output saved to a file" is not answering.

The ceiling now lives in one place, `fitToBudget`, at the point every read
passes through, so a view added next year inherits it. Two passes: long texts
keep their opening and say how much was left behind; if that is not enough,
lists lose entries from the end, largest list first, never below one. Nothing
is cut in silence — whatever was trimmed comes back in a `truncated` block with
the real total, what was returned, and the exact call that fetches the rest.
The boot protocol block, `memory_discipline` and `retired_tools` are never
touched: a session that starts without them starts wrong.

Measured on the same 1,145-neuron brain, text plus structuredContent:

| Call | Before | After |
|---|--:|--:|
| `view=neuron` (the largest) | 132,673 | 11,606 |
| `view=sessions` | 84,300 | 9,569 |
| `view=global_map` | 28,940 | 3,669 |
| `crbro_boot` | 20,352 | 4,989 |
| `crbro_recall limit=50` | unbounded | 9,319 |

### crbro_learn refused the call its own description recommends

`neuron_id` was documented as skipping name matching entirely, but the schema
still demanded `topic`, so the call died at the SDK with `-32602` before the
handler existed — 38 times in one user's transcripts. The engine never reads
`topic` when the id resolves. It is optional now, and missing both is answered
with a sentence that says what to pass instead of `expected string, received
undefined`. A blank `topic` no longer creates a nameless neuron, and a
`neuron_id` that does not resolve is refused rather than written somewhere else.

### view=neurons said 50 when it meant 1,145

`total` carried the size of the page, so a client paging through the brain was
told there was nothing after the first 50. It now reports what matched the
filters before the slice, with `returned` and `has_more` beside it.

Fourteen new tests in `tests/budget.test.ts`, 290 in total.

## [2.0.2] — 2026-09-04

### A path that is still a template is not a path

The first field test of the desktop extension was run in a launcher that does
not know the MCPB format. It handed the server the literal placeholder
`${user_config.brain_path}` as its brain folder; being relative, Node resolved
it against the launcher's working directory, `C:\WINDOWS\system32`, and the
first mkdir died with EPERM. Nothing was written, but nothing worked either.

The same thing can happen inside Claude Desktop if the optional folder field
is left blank, which is exactly what a non-technical user does, so the defence
lives in the server, not in the manifest. `CRBRO_PATH` now has to be a usable
absolute path to be honoured: a value with an unexpanded `${…}` or `%VAR%` is
ignored with a note on stderr and the brain goes to `~/.crbro`; a relative
value is resolved against the home folder, never against whatever directory
the host launched us from; `~` expands. Covered by `tests/brain-path.test.ts`.
The `.mcpb` for this version is attached to the release.

## [2.0.1] — 2026-09-04

### Two annotations that lied, found by the grader

Glama rescanned 2.0.0 and scored the coherence of the surface 5/5 on all
four dimensions, up from 3.5 — and in the same pass gave two tools a 1/5 on
Behavioral Transparency for the same reason: a description that contradicts
its own annotation. It was right, and the annotations were the bug, not the
prose. Both are fixed here.

- `crbro_inspect` declared `readOnlyHint` while `view=neuron` went through
  `cortex.get`, which stamps `access_count` and `last_accessed`. A client
  auto-approves a read-only call; ours wrote to the neuron file. The view now
  reads through `cortex.peek` and touches nothing, and the payload no longer
  carries `access_bumped`.
- `crbro_context` declared `destructiveHint: false` while `clear` empties the
  whole working context and `discard_pending` drops an item without recording
  it in `recently_closed`. It now declares `true`, like `crbro_connect` since
  2.0.

**What this costs.** Heat's frequency term no longer counts reading a neuron
by id. It never counted `crbro_recall` — the read an agent actually makes —
so the signal was already inconsistent: heat now reflects writes and
connectivity, in every path. Hot topics keep working; what changes is that
looking something up no longer warms it.

2.0.0's per-tool scores were `crbro_context` 3.8 and `crbro_inspect` 4.1,
the two lowest of the fifteen, against an average of 4.7. The minimum
carries 40% of the quality term, so these two dragged the whole server.

## [2.0.0] — 2026-09-03

### One surface of 15 tools

The 23 tools of 1.x were nine reads with nine names, one writer that logged
sessions twice over, and a sync verb that was really an action of the space.
A model choosing between `crbro_neuron`, `crbro_neurons` and
`crbro_connections` was choosing between three doors to the same room, and
Glama's rubric said the same thing in its own words ("16-25 feels heavy").
2.0 folds them: the reads become views of one `crbro_inspect`, the session
log lives only in `crbro_consolidate`, and `crbro_sync` becomes `crbro_space
action=sync`. The brain format does not change — a pre-2.0 brain opens as it
is, and the one new field (`entry_status`, below) is a sidecar that every
1.x reader ignores.

**Why the eight core verbs were not renamed.** `boot`, `learn`, `recall`,
`revise`, `forget`, `connect`, `context` and `consolidate` are written into
the customer cards — the zero-crbro skill and its copies in every language of
the decks. A `verb_noun` rename would have bought one point of naming
consistency at the price of a break in every copy sold, so the eight keep
their names and their shipped parameters (`topic` + `neuron_id` in learn,
`from`/`to` in connect). The one card line that changes is `crbro_sync` →
`crbro_space action=sync`; boot and consolidate sync on their own, so a card
that still says `crbro_sync` loses the manual form and nothing else.

**23 → 15**

| 1.x | 2.0 |
|-----|-----|
| `crbro_status` | `crbro_inspect view=status` — everything status returned, plus `hot_topics_recalculated` |
| `crbro_neuron` | `crbro_inspect view=neuron neuron=<id or name>` — still bumps `access_count`, and says so |
| `crbro_neurons` | `crbro_inspect view=neurons [domain\|type\|min_heat\|limit\|offset]` |
| `crbro_hot_topics` | `crbro_inspect view=neurons` (the same rows, live instead of cached) · `view=status` (`hot_topics_recalculated`) |
| `crbro_connections` | `crbro_inspect view=neuron neuron=<id> [min_strength]` — connections come resolved with name, type and strength |
| `crbro_sessions` | `crbro_inspect view=sessions [limit]` |
| `crbro_global_map` | `crbro_inspect view=global_map` — computed live on every call, never written to disk |
| `crbro_session_log` | `crbro_consolidate summary=... [topics_touched=[...]]` — `topics_touched` logs neuron ids the session only read; write counters stay real (+ `crbro_context set_topics=[...]` to replace the active topics) |
| `crbro_sync` | `crbro_space action=sync [name]` |
| the other 14 | same names; what changed inside each is listed below |

**The descriptions, rewritten.** Every one of the 15 says in its first
sentence whether it reads or writes and names the neighbour to use for the
adjacent job (recall → "to read one neuron by id use `crbro_inspect
view=neuron`"; inspect → "to search by content use `crbro_recall`"; map →
"inspect already returns the map"). Mode and parameter detail moved into the
parameters' own `describe()` text. All 15 stay under 1,000 characters
(enforced by test), none names a retired tool, and the two whole-object
destructions — share commit, forget entire — use the same two-step wording:
call without `confirm_token`, show the dry run, call again with the token; a
stale token is refused.

**The three-stage lifecycle, spelled out.** A new truth that replaces an old
one → `crbro_learn` with `supersedes` (one call does both). Something stopped
being true, or was never true, and nothing replaces it → `crbro_revise` (kept
in the file, gone from recall, reversible with `status=active`). Something
must not exist on disk at all — a credential, personal data, a whole neuron →
`crbro_forget` (quarantine copy first). The sentence opens the three
descriptions and closes boot's `memory_discipline`. Every new parameter that
names a neuron is called `neuron` and takes an id or a name.

- `crbro_boot` returns `retired_tools` (the table above, keyed by the old
  name) on every call throughout 2.x, and `recent_sessions` with the last
  three logs; `last_session` is now the newest of them instead of the `null`
  that 1.x reported forever.
- `crbro_inspect` (read-only, structured): `view=neuron` reads by id or name,
  pages facts newest first (`limit`, `offset`, `include_superseded`), and
  resolves connections with `min_strength`. `view=neurons` takes `offset`;
  `view=status` adds `hot_topics_recalculated`; `view=global_map` is computed
  live — nothing writes `prefrontal/global_map.json` any more, and a dry-run
  maintenance writes nothing at all (a leftover cache file is deleted on the
  next real run).
- `crbro_revise`: `facts` is optional; `entries` retires decisions, patterns,
  errors and debts by exact text through a new `entry_status` sidecar keyed
  like `entry_dates` (retired entries leave recall like a superseded fact;
  `crbro_learn` refuses to re-add one and answers `skipped_retired`).
  `status=active` reactivates a retired fact or entry — local only on a
  shared neuron, and the response says so (`shared_warning`). `summary`,
  `domain`, `tags` (the whole list is replaced — re-send `priority:` and
  `source:` tags on protocol neurons) and `name` (the id never moves) edit
  metadata in the same call.
- `crbro_forget`: exactly one mode per call. `facts` (decision and pattern
  removals now travel to spaces as purge ops, as errors and debts already
  did), `entire` (two-step with `confirm_token` derived from the neuron's
  counts; refused while the neuron is shared — unshare first), `restore`
  (newest quarantine copy, merged into the neuron if it exists again),
  `merge_into` (union of everything, synapses rewired, source quarantined
  then deleted), `session` (one day's log, quarantined first).
- `crbro_connect`: `from`/`to` are validated (unknown id is an error, not a
  dangling synapse), `type` is optional (default `conceptual`), `strength`
  sets an absolute value instead of the 0.5 / +0.1 rule, and
  `action=disconnect` deletes the synapse — which is why the tool now carries
  `destructiveHint: true`.
- `crbro_context`: a call with no arguments reads and no longer rewrites the
  file (`written: false`); `discard_pending` drops an open item without
  recording it as done; `clear` empties topics, pending and recently closed.
- `crbro_consolidate` passes the summary through the credential filter
  before storing it (`redacted` lists the kinds found, never the values),
  returns `session_id`, and sets the context's `last_session`. It is the only
  way to log a session.
- `crbro_learn` on an exact duplicate of an active fact updates `confidence`
  in place and takes `keywords_replace`; the response says `duplicate` and
  `updated_in_place`. Teammates only ever receive the union of keys and the
  maximum confidence, so lowering either does not propagate — documented,
  not fought.
- `crbro_maintenance`: `repair` fixes what the integrity check finds
  (dangling connection ids, orphan synapse files, stale `entry_dates` /
  `entry_status` keys, manifest counters); `unarchive` brings ids (or `all`)
  back from `archives/` and reindexes them. Retired debts no longer count as
  open. The report gains `archives_count`, `repairable`, `repaired`,
  `repairs[]`.
- `crbro_audit` also scans the session logs (`session_findings`,
  `sessions_affected` — kinds only, as everywhere).
- `crbro_space action=leave` pushes pending notes, deletes the local copy of
  the space and stops following its neurons; the remote is untouched.
  `crbro_share unshare:true` stops following one neuron (tombstoned in
  `unshared.json`, re-shareable later, and only then can it be forgotten).
  What was already sent stays in the remote and in teammates' brains — the
  description says so instead of "sharing cannot be undone".
- Search index version 4 → 5: retired entries are excluded from chunks, so
  the index rebuilds once on the first start after upgrading. Ops version
  stays 1: an older teammate reads the two new purge kinds and ignores them,
  a degradation, not a corruption.
- 22 tool-surface tests (264 in the whole suite, with tests/surface2 and
  tests/lifecycle2 covering the engine side), speaking real MCP to the server over
  an in-memory transport: the fifteen names and nothing else, no retired
  name in any description or schema, disconnect on an absent synapse,
  forget entire without token, revise `status=active` back into recall,
  context without arguments not writing, dry-run maintenance leaving no
  global map file.

**Upgrading — what breaks and what does not.** A client that calls one of
the nine retired names gets the MCP "unknown tool" error; `retired_tools` in
boot only helps a model that has booted, which is the first thing every card
does. A 1.x card against a 2.0 server loses only the `crbro_sync` line. Claude
Code hooks that name `mcp__crbro__crbro_session_log` in a matcher or in the
session-start text must drop it, or every session start orders a call to a
tool that no longer exists. The cards ship before or with the server, never
after (see RELEASING.md). 1.x stays installable — `npx -y crbro-memory@1` —
for anyone who cannot move yet; it receives no new features.

**Cost, measured.** The 15 definitions weigh 25,866 characters of
description + input schema (~6.5k tokens) in a real `tools/list`, against
21,662 (~5.4k) for the 23 of 1.13: fewer tools, not fewer characters,
because each parameter a fold absorbed still explains itself inside the tool
that took it. Counting the output schemas of the three readers the whole
payload is 34,047 characters (~8.5k tokens). Claude Code defers tool
definitions and pays only for the ones it uses; Claude Desktop and Cursor
pay it on every request.

### Also

- Fixed in the merge: a fact saved before facts had ids (brain format 1.0,
  any neuron older than 1.5) could never be superseded or retracted by a
  teammate. The incoming `fact` note landed on it by text, but the `status`
  note that followed carried only the fid, which nothing had registered for
  the local fact, so the retirement was dropped — on every replay. Found by
  materialising a 1.16 brain plus a hand-written 1.x log under 2.0; 1.16 has
  the same hole. Two tests in `tests/sync.test.ts` pin it.
- Lockfile-only security refresh: `npm audit` reported 9 advisories (6 of
  them in the production tree) in the express chain that the MCP SDK pulls in
  — qs, postcss, vite, nanoid. `npm audit fix` clears all 9 within the
  declared ranges, so no dependency range moved. It surfaced in a registry
  build log, not in ours: our CI never ran audit. The npm tarball ships no
  lockfile, so anyone installing crbro-memory already resolved the fixed
  versions.

## [1.16.0] — 2026-09-03

### Semantic recall, installed by default

Until 1.15 the embedding layer was opt-in twice over: install it, then set
an env var. The author's call for 1.16 is the opposite default — the best
recall out of the box — so `npx crbro-memory init` now installs the runtime,
downloads the model and embeds the existing brain (once per machine, about
500 MB, a few minutes), and the layer is on wherever the runtime is present.
The costs did not change and are still printed: ~0.5 GB of RAM per running
server, ~13 s of model load per process in the background, 20–45 ms per
saved line. Measured on top of save-time keywords it adds 2 to 5 points of
recall@1; that is what the RAM buys.

- `init --no-semantic` skips the install; `CRBRO_SEMANTIC=0` turns the layer
  off; `CRBRO_SEMANTIC=1` forces it on. `semantic status` says which, and
  whether the model is downloaded.
- `semantic install` now also downloads the model and embeds the brain, so
  one command leaves recall semantic.
- A rebuild after an upgrade embeds in the background: boot no longer waits
  for a big brain to be embedded, recall serves what is embedded so far, and
  overlapping embedding jobs are serialised.
- `crbro_boot` says when the layer is not installed (`semantic_hint`);
  `crbro_status` reports it (`semantic`).
- The retrieval benchmark and the test suite pin the layer off unless asked,
  so the pre-registered keyword numbers stay comparable. The Docker image
  carries no semantic runtime.

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
