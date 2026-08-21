# 🧠 CRBRO — Persistent Neural Memory for AI

[![npm](https://img.shields.io/npm/v/crbro-memory)](https://www.npmjs.com/package/crbro-memory)
[![license](https://img.shields.io/github/license/Octonove/crbro-memory)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Claude%20Code%20%C2%B7%20Claude%20Desktop%20%C2%B7%20Cursor-1E3A5F)](https://modelcontextprotocol.io)

**CRBRO** is a local MCP (Model Context Protocol) server that gives your AI assistant **persistent long-term memory** across sessions. It uses a biological neural architecture — cortex, synapses, hippocampus — to store, connect, and retrieve knowledge automatically.

![CRBRO demo](docs/demo.gif)

Free and open source (MIT). All 21 tools included — no license, no account, no tiers.

> ⭐ **If CRBRO gives your AI a memory worth keeping, a star on GitHub is the best way to support it.**

## Features

- **🧬 Biological Architecture** — Knowledge organized as neurons (cortex), connections (synapses), and session memory (hippocampus)
- **🔍 Fact-Level Search** — Powered by [Orama](https://orama.com/). Every fact is indexed on its own, so a topic with hundreds of facts stays as findable as one with three, and each result comes back with the exact fact that matched and the date it was recorded
- **🔥 Heat Scores** — Automatic relevance tracking based on frequency, recency, and connectivity
- **✏️ Correctable** — Knowledge can be superseded or retracted, not just piled up. A memory that only appends keeps serving yesterday's answer with today's confidence
- **🔐 Credential-aware** — API keys, tokens and passwords are replaced with a marker before they touch the disk. The sentence around them survives; the secret does not
- **👥 Safe with two editors open** — Writes are serialised per neuron, so running CRBRO in two IDEs at once does not silently lose facts
- **🤝 Shareable per project** — Put one project in a team space and it stays in step across everyone's machine. Everything else in your brain never leaves it
- **🗺️ Global Map** — Cluster detection and cross-domain bridge identification
- **⛏️ Knowledge Miner** — Optionally scans your local `.md`/`.txt` notes and feeds them into the brain
- **🔒 Fully Local** — Runs on Node.js alone: no Python, no Docker, no databases, no external services. Your memory never leaves your machine
- **💾 File-Based** — All data stored as readable JSON files in `~/.crbro/` — inspectable, diffable, and versionable with git
- **🔌 MCP Native** — Works with Claude Desktop, Claude Code, Cursor, Windsurf, and any MCP-compatible client

## Quick Start

### 1. Initialize

```bash
npx crbro-memory init
```

### 2. Add to your MCP config

> **Register CRBRO at the user level, not per-project.** Your brain lives in
> `~/.crbro/` and is shared across every folder — but if you register the
> server inside a single project, other folders won't have the tools and it
> will *look* like the memory is gone. User-level registration makes it
> available everywhere, which is the whole point.

**Claude Code** (one command, available in every folder):
```bash
claude mcp add --scope user crbro -- npx -y crbro-memory
```

**Claude Desktop** (`~/AppData/Roaming/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "crbro": {
      "command": "npx",
      "args": ["-y", "crbro-memory"]
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json` — the one in your home folder, not a project's `.cursor/`):
```json
{
  "mcpServers": {
    "crbro": {
      "command": "npx",
      "args": ["-y", "crbro-memory"]
    }
  }
}
```

### 3. Start using it

Your AI will now have access to 21 memory tools. Start any session with `crbro_boot`.

## Tools

| Tool | Description |
|------|-------------|
| `crbro_boot` | Boot the brain at session start — loads hot topics and context |
| `crbro_status` | Brain status — neurons, synapses, sessions count |
| `crbro_learn` | Store a fact, decision, pattern, or preference |
| `crbro_neuron` | Read a specific neuron (topic) with all its knowledge |
| `crbro_neurons` | List neurons with optional filters (domain, type, heat) |
| `crbro_recall` | Search every stored fact, not just topic names — returns the fact that matched |
| `crbro_connect` | Create or strengthen a connection between neurons |
| `crbro_connections` | Get all connections for a neuron |
| `crbro_session_log` | Log a session summary |
| `crbro_sessions` | List recent sessions |
| `crbro_context` | Read/update active working context |
| `crbro_hot_topics` | Get the most active topics by heat score |
| `crbro_global_map` | View the neural network — clusters and cross-domain bridges |
| `crbro_revise` | Mark facts as superseded or retracted when they stop being true |
| `crbro_audit` | Find credentials stored in the brain — reports the kind, never the value |
| `crbro_forget` | Remove facts for good, keeping a copy in `.quarantine/` first |
| `crbro_space` | Create or join a team space — a private git repo for shared projects |
| `crbro_share` | Put one project into a space, after showing exactly what would be sent |
| `crbro_sync` | Exchange notes with teammates now, instead of waiting for the next session |
| `crbro_maintenance` | Brain maintenance — heat, pruning, integrity, index rebuild |
| `crbro_consolidate` | End-of-session consolidation |

## Team memory

Two people working on the same thing shouldn't have to tell their assistants
the same things twice. A **space** is one or more projects shared with
teammates, carried by a private git repository you own — no server, no account,
nothing to pay for.

```bash
# One person, once:
crbro_space  action: create   name: "team"   remote: git@github.com:acme/team-memory.git   author: "ana"
crbro_share  neuron: "project_x"   space: "team"

# Everyone else, once:
crbro_space  action: join     name: "team"   remote: git@github.com:acme/team-memory.git   author: "bruno"
```

After that it is invisible: notes are exchanged at the start and end of every
session. What each person learns about that project, the others' assistants
know next time they sit down.

**How it stays out of your way**

- Nobody ever writes to anybody else's file. Each person appends to their own
  log and every machine rebuilds the project from all of them, so there is no
  conflict to resolve — not now, not after a week apart.
- If someone marks a fact as no longer true, that wins. Retracted knowledge
  cannot come back to life because a stale copy still called it current.
- No connection is a normal answer, not an error. Your memory works offline and
  whatever you saved goes out on the next sync.

**What never leaves your machine**

- Every project you did not explicitly share.
- Preferences — not shareable at all, at any setting. They are the field most
  likely to hold a key.
- Credentials. `crbro_share` refuses outright if it finds one, and tells you
  where. It will not redact it and send the rest.

> **Sharing cannot be undone.** Once a teammate has pulled a project it is on
> their disk. Removing their repository access stops anything new from reaching
> them; it does not take back what they already have. That is true of any
> sync system — worth knowing before you share, not after.

## Architecture

```
~/.crbro/
├── manifest.json           ← Brain metadata
├── cortex/                 ← One JSON per neuron (topic)
│   ├── project_octochat.json
│   └── tech_firebase.json
├── synapses/               ← One JSON per connection
│   └── syn_octochat__firebase.json
├── hippocampus/            ← One JSON per session
│   └── session_2026-05-06.json
├── prefrontal/             ← Working memory
│   ├── active_context.json
│   ├── hot_topics.json
│   └── global_map.json
├── archives/               ← Cold neurons (opt-in; nothing is archived unless you ask)
├── shared/                 ← One git repo per team space. Notes only, never the cortex
│   └── team/
│       └── neurons/project_x/ops/ana.a1b2c3.jsonl
└── .search/                ← Orama search index
    └── chunks.index.json   ← one document per fact
```

## Heat Score Algorithm

Each neuron has a heat score (0.0 - 1.0) calculated from:

- **Frequency (35%)** — How often the neuron is accessed
- **Recency (40%)** — When it was last accessed (today = 1.0, >3 months = 0.05)
- **Connectivity (25%)** — How many synapses connect to it

## Knowledge Miner

The miner is an **optional, fully local** helper that scans a directory for `.md` and `.txt` files (notes, docs, journals) and extracts knowledge into the brain — so CRBRO can learn from what you already wrote, not just from conversations. It never touches the network and never leaves your machine.

```bash
npx crbro-memory mine [dir]       # One-shot scan of a directory
npx crbro-memory setup-miner      # Install a scheduled auto-scan (OS task scheduler)
npx crbro-memory miner-status     # Check the auto-miner status
npx crbro-memory remove-miner     # Remove the scheduled task
```

> Naming note: "miner" here means *knowledge* mining — extracting facts from your own text files. Nothing to do with cryptocurrency.

## CLI Commands

```bash
npx crbro-memory          # Start MCP server (stdio)
npx crbro-memory init     # Initialize brain + detect IDEs
npx crbro-memory status   # Show brain status
npx crbro-memory reindex  # Rebuild the search index
npx crbro-memory eval     # Measure retrieval quality against your own query set
npx crbro-memory --help   # Help
```

### Measuring retrieval

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

## License

MIT — see [LICENSE](LICENSE). Built by [Octonove](https://github.com/Octonove).
