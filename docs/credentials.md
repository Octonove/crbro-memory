# Credentials

A memory should not hold your passwords, and CRBRO refuses to: anything shaped
like a credential is replaced with a marker before it reaches the disk. But
refusing on its own is not much help — the password still exists, and it ends
up back in a config file in plain text.

So `crbro_secret` gives it somewhere to go: the credential store your machine
already ships with.

| Platform | Where the value actually lives |
|----------|--------------------------------|
| macOS | Keychain, via `security` |
| Linux | Secret Service, via `secret-tool` |
| Windows | Sealed with DPAPI to your Windows account |

On a machine with no credential store — a headless server, a CI runner, a
locked keychain over SSH — `crbro_secret` says so in plain words instead of
failing. Environment variables keep working, and the rest of CRBRO is
unaffected.

CRBRO keeps no copy and writes no crypto of its own. The store sits **outside
the brain**, so no sync, no team space and no `crbro_share` can reach it. What
goes in the brain is the *name*:

> "The WordPress password for example.com is in `WP_EXAMPLE_APP_PASSWORD`."

Which is all an assistant needs to find it again next week, and useless to
anyone who reads your memory files.

## From the terminal

Until 2.3 the only way in was `crbro_secret`, which meant typing the value into a
conversation with a model. `npx crbro-memory secret` is the same store from the shell:

```bash
npx crbro-memory secret set GITHUB_TOKEN     # value read from stdin, never argv
npx crbro-memory secret list                 # names only, never values
npx crbro-memory secret get GITHUB_TOKEN     # pipe it; warns if it would hit the screen
npx crbro-memory secret remove GITHUB_TOKEN --yes
npx crbro-memory secret status               # which store this machine offers
```

An argument lands in the shell history and in the process table; stdin does not.
On a terminal the input is hidden as you type, and piping works the same way:

```bash
Get-Content token.txt | npx crbro-memory secret set GITHUB_TOKEN    # PowerShell
op read "op://vault/github/token" | npx crbro-memory secret set GITHUB_TOKEN
```

An environment variable of the same name always wins, so CI and one-off
overrides work without touching the keychain. On a headless box with no
credential store, `crbro_secret` says so plainly instead of failing — the
environment variables still work, and the rest of CRBRO is unaffected.
