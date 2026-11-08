# Repository Guidelines

## Project Overview

This TypeScript extension registers a self-hosted OmniRoute gateway as OMP provider `omniroute`. It supplies dynamic model discovery, chat/tool streaming, embedding/image model kinds, diagnostics, and optional usage reporting. It is not a gateway server or an OMP built-in provider; preserve gateway model IDs and avoid provider impersonation.

## Architecture & Data Flow

- Root `index.ts` re-exports the default factory from `src/extension.ts`. Keep this single entry point and `package.json`'s `omp.extensions: ["./index.ts"]`; helpers are not independently loadable extensions.
- `extension.ts` coordinates registration, commands, session events, and refreshes. Discovery loads validated overrides, fetches `/v1/models`, then calls `catalog.ts`'s `mapCatalog` to produce OMP models plus in-memory raw/mapping metadata. `changes.ts` compares successful catalogs for alerts.
- Chat uses native `openai-completions` when interception features are off. Otherwise `reported-cost.ts` delegates through provider-owned `omniroute-chat`, using `telemetry.ts` for controls/inspection and `cost.ts` for reported accounting. Embeddings/images retain native `openai-embeddings`/`openai-images` APIs.
- Preserve the inner delegation guard in `reported-cost.ts`: OMP's outer dispatcher already owns the provider permit and dispatch callback. Acquiring them twice can deadlock at concurrency one. Keep the scoped adapter registered for cached custom-API rows.
- `gateway.ts` implements bounded authenticated GETs and prefix-preserving URLs for `doctor.ts` and `usage.ts`. Usage is a sibling `/api/usage/om-usage` route, not under `/v1`; preserve friendly 403 handling for keys without `allowUsageCommand`.

## Key Directories

- `src/`: flat runtime modules; keep transport, mapping, and lifecycle responsibilities separate.
- `test/`: Node unit/lifecycle suites, Bun SDK integrations, and standalone actual-CLI smoke orchestration. There is no separate scripts directory.
- `docs/`: operational reference and source-backed compatibility evidence; update relevant documentation when behavior changes.
- `.github/workflows/`: reusable CI and Release Please/GitHub Packages publishing. Keep write permissions confined to release metadata and publishing jobs.

## Development Commands

Run from the repository root. Use `npm.cmd` on this Windows host; use `npm` on POSIX.

```sh
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
npm.cmd run test:integration
npm.cmd run test:cli
npm.cmd pack --ignore-scripts --dry-run
```

Focused unit check: `node --test test/doctor.test.ts`.

With authorized gateway settings supplied through the process environment:

```sh
omp models omniroute --kind all --json --no-extensions -e ./index.ts
omp --no-extensions -e ./index.ts
```

There is no build, lint, or formatter script. TypeScript checking uses `noEmit`; OMP loads source directly. Automatic installation uses the complete folder under the active profile's `agent/extensions/omniroute/`.

## Code Conventions & Common Patterns

- Match surrounding compact TypeScript: single-quoted strings, semicolons, explicit `.ts` relative imports, and `import type` where appropriate. Use camelCase functions/variables, PascalCase types, and lowercase/kebab-case filenames. Avoid unrelated reformatting.
- Preserve dependency injection: `installOmniRoute(pi, env, fetchImpl, adapter)` and helper `fetchImpl` parameters support isolated fixtures; `createOmniRouteStream` receives settings/session/observer callbacks. Validate external data before mapping it.
- State belongs to the extension closure: catalog metadata, last request, change baseline, and settings are process-local. Coalesce refreshes through the pending promise, clear timers on shutdown, and rebind selected models only while idle.
- Discovery failures must throw, not return an empty catalog: OMP retains its last successful roster. Its provider-name cache can retain old configuration during outages; filters are not access control.
- Bound network/file reads, preserve abort/deadline handling and redirect rejection, and report sanitized errors rather than raw response bodies. Observer failures must not break inference; never retain prompts, tool arguments, or secrets in telemetry.
- Preserve explicit false/zero metadata. Unknown/variable price zeros are schema placeholders, not free inference. Catalog schema headers are not deployment versions; absent deployment-version headers are informational in doctor.

## Important Files

- `package.json`, `package-lock.json`: scripts, exact development pins, extension manifest, and Bun installer approval.
- `release-please-config.json`, `.release-please-manifest.json`: SemVer baseline/policy; Release Please updates package/lock versions, `CHANGELOG.md`, and the annotated README version. Use Conventional Commit titles and squash merges; review generated release notes.
- `.npmrc` and `package.json`'s `publishConfig` target GitHub Packages for `@actu4l-human/omp-omniroute`. Preserve the package file allowlist; never include `.env` or local profiles. Publishing happens only after the release tarball passes CI.
- `tsconfig.json`: strict NodeNext/ES2022 checking of `index.ts` and `src/**/*.ts`; tests are excluded.
- `.env.example`, `overrides.example.json`: configuration examples. Override keys are exact existing model IDs; relative file paths resolve from OMP's working directory.
- `README.md`: installation and quickstart. `docs/configuration.md`: defaults, commands, mapping, pricing, and troubleshooting.
- `docs/development.md`: verification workflows. `docs/compatibility.md`: immutable upstream references and observed evidence; do not treat historical pass counts as current results.

## Runtime/Tooling Preferences

Development requires Node >=24; npm scripts use package-local Bun **1.4.4**, TypeScript **7.0.2**, and OMP SDKs **18.18.1**. Preserve pins and the npm lockfile; do not substitute an older global Bun. `allowScripts` approves only `bun@1.4.4`'s installer.

Runtime installation needs `index.ts`, `package.json`, and `src/`, not extension-local dependencies. OMP supplies SDK imports. Configuration comes from process environment; `.env` is ignored by Git and is **not automatically loaded**. Never disclose credentials/private deployment data. Live checks require authorization; live inference needs explicit model/scope authorization, not merely access to `.env`.

## Testing & QA

- `test/*.test.ts`: `node:test` with `node:assert/strict`; injected fetch/lifecycle fixtures plus temporary-file override cases.
- `test/*.integration.ts`: `bun:test`; real SDK streaming/cost/concurrency checks and authenticated loopback embedding/image calls.
- `test/cli-smoke.ts`: real OMP CLI in a disposable profile, without extension-local dependencies. With an optional tarball path, extract and test the packaged extension instead of source copies. Preserve fresh-profile automatic discovery, explicit loading, both real read-tool round trips, controls/overrides, and outage fallback.

For runtime changes, run unit tests and typecheck, then the affected integration/CLI paths. Keep fixtures credential-free, loopback-only, bounded by timeouts, and cleaned up in `finally`/teardown hooks. Assert consumer-visible behavior and failure boundaries; mock registration alone does not prove transport or agent-loop compatibility. Fixtures do not prove live availability, settled billing, or native usage UI rendering. For documentation-only changes, validate referenced commands, paths, and links without contacting the gateway.
