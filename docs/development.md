# Development

[README](../README.md) · [Configuration](configuration.md) · [Compatibility and observed results](compatibility.md)

## Layout

```text
index.ts                    Root loader; the only extension entry point
package.json                omp.extensions manifest and pinned development tools
package-lock.json           Locked development dependency graph
tsconfig.json               Strict runtime checking: index.ts and src/**/*.ts
.env.example                Environment reference, not automatically loaded
overrides.example.json      Exact-ID override example
src/
  extension.ts              Provider registration, lifecycle, commands and refresh
  catalog.ts                Configuration, catalog fetch/filter/map and metadata
  changes.ts                Meaningful catalog diffs
  cost.ts                   Reported USD parsing and additive accounting
  doctor.ts                 Local override and read-only gateway diagnostics
  gateway.ts                Bounded authenticated same-origin GETs and URL derivation
  overrides.ts              Bounded file loading, strict validation and ID auditing
  reported-cost.ts          Scoped chat wrapper delegating to OMP's native adapter
  telemetry.ts              Request-control headers and sanitized request metadata
  usage.ts                  Optional key-scoped usage fetching and normalization
test/
  *.test.ts                 Node unit/lifecycle fixtures
  reported-cost.integration.ts  Real SDK chat-adapter cases
  specialty.integration.ts  Real SDK embedding/image HTTP loopback cases
  cli-smoke.ts              Actual OMP CLI in a disposable profile
docs/                       Configuration, compatibility, and this guide
.github/workflows/          CI and release/package publishing automation
release-please-config.json  SemVer policy and generated documentation updates
.release-please-manifest.json  Last release version tracked by Release Please
CHANGELOG.md                Generated, reviewable release notes
```

Root `index.ts` only re-exports the default factory from `src/extension.ts`. Keep helper modules out of the extension discovery root. The package manifest stays `omp.extensions: ["./index.ts"]`; no `main` or `exports` entry is required. Runtime users need the folder, not development dependencies.

## Prerequisites and commands

Development requires Node >=24, npm, and the package-local **Bun 1.4.4**. Both OMP SDK packages are pinned to **18.18.1** and require Bun >=1.4.4. TypeScript is pinned to **7.0.2**. Do not use an older globally installed Bun for verification.

