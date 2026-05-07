# 🧠 CRBRO — Persistent Neural Memory for AI

**CRBRO** is a local MCP (Model Context Protocol) server that gives your AI assistant **persistent long-term memory** across sessions. It uses a biological neural architecture — cortex, synapses, hippocampus — to store, connect, and retrieve knowledge automatically.


## Features

- **🧬 Biological Architecture** — Knowledge organized as neurons (cortex), connections (synapses), and session memory (hippocampus)
- **🔍 Hybrid Search** — Powered by [Orama](https://orama.com/) for fast BM25 + fuzzy text search
- **🔥 Heat Scores** — Automatic relevance tracking based on frequency, recency, and connectivity
- **🗺️ Global Map** — Cluster detection and cross-domain bridge identification *(premium)*
- **📦 Zero Dependencies** — Pure Node.js, no Python, no Docker, no external databases
- **💾 File-Based** — All data stored as readable JSON files in `~/.crbro/`
- **🔌 MCP Native** — Works with Claude Desktop, Cursor, Windsurf, and any MCP-compatible client

## Quick Start

### 1. Initialize

```bash
npx crbro-memory init
```

### 2. Add to your MCP config

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

**Cursor** (`.cursor/mcp.json`):
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

Your AI will now have access to 15 memory tools. Start any session with `crbro_boot`.

## Tools

### Free (always available)

| Tool | Description |
|------|-------------|
| `crbro_boot` | Boot the brain at session start — loads hot topics and context |
| `crbro_status` | Brain status — neurons, synapses, sessions count |
| `crbro_learn` | Store a fact, decision, pattern, or preference |
| `crbro_neuron` | Read a specific neuron (topic) with all its knowledge |
| `crbro_neurons` | List neurons with optional filters (domain, type, heat) |
| `crbro_recall` | Search the brain using hybrid text search |
| `crbro_connect` | Create or strengthen a connection between neurons |
| `crbro_connections` | Get all connections for a neuron |
| `crbro_session_log` | Log a session summary |
| `crbro_sessions` | List recent sessions |
| `crbro_context` | Read/update active working context |
| `crbro_hot_topics` | Get the most active topics by heat score |
| `crbro_consolidate` | End-of-session consolidation |

### Premium (requires Synthetica Zero Deck license)

| Tool | Description |
|------|-------------|
| `crbro_global_map` | View the neural network — clusters and cross-domain bridges |
| `crbro_maintenance` | Full brain maintenance — archive, prune, rebuild |

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
├── archives/               ← Cold neurons
└── .search/                ← Orama search index
    └── orama.index.json
```

## Heat Score Algorithm

Each neuron has a heat score (0.0 - 1.0) calculated from:

- **Frequency (35%)** — How often the neuron is accessed
- **Recency (40%)** — When it was last accessed (today = 1.0, >3 months = 0.05)
- **Connectivity (25%)** — How many synapses connect to it

## CLI Commands

```bash
npx crbro-memory          # Start MCP server
npx crbro-memory init     # Initialize brain
npx crbro-memory status   # Show brain status
npx crbro-memory --help   # Help
```

## License

MIT — Part of Octonove Agency.
