# Architecture

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
│   └── hot_topics.json     (the global map is computed live since 2.0, never stored)
├── .quarantine/            ← What crbro_forget removed, kept until you delete it
├── unshared.json           ← Projects you stopped following in a space (after an unshare)
├── archives/               ← Cold neurons (opt-in; nothing is archived unless you ask)
├── shared/                 ← One git repo per team space. Notes only, never the cortex
│   └── team/
│       └── neurons/project_x/ops/ana.a1b2c3.jsonl
└── .search/                ← Orama search index
    └── chunks.index.json   ← one document per fact
```

## Heat score algorithm

Each neuron has a heat score (0.0 - 1.0) calculated from:

- **Frequency (35%)** — How often the neuron is accessed
- **Recency (40%)** — When it was last accessed (today = 1.0, >3 months = 0.05)
- **Connectivity (25%)** — How many synapses connect to it

## Knowledge miner

The miner is an **optional, fully local** helper that scans a directory for `.md` and `.txt` files (notes, docs, journals) and extracts knowledge into the brain — so CRBRO can learn from what you already wrote, not just from conversations. It never touches the network and never leaves your machine.

```bash
npx crbro-memory mine [dir]       # One-shot scan of a directory
npx crbro-memory setup-miner      # Install a scheduled auto-scan (OS task scheduler)
npx crbro-memory miner-status     # Check the auto-miner status
npx crbro-memory remove-miner     # Remove the scheduled task
```

> Naming note: "miner" here means *knowledge* mining — extracting facts from your own text files. Nothing to do with cryptocurrency.
