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
failing. Environment variables named `CRBRO_SECRET_<NAME>` keep working (see
below), and the rest of CRBRO is unaffected.

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

## Environment variables (changed in 2.11)

Until 2.10 any environment variable of the same name won over the keychain,
so `crbro_secret get USERNAME` returned the server's own `USERNAME`. Since 2.11
an environment value counts only when it opts in:

- `CRBRO_SECRET_<NAME>` — for example `CRBRO_SECRET_GITHUB_TOKEN` answers
  `crbro_secret get GITHUB_TOKEN`;
- or `<NAME>` itself, when it is listed in `CRBRO_SECRET_ENV`
  (`CRBRO_SECRET_ENV=GITHUB_TOKEN,NPM_TOKEN`).

The answer says where the value came from (`source: "env"` or `"keychain"`).
That is how CI and a headless box with no credential store keep working; names
are always SCREAMING_SNAKE_CASE.

## Overwrites and removals

Through MCP, `set` on an existing name with a different value, and `remove`,
take two calls: the first changes nothing and returns a `confirm_token`, the
second passes it back as `confirm`. A new name, or the same value again, needs
no token. On Windows every write also keeps a sealed copy of the encrypted
file (`CRBRO_KEYS_COPIES`, default 5), so a removal can be undone:

```bash
npx crbro-memory secret copies               # the sealed copies, newest first
npx crbro-memory secret restore <id> --yes   # checked with DPAPI, then put back
```

A missing `keys.dpapi` next to signs that a store existed (a marker, a sealed
copy, a leftover temporary) is an error with recovery steps, never an empty
store; `secret set NAME --force` starts a new store on purpose.

## Encryption at rest of backups and quarantine copies

Backups and quarantine copies are plain JSON by default. With
`CRBRO_ENCRYPT_AT_REST=1` they are sealed with AES-256-GCM, using a 32-byte
key that lives in this same keychain as `CRBRO_AT_REST_KEY`. Create the key
once, by hand, so that losing the keychain never silently orphans sealed
copies:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" | npx crbro-memory secret set CRBRO_AT_REST_KEY
```

Without the key nothing is written in clear and nothing is deleted. Losing the
key loses the sealed copies, so keep a copy of the keychain (or of the key)
somewhere safe.
