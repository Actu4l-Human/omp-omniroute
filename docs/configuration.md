# Configuration and operation

[Installation](../README.md) · [Compatibility and evidence](compatibility.md) · [Development](development.md)

## Environment

Settings are read from the OMP process environment at extension load. Restart/reload after changing them. The extension does not load dotenv files itself, and [.env.example](../.env.example) is never loaded automatically. **OMP does load dotenv settings**, including the active profile's `agent/.env`; for a named profile the default path is `~/.omp/profiles/<name>/agent/.env`.

Existing nonempty process variables take precedence over OMP's dotenv loader. OMP checks project, active agent/profile, configuration-root, then home `.env` values for unset variables; Bun may already have loaded project dotenv values before OMP starts. A stale exported `OMNIROUTE_API_KEY` can therefore override the key in a named profile. Check the launching shell's environment without printing credentials, clear unintended overrides there, and launch with `omp --profile <name>`. The extension does not modify these sources. `/omniroute-controls` changes only the listed process-local settings; an override file is reread on discovery attempts.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMNIROUTE_BASE_URL` | required | Reachable HTTPS API root, optionally ending in `/v1`; preserves a proxy prefix |
| `OMNIROUTE_API_KEY` | required | Bearer API key, not a dashboard password |
| `OMNIROUTE_INCLUDE` | all | Comma-separated, case-sensitive ID globs |
| `OMNIROUTE_EXCLUDE` | none | Excluded ID globs; exclusions win |
| `OMNIROUTE_REQUIRE_TOOLS` | `true` | Exclude chat rows explicitly declaring no tools; unknown support stays unknown |
| `OMNIROUTE_REFRESH_MS` | `300000` | Refresh interval, integer 30000–86400000 ms |
| `OMNIROUTE_TIMEOUT_MS` | `12000` | Discovery/diagnostic deadline, integer 100–14000 ms; below OMP's 15-second discovery limit |
| `OMNIROUTE_VARIABLE_PRICE` | none | Additional variable-price ID globs for routing aliases |
| `OMNIROUTE_REPORTED_COST` | `false` | Apply reported chat costs to OMP totals |
| `OMNIROUTE_INSPECT_REQUESTS` | `true` | Capture chat metadata for `/omniroute-last`; enables the scoped chat adapter |
| `OMNIROUTE_CATALOG_ALERTS` | `true` | Notify on meaningful catalog changes after the initial baseline |
| `OMNIROUTE_OVERRIDES_FILE` | none | JSON override path; absolute recommended, relative resolved from OMP's working directory |
| `OMNIROUTE_STICKY_SESSIONS` | `false` | Send an opaque, stable session-affinity tag on chat requests |
| `OMNIROUTE_BYPASS_CACHE` | `false` | Ask the gateway to bypass its semantic cache for chat |
| `OMNIROUTE_BYPASS_MEMORY` | `false` | Skip gateway memory/skills injection for chat |
| `OMNIROUTE_ALLOW_INSECURE_HTTP` | `false` | Allow plaintext HTTP on a trusted network; loopback HTTP is already allowed |

Booleans accept literal `true` or `false`; an empty value uses the default. Globs support `*` only. For example, `OMNIROUTE_INCLUDE='openai/*,anthropic/*,auto/*'` filters by full gateway ID, not display name. Filters are not an access-control boundary.

HTTPS is recommended. URLs with embedded credentials, query parameters, or fragments are rejected. The API root gains `/v1` if absent. Discovery and read-only diagnostic GETs reject redirects and bound response bodies to 5 MiB. The key is not stored in returned configuration or catalog rows.

## Commands

| Command | Effect |
| --- | --- |
| `/omniroute-refresh` | Force online discovery for this provider only |
| `/omniroute-status` | Show catalog freshness, skipped/fallback counts, unmatched override counts, selected-model update status, and pricing caveats |
| `/omniroute-model <ID or selector>` | Show accepted-model metadata and override guidance, or explain why the exact gateway ID was skipped |
| `/omniroute-usage` | Fetch key-scoped usage and provider quota snapshots, augmented with 3.8.54+ self-service monthly spend, token totals (including cache/reasoning splits) and limit entries when the key has the self:usage scope; personal limit rows honor explicit exceeded flags |
| `/omniroute-sessions [id]` | List agent sessions the gateway attributes to this API key (OmniRoute 3.8.54+, self:usage key scope); with an id, show that session and its recent requests including cached-token breakdowns |
| `/omniroute-doctor` | Validate local overrides and perform read-only endpoint, authentication, catalog, version-header, optional health, and agent-session attribution checks |
| `/omniroute-last` | Show the last inspected chat request's routing/cost metadata |
| `/omniroute-changes` | Show the latest meaningful catalog change |
| `/omniroute-controls` | Show local settings; append a control and `on`/`off` to change it |

Controls are `sticky`, `cache-bypass`, `memory-bypass`, `inspect`, and `alerts`. Change them when the current turn is idle. Transport-affecting controls trigger discovery; if a changed control joins an older refresh, the command waits for a trailing pass that includes the new settings. Multiple callers share that pass; unchanged controls retain ordinary coalescing. Discovery failure still warns and retains cached models rather than retrying automatically. Changes apply to subsequent requests, not an active stream. Environment defaults return on reload.

Tab completion supplies control names with `on`/`off`, and known accepted or rejected model IDs. `/omniroute-model` accepts either a raw gateway ID or a copied `omniroute/<gateway ID>` selector. Exact gateway IDs take precedence if an ID itself starts with `omniroute/`; use the raw ID to resolve an ambiguous selector.

Startup and periodic refreshes use OMP's scoped discovery API. Concurrent refreshes are coalesced, shutdown clears timers, and failures retain the last successful catalog. Catalog and diagnostic GETs contact the configured gateway, not an external metadata service. Native image downloads have a separate trust boundary described below.

After successful discovery, an idle session rebinds its selected OmniRoute model only when the model configuration differs, including transport, capabilities, or prices. Refresh reads the live selection after discovery, so it respects changes made during discovery. Structurally unchanged refreshes do not trigger model selection. If the session is busy, a managed idle check applies the pending metadata without another catalog request; it never rebinds during a stream. A changed selection, failed refresh, or shutdown cancels that pending rebind.

OMP recreates request-time header resolver functions during discovery. Their object identity alone does not constitute a metadata change; resolver presence and all other exposed model fields, including static headers, still participate in comparison. Refresh does not execute resolvers merely to compare credentials.

**Upstream limitation:** OMP 18.18.2's `setModel` awaits authentication before unconditionally replacing the selection. A user selection or session change during that authentication await can still be overwritten. The public API has no atomic conditional replacement; a post-call check cannot prevent it. Reliable remediation requires an upstream guard on both the expected current selection and session after authentication. The extension does not attempt restoration that could overwrite another newer choice.

Catalog freshness and selected-model updates are separate. A rejected or failed model update warns without marking a successfully fetched catalog stale or suppressing catalog change reporting. Status distinguishes metadata waiting for idle (`pending`), unavailable model authentication (`rejected`), update errors (`failed`), and a selected model absent from the latest discovered catalog (`missing`). Resolve authentication or retry `/omniroute-refresh` while idle as directed.

When the selected model disappears or is filtered out, the extension warns but does not switch it automatically. Repeated unchanged refreshes do not repeat that warning. Select an available model or correct filters/overrides; the warning clears when the model returns, selection changes, or a new discovery failure makes the catalog stale.

### Request attribution and rate-limit visibility (OmniRoute 3.8.54+)

Chat requests always carry an opaque, stable `X-OmniRoute-Session-Id` derived from the OMP session, so the gateway can attribute spend to that session in its analytics. With `OMNIROUTE_STICKY_SESSIONS=true` the same tag additionally pins `X-Session-Id` for routing affinity; the tag never contains the session id, path, or working directory. `/omniroute-last` reports any upstream `anthropic-ratelimit-*` headers the gateway forwards under its per-key policy, redacted like other inspected metadata. `/omniroute-sessions` reads the gateway's key-scoped agent-session reports, which separate cache-read/cache-write input from uncached input. Both features degrade gracefully: deployments without session attribution or the self:usage key scope simply report nothing or a friendly error.

## Catalog-to-OMP mapping

| Gateway field | OMP interpretation |
| --- | --- |
| `id` | Preserved unchanged; select as `omniroute/` plus the complete ID |
| `name` | Display name; an empty or whitespace-only name after terminal-control removal falls back to the unchanged ID |
| `type` absent, `chat`, `text`, or `completion` | Chat kind, `openai-completions`; `omniroute-chat` when interception features are enabled |
| `type: "embedding"` | Embedding kind, `openai-embeddings` |
| `type: "image"` | Image kind, `openai-images` |
| Other specialty types or unsupported input-only modalities | Skipped, not misregistered as chat |
| `capabilities.reasoning`, `thinking`, `supportsThinking` | Reasoning capability; explicit false preserved |
| `capabilities.effort_tiers` or top-level `effort_tiers` | Supported effort intersection: `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `capabilities.tool_calling` | Explicit `supportsTools`; false can trigger the configured chat filter |
| `input_modalities` | Supported `text`/`image` inputs; vision capability is a fallback |
| `context_length` | `contextWindow` |
| `max_output_tokens` | `maxTokens`, bounded by context window |

