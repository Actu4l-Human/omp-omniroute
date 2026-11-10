# Compatibility and verification

[README](../README.md) · [Configuration](configuration.md) · [Development commands](development.md)

## Historical scope and baseline

This review covers the supplied extension source snapshot, not a Git diff: the initial `git status --short --branch` reported that the directory was not a Git repository. No LSP was configured. The goal is an extension-registered provider using OMP's normal discovery, model kinds, streaming, tool loop, and usage interfaces, not an upstream patch or an OMP built-in provider.

| Component | Reviewed baseline |
| --- | --- |
| Published `@oh-my-pi/pi-ai` | 18.18.1, Bun >=1.4.4 |
| Published `@oh-my-pi/pi-coding-agent` | 18.18.1, Bun >=1.4.4 |
| OMP `main` source | `24439066040e006eb08da7b204f0ac41c79d2de9` |
| Latest published OmniRoute release at review | v3.8.53, `191dce8d534ceb56c28a08e71381284a9a87838f` |
| OmniRoute development source | `release/v3.8.54`, `a952f49838625656a3341feceb6e8a60c962b150` |

These are fixed historical review baselines, not current dependency policy. Pins were retained during that review; development and release verification now require each SDK's latest published stable npm release, including breaking releases. The development branch is not described as a published 3.8.54 server. The deployment's exact release cannot be inferred from its catalog schema header.

The read-only upstream comparison found byte-identical stable/development versions of `src/lib/modelMetadataRegistry.ts`, `src/app/api/v1/models/catalogPricing.ts`, `src/app/api/v1/models/health/route.ts`, and `src/lib/usage/internalUsageCommand.ts`. The reviewed metadata, pricing, health, and usage contracts therefore apply to both inspected revisions.

## Findings and resolutions

| Finding | Resolution or boundary |
| --- | --- |
| OMP supports `registerProvider`, `fetchDynamicModels`, scoped `refreshDiscoverableProviders([PROVIDER], 'online')`, usage hooks, async factories, tools, reasoning efforts, and kind/API pairs | Retain registration and transport design; no host patch or impersonation |
| Manifest/index precedence supports a single root entry | Root `index.ts` re-exports `src/extension.ts`; runtime helpers moved into `src/`; manifest stays `./index.ts` |
| Custom-stream dispatcher owns the outer provider permit | Retain inner delegation guard in `src/reported-cost.ts`; integration checks confirm one dispatch and no nested-permit stall under a cap of one |
| Native OpenAI chat applies reported cost only for built-in `openrouter`/`cline-pass` names | Keep native chat when interception is off; use provider-owned `omniroute-chat` for inspector, controls, or reported accounting |
| OmniRoute pricing, capabilities, Bearer authentication, SSE `usage.cost`, optional usage permission, health states, and control headers match mapping | Retain units, metadata interpretation, URL derivation, and friendly usage-denial handling |
| **Low-severity defect:** absent deployment-version header incorrectly warned | Fixed only the version branch in `src/doctor.ts`: absent is informational `ok`; valid semver populates `version`; malformed/empty values warn without echoing them |
| `X-Model-Catalog-Version` is a schema identity, not deployment semver | Never read it into `DoctorReport.version`; doctor remains GET-only and does not probe inference or management endpoints |
| Previous CLI cases disabled tools and only discovered specialty models | Added real built-in read-tool loops in native/scoped modes and actual SDK embedding/image HTTP invocation |
| Existing verification ledger included unsupported historical pass/date claims | Replaced it with the observed results and explicit limits on this page; development instructions live in `development.md` |

Deployment contingencies are not extension defects. Bare `auto` is already variable because OmniRoute emits `owned_by: "combo"`. A configured proxy prefix is preserved; operators must separately expose the optional sibling usage route. No guessed bare-combo pattern, usage-origin override, `main`/`exports` field, configuration-default change, or runtime dependency was added.

## Observed local verification

Host tools observed during implementation: Windows x64, Node **26.13.0**, npm **12.2.2**, package-local Bun **1.4.4**, TypeScript **7.0.2**, and actual CLI **omp/18.18.1**. The older global Bun 1.4.2 was not used for npm-script verification.

