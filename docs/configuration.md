# Configuration and operation

[Installation](../README.md) · [Compatibility and evidence](compatibility.md) · [Development](development.md)

## Environment

Settings are read from the OMP process environment at extension load. Restart/reload after changing them. Neither `.env` nor [.env.example](../.env.example) is automatically sourced. `/omniroute-controls` changes only the listed process-local settings; an override file is reread on discovery attempts.

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
| `/omniroute-status` | Show last refresh, accepted/skipped counts, errors, and pricing caveats |
| `/omniroute-model <exact gateway model ID>` | Show original metadata, applied overrides, and mapping decisions |
| `/omniroute-usage` | Fetch key-scoped usage and provider quota snapshots |
| `/omniroute-doctor` | Read-only endpoint, authentication, catalog, version-header, and optional health checks |
| `/omniroute-last` | Show the last inspected chat request's routing/cost metadata |
| `/omniroute-changes` | Show the latest meaningful catalog change |
| `/omniroute-controls` | Show local settings; append a control and `on`/`off` to change it |

Controls are `sticky`, `cache-bypass`, `memory-bypass`, `inspect`, and `alerts`. Change them when the current turn is idle. Transport-affecting controls trigger discovery; changes apply to subsequent requests, not an active stream. Environment defaults return on reload.

Startup and periodic refreshes use OMP's scoped discovery API. Concurrent refreshes are coalesced, shutdown clears timers, and failures retain the last successful catalog. The extension contacts only the configured gateway, not an external metadata service.

## Catalog-to-OMP mapping

| Gateway field | OMP interpretation |
| --- | --- |
| `id` | Preserved unchanged; select as `omniroute/` plus the complete ID |
| `name` | Display name, falling back to ID |
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

The last successful raw rows and mapping metadata are kept in memory for `/omniroute-model`. OMP's public model schema cannot preserve arbitrary custom fields. This metadata is unavailable after restart until successful discovery.

## Pricing and reported costs

`pricing.input`, `output`, `cached`, and `cache_creation` use USD per million tokens, matching OMP directly. When absent, OpenRouter-shaped `prompt`, `completion`, `input_cache_read`, and `input_cache_write` use USD per token and are multiplied by 1,000,000. Explicit zero is preserved.

- **Estimated:** known input/output catalog rates, not a settled bill. Missing cache rates are recorded separately.
- **Unknown:** missing input/output pricing, labeled `[price unknown]`.
- **Variable:** routing aliases/combinations, labeled `[price variable]`; a first-target price is not a fixed bill.
- **Reported:** a finite, nonnegative SSE `usage.cost` value observed for that request, including zero.

`auto/*`, `combo/*`, `owned_by: "combo"`, and explicit variable-pricing metadata identify variable routes. OmniRoute's bare `auto` row is covered by its `owned_by: "combo"` metadata. Other aliases need explicit metadata or `OMNIROUTE_VARIABLE_PRICE`; names alone are not reliable.

Unknown and variable rates use zero-valued numeric schema placeholders. **Zero placeholders do not mean free.** Credit/per-request pricing cannot be represented faithfully in token-rate fields.

Enable `OMNIROUTE_REPORTED_COST=true` to replace final chat totals with reported USD costs. OMP 18.18.1 only applies native chat reported costs automatically for its built-in `openrouter` and `cline-pass` provider names. The extension instead delegates through its own `omniroute-chat` wrapper to OMP's real OpenAI adapter, without replacing global transports or impersonating a provider.

Inspection is enabled by default, so default chat models use the wrapper even with reported-cost accounting off. To retain the exact `openai-completions` API identifier, disable inspection and keep reported cost, sticky sessions, and both bypass controls false, then refresh successfully. The wrapper remains registered to support previously cached custom-API models.

OMP's outer custom-stream dispatcher owns the provider concurrency permit and `beforeDispatch` check. Inner delegation avoids acquiring them twice. Bounded socket cleanup can outlive a completed logical request by up to 2.5 seconds; the permit does not strictly count still-draining sockets.

