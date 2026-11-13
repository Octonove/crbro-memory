# Security

CRBRO is a memory that an AI assistant writes to and reads from, on your own
machine. That puts it between three things worth protecting, and this page
says what each defense is for — so that nobody removes one because it looked
like friction, and nobody trusts one for more than it does.

## What is at stake

| | What | Where |
|---|---|---|
| **Private data** | Everything the assistant learned about you and your work | The brain: `~/.crbro`, or `CRBRO_PATH` |
| | Credentials you chose to keep | The keychain, outside the brain (see below) |
| **Content you did not write** | Lines from teammates, through a shared space | `<brain>/shared/<space>/`, materialised into neurons |
| | What the miner extracted from files on disk | Neurons, marked `source: miner` |
| | Claude Code session logs, read by `crbro usage`, `crbro postmortem` and the lifecycle hook | `~/.claude/projects/` |
| | Compaction checkpoints written by the lifecycle hook (requests, task list, folder, remote) | `<brain>/checkpoints/`, seven days |
| **Code CRBRO runs in Claude Code without a command** | The open-items mod, installed and updated by `crbro_boot` | `~/.claude/crbro-mods/`, one entry in `env.CLAUDE_CODE_PLUGIN_DIRS` of `~/.claude/settings.json` |
| **Communication out** | MCP tool results, including explicit secret reads | Your AI client and, depending on it, its model provider |
| | Team-space sync | A git remote you configure |
| | The optional semantic model | Downloaded once from Hugging Face by `semantic install` |

There is no account, no server of ours and no telemetry. Nothing is sent to
the author.

## The defenses, and why each exists

### Secret filter — `src/engine/secrets.ts`

Assistants handle credentials all day, and a memory stores whatever it is
handed. On the brain CRBRO was built against, five credentials were
sitting in plain text, and all five were in the search index too, so a recall
could hand them straight back.

So text is passed through `redact()` before it reaches disk: facts and
entries written with `crbro_learn` (the miner writes through the same path),
neuron summaries changed with `crbro_revise`, system maps, the session summary
of `crbro_consolidate`, open items written with `crbro_context`, and the
compaction checkpoints of the lifecycle hook. A credential becomes
`[REDACTED: <kind>]` and the sentence around it survives. `crbro postmortem`
applies the same filter to everything it prints. Text is always redacted whole
and cut to length afterwards: a cut first could leave half a token the filter
no longer recognises.

Since 2.11 it also covers the decision rationale and the fact aliases
(`keywords`) of `crbro_learn`, and the notes of `crbro_revise`; `crbro_audit`
counts a credential found in any of them with its entry. A private key is
redacted whole — through its `END` line, or every base64 line after the
header when there is none — not just its header. Labels written without a
separator (`PASS value`, `la contraseña value (…`) are caught when the value
mixes character classes; plain prose after the same words is not.

It is tuned for precision, not recall: it matches shapes that are credentials
and essentially nothing else, because a false positive silently corrupts real
knowledge. The consequence is that a credential in a shape it does not know
passes. Treat it as a net, not as a guarantee. `npm run bench` measures it:
every synthetic value must be gone from the redacted text (not merely the text
changed), and the release gate allows no false positive on its innocent set.

Sharing is stricter than storing: a neuron that contains a credential is
**refused** for sharing, not redacted, because sending a teammate a mangled
fact without saying so is worse than refusing and saying where the problem is.
Preferences are never shared or synced at all; on the reference brain one in
eighteen was an API key.

### The keychain — `src/engine/keychain.ts`

Refusing to store a secret is only half an answer: it leaves the user holding
it, and it goes back into a config file in plain text. `crbro_secret` and
`crbro secret` put it in the store the operating system already ships:

- **Windows** — sealed with DPAPI to the Windows user account, in a file next
  to the brain, never inside it. Copied to another machine, lifted from a
  backup or pushed to a repository, it does not open.