Missing limits use 8192 context tokens and 2048 output tokens, recorded in `defaultsUsed`; these are placeholders, not model-specific guarantees. Missing/empty effort tiers do not invent a reasoning dial. Unsupported effort names and unknown fields remain in the raw metadata. Image and embedding models have their own roles, not chat-picker entries.

**Native image download boundary:** OMP 18.18.2 requests base64 images, but its native decoder also accepts a response's `data.url` and downloads that destination, following redirects. That second request does not carry the gateway Bearer token. The extension's bounded, redirect-rejecting gateway GET helper does not govern these image downloads. Use a trusted gateway; a compromised or untrusted response could select another network destination. The public image API has no provider-scoped destination/redirect/size policy hook. Enforcement is deferred to an upstream mechanism rather than replacing native transport or breaking valid CDN URLs.

The last successful accepted rows and mapping metadata are kept in memory for `/omniroute-model`. Rejected valid IDs retain rejection reasons, not their raw payloads. `/omniroute-status` counts malformed rows/IDs, accepted-ID duplicates, include/exclude filtering, unsupported types/inputs, and explicit lack of required tools. Each skipped row counts under its first rejection; one ID can accumulate distinct reasons, including a discarded duplicate after an accepted row. Malformed IDs contribute only to counts.

Fallback context/output counts are grouped by chat, embedding, and image kind. They count missing or invalid limits, not explicit limits or output clamping. Inspect a model's `defaultsUsed`, then supply verified `context_length`/`max_output_tokens` through an [exact-ID override](#exact-id-overrides). OMP's public model schema cannot preserve arbitrary custom fields; these diagnostics are process-local, unavailable after restart until discovery succeeds, and retained on discovery failure.