Reported cost is authoritative only when supplied; otherwise the catalog estimate or unknown placeholder remains. No extra billing request is made. Accounting buckets are scaled proportionally to keep OMP aggregators additive; only the reported total is authoritative, not the inferred input/output allocation. Embedding/image costs are not intercepted. Use gateway/provider accounting for a complete bill.

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

Overrides apply before capability filtering. Explicit reasoning/vision overrides take priority over raw metadata. Native chat API overrides still use the wrapper if its features are enabled. `estimated` cannot turn missing input/output rates into known prices. Overrides are operator assertions, not proof the upstream supports the capability. Run `/omniroute-refresh` after editing; `/omniroute-model` separates the original row from overrides.

## Usage permission and reverse proxies

The native usage adapter and `/omniroute-usage` read `/api/usage/om-usage?format=json` on the same gateway. The key needs optional **allowUsageCommand**, off by default. HTTP 403 is reported clearly; the extension never grants permission or asks for management credentials.

Personal daily/weekly amounts use USD. Provider quotas are raw cached upstream snapshots, not cutoff-adjusted usable allowance. Missing, empty, or refused data is not zero; gateway tracking is not a settled provider bill.

For a configured API path `/prefix/v1`, inference/catalog routes stay under `/prefix/v1/*`, but usage resolves to `/prefix/api/usage/om-usage?format=json`. Forward that sibling path separately. Preserve `Authorization` and SSE through the proxy; do not redirect API traffic to a dashboard login. No alternate usage-origin setting is needed or provided.

## Doctor and health

Doctor validates the configured endpoint, GETs `/v1/models`, and optionally GETs `/v1/models/health`. It does not perform inference or visit management endpoints.

An absent `x-omniroute-version` produces an informational `ok` check with no `version` value. A present bounded semantic version is reported; malformed or empty values warn without echoing their contents. `X-Model-Catalog-Version`, such as `model-metadata-v1:static`, identifies the metadata schema, **not the deployed server release**.

Health states other than `ok` warn. Unknown states normalize to `unknown`; unsupported health endpoints warn without invalidating successful catalog authentication. `ok` means no pause observed by that instance, not guaranteed upstream availability; connection-level pauses may be absent.

## Inspector, alerts, and request controls

`/omniroute-last` keeps only the latest inspected chat request's metadata in memory: requested model, available routing identifiers, request ID, status, elapsed time, tokens, and cost provenance. It retains no messages, prompts, tool arguments, arbitrary headers, API keys, or cookies.

`servedModel` comes from routing headers when available; `responseModel` may merely be an alias. `observedResponses` counts OMP response callbacks, not every internal attempt/failover. Some failure metadata is unavailable. `gatewayCostHeaderUsd` stays separate because it can be an estimate or an unpriced zero. `ompTotalUsd` can differ from a reported total when reported-cost accounting is off. Native image/embedding requests are not inspected.

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
| Authentication failure or redirect | Inference API key, proxy `Authorization` forwarding, non-dashboard API URL |
| Old filters/prices/transports | Successful online refresh; cached listing alone is insufficient |
| Models skipped | Include/exclude globs, explicit lack of tools, unsupported type/input, malformed/duplicate IDs |
| Incorrect limits/capabilities | `/omniroute-model` fallback metadata, gateway metadata, then exact-ID overrides |
| Usage 403 | Operator-controlled `allowUsageCommand` permission; inference does not require it |
| Usage 404 behind a prefix | Separate forwarding for the sibling `/api/usage/om-usage` route |
| Version unavailable | Informational when absent; schema headers cannot identify a deployment release |
| Health warns | Inspect actual state or optional-endpoint support; a catalog success is not inference proof |
| Specialty model lists but does not run live | Verify the corresponding deployed endpoint and model permission; local transport fixtures do not prove deployment availability |
