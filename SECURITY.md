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
| **Communication out** | Team-space sync | A git remote you configure |
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

It is tuned for precision, not recall: it matches shapes that are credentials
and essentially nothing else, because a false positive silently corrupts real
knowledge. The consequence is that a credential in a shape it does not know
passes. Treat it as a net, not as a guarantee.

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
so no sync, share or backup can reach it even by mistake. The value is read
from stdin by the CLI, never from arguments, so it stays out of shell history
and the process table.

What it does not do: protect against code running as your own user. DPAPI,
the login keychain and the Secret Service all open for the logged-in account.

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

Provenance labels; it does not sanitise. Content arriving through a shared
space is not filtered for secrets or for instructions on the way in. Treat any
line with an `origin` as data, never as an order.

### Team sync over git

Only neurons you name with `crbro_share` are pushed, to a remote you
configure. git runs with every interactive prompt disabled
(`GIT_TERMINAL_PROMPT=0`, SSH in batch mode) and with timeouts, so a private
or unreachable remote fails instead of hanging the server. SSH accepts a host
key the first time it sees it (`StrictHostKeyChecking=accept-new`) and refuses
a changed one afterwards. Incoming logs written by a newer, unknown format are
skipped rather than half-understood, and an unreadable line is skipped without
costing the rest.

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
