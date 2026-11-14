# Installing CRBRO from an AI agent

For an AI coding agent (Cline, or any other) that has been asked to set CRBRO up in the client it is running in. People: the [README](README.md#1-quick-start) says the same with more context.

CRBRO is a local MCP server that speaks stdio. It needs **Node.js 20 or later** and nothing else: no API key, no account, no environment variables, nothing to clone and nothing to build. `npx` fetches the published package.

## 1. Register the server

Add this entry to the MCP settings file of your client, next to the servers that are already there (in Cline that file is `cline_mcp_settings.json`; read it first and keep what it holds):

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

If you were told which server name to use, use that name instead of `crbro`. If the settings file is not there yet, find out where your client reads it before creating one: a file in a guessed place is never loaded.

Three things not to do:

- Do not clone this repository or build it. The entry above is the whole install.
- Do not run `npx crbro-memory install` unless the user asks for it. That command registers CRBRO in other MCP clients on the machine (Claude Code, Claude Desktop, Codex, Cursor) and edits their config files; Cline is not one of them.
- Do not run `npx crbro-memory init` on your own either: it downloads the optional semantic layer, several hundred MB. Without it recall works on keywords, and the user can add it later.

## 2. Check that it works

Once the client has started the server, call `crbro_boot` with no arguments. A working install answers with a `status` (`"initialized"` the first time, when it creates the memory; `"ok"` after that) and a count of neurons. The memory lives in `~/.crbro`, as plain JSON files; `CRBRO_PATH` moves it.

Then show the round trip: `crbro_learn` one fact and `crbro_recall` it.

## 3. Tell the user about the start of each conversation

Installing the server does not make the assistant use it: nothing reads the memory unless `crbro_boot` is called when a conversation starts. In a client without session hooks that is one line in its always-on rules (in Cline, a rules file such as `.clinerules`, or the custom instructions):

> CRBRO: call the `crbro_boot` tool as your FIRST tool action, before answering, unless this session already contains its result. Apply the `protocol_enforcement` block it returns for the rest of the session.

Offer to add it; do not write to the user's rules without asking.