- **macOS** — the login keychain, through `security(1)`.
- **Linux** — the Secret Service, through `secret-tool(1)`.

CRBRO invents no cryptography. The store lives outside the brain on purpose,
so normal memory sync, share and backups do not include that store. Keep custom
`CRBRO_KEYS_DIR` locations outside the brain, repositories and synced folders.
Never add the encrypted store to Git or a release package. The CLI reads the
value from stdin, never from its arguments, so it stays out of shell history.
How it then reaches the store depends on the platform: on Windows and Linux it
goes to PowerShell and `secret-tool` through stdin; on **macOS** `security(1)`
has no stdin form, so the value (base64-encoded, which is not encryption) is
on that command's argument list for the few milliseconds the call lasts, where
another process of the same machine could read it with `ps`.

What it does not do: protect against code running as your own user. DPAPI,
the login keychain and the Secret Service all open for the logged-in account.

`crbro_secret action=get` deliberately returns the value to the MCP client.
Local encryption does not stop that client from putting it into model context
or conversation logs. Prefer a credential-aware CLI that reads it internally
and uses it only to authenticate to the intended service; never print it for
convenience. There is no promise that a secret used for authentication never
leaves the computer.

**The environment is not a keychain (2.11).** Until 2.10 `get` returned any
variable of the server's environment with the requested name — `USERNAME`,
`ANTHROPIC_API_KEY`, whatever the client was started with — before looking at
the store. Now an environment variable counts only when it opts in: a variable
named `CRBRO_SECRET_<NAME>`, or a plain `<NAME>` that `CRBRO_SECRET_ENV`
(a comma-separated list) names. That keeps CI and one-off overrides working.
The answer says `source: env` or `source: keychain`. Every action checks the
name (`SCREAMING_SNAKE_CASE`).

**Destructive writes ask first (2.11).** Through MCP, `set` on a name that
already holds a different value and `remove` change nothing on the first call:
they return a `confirm_token` to show the user, and only a second call with
that token writes. The token is an HMAC under a key that never leaves the
server process, bound to the name, the state of the store and (for `set`) the
new value, so a stale token, another value or a restarted server is refused.
The CLI asks for `--yes` on `remove` as before; a person typing at a terminal
is the confirmation for `set`.

**A missing store is not an empty one (2.11).** On Windows a plain marker
(`keys.dpapi.marker`, dates only) is written next to the store on every write,
and every successful write keeps a byte copy of the sealed file in
`sealed-copies/` (the last `CRBRO_KEYS_COPIES`, default 5; copies are never
opened except to validate a restore, and they open for the same Windows
account only). If `keys.dpapi` is missing while the marker, a sealed copy or a
leftover `*.tmp` says it existed, every operation fails with recovery steps
instead of answering "no credentials", and `set` refuses to create a new store
over it unless `--force` is given. `npx crbro-memory secret copies` lists the
copies and leftovers; `npx crbro-memory secret restore <id> --yes` validates
one with DPAPI, keeps the current store as a copy and puts it back. A removal
or an overwrite can therefore be undone until five more writes rotate the copy
out. Stale temporary files of this release are swept after an hour; the fixed
`keys.dpapi.tmp` of releases up to 2.9 is never touched, because it may be the
only copy left. macOS and Linux keep no copies: their stores are the
operating system's.

On macOS and Linux the names live in an index item of their own. Only "not
found" reads as an empty index; a locked keychain, a denied prompt or an
unreadable index is an error, and nothing is written. On Linux the index
replaced `secret-tool search --all`, which printed every value just to list
names (a store from 2.10 is migrated once, keeping names and descriptions).