| Command or scenario | Observed outcome |
| --- | --- |
| `npm.cmd ci` | Installed 70 packages; first run blocked Bun's postinstall, final clean install succeeded with the pinned approval and no blocked-script warning |
| `npm.cmd install-scripts approve bun@1.4.4` then `npm.cmd rebuild bun` | Approved only the pinned Bun installer, rebuilt successfully; package-local `bun --version` returned 1.4.4 |
| `node --test test/doctor.test.ts` | 7 passed, including schema-only catalog and malformed/empty deployment headers |
| Direct `runDoctor` smoke with schema header and healthy fixture | All four checks `ok`, no deployment version, and explicit inference-not-tested limitation |
| `npm.cmd test` | 55 unit/lifecycle tests passed, 0 failed |
| `npm.cmd run typecheck` | Strict runtime-source check passed |
| `npm.cmd run test:integration` | 9 passed across 2 files, 0 failed; 48 Bun expect calls |
| `npm.cmd run test:cli` | Passed automatic/explicit loading, all three model kinds, native/scoped chat and read-tool loops, controls/overrides, and cached custom-API fallback |
| Documentation validation | Local links resolved across 4 documents, code fences balanced, upstream source links immutable, all example environment variables documented |

The original pre-implementation read-only fixture runs passed 24 catalog/change/cost/telemetry cases and 24 extension/doctor/gateway/usage cases. They were not real SDK, CLI, or live inference proof; the current complete-suite result above supersedes those partial counts.

The final sequence reran `npm.cmd ci && npm.cmd test && npm.cmd run typecheck && npm.cmd run test:integration && npm.cmd run test:cli` successfully with the completed layout and coverage. npm reported deprecation notices for two OpenTelemetry dependencies; no version pins were changed.

### What the executable checks prove

- The CLI's first invocation discovers exactly `fixture-chat` (chat), `fixture-embedding` (embedding), and `fixture-image` (image) automatically in a fresh profile. Its staged `agent/extensions/omniroute` contains root `index.ts`, `package.json`, and `src/`, without dependencies. Explicit `--no-extensions -e <entrypoint>` cases also pass.
- Both native and scoped chat modes execute OMP's built-in `read` against a real temporary UTF-8 file. The fixture sends split SSE tool arguments for `call_read_1`, validates the returned tool message and file marker, then emits `File contents verified.`. Each mode observed exactly two chat requests and delivered the final text. Invalid bearer, tools, tool results, or extra requests fail the scenario.
- Existing chat integration cases use the real SDK adapter with synthetic SSE/fetch responses, covering reported zero/nonzero/absent cost, streamed content and terminal events, controls, sanitized telemetry, and single dispatch under a provider cap of one. Actual CLI cases additionally exercise chat over loopback HTTP.
- Specialty cases obtain descriptors through `readConfig` and `mapCatalog` without changing mapped API/kind. Exported `embed` POSTs to authenticated `/v1/embeddings`, returning indexed vector `[0.0123,-0.0456,0.0789]` and input/total usage 4. Exported `generateImage` POSTs to `/v1/images/generations`, returning the exact fixture PNG data and `image/png`. This covers text-to-image, not edits or every media option.

All inference fixtures use `fixture-key`, isolated state, bounded requests/subprocesses, and teardown. No real gateway key is passed to these suites. Runtime registration mocks alone are not the basis for the CLI/transport findings.

## Functionality and QoL follow-up

The later remediation pass retained SDK pins at **18.18.1** and also exercised the installed **OMP 18.18.2** binary. The earlier tables remain historical observations, not current catalog counts.

- Refresh uses the live model selection rather than a command-context snapshot. Changed metadata waits for idle; selection changes, refresh failures, and shutdown cancel deferred rebinding.
- Discovery retains sanitized rejection reasons, reports skipped counts and fallback limits by kind, and supports raw or provider-qualified inspection with command argument completion.
- Personal USD limits expose consumed and remaining fractions. Explicit percentage overages remain visible as raw amounts while normalized fractions stay within the SDK's 0–1 range and report exhaustion.
- Doctor reports exact-ID health coverage separately from observed health states; an empty observation set warns rather than implying health.
- Configuration documentation distinguishes OMP profile dotenv loading from the extension's environment-only configuration and explains inherited-variable precedence.

| Local check | Observed outcome |
| --- | --- |
| `npm.cmd test` | 72 passed, 0 failed |
| `npm.cmd run typecheck` | Passed |
| `npm.cmd run test:integration` | 9 passed, 0 failed; 48 expect calls |
| `npm.cmd run test:cli` | Passed against pinned SDK 18.18.1, including native usage fractions and existing read-tool/outage cases |
| `OMNIROUTE_SMOKE_CLI=omp` with the CLI smoke command | Same scenarios passed against installed OMP 18.18.2 in a disposable profile |
| Actual SDK autocomplete provider | Control arguments and qualified skipped-model IDs completed and replaced the intended argument text |
| Actual SDK usage text renderer | Fixture spending of 1.25 USD against 5 USD rendered a 25% bar and 75.0% remaining |

