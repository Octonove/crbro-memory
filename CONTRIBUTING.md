# Contributing to CRBRO

Thanks for looking. Small, focused changes are the easiest to review.

## Set up

You need Node.js 20 or later and git.

```bash
git clone https://github.com/Octonove/crbro-memory.git
cd crbro-memory
npm ci
npm run build        # TypeScript -> dist/
npx vitest run       # the whole suite
```

Useful while working: `npx vitest run tests/<file>.test.ts`, `npm run dev` (tsc --watch), `npm run typecheck` (hooks/ and scripts/, after a build), `npm run smoke` (starts the real server over stdio against a temporary brain), `npm run bench` (the retrieval and redaction gates).

## Rules that matter here

- **Never run the server or the CLI against your real brain while developing.** Tests are sandboxed (`tests/setup.env.ts`). For manual runs set `CRBRO_PATH`, `HOME` and `USERPROFILE` to a temporary folder, plus `CRBRO_MOD=0` and `CRBRO_AUTOBACKUP=0`.
- **A bug fix comes with a test that fails without it.**
- **Keep the 15 tool names and the documented output fields.** Other people's prompts and cards rely on them. Adding a field or a command is fine; renaming or removing one needs a discussion first.
- **No new runtime dependency** without an issue that explains why nothing in Node or the existing three dependencies will do.
- **Never commit a credential**, not even a revoked one, and never put one in a test. `node scripts/check-publication.mjs` runs in CI and fails on private file names and on files that do not belong in the package.
- Keep a file's line endings and style as they are; do not reformat code you are not changing.
- User-visible changes get a `CHANGELOG.md` entry; behaviour that the README or `docs/` describes gets updated there too.

## Pull requests

1. Open an issue first for anything bigger than a bug fix.
2. Branch from `master`; commit messages like `fix(search): ...`, `feat(cli): ...`, `docs: ...`.
3. Make sure `npm run build`, `npx vitest run` and `npm run bench` pass. CI runs them on Linux, Windows and macOS with Node 20, 22 and 24.
4. Describe what changed and how you checked it.

## Reporting problems

Bugs and ideas: open an issue (`npx crbro-memory doctor` output helps; it reads no credential values). **Security problems: do not open a public issue**; follow [SECURITY.md](SECURITY.md).

Maintainers: how releases work is in [docs/releasing.md](docs/releasing.md).