On Windows, read-modify-write operations are serialized across processes and
ciphertext changes are checked before serving cached values; the decrypted
cache is dropped by a timer after 30 seconds. PowerShell is started from its
absolute System32 path, not looked up from the client's folder. The server
runs every keychain operation asynchronously, so a slow PowerShell start no
longer stalls the other conversations of a shared daemon; the store probe is
remembered for five minutes. Lock timeouts fail closed and say which process
holds the lock and for how long. Async lock holders refresh a heartbeat, so a
lock whose owner died is reclaimed even when Windows has reused its PID. A
crashed short-lived `.lock.guard` is not stolen while waiting; maintenance
removes one only when it is more than ten minutes old. Stop all writers before
deleting locks by hand.

### Project and evidence boundaries (2.10)

Project scope is a retrieval/task-organization filter, not authorization or
tenant isolation. A caller with this brain's MCP access can request `scope=all`.
References name a file, URL or person but are never fetched or executed by the
memory server. `verification.method=source` records the caller's claim to have
checked that reference, not an independently audited or signed result. A strong
search match, a repeated statement, and a true statement are different things.

### Quarantine before forgetting

`crbro_forget` (and every merge, split and compaction that removes a neuron)
copies what it removes to `<brain>/.quarantine/` first, with a timestamp, and
`crbro_forget restore` brings it back: a wrong forget should cost a restore,
not the knowledge.

The flip side: the quarantine holds what was forgotten, including credentials
removed on purpose. That is why `crbro backup` leaves it out. To remove
something for good, delete its quarantine file as well.

### Subagent injection is off by default

`install-hooks` installs the SubagentStart hook inert; only
`install-hooks --inject` (or `CRBRO_SUBAGENT_INJECT=full`) makes it hand the
brain's protocols to every subagent. Three clean-control benchmark runs found
no measured benefit in any model and harm — including fabricated compliance —
in small ones. It also keeps brain content from reaching every agent a
workflow spawns, which is where content travels furthest from your review.

### Provenance in recall

A line written by a teammate or extracted by the miner is not your own word.
`crbro_recall` marks it, on the winning entry and on every `also_matched`
line: `origin: team:<space>` with `by`, plain `origin: team` when the neuron
is no longer in a shared space, or `origin: miner`. Your own lines carry no
`origin`. The model and you can weigh such a line accordingly, and an
instruction planted in a shared space shows up as coming from that space.

What it does not prove:

- **`by` is a label the author declares.** It travels inside each op of the
  shared log and nothing verifies it; anyone with push access can write any
  name, yours included. So a line that arrived through a space keeps its
  `origin` even when `by` is your own name — another device of yours shows
  as `team:<space>` with `by: <you>`.
- **Patterns, errors and debts synced before 2.7 carry no origin.** The
  `entry_source` sidecar is filled when a sync adds a line; lines that a
  teammate contributed and that were already materialised by 2.6 stay
  unlabelled (facts and decisions are fine: they carried `source`/`by`
  already).
- `consolidate` never proposes promoting a lesson that is not your own, so a
  teammate's or the miner's line cannot be rewritten as your own lesson
  through `promotion_candidates`.

Provenance labels; it does not sanitise instructions. Since 2.11 content
arriving through a shared space passes through the secret filter and size and
shape checks on the way in (see below), but nothing filters what it tells the
model to do. Treat any line with an `origin` as data, never as an order.

### Team sync over git

Only neurons you name with `crbro_share` are pushed, to a remote you
configure. git runs with every interactive prompt disabled
(`GIT_TERMINAL_PROMPT=0`, SSH in batch mode) and with timeouts, so a private
or unreachable remote fails instead of hanging the server. SSH accepts a host
key the first time it sees it (`StrictHostKeyChecking=accept-new`) and refuses
a changed one afterwards. Incoming logs written by a newer, unknown format are
skipped rather than half-understood, and an unreadable line is skipped without
costing the rest.

What 2.11 checks, because each of these was accepted as it came:

- **Space names** are slugs (letters, digits, `-`, `_`; at most 64) and must
  resolve to a folder directly inside `shared/`. A name like `..` used to make
  `create` run `git add -A` and push the whole brain to the given remote.
