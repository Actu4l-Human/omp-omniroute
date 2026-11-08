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
  doctor.ts                 Read-only endpoint/catalog/version/health diagnostics
  gateway.ts                Bounded authenticated same-origin GETs and URL derivation
  overrides.ts              Bounded file loading and strict override validation
  reported-cost.ts          Scoped chat wrapper delegating to OMP's native adapter
  telemetry.ts              Request-control headers and sanitized request metadata
  usage.ts                  Optional key-scoped usage fetching and normalization
test/
  *.test.ts                 Node unit/lifecycle fixtures
  reported-cost.integration.ts  Real SDK chat-adapter cases
  specialty.integration.ts  Real SDK embedding/image HTTP loopback cases
  cli-smoke.ts              Actual OMP CLI in a disposable profile
docs/                       Configuration, compatibility, and this guide
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

npm 12 initially blocked Bun's required installer. The manifest now contains a version-specific `allowScripts` entry for `bun@1.4.4`. During setup it was approved with `npm.cmd install-scripts approve bun@1.4.4`, followed by `npm.cmd rebuild bun`. Do not bypass all installation-script checks or silently fall back to a different Bun. If installation fails, report the exact unavailable dependency/check while retaining the pins.

## What the checks exercise

- `test`: Node unit/lifecycle suites for mapping, refresh, overrides, costs, telemetry, gateway bounds, usage, and doctor. Missing deployment-version headers are healthy; explicitly malformed/empty ones warn without leaking their contents.
- `typecheck`: strict checking of the root loader and runtime modules against the pinned public SDK. Test files are not included in this compiler target.
- `test:integration`: OMP's real chat adapter with controlled SSE/fetch responses, zero/nonzero/absent reported cost, controls and terminal events, plus a registered custom API under a one-request provider cap with one dispatch. Specialty cases call exported `embed` and `generateImage` over authenticated loopback HTTP, verifying an indexed vector/usage and exact PNG data.
- `test:cli`: starts the actual package CLI with package-local Bun against an authenticated loopback fixture. The staged profile contains `agent/extensions/omniroute/{index.ts,package.json,src/}` and no extension-local dependencies. Its first command uses automatic discovery before a catalog cache exists. Later commands exercise explicit loading, native/scoped chat, real built-in `read` tool loops with split streamed arguments, request controls/overrides, and cached custom-API fallback during discovery outage.

The CLI receives only fixture credentials, uses a temporary working directory/profile, and bounds each subprocess to 45 seconds. Both native and scoped tool scenarios require exactly two chat requests: the tool call, then the real file result before final text. Specialty requests have five-second abort signals. Teardown removes the temporary profile and stops loopback servers.

These fixtures prove client registration/transport behavior, not a production model's availability, quality, billing, or every provider-specific image option. Image coverage is text-to-image, not editing. Native usage UI rendering is not covered. Do not replace actual SDK/CLI checks with mock registration assertions.

## Authorized read-only deployment check

Only run this against a deployment you are authorized to inspect. It explicitly parses a local `.env` without shell evaluation; this does not imply extension-level dotenv support. It sends only the doctor's catalog/health GETs and prints statuses/counts, not the URL, credential, raw payload, or account details:

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