## Pricing and reported costs

`pricing.input`, `output`, `cached`, and `cache_creation` use USD per million tokens, matching OMP directly. When absent, OpenRouter-shaped `prompt`, `completion`, `input_cache_read`, and `input_cache_write` use USD per token and are multiplied by 1,000,000. Explicit zero is preserved.

- **Estimated:** known input/output catalog rates, not a settled bill. Missing cache rates are recorded separately.
- **Unknown:** missing input/output pricing, labeled `[price unknown]`.
- **Variable:** routing aliases/combinations, labeled `[price variable]`; a first-target price is not a fixed bill.
- **Reported:** a finite, nonnegative SSE `usage.cost` value observed for that request, including zero.

`auto/*`, `combo/*`, `owned_by: "combo"`, and explicit variable-pricing metadata identify variable routes. OmniRoute's bare `auto` row is covered by its `owned_by: "combo"` metadata. Other aliases need explicit metadata or `OMNIROUTE_VARIABLE_PRICE`; names alone are not reliable.

Unknown and variable rates use zero-valued numeric schema placeholders. **Zero placeholders do not mean free.** Credit/per-request pricing cannot be represented faithfully in token-rate fields.

OMP 18.18.2's public custom-model registration does not propagate structured `pricingStatus`. Its native zero-price classification without that field is **unknown**, not free; explicit free, variable and unknown zero-priced rows cannot all be distinguished there. The extension preserves its display-name annotations and inspection metadata. Full native classification awaits upstream field propagation; it does not justify impersonating a built-in provider.

