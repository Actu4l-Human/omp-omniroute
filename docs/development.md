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
  run-bun.ts                Node launcher isolating Bun before startup
docs/                       Configuration, compatibility, and this guide
.github/workflows/          CI and release/package publishing automation
release-please-config.json  SemVer policy and generated documentation updates
.release-please-manifest.json  Last release version tracked by Release Please
CHANGELOG.md                Generated, reviewable release notes
```

Root `index.ts` only re-exports the default factory from `src/extension.ts`. Keep helper modules out of the extension discovery root. The package manifest stays `omp.extensions: ["./index.ts"]`; no `main` or `exports` entry is required. Runtime users need the folder, not development dependencies.

## Prerequisites and commands

Development requires **Node 24.15+ (24.x) or Node 26+**, npm **12.2.2**, and the package-local **Bun 1.4.4**. The extension's runtime declaration remains Node >=24; the stricter development prerequisite comes from [npm 12.2.2's engine range](https://registry.npmjs.org/npm/12.2.2). TypeScript is pinned to **7.0.2**. Both OMP SDK development dependencies must track the published stable npm `latest` dist-tags, including major/breaking releases. Their exact pins and lockfile record the validated snapshot; they are not a frozen compatibility policy. Migrate to changed public APIs rather than downgrading or adding compatibility shims. Update Bun and its version-specific installer approval only if the SDK engine requirements demand it. Do not use an older globally installed Bun or change the user's host installation/profile.

The root manifest uses npm's [scoped overrides](https://docs.npmjs.com/cli/v12/configuring-npm/package-json#overrides) to replace SDK 18.18.2's Puppeteer 25.3.0 with **25.16.0** for development checks. Its supported Chromium BiDi **157.0.8090-0** dependency accepts Zod 4, and the lockfile resolves patched **Zod 4.6.7**. This is not a direct Zod-major override into the old BiDi consumer. Reassess/remove this exact-SDK-scoped override when updating the SDK; it intentionally does not constrain future SDK releases. npm ignores dependency-owned overrides when users install this extension, and runtime dependencies are supplied by their host, so this does not repair or modify an installed OMP host.

From the repository root on Windows:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
npm.cmd run test:integration
npm.cmd run test:cli
```

Use `npm` instead of `npm.cmd` on POSIX. On the reviewed Windows host the Bash-resolved `npm` launcher failed, so verification used `npm.cmd`. npm scripts resolve package-local executables first.