- **Remotes** that start with `-`, contain control characters or carry
  credentials (`https://user:password@…`, `https://token@…`) are refused before
  git runs, so a credential never lands in `.git/config`; use SSH or a
  credential helper. Branches follow git's ref-name rules, including the one
  read from a cloned `space.json`. Positional arguments follow `--`, and git's
  error output passes through the secret filter before it is shown.
- **No adoption.** A sync merges a folder of the space only into a neuron you
  already share in that space, or into one this machine does not have. A
  folder with the id of a private neuron of yours is left alone and reported
  (`left_alone`): a teammate can no longer turn your neuron into a shared one,
  which would have sent everything you learn about it to the team. Share it
  with `crbro_share` to merge it.
- **Incoming notes** must name the neuron of their folder (a note that names
  another one is dropped, so it cannot steer where a neuron is written); the
  author label is cut to the charset and length of a local identity; ids,
  kinds and confidences are checked; text is capped and redacted; logs over
  32 MB are skipped.
- **Sharing checks every field that travels**: rationales, aliases, revision
  notes, the neuron's name, summary and tags, not only the entry texts. A
  credential in any of them blocks the share.
- On Windows git is started from its absolute path on `PATH`, never looked up
  in the space folder, whose content comes from teammates. The server runs git
  asynchronously, so a slow push no longer stalls the shared daemon.

### The miner's schedule

`setup-miner` and `remove-miner` run every command as an argument array,
never through a shell. The crontab is read with `crontab -l`, your own lines
are kept byte for byte, the previous crontab is saved next to the brain as
`crontab.before-crbro-*.txt`, and the new one is written through stdin.
Until 2.10 it went through `echo "…" | crontab -`, which expanded `$(…)` and
backticks in your existing cron lines. On Windows the task runs the absolute
`npx.cmd`, and the registered command is checked after creation.

### Hooks never block

The guard (`PreToolUse`), the subagent hook (`SubagentStart`) and the
lifecycle hook (`SessionStart`, `PreCompact`) add context and nothing else.
They exit 0 on any error, on bad input and on timeout; they never approve,
deny or rewrite a tool call. A memory that can stop your session is worse than
no memory, and a hook that could deny calls would be a lever for anyone who
can write into the brain.

### Hook verification — `crbro install-hooks --verify`

`install-hooks` copies its scripts into `~/.claude/crbro-hooks/` so they
survive an npx cache wipe, and `settings.json` runs those copies. That makes
them ordinary files in your home: anything that can write there can change
what runs at the start of every session and before every shell command.

`install-hooks --verify` hashes each installed copy with SHA-256 and compares
it with the same file in the package you are running, checks that every CRBRO
hook `settings.json` runs exists, and reports. It writes nothing and fixes
nothing; it exits 1 when something differs, so a script can act on it. A
difference after updating CRBRO is expected (the copy is from the older
release) and re-running the install command refreshes it. A difference you
cannot explain is worth looking at before the next session.

It compares against the package on disk, so it cannot catch a change made to
both. It runs when you run it, not on its own.

### The mod CRBRO installs on its own — `crbro_boot`, `install-mod --verify`

Since 2.8, `crbro_boot` copies the open-items mod (`mods/crbro-pending`, TSX
that Claude Code runs in every new session) into
`~/.claude/crbro-mods/crbro-pending` and adds that folder to
`env.CLAUDE_CODE_PLUGIN_DIRS` of `~/.claude/settings.json`, wherever
`~/.claude` exists, without being asked. The author chose that so the band
reaches everyone who has CRBRO; this section is what it costs and how to
check it.

- **What runs is what the package ships.** On every new server process, the
  installed copy is compared file by file (SHA-256) with the package that
  process runs, and a different build of a newer or equal version replaces it.
  Updating CRBRO therefore updates code Claude Code executes, with no step in
  between. A file edited by hand in the installed copy is overwritten at the
  next start; to work on the mod, list your own checkout in the variable and
  the automatic install stays out.