These follow-up checks used local fixtures only. The text-renderer check does not establish interactive overlay appearance, live availability, or settled billing. No dependency pins, user profile settings, gateway permissions, or live inference were changed.

## Post-1.3.0 diagnostic and CI hardening

The next local pass added override-file preflight and exact-ID match diagnostics, preserved catalog errors across failed cancellation cleanup, separated catalog freshness from selected-model update outcomes, and warned without switching when a selected model disappeared.

| Local check | Observed outcome |
| --- | --- |
| `npm.cmd test` | 83 of 84 passed initially; the sole failure was an incidental wording assertion in a new test, which was removed without changing runtime behavior |
| `node --test test/overrides.test.ts test/doctor.test.ts` | All 22 affected tests passed after the test-only correction |
| `npm.cmd run typecheck` | Passed |
| `npm.cmd run test:integration` | 9 passed; 48 expect calls |
| Workflow package step through Windows Git Bash | Passed real `npm.cmd pack`, keyed JSON parsing, allowlist checks, and the `v1.3.0` tag/version check; output paths redirected to a disposable directory |
| `npm.cmd run test:cli -- <validated tarball>` | Passed automatic discovery, native/scoped chat and read-tool round trips, usage, controls/overrides, and outage fallback |
| Workflow YAML and artifact contract checks | Three required lanes configured; one canonical artifact and all-lane publication gating retained |

The new hosted Ubuntu/Node 24 and Windows/Node 24 jobs have not run locally. Local execution used Windows with Node 26.13.0 and the existing pinned Bun/SDK tools; `actionlint` was unavailable. No live gateway, profile changes, dependency updates, publication, or remote workflow execution was involved.

## Post-1.4.0 SDK policy and control-refresh correction

Both SDK development pins were updated from 18.18.1 to the execution-time stable `latest`, **18.18.2**. Bun **1.4.4** satisfies their published engine requirements; TypeScript remains **7.0.2**. CI independently rejects stale manifest/root-lock/resolved-lock versions and runs locked plus latest-install compatibility lanes. SDK freshness and all five lanes gate publication; the Ubuntu/Node 24 lane covers the declared minimum major. Hosted results remain unverified by local execution.

Transport-control revisions now request a shared trailing refresh when joining a pass that did not include them. Focused local checks passed 20 lifecycle cases, including both native/scoped transitions, multiple waiters, unchanged controls and shutdown, plus the real-adapter regression confirming no initial bypass header and `X-OmniRoute-No-Cache: true` after the changed control completes.

The completed runtime changes passed `npm.cmd test` (**88 passed**), `npm.cmd run typecheck`, and `npm.cmd run test:integration` (**10 passed**, 57 expect calls) locally on Windows/Node 26.13.0 with both SDKs at 18.18.2. These are fixture results, not hosted Ubuntu/Windows/Node 24 or live gateway evidence.