The integration and CLI scripts enter through the Node launcher `test/run-bun.ts`, not a bare Bun command. Before Bun starts, it disables automatic dotenv loading with `--no-env-file`, crash-report uploads with `DO_NOT_TRACK=1`, and the runtime transpiler cache with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`. These are [native Bun controls](https://bun.com/docs/runtime/environment-variables). The launcher inherits only executable lookup and OS essentials (`PATH`, `SystemRoot`, `WINDIR`, `COMSPEC`, `PATHEXT`, case-insensitively), plus the explicit test-only CLI selection below. It does not forward credentials, proxy settings, `BUN_OPTIONS`, or `NODE_OPTIONS`.

Each invocation creates disposable home, agent, temporary, configuration, data, and cache directories and removes them on exit. Arguments, Bun test mode, and exit status are preserved; the launcher has a ten-minute deadline. The package CLI subprocess also receives `--no-env-file` and an isolated environment. This isolation is for repository checks, not a change to users' normal extension startup or a sandbox for arbitrary test code. Run these npm scripts rather than invoking Bun directly.

To exercise an installed standalone CLI without changing SDK pins, set the test-only `OMNIROUTE_SMOKE_CLI` to its executable name or absolute path:

```powershell
$env:OMNIROUTE_SMOKE_CLI = 'omp'
try { npm.cmd run test:cli } finally { Remove-Item Env:OMNIROUTE_SMOKE_CLI }
```

On POSIX, use `OMNIROUTE_SMOKE_CLI=omp npm run test:cli`. This selects the executable, not the user's profile: the smoke still uses fixture credentials, a disposable agent directory, and loopback inference. Leave it unset for the pinned package CLI used by CI. The optional tarball argument works in either mode.

npm 12 initially blocked Bun's required installer. The manifest now contains a version-specific `allowScripts` entry for `bun@1.4.4`. During setup it was approved with `npm.cmd install-scripts approve bun@1.4.4`, followed by `npm.cmd rebuild bun`. Do not bypass all installation-script checks or silently fall back to a different Bun. If installation fails, report the exact unavailable dependency/check while retaining the pins.

## What the checks exercise

- `test`: Node unit/lifecycle suites for mapping, rejection/fallback and unmatched-override diagnostics, live-selection refresh races, deferred idle rebinding, selected-model failures/removal/recovery, overrides, costs, telemetry, gateway bounds, usage fractions/overages, and doctor coverage. Override-file validation remains available during catalog outages; cancellation cleanup cannot hide HTTP/size errors. Launcher regressions spawn the actual package-local Bun in synthetic dotenv fixtures, check inherited credential/options exclusion and isolated paths, exercise script/test modes and argument forwarding, and assert nonzero exit propagation and cleanup.
- `typecheck`: strict checking of the root loader and runtime modules against the pinned public SDK. Test files are not included in this compiler target.
- `test:integration`: OMP's real chat adapter with controlled SSE/fetch responses, zero/nonzero/absent reported cost, controls and terminal events, plus a registered custom API under a one-request provider cap with one dispatch. Specialty cases call exported `embed` and `generateImage` over authenticated loopback HTTP, verifying an indexed vector/usage and exact PNG data.
- `test:cli`: starts the actual package CLI with package-local Bun (or `OMNIROUTE_SMOKE_CLI`) against an authenticated loopback fixture. The staged profile contains `agent/extensions/omniroute/{index.ts,package.json,src/}` and no extension-local dependencies. Its first command uses automatic discovery before a catalog cache exists. Later commands exercise native personal usage fractions/remaining allowance, explicit loading, native/scoped chat, real built-in `read` tool loops with split streamed arguments, request controls/overrides, and cached custom-API fallback during discovery outage.
- CI has five required lanes: Ubuntu/Node 26/locked, Windows/Node 26/locked, Ubuntu/Node 24/locked, Ubuntu/Node 26/latest, and Windows/Node 26/latest. Each Node major resolves its latest patch. Every lane starts with `npm ci`; latest lanes then install both SDK `@latest` tags without saving or changing the lockfile and print the installed versions. Windows uses `npm.cmd`; package validation uses explicit Bash on each runner. Every lane runs unit, typecheck, integration, allowlist and packed-CLI checks. Only locked Ubuntu/26 uploads the canonical `npm-package` artifact. An independent blocking `sdk-policy` job compares public latest metadata against the manifest, root lock pins and resolved lock versions; unavailable metadata fails closed. Publication waits for this gate and all five lanes. Local source-folder checks remain available without a tarball argument.

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

- `ci.yml` runs on PRs, pushes to `main`, manual/reusable invocation, and every six hours (`17 */6 * * *`). It uses npm **12.2.2**, the Node lanes above, and package-local Bun. Unit tests, typechecking, SDK integration tests, package-content checks, and the real CLI against each packed tarball must pass. The verified canonical tarball is retained as the `npm-package` Actions artifact for 14 days. Stale SDK pins or failures against a new breaking release block publication until migration passes; polling is not instantaneous adaptation.
- `.github/dependabot.yml` checks the two OMP SDKs every six hours in UTC, excludes them from cooldown, and groups major/minor/patch updates with the lockfile in one `build(deps-dev)` PR. Review and migrate breaking changes; automatic merging is not configured. See the [Dependabot options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference) for schedule, grouping, and cooldown semantics.
- `release.yml` runs on pushes to `main`. Merging a Release Please PR creates `vX.Y.Z` and a GitHub release. It calls the same CI workflow at the **release commit SHA**, checks the tag against the packed version, then publishes that exact tested tarball to GitHub Packages. A GitHub release may exist even if verification or publication fails; check the workflow before announcing package availability.
- Under [GitHub's current event rules](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow), `GITHUB_TOKEN`-created or updated PRs generate **approval-required** runs for `opened`, `synchronize`, and `reopened`. A user with write access must select **Approve workflows to run** on the PR before merging. Other bot-triggered PR activity types, including `edited`, do not create runs; bot-created release/tag events also do not trigger a separate publication workflow. Publishing therefore stays in the same workflow. A manual **CI → Run workflow** on the release branch runs verification but **does not run the PR-title job** and is not a substitute for that required PR check. If approval-free automatic PR checks are needed, use an approved GitHub App token as a separately reviewed configuration change; no personal token is required by this setup.
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