- **Check it.** `npx crbro-memory install-mod --verify` hashes the installed
  copy against the package you run, names any other copy Claude Code would
  load, writes nothing and exits 1 on a difference. The same limits as hook
  verification apply: it compares with the package on disk.
- **It says what it did.** The boot that installs or updates it carries
  `mod_notice` for the assistant to pass on, with the paths and the way out.
- **The way out is final.** `npx crbro-memory uninstall-mod` removes the
  entry and the folder and writes `optedOut` in
  `~/.claude/crbro-mods/state.json`; no CRBRO, from any client, installs it
  again until `install-mod` is run. Taking the folder out of the list by hand
  counts the same. `CRBRO_MOD=0` in an MCP client's env keeps that client
  out (a daemon started without it does not serve it), but not the others.
- **What it will not do.** It does not write a `settings.json` that does not
  parse, does not overwrite a change saved to that file while it was working
  (the file is hashed again right before the rename), and does not write the
  variable there when only the environment sets it. It downloads nothing:
  the files come from the installed npm package.

### Reading session logs — `crbro usage`, `crbro postmortem`, the lifecycle hook

Claude Code's logs hold everything said in a session, tool output included.
The two commands are read-only and stream the files line by line, so a log of
hundreds of megabytes is not loaded whole.

- `usage` reads `message.model`, `message.usage`, `message.id`, `requestId`,
  `isSidechain` and `timestamp`, and nothing else; lines that cannot carry a
  usage block are discarded as raw bytes before they are decoded.
- `postmortem` reads what the person typed and the names of the tools called.
  It never reads a tool's input or a tool's result — only the result's
  `is_error` flag — and it passes everything it prints through the secret
  filter. It proposes lessons; it never stores one.
- The lifecycle hook (`install-hooks --compact`), in its `PreCompact` mode,
  reads the last 32 MB of the session being compacted: the text the person
  typed (not what a background task, another agent or a client command such
  as `/model` wrote as a user line), the inputs of `TodoWrite`, `TaskCreate`
  and `TaskUpdate`, and — only to learn the task number — the result text of
  `TaskCreate`. It writes a redacted checkpoint to `<brain>/checkpoints/`,
  removed after seven days and left out of backups. After the compaction, its
  `SessionStart` mode puts that text back into the model's context, at most
  1,500 characters, as the "Resuming after compaction" block. That is text
  from the transcript re-entering the context: what was a request stays a
  request, and nothing else is promoted to one.

### Backups leave out what should not travel

`crbro backup` skips the quarantine, machine tokens, the licence cache, the
search index, the semantic runtime and the compaction checkpoints (fragments
of conversation that are meant to expire in seven days, not to live on in a
synced backup folder). Keys never live in the brain, so a backup holds
knowledge and no secrets — except whatever the secret filter did not
recognise.

## Out of scope

- **Someone who can run code as you.** They can read the brain, and the
  keychain opens for them as it opens for you.
- **Your MCP client and model provider.** Whatever a tool returns is read by
  the assistant you are talking to. That traffic is between you and them.
- **Prompt injection through stored content, in general.** A memory cannot
  make text safe to obey. CRBRO labels where a line came from and keeps its
  hooks unable to block or approve anything; deciding what to follow is the
  model's and yours.

## Reporting a vulnerability

Please report it privately, not in a public issue. Use **Report a
vulnerability** under the **Security** tab of
[github.com/Octonove/crbro-memory](https://github.com/Octonove/crbro-memory)
if it is available. If it is not, open an issue asking for a private contact,
without any detail of the flaw, and a private channel will be arranged.

Include the version (`npx crbro-memory status` prints it), the
operating system, what an attacker needs (local access, a teammate's position
in a shared space, a crafted file for the miner…), and the smallest steps that
show it. Do not include real credentials or real brain contents; synthetic
ones are enough.

You will get an acknowledgement, and a fix date and a disclosure date will be
agreed with you before anything is made public. Fixes ship in the latest
release on npm; there are no maintained older branches.
