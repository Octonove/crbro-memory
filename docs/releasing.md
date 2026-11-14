# Releasing crbro-memory

Releases are made by pushing a version tag. `.github/workflows/release.yml` does the rest: it checks, builds, tests and packs the release, publishes it to npm **with provenance**, publishes it to the MCP Registry, and creates the GitHub release with the `.mcpb` bundle and the CHANGELOG notes. No token has to live in the repository.

## Every release

1. Bump the version: `npm version X.Y.Z --no-git-tag-version`, and set the same version in `server.json` (both `version` and `packages[0].version`).
2. Write the `## [X.Y.Z] — date` section of `CHANGELOG.md`. The release notes are that section, verbatim; the workflow stops if it is missing or empty.
3. `npm run build && npx vitest run && npm run bench && npm run smoke`.
4. Commit and push to `master`. **Wait for CI to go green** on that commit (ubuntu, windows and macos, Node 20, 22 and 24): the release workflow refuses to run for a commit without a successful CI run.
5. Tag and push the tag:
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

What `release.yml` then does, in order, stopping at the first failure:

| Job | What it does |
|---|---|
| `verify` | The tag equals `package.json`'s and `server.json`'s version; the tagged commit is on `master`; CI passed for it. Then `npm ci`, build, the full test suite, `npm run bench`, `check-publication`, the stdio smoke test, `npm run mcpb` + `mcpb:verify`, and `npm pack`. Nothing is published yet. The tarball and the bundle that were tested are the ones that get published. |
| `npm` | `npm publish --provenance --access public` of that tarball. **Skipped** if that exact version is already on npm (see below). |
| `registry` | Waits until the version is visible on npm, then publishes `server.json` to the MCP Registry with GitHub OIDC. `mcp-publisher` is pinned to an exact release and its SHA-256 is verified before it runs. |
| `github-release` | Creates the release `vX.Y.Z` with `build/crbro-memory-X.Y.Z.mcpb` and the CHANGELOG section. If the release already exists, it only attaches the bundle. |

If a job fails, fix the cause and **re-run the failed jobs** from the Actions tab. Never move a tag that has published something.

**Then republish the GitHub release under your own account.** Glama's Auto-Release builds a new Glama version only for releases published by a person: it ignored v2.11.0 and v2.12.0, which `github-release` created as `github-actions[bot]`, and picked up v2.12.0 within minutes once it was republished by hand on 14-11-2026. From your machine:

```bash
gh release edit vX.Y.Z --repo Octonove/crbro-memory --draft=true
gh release edit vX.Y.Z --repo Octonove/crbro-memory --draft=false --latest
```

If no new build shows up under Glama's *Admin → Dockerfile → Recent Tests* within a few minutes, run the two commands again or press *Sync Server* under *Admin → Repository*: with 2.12.1 the first republish, a minute after the workflow created the release, was not picked up, and the second one was.

Do not use Glama's own *Build & Release* button for this: it labels the build with Glama's next patch number (it called 2.12.0 "2.10.1"), not the package's version.

## Publishing npm by hand (still possible)

If you publish from your own machine, do it *before* pushing the tag: the workflow sees that `crbro-memory@X.Y.Z` is already on npm, skips its `npm` job and carries on with the registry and the GitHub release. A hand publish has no provenance attestation and runs `prepublishOnly` (build, tests, `check-publication`) on your machine; prefer the workflow.

## One-time setup (the maintainer, on npmjs.com)

The `npm` job authenticates with **npm trusted publishing** (OIDC): npm trusts a specific GitHub workflow and issues a short-lived credential for the run. There is no token to rotate or leak.

1. On npmjs.com, open the package `crbro-memory` → **Settings** → **Trusted publisher** → **GitHub Actions**.
2. Fill in:
   - Organization or user: `Octonove`
   - Repository: `crbro-memory`
   - Workflow filename: `release.yml`
   - Environment: leave empty (the workflow does not use one; if you add an environment to the job later, put its name here too).
3. Save. Trusted publishing needs npm 11.5.1 or newer on the runner; the job uses Node 24, which ships it.
   Set up for this package on 14-11-2026 (permissions: `npm publish` and `npm stage publish`). npm lists a new trusted publisher as *pending validation* until the workflow publishes once; it asked for that publish before 16-11-2026.
4. Optional hardening: in the package's **Publishing access**, require two-factor authentication and disallow tokens, so that the workflow is the only way to publish.

### Fallback: an npm token

If trusted publishing cannot be used yet, create a *granular* automation token limited to this package and add it as the repository secret `NPM_TOKEN`. When that secret exists, the `npm` job uses it instead of OIDC (provenance is still attached). Remove the secret once the trusted publisher works.

## The MCP Registry on its own

`publish-mcp.yml` is a manual workflow (Actions → *Publish to MCP Registry (manual)* → type the tag). It exists only to re-publish a version to the registry, for example after the registry was down during a release. It applies the same checks as `release.yml`: tag equals the versions in `package.json` and `server.json`, CI passed for the commit, the version is on npm, and the same pinned `mcp-publisher`.

To upgrade `mcp-publisher`, change `MCP_PUBLISHER_VERSION` and `MCP_PUBLISHER_SHA256` (the digest GitHub shows for `mcp-publisher_linux_amd64.tar.gz` on that release) in **both** workflow files.

## Other checks that run on every push

`.github/workflows/ci.yml`: build and tests on ubuntu, windows and macos with Node 20, 22 and 24; the real server started over stdio (`npm run smoke`); the benchmark gates; `typecheck` of `hooks/` and `scripts/`; the publication check (file names, no sourcemaps or declaration files, a cap on size); the `.mcpb` build and verification; a Docker build; `npm audit`. Dependabot proposes npm and GitHub Actions updates weekly.
