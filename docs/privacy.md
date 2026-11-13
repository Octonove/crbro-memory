# Privacy

Everything CRBRO knows lives in plain JSON files on your machine, under
`~/.crbro` or the folder you point it at. You can open them, diff them, back
them up with git and delete them. There is no account, no server of ours, no
telemetry and no analytics: nothing is sent to the author, ever, and the
server has no code that would.

These data flows can touch the network:

- **The optional semantic layer.** `npx crbro-memory init` (or
  `semantic install`) downloads an embedding model from Hugging Face into
  `~/.crbro/.semantic`, about 500 MB, once per machine. Skip it with
  `init --no-semantic` and recall stays keyword-only. The desktop extension
  never downloads it.
- **Team spaces.** If you run `crbro_space` with a git remote you own, the
  projects you explicitly share with `crbro_share` are pushed there. Nothing
  else is included by that sync: preferences are excluded by design, and
  a project is shared only when you name it.
- **Your MCP client.** Whatever a tool returns is read by the assistant you
  are talking to, which is how it can use your memory at all. That traffic is
  between you and your client, not us.

Recognized credential patterns are replaced with a marker before the text
reaches disk, and the sentence around it survives; `crbro_secret` puts the
real value in your operating system's own keychain instead of the brain.
An explicit `crbro_secret action=get` returns the value to the AI client;
encryption at rest does not prevent that transfer. Normal brain backups do
not include the keychain. Deleting the brain does not delete keychain entries,
backups, conversation logs or copies others already received. To inspect a topic,
read its file or call `crbro_inspect`.

`npx crbro-memory usage` and `npx crbro-memory postmortem` read Claude Code's own session logs in
`~/.claude/projects`, locally and read-only: `usage` reads only the model name
and token counts of each response, `postmortem` only what you typed and the
names of the tools called — never a tool's input or output — and redacts what
it prints.

The one thing CRBRO writes in Claude Code's folder without being asked is the
open-items mod: `~/.claude/crbro-mods/` (the mod itself, a `state.json` with
the opt-out mark and the installed version, a lock held for the seconds an
install takes, and a notice kept until the boots that hand it over have had
it) and its one entry in `env.CLAUDE_CODE_PLUGIN_DIRS` of
`~/.claude/settings.json`. No other key in that file is changed; it is
rewritten as JSON with its indentation and line endings (on Windows the new
file takes the folder's permissions). Nothing is downloaded or sent, and none
of it happens without `~/.claude`, in a client with `CRBRO_MOD=0`, or after
`uninstall-mod`.

What each defense is for, and how to report a vulnerability, is in
[SECURITY.md](https://github.com/Octonove/crbro-memory/blob/master/SECURITY.md).
