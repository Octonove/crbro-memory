# Upgrading from 1.x

2.0 went from 23 tools to 15 without touching the brain on disk: a 1.x brain
opens as it is, and the search index rebuilds itself once. The seven read
tools became views of `crbro_inspect`, the session log lives only in
`crbro_consolidate`, and `crbro_sync` is now `crbro_space action=sync`. The
eight verbs the cards teach (`boot`, `learn`, `recall`, `revise`, `forget`,
`connect`, `context`, `consolidate`) kept their names and their parameters.
`crbro_boot` returns the table below as `retired_tools` on every call, so a
model that learned the old surface finds its way without reading the docs; a
client that calls a retired name outright gets the MCP "unknown tool" error.

| Retired | Use instead |
|---------|-------------|
| `crbro_status` | `crbro_inspect view=status` |
| `crbro_neuron` | `crbro_inspect view=neuron neuron=<id or name>` |
| `crbro_neurons` | `crbro_inspect view=neurons [domain\|type\|min_heat\|limit\|offset]` |
| `crbro_hot_topics` | `crbro_inspect view=neurons` (rows) and `view=status` (`hot_topics_recalculated`) |
| `crbro_connections` | `crbro_inspect view=neuron neuron=<id> [min_strength]` |
| `crbro_sessions` | `crbro_inspect view=sessions [limit]` |
| `crbro_global_map` | `crbro_inspect view=global_map` |
| `crbro_session_log` | `crbro_consolidate summary=... [topics_touched=[...]]` — `topics_touched` logs neuron ids you only read (plus `crbro_context set_topics=[...]` to replace the active topics) |
| `crbro_sync` | `crbro_space action=sync [name]` |

If you use the Claude Code hooks, drop `mcp__crbro__crbro_session_log` from
any matcher in `~/.claude/settings.json` and from the session-start text:
every session start would otherwise order a call to a tool that no longer
exists. Cannot move yet? 1.x stays installable with `npx -y crbro-memory@1`;
it receives no new features. What changed inside each surviving tool is in
[CHANGELOG.md](https://github.com/Octonove/crbro-memory/blob/master/CHANGELOG.md).
