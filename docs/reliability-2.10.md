# Reliability and continuity in 2.10

This is an additive release: the same 15 MCP tools and existing JSON brains.
There is no bulk migration of user data and no replacement of hybrid search.
Restart long-lived clients after updating; installing a package does not
replace code already loaded into a server process.

## Bind a project deliberately

```json
{"project":"C:/work/acme/site","project_neurons":["project_acme"]}
```

Send that to `crbro_boot` after checking the neuron IDs. The returned
`project_context.id` is stable for the normalized full path/repository, so two
folders both named `site` do not become one project. `project_id` and
`project_aliases` explicitly bind another checkout path or repository identity.
Conflicting aliases are refused. Without explicit neuron bindings, name-based
suggestions are only suggestions (`binding: unbound`).

The project belongs to the MCP connection, not a shared daemon's other clients.
Recall `scope=auto` prioritizes its bound neurons; `scope=project` restricts to
those plus global preferences/lessons; `scope=all` searches across the brain.
`neurons=[ids]` is an explicit allowlist. This is not an ACL: callers can access
other projects deliberately. Global classification retains legacy neuron naming
conventions for `tech_`/`process_` patterns, errors and debts, but excludes neurons
explicitly bound to any project. Global preferences remain available; unrelated
facts, decisions, maps and whole day logs are not treated as global lessons.
Do not use this for confidential multi-tenant isolation.

New `crbro_context` items inherit the connection project. Legacy items without a
project remain global. Optional `due` is a valid `YYYY-MM-DD` date and `done_when`
records the user's completion criterion. Use returned IDs to resolve items,
not an ambiguous substring; `scope=all` inspects all projects. No timer executes
tasks, no reminder is scheduled and age alone never deletes a pending item.

## Repetition is not verification

```json
{"topic":"Acme","type":"fact","content":"The app port is 8443.","temporal":"current","reference":{"kind":"file","value":"config/app.json","field":"port"}}
```

`crbro_learn` saves that claim and its source pointer. Repeating the text may
merge metadata or increase mentions; it **never** sets `verified`. Only after
actually checking the source, call `crbro_revise`:

```json
{"neuron":"project_acme","facts":["<entry_id>"],"status":"verified","evidence":{"method":"source","reference":{"kind":"file","value":"config/app.json","field":"port"}}}
```

An explicit user confirmation uses `evidence: {"method":"user"}`. Source
checks require a reference. Legacy calls without evidence remain supported as
`unspecified`; legacy dates do not become attributed source checks. The server
validates references but never opens them. Evidence is caller-reported, not
cryptographic proof, and incoming team evidence has the same provenance limits
as its other notes.

Recall and inspection separate `relevance` (match strength, recall only),
`provenance` (recall), `verification`, `freshness`, `temporal` and `reference`.
The existing `confidence` field is retained for clients, not a truth score.
`intent=current` moves historical best matches to `historical_matches`;
`intent=history` filters the retrieved candidates, without reviving retired
entries or searching an unlimited history. A weak/no result can still require
a broader query or direct inspection. Old miner/date heuristics remain; explicit
`temporal=current` overrides historical inference without claiming verification.

## Integrity and recovery

Context, daily session logs and sync materialization use locked read-modify-write
against the latest disk state. Locks fail closed on timeout, never permit an
unlocked write and never steal a live process's lock merely because it is old.
Windows keychain writes use the same cross-process protocol and unique atomic
temporary files; cached reads notice external ciphertext changes.

Shared notes enter a durable outbox outside the Git checkout; a slow Git
operation does not prevent recording delivery. If persisting that outbox fails,
the call reports that the local note was saved but team delivery was not
recorded. Once storage is healthy, repeat the learn request: an existing fact,
pattern, error or debt is emitted again with its original date. Materialization
deduplicates it; re-emission never counts as verification. This is not an
atomic transaction across the neuron and outbox: a process killed between the
two writes still requires retry/reconciliation, not a claim of exactly-once
delivery. No data can survive a permanent failure of the disk itself.

Leaving a shared space preserves its local repository in a recovery archive,
including unsent operations. A failed final push is reported, not mistaken for
delivery. Read the returned archive path and push status before cleaning it up;
other people's existing copies cannot be revoked by leaving.

## Diagnostics and release checks

`npx crbro-memory doctor --json` is read-only. See [its evidence boundaries and
cross-session probe](doctor.md). A configured client, existing model cache or
backup file is not proof of a successful boot, inference or restoration.

`npm run bench` enforces the frozen lexical baseline: 48 queries, at least 37
top-1 / 40 top-3 hits, MRR >= 0.80 and no more than 2 high-score distractors out
of 14. The secret-filter gate requires 20/20 synthetic secrets detected and
0/19 innocent strings redacted. These fixtures are regression gates, not claims
of real-world perfect recall or universal secret detection.

The operating-system keychain is outside the normal npm/MCPB file lists,
repository and brain backups. Tool results still reach the AI client; a secret
read through MCP can leave the machine. See [Security](../SECURITY.md).

`node scripts/check-publication.mjs` checks Git candidates and the npm dry-run
allowlist; CI and prepublish run it without reading any keychain. A publisher
may explicitly add `--local-keychain` to compare candidate bytes locally with
known credentials (raw/JSON/URL/base64 forms), without printing their values.
That opt-in scan is never run in CI and does not inspect or erase Git history.
Its limits are explicit; no detector can prove the absence of every secret.