**Unresolved upstream dependency:** the reviewed [OMP selection controller](https://github.com/can1357/oh-my-pi/blob/cb4801a7d6db666946a1b65fce5cdf50d2947b96/packages/coding-agent/src/modes/controllers/extension-ui-controller.ts#L254-L258), also present in published 18.18.2, awaits authentication before unconditional replacement. The public `setModel(model): Promise<boolean>` contract has no conditional parameter. Fixing selection/session changes during that await requires atomic replacement guarded by the expected selection and session after authentication. This local correction does not fix that separate race, patch the host, or restore a potentially stale selection.

## Audit remediation (2026-11-08)

Findings were revalidated against SDK **18.18.2**, Bun **1.4.4**, TypeScript **7.0.2**, and the current source before implementation. The initial batch needed no dependency overrides, host/profile edits or live gateway requests. The subsequent development-only security override is described below.

| Batch | Acceptance and observed local evidence |
| --- | --- |
| Release and fixture isolation | Release Please v4.4.1 resolves to `5c625bfb5d1ff62eadeeb3772007f7f66fdcf071`. Three actual spawned-Bun regressions pass: dotenv and inherited credential/proxy/preload markers are absent, temporary paths are isolated and removed, and script/test modes, arguments and nonzero status are preserved. |
| Usage privacy and identity | Direct and native usage paths pass control-normalization/redaction, truncated/control/provider label collision, exact duplicate, named reorder and anonymous namespace cases. Personal IDs and values remain unchanged; each fetch makes one GET. |
| Catalog and selection | Sanitized-empty names retain the exact gateway ID. A real owner registry retains that row and makes zero selections across two unchanged authenticated refreshes, then updates changed limits, prices and transport. Resolver comparison does not resolve credentials. |
| Licensing | Owner selected AGPL-3.0-or-later. The official license accompanies the source package; CI now requires it. Dependency scope and redistribution obligations are documented in the README. |

Local validation passed **100 unit/lifecycle tests**, strict typechecking and **11 SDK integrations (67 assertions)** on Windows/Node 26.13.0. Integration startup uses the new Node launcher and Bun's native `--no-env-file`, `DO_NOT_TRACK=1`, and `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` controls. Earlier checks launched with bare Bun do not establish dotenv isolation and may have inherited the working directory's `.env`; the new regressions use only synthetic markers. Hosted Actions, POSIX execution, live inference, settled billing and native usage UI rendering are not established by these results.

### Remaining findings and rejected workarounds

- **Native image policy (F07):** SDK response-selected URL downloads remain outside the bounded gateway GET helper. The installed public image API has no provider-scoped policy hook. The trust boundary is documented; destination/redirect/size enforcement is deferred rather than silently breaking CDN image responses or patching host internals.
- **Structured pricing (F10):** SDK custom-model registration drops `pricingStatus`. Native zero-price classification is unknown, not free, absent that field. Name/inspection distinctions remain; full native classification is blocked on upstream propagation.
- **Transitive Zod advisory — remediated in this development graph:** [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) names **4.6.6** as fixed. A scoped npm override upgrades SDK 18.18.2's Puppeteer to **25.16.0**, whose supported BiDi dependency accepts Zod 4; the lockfile resolves **4.6.7**. Forcing Zod 4 into the old BiDi 16 consumer remains rejected. This does not update users' host-supplied SDK/browser dependencies.
- **Existing upstream limits:** the authentication-await selection race described above and bounded socket-drain behavior described in configuration remain. No unsupported conditional-selection shim or duplicate concurrency permit was added.
- **GET consolidation — implemented after reproduction:** an injected fetch ignoring cancellation left catalog discovery pending after its timeout signal fired. Discovery now reuses the shared bounded GET helper, retaining model-envelope validation and sanitized model-specific errors. A fake-clock regression covers stalled fetch and stalled body/cancellation cleanup. Broader performance rewrites remain speculative and unimplemented.

### Follow-up verification

The follow-up passed **101 unit/lifecycle tests**, strict typechecking and **11 SDK integrations (67 assertions)**. A disposable dependency probe exercised OMP's real Puppeteer loader/error identity, BiDi valid/invalid command parsing, and Zod's constrained-array early rejection: 1,000 invalid elements over a length limit produced one `too_big` issue rather than per-element issues. `npm ls` confirms the overridden parent → supported BiDi → Zod 4.6.7 chain. Eight transitive packages changed; direct SDK/Bun/TypeScript pins and the dependency license distribution are unchanged.

No full Chromium browser session was exercised, so browser launch/interaction compatibility beyond the loader/parser checks remains unverified. Hosted Actions, POSIX/Node 24, live gateway/inference and native UI checks remain unverified. The override is development-root-only, not a runtime security guarantee for separately installed hosts.

## Live deployment evidence

The supplied root `.env` was an explicit validation input, parsed with Node `parseEnv(readFileSync('.env','utf8'))`, not shell evaluation or extension dotenv loading. Only authenticated GET requests were authorized and sent. No private URL, credential, raw remote payload, spend, or account detail is recorded here.

The following observations were collected in the approved pre-implementation review:

| Read-only check | Observed result |
| --- | --- |
| `/v1/models` | 1,957 catalog rows |
| `mapCatalog` with supplied configuration | 1,828 accepted, 129 skipped |
| Accepted kinds | 1,610 chat, 13 embedding, 205 image |
| Pricing interpretation | 1,238 estimated, 544 unknown, 46 variable |
| Tool/reasoning metadata | 1,610 explicitly tool-capable; 1,419 reasoning models |
| Missing limits | 457 accepted models use at least one existing fallback |
| `/v1/models/health` | 766 rows, all `ok` |
| Old doctor version branch | Missing deployment-version warning reproduced live |
| Native `createUsageProvider(config).fetchUsage(...)` | Succeeded after the user enabled `allowUsageCommand`; provider `omniroute`, 30 normalized percent-based quotas: 29 `ok`, 1 `warning` |

Usage initially returned HTTP 403 before the user enabled the optional permission. The extension did not change permissions, and friendly denial handling remains for other keys. No include/exclude filters or override file were configured in this validation input.

### Post-fix read-only doctor

After the diagnostic correction and source move, the exact [read-only doctor command](development.md#authorized-read-only-deployment-check) was run against the supplied `.env`.

| Check | Observed result |
| --- | --- |
| Endpoint, authenticated models, version, health | All four statuses `ok`; no warnings |
| Catalog count | 1,958 rows |
| Health | 766 rows, all `ok` |

The catalog changed from the earlier 1,957-row observation. Mapping and usage were not rerun in this final check, so their earlier counts are not asserted for the new roster. Only catalog and health GETs were sent; no inference or setting change occurred.

These observations prove live authentication, catalog parsing/mapping, read-only health connectivity, and usage-adapter fetching/normalization. They do **not** prove live chat/tool execution, embeddings, image generation, native usage UI rendering, settled billing, or the server's exact release. Healthy rows only mean no pause observed by that instance. Any live inference requires separate authorization for its model and scope.

## Immutable primary sources

### OMP at `24439066040e006eb08da7b204f0ac41c79d2de9`

- [Extension/provider contracts](https://github.com/can1357/oh-my-pi/blob/24439066040e006eb08da7b204f0ac41c79d2de9/docs/extensions.md)
- [Extension loading and manifest/index precedence](https://github.com/can1357/oh-my-pi/blob/24439066040e006eb08da7b204f0ac41c79d2de9/docs/extension-loading.md)
- [Model kinds and APIs](https://github.com/can1357/oh-my-pi/blob/24439066040e006eb08da7b204f0ac41c79d2de9/docs/models.md)
- [Stream dispatch and provider permits](https://github.com/can1357/oh-my-pi/blob/24439066040e006eb08da7b204f0ac41c79d2de9/packages/ai/src/stream.ts)
- [Native chat reported-cost whitelist](https://github.com/can1357/oh-my-pi/blob/24439066040e006eb08da7b204f0ac41c79d2de9/packages/ai/src/providers/openai-shared.ts)
- [Built-in read tool schema](https://github.com/can1357/oh-my-pi/blob/24439066040e006eb08da7b204f0ac41c79d2de9/packages/coding-agent/src/tools/read.ts)
- [Embedding public API](https://github.com/can1357/oh-my-pi/blob/24439066040e006eb08da7b204f0ac41c79d2de9/packages/ai/src/embeddings/index.ts) and [types](https://github.com/can1357/oh-my-pi/blob/24439066040e006eb08da7b204f0ac41c79d2de9/packages/ai/src/embeddings/types.ts)
- [Image public API](https://github.com/can1357/oh-my-pi/blob/24439066040e006eb08da7b204f0ac41c79d2de9/packages/ai/src/images/index.ts) and [types](https://github.com/can1357/oh-my-pi/blob/24439066040e006eb08da7b204f0ac41c79d2de9/packages/ai/src/images/types.ts)

### OmniRoute stable v3.8.53 at `191dce8d534ceb56c28a08e71381284a9a87838f`

- [API reference: authentication, usage, session/bypass headers](https://github.com/cheaper-inference/OmniRoute/blob/191dce8d534ceb56c28a08e71381284a9a87838f/docs/reference/API_REFERENCE.md)
- [Catalog paging defaults](https://github.com/cheaper-inference/OmniRoute/blob/191dce8d534ceb56c28a08e71381284a9a87838f/src/app/api/v1/models/catalogPagination.ts)
- [Health response](https://github.com/cheaper-inference/OmniRoute/blob/191dce8d534ceb56c28a08e71381284a9a87838f/src/app/api/v1/models/health/route.ts)

### OmniRoute development at `a952f49838625656a3341feceb6e8a60c962b150`

- [Metadata and diagnostic headers](https://github.com/cheaper-inference/OmniRoute/blob/a952f49838625656a3341feceb6e8a60c962b150/src/lib/modelMetadataRegistry.ts)
- [Catalog pricing](https://github.com/cheaper-inference/OmniRoute/blob/a952f49838625656a3341feceb6e8a60c962b150/src/app/api/v1/models/catalogPricing.ts)
- [Catalog construction](https://github.com/cheaper-inference/OmniRoute/blob/a952f49838625656a3341feceb6e8a60c962b150/src/app/api/v1/models/catalog.ts)
- [Usage implementation and permission](https://github.com/cheaper-inference/OmniRoute/blob/a952f49838625656a3341feceb6e8a60c962b150/src/lib/usage/internalUsageCommand.ts)
- [Reported-cost behavior](https://github.com/cheaper-inference/OmniRoute/blob/a952f49838625656a3341feceb6e8a60c962b150/tests/unit/usage-openrouter-cost-4074.test.ts)

## SDK 18.18.6 refresh (2026-11-10)

Both SDK development pins were updated from 18.18.2 to the stable `latest`, **18.18.6** (published 2026-11-09), per the track-latest policy. The upstream delta 18.18.2 → 18.18.6 was reviewed from OMP `main` commits: the credential-scoped idle-cache classification fix, wait-delivered result labeling, GTK4/AT-SPI natives fix, and the new optional `session_before_shutdown` extension gate. None change a surface this extension uses; `session_shutdown` remains a notification-only teardown event, and this extension has no pre-close state needing the new gate, so no handler was added.

| Local check | Observed outcome |
| --- | --- |
| `npm.cmd ls @oh-my-pi/pi-ai @oh-my-pi/pi-coding-agent` | Both resolve to 18.18.6 with all `@oh-my-pi/*` transitives deduped at 18.18.6 |
| `npm.cmd run typecheck` | Passed |
| `npm.cmd test` | 101 passed, 0 failed |
| `npm.cmd run test:integration` | 11 passed, 0 failed; 67 expect calls |
| `npm.cmd run test:cli` | Passed automatic/explicit loading, three model kinds, native/scoped chat and read-tool round trips, controls, reported cost, and cached fallback |

OmniRoute remains at stable v3.8.53; no new server release or API change was found. Bun stays 1.4.4, satisfying the 18.18.6 engine requirement. These are local Windows fixture results; hosted Actions and live gateway behavior remain unverified by this pass.

**Override scope correction:** the Zod advisory override had been exact-scoped to `@oh-my-pi/pi-coding-agent@18.18.2` and silently stopped applying after the pin bump, resolving vulnerable Zod 3.25.76 through Puppeteer 25.3.0. It is now scoped to `@^18.18.6`, and `npm ls` confirms puppeteer-core **25.16.0 (overridden)** → Chromium BiDi 157.0.8090-0 → Zod **4.6.7**. All suites above were rerun after this correction.

## OmniRoute 3.8.54 feature adoption (2026-11-10)

The deployment under review runs OmniRoute 3.8.54 (its release branch tip is now `8e72dbf546f2674da4e1ae9073ad4d4b65b836f0`, 142 commits past the previously reviewed `a952f498`). Four reviewed upstream features are now used by the extension; all degrade gracefully on older deployments.

| Upstream feature | Extension change |
| --- | --- |
| Agent-session attribution (#14833) | Chat requests always send an opaque `X-OmniRoute-Session-Id` tag (same derivation as sticky affinity); sticky mode additionally pins `X-Session-Id` |
| `GET /v1/me/sessions` (#14840) | New `/omniroute-sessions [id]` command lists key-scoped agent sessions; detail shows recent requests with cached-token breakdowns. Requires the key's self:usage scope; 401/403/404 get friendly errors |
| Cached input token reporting (#16452) | Session rows map `cacheRead`/`cacheCreation`/`uncachedInput`; per-request inspection already recorded `cacheRead`/`cacheWrite` |
| Personal exceeded flags (#14771 self-service) | `dailyExceeded`/`weeklyExceeded: true` marks the matching limit `exhausted` even when raw ratios read lower |
| Anthropic rate-limit header forwarding (#14862) | `/omniroute-last` captures forwarded `anthropic-ratelimit-*` headers, redacted; absent on `auto`/`strip` policies or non-Anthropic routes |

| Local check | Observed outcome |
| --- | --- |
| `npm.cmd run typecheck` | Passed |
| `npm.cmd test` | 108 passed, 0 failed (new sessions suite, exceeded-flag and rate-limit-header cases; updated session-header pins) |
| `npm.cmd run test:integration` | 11 passed, 0 failed; 67 expect calls |
| `npm.cmd run test:cli` | Passed all scenarios including native/scoped chat round trips with the unconditional attribution header |

These are local fixture results against SDK 18.18.6. Live 3.8.54 gateway behavior for the new endpoints was not exercised in this pass.