Enable `OMNIROUTE_REPORTED_COST=true` to replace final chat totals with reported USD costs. OMP 18.18.1 only applies native chat reported costs automatically for its built-in `openrouter` and `cline-pass` provider names. The extension instead delegates through its own `omniroute-chat` wrapper to OMP's real OpenAI adapter, without replacing global transports or impersonating a provider.

Inspection is enabled by default, so default chat models use the wrapper even with reported-cost accounting off. To retain the exact `openai-completions` API identifier, disable inspection and keep reported cost, sticky sessions, and both bypass controls false, then refresh successfully. The wrapper remains registered to support previously cached custom-API models.

OMP's outer custom-stream dispatcher owns the provider concurrency permit and `beforeDispatch` check. Inner delegation avoids acquiring them twice. Bounded socket cleanup can outlive a completed logical request by up to 2.5 seconds; the permit does not strictly count still-draining sockets.

Reported cost is authoritative only when supplied; otherwise the catalog estimate or unknown placeholder remains. No extra billing request is made. Accounting buckets are allocated by their share of the estimate to keep OMP aggregators additive, including tiny positive estimates; only the reported total is authoritative, not the inferred input/output allocation. Embedding/image costs are not intercepted. Use gateway/provider accounting for a complete bill.

## Exact-ID overrides

Copy [overrides.example.json](../overrides.example.json), replacing its key with an exact ID already in the gateway catalog. For example, if the catalog contains `fixture-chat`, this overrides only that ID:

```json
{
  "fixture-chat": {
    "api": "openai-completions",
    "context_length": 16384,
    "max_output_tokens": 4096,
    "capabilities": {"tool_calling": true, "vision": false},
    "input_modalities": ["text"],
    "pricingStatus": "unknown"
  }
}
```

`fixture-chat` is a local-test ID, not a promised live model. Set the path, for example in Bash:

```bash
export OMNIROUTE_OVERRIDES_FILE="$HOME/omp-extensions/omniroute-overrides.json"
```

Relative paths are accepted and resolve from OMP's working directory. There is no absolute-path validator; an absolute path avoids ambiguity when launching from another directory.

Allowed fields and constraints:

| Field | Accepted values |
| --- | --- |
| Object keys | Exact IDs, nonempty, at most 512 characters, no control characters |
| `name` | Nonblank string, at most 240 characters, no control characters |
| `type` | `chat`, `text`, `completion`, `embedding`, `image` |
| `api` | `openai-completions`, `openai-embeddings`, `openai-images`; must agree with `type` if both supplied |
| `context_length`, `max_output_tokens` | Positive safe integers |
| `capabilities` | Boolean `reasoning`, `thinking`, `supportsThinking`, `vision`, `tool_calling`; `effort_tiers` is a unique array of supported efforts |
| `input_modalities` | Unique array containing only `text` and/or `image` |
| `pricing` | Finite nonnegative numbers for `input`, `output`, `cached`, `cache_creation`, in USD per million tokens |
| `pricingStatus` | `estimated`, `unknown`, `variable` |

Files must be regular JSON files of at most 256 KiB. Unknown fields, prototype keys, unsupported values, and contradictory API/type pairs fail the refresh, leaving the prior catalog under OMP's cache policy. Overrides cannot insert absent models, rename IDs, change destinations, set credentials/headers, or execute commands.