From the repository root on Windows:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
npm.cmd run test:integration
npm.cmd run test:cli
```

Use `npm` instead of `npm.cmd` on POSIX. On the reviewed Windows host the Bash-resolved `npm` launcher failed, so verification used `npm.cmd`. npm scripts resolve package-local executables first.

To exercise an installed standalone CLI without changing SDK pins, set the test-only `OMNIROUTE_SMOKE_CLI` to its executable name or absolute path:

```powershell
$env:OMNIROUTE_SMOKE_CLI = 'omp'
try { npm.cmd run test:cli } finally { Remove-Item Env:OMNIROUTE_SMOKE_CLI }
```

On POSIX, use `OMNIROUTE_SMOKE_CLI=omp npm run test:cli`. This selects the executable, not the user's profile: the smoke still uses fixture credentials, a disposable agent directory, and loopback inference. Leave it unset for the pinned package CLI used by CI. The optional tarball argument works in either mode.

npm 12 initially blocked Bun's required installer. The manifest now contains a version-specific `allowScripts` entry for `bun@1.4.4`. During setup it was approved with `npm.cmd install-scripts approve bun@1.4.4`, followed by `npm.cmd rebuild bun`. Do not bypass all installation-script checks or silently fall back to a different Bun. If installation fails, report the exact unavailable dependency/check while retaining the pins.

## What the checks exercise

- `test`: Node unit/lifecycle suites for mapping, rejection/fallback and unmatched-override diagnostics, live-selection refresh races, deferred idle rebinding, selected-model failures/removal/recovery, overrides, costs, telemetry, gateway bounds, usage fractions/overages, and doctor coverage. Override-file validation remains available during catalog outages; cancellation cleanup cannot hide HTTP/size errors.
- `typecheck`: strict checking of the root loader and runtime modules against the pinned public SDK. Test files are not included in this compiler target.
- `test:integration`: OMP's real chat adapter with controlled SSE/fetch responses, zero/nonzero/absent reported cost, controls and terminal events, plus a registered custom API under a one-request provider cap with one dispatch. Specialty cases call exported `embed` and `generateImage` over authenticated loopback HTTP, verifying an indexed vector/usage and exact PNG data.
- `test:cli`: starts the actual package CLI with package-local Bun (or `OMNIROUTE_SMOKE_CLI`) against an authenticated loopback fixture. The staged profile contains `agent/extensions/omniroute/{index.ts,package.json,src/}` and no extension-local dependencies. Its first command uses automatic discovery before a catalog cache exists. Later commands exercise native personal usage fractions/remaining allowance, explicit loading, native/scoped chat, real built-in `read` tool loops with split streamed arguments, request controls/overrides, and cached custom-API fallback during discovery outage.
- CI runs the checks on Ubuntu with Node 26.13.0, Ubuntu with Node 24, and Windows with Node 24. Windows uses `npm.cmd`; package validation uses explicit Bash on each runner. Every lane packs an allowlisted tarball and passes it to `test:cli`, so missing runtime files fail actual discovery/tool scenarios. Only Ubuntu/Node 26.13.0 uploads the canonical `npm-package` artifact, and publication waits for every verification lane. Local source-folder checks remain available without a tarball argument.

The CLI receives only fixture credentials, uses a temporary working directory/profile, and bounds each subprocess to 45 seconds. Both native and scoped tool scenarios require exactly two chat requests: the tool call, then the real file result before final text. Specialty requests have five-second abort signals. Teardown removes the temporary profile and stops loopback servers.

These fixtures prove client registration/transport behavior, not a production model's availability, quality, billing, or every provider-specific image option. Image coverage is text-to-image, not editing. Native usage UI rendering is not covered. Do not replace actual SDK/CLI checks with mock registration assertions.

## Releases and GitHub Packages

The package is `@actu4l-human/omp-omniroute`; `.npmrc` maps only this scope to GitHub Packages, and `publishConfig.registry` prevents accidental publication to npmjs.org. The `repository` URL links the package to this GitHub repository. TypeScript is shipped directly, with no compilation or bundled OMP SDKs. `files` allows only runtime source, documentation, and safe examples; `.env`, tests, dependencies, workflows, and local profiles are not packaged.

### One-time setup

1. Push the workflow/configuration files to `main` after review. Local files do not activate GitHub Actions.
2. In **Settings → Actions → General → Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests**. This was disabled when the workflow was prepared. The workflow declares its own narrowly scoped job permissions; do not enable blanket write permissions or add an npm token.
3. Keep Actions enabled and permit the pinned official GitHub and Google Release Please actions. Publishing uses the repository's `GITHUB_TOKEN` with `packages: write`; only the publishing job receives that permission. The release job can write releases, PRs, and their labels but has no package permission.
4. After the first publication, check package access and visibility. GitHub npm packages start private; a public repository does not by itself guarantee a public package. Set package visibility to public if desired. Downloads require authentication even for public packages.

### Version and documentation policy

Use Conventional Commit PR titles and **squash merge** to preserve them in `main` history. CI checks PR titles; it does not configure merge rules or branch protection. For direct commits, use the same convention.

| Change | Example | Version effect |
|---|---|---|
| Backward-compatible feature | `feat: add model filtering` | Minor |
| Bug fix or performance change | `fix: preserve zero cost`, `perf: reduce catalog work` | Patch |
| Breaking contract | `feat!: change override schema`, or a `BREAKING CHANGE:` footer | Major |
| Documentation | `docs: clarify profile setup` | Included in release notes; can produce a patch release |
| Internal maintenance | `ci: update workflow`, `test: cover timeout` | No release on its own |

Release Please opens/updates a release PR with `package.json`, `package-lock.json`, `.release-please-manifest.json`, `CHANGELOG.md`, and the annotated package version in `README.md`. Review the generated notes and add migration instructions for breaking changes. Automation does not infer or rewrite the operational documentation: update affected configuration/compatibility instructions with the change that needs them.

The initial manifest is `1.1.0`, matching the pre-automation source version; the bootstrap SHA excludes the imported history. The first new release advances from that baseline according to subsequent commits. It does not retroactively publish `1.1.0`. Generated release commits use GitHub's automation identity, not a developer's local Git name.

### Workflow execution

- `ci.yml` runs on PRs, pushes to `main`, and manual dispatch. It uses Node **26.13.0**, npm **12.2.2**, and the existing pinned Bun/OMP tools. Unit tests, typechecking, SDK integration tests, package-content checks, and the real CLI against the packed tarball must pass. The verified tarball is retained as the `npm-package` Actions artifact for 14 days.
- `release.yml` runs on pushes to `main`. Merging a Release Please PR creates `vX.Y.Z` and a GitHub release. It calls the same CI workflow at the **release commit SHA**, checks the tag against the packed version, then publishes that exact tested tarball to GitHub Packages. A GitHub release may exist even if verification or publication fails; check the workflow before announcing package availability.
- `GITHUB_TOKEN`-created PRs and release tags do **not** trigger other workflows. Publishing is therefore in the same workflow, not a separate `release: published` listener. For a bot-created release PR, manually run **CI → Run workflow**, selecting its release branch, before merging. If required PR checks must run automatically, use an approved GitHub App token as a separately reviewed configuration change; no personal token is required by this setup.
- On a failed publish, rerun **failed jobs** in that release run while its artifact is available. Do not rerun all jobs after a release has already been created: Release Please will no longer emit `release_created`. Never reuse a published version for different contents; ship a new patch release instead.

Local packaging smoke (no credentials or publication):

```sh
mkdir -p dist
npm pack --ignore-scripts --pack-destination dist
npm run test:cli -- dist/actu4l-human-omp-omniroute-1.1.0.tgz
npm publish ./dist/actu4l-human-omp-omniroute-1.1.0.tgz --dry-run --ignore-scripts
```

Use the filename printed by `npm pack` after a version bump. On PowerShell, create the directory with `New-Item -ItemType Directory -Force dist` and use `npm.cmd`. Keep registry credentials in the user-level npm login/secret store; never commit tokens or copy the gateway `.env` into a package.

## Authorized read-only deployment check

Only run this against a deployment you are authorized to inspect. It explicitly parses a local `.env` without shell evaluation; this script does not reproduce OMP's process/project/profile environment precedence. To check a named profile's file directly, supply its `agent/.env` path to `readFileSync`. It sends only the doctor's catalog/health GETs and prints statuses/counts, not the URL, credential, raw payload, or account details:

```bash
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {parseEnv} from 'node:util'; import {readConfig} from './src/catalog.ts'; import {runDoctor} from './src/doctor.ts'; const env=parseEnv(readFileSync('.env','utf8')); const report=await runDoctor(readConfig(env),env.OMNIROUTE_API_KEY); console.log(JSON.stringify({checks:report.checks.map(({id,status})=>({id,status})),modelCount:report.modelCount,health:report.health}));"
```

A live inference run needs separate authorization for the model and scope. Never copy `.env`, private URLs, API keys, or account/spend data into fixtures or documentation. Do not change server permissions automatically to make a check pass.

## Refreshing the upstream contract review

1. Record published OMP package versions and engine requirements separately from the exact source commit inspected. Record OmniRoute's stable release separately from its development branch/ref; do not call a development branch a release.
2. Inspect provider registration, async factories, loading precedence, dynamic discovery/refresh, model kinds/APIs, usage hooks, tool schema, and custom-stream concurrency ownership. Check chat cost handling and exported embedding/image interfaces.
3. Inspect OmniRoute catalog pagination/defaults, metadata/capabilities, pricing units, Bearer authentication, health states, optional usage permission, SSE cost, and request-control headers. Compare stable and development files where claims rely on both.
4. Reproduce a suspected incompatibility with a source-shaped fixture. Keep schema identity separate from deployment version, retain path-prefix derivation, and avoid inferred alias rules or provider impersonation.
5. Run the pinned checks above, including the actual CLI and HTTP transports. Any approved live checks must be labeled separately from fixture results.
6. Update [compatibility.md](compatibility.md) with observed commands, versions, results, immutable source links, and untested boundaries. Do not copy historical pass counts, future-dated ledgers, or independent-review claims without new evidence. Update affected configuration/installation instructions in the same change.