`/omniroute-doctor` validates a configured file even when catalog access fails. Missing, unreadable, invalid, and oversized files produce actionable errors naming `OMNIROUTE_OVERRIDES_FILE`, without exposing local paths or invalid contents. Correct the file/path (relative paths use OMP's working directory), or unset the variable if overrides are no longer needed.

Override keys are audited against unique **raw catalog IDs before local filtering**. Status and the footer warn about unmatched keys; doctor exposes `overrides.matched` and `overrides.unmatched`, with an optional `suggestedId`. For example, an override key `omniroute/vendor/chat` suggests `vendor/chat` only when the former is absent and the latter exists. An exact raw ID beginning with `omniroute/` always wins. Keys are never rewritten, and missing models are never inserted. If catalog access fails, doctor reports file validity without claiming match counts.

Overrides apply before capability filtering. Explicit reasoning/vision overrides take priority over raw metadata. Native chat API overrides still use the wrapper if its features are enabled. `estimated` cannot turn missing input/output rates into known prices. Overrides are operator assertions, not proof the upstream supports the capability. Run `/omniroute-refresh` after editing; `/omniroute-model` separates the original row from overrides.

## Usage permission and reverse proxies

The native usage adapter and `/omniroute-usage` read `/api/usage/om-usage?format=json` on the same gateway. The key needs optional **allowUsageCommand**, off by default. HTTP 403 is reported clearly; the extension never grants permission or asks for management credentials.

Personal daily/weekly amounts use USD. When both spending and a positive limit are known, the adapter supplies remaining allowance and bounded fractions for native usage bars. Missing spending/limits remain unknown; zero limits are not divided by. Explicit provider `usedPercentage` values above 100 remain visible and report exhausted, while normalized fractions cap at 1. Invalid remaining percentages and bare counters without interpretable units remain unknown.

Provider quotas are raw cached upstream snapshots, not cutoff-adjusted usable allowance. Missing, empty, or refused data is not zero; gateway tracking is not a settled provider bill.

Usage labels remove terminal controls, redact normalized credential echoes, then truncate. Account and quota identifiers are opaque hashes of namespaced raw identities rather than display labels, so truncation, control removal and provider-name collisions do not merge unrelated limits. Named identities survive response reordering; snapshots without a connection ID use position-dependent anonymous identifiers. Native usage cache version 3 invalidates the former identity representation without changing personal limit IDs, user configuration or catalog caches.

For a configured API path `/prefix/v1`, inference/catalog routes stay under `/prefix/v1/*`, but usage resolves to `/prefix/api/usage/om-usage?format=json`. Forward that sibling path separately. Preserve `Authorization` and SSE through the proxy; do not redirect API traffic to a dashboard login. No alternate usage-origin setting is needed or provided.

## Doctor and health

Doctor validates the configured endpoint and any local override file, GETs `/v1/models`, and optionally GETs `/v1/models/health`. Override-file errors do not suppress the network checks. It does not perform inference or visit management endpoints.

An absent `x-omniroute-version` produces an informational `ok` check with no `version` value. A present bounded semantic version is reported; malformed or empty values warn without echoing their contents. `X-Model-Catalog-Version`, such as `model-metadata-v1:static`, identifies the metadata schema, **not the deployed server release**.

Health states other than `ok` warn. Unknown states normalize to `unknown`; unsupported health endpoints and empty observations warn without invalidating successful catalog authentication. `health.coverage` reports unique raw-catalog IDs (`catalog`), the exact-ID intersection (`matched`), catalog IDs without observations (`unobserved`), and health IDs outside that catalog (`healthOnly`). These counts are independent of local model filters; row totals/state counts can include duplicates.

Partial or disjoint coverage is informational: unobserved IDs are not evidence of unhealthy models. `ok` describes only the returned observations and means no pause observed by that instance, not guaranteed upstream availability; connection-level pauses may be absent.

## Inspector, alerts, and request controls

`/omniroute-last` keeps only the latest inspected chat request's metadata in memory: requested model, available routing identifiers, request ID, status, elapsed time, tokens, and cost provenance. It retains no messages, prompts, tool arguments, arbitrary headers, API keys, or cookies.

`servedModel` comes from routing headers when available; `responseModel` may merely be an alias. `observedResponses` counts OMP response callbacks, not every internal attempt/failover. Some failure metadata is unavailable. `gatewayCostHeaderUsd` stays separate because it can be an estimate or an unpriced zero. `ompTotalUsd` can differ from a reported total when reported-cost accounting is off. Native image/embedding requests are not inspected.

Malformed JSON, terminal `[DONE]` events, and non-object payloads do not clear previously observed cost or routing identifiers. A valid reported zero replaces an earlier reported cost; a new response resets the observation for retries.

After the first successful baseline, catalog changes track additions/removals and changed limits, capabilities, transports, or pricing. Unchanged results and raw field ordering do not notify. Alerts contain counts; `/omniroute-changes` provides details. Both baseline and latest change are process-local, not an audit log. Disable notifications with `OMNIROUTE_CATALOG_ALERTS=false` or `/omniroute-controls alerts off`.

```text
/omniroute-controls sticky on
/omniroute-controls cache-bypass on
/omniroute-controls memory-bypass on
```

Sticky sessions send a hash of the OMP session ID in `X-Session-Id` and `X-OmniRoute-Session-Id`; subrequests use their own ID when supplied by OMP. No raw session path is sent. Affinity is a hint, not an availability guarantee.

Cache bypass sends `X-OmniRoute-No-Cache: true`; memory bypass sends `x-omniroute-no-memory: true`. They are separate from the model catalog cache, can increase cost/change injected context, and default off. They affect chat in this process, not server-global settings. Revert with `off`.

## Cache limitations and troubleshooting

OMP 18.18.1 caches extension catalogs by provider name without an extension configuration-specific key or cached-row transform. The extension forces online discovery at session start, but an outage can restore models from an earlier configuration. New filters, capability requirements, variable-price patterns, or transport settings may not apply until discovery succeeds. `omp models` can use a cached roster without opening a session. Raw metadata, last-request data, and change baselines are not persisted by the extension.

**After changing configuration, confirm a successful `/omniroute-refresh` before selecting a model.** Use separate OMP profiles for separate gateways when cache isolation matters, and gateway API-key permissions for access control.

| Symptom | Check |
| --- | --- |
| No provider/models | Process environment, root entry point, `/omniroute-doctor`, then `/omniroute-status`; do not assume `.env` was loaded |
| Authentication failure or redirect | Inference API key, unintended inherited environment overriding profile dotenv, proxy `Authorization` forwarding, non-dashboard API URL |
| Old filters/prices/transports | Successful online refresh; cached listing alone is insufficient |
| Catalog current but selected metadata unchanged | Selected-model status in `/omniroute-status`; resolve authentication or retry refresh while idle |
| Selected model missing | Choose an available model or check filters and gateway catalog; the extension never switches automatically |
| Overrides have no effect | Doctor's `overrides-file` and `overrides-match` checks; use exact raw IDs and inspect `overrides.unmatched` suggestions |
| Models skipped | `/omniroute-status` reason counts, then `/omniroute-model <ID>` for the retained rejection reason |
| Incorrect limits/capabilities | `/omniroute-model` fallback metadata, gateway metadata, then exact-ID overrides |
| Usage 403 | Operator-controlled `allowUsageCommand` permission; inference does not require it |
| Usage 404 behind a prefix | Separate forwarding for the sibling `/api/usage/om-usage` route |
| Version unavailable | Informational when absent; schema headers cannot identify a deployment release |
| Health warns | Inspect actual state or optional-endpoint support; a catalog success is not inference proof |
| Specialty model lists but does not run live | Verify the corresponding deployed endpoint and model permission; local transport fixtures do not prove deployment availability |
