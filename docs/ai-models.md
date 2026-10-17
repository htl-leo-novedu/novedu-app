# AI models & LLM providers

How the app talks to language models: three OpenAI-compatible providers behind one
isolated seam. Every activity YAML picks its model with `llm.model`, its
provider with `llm.provider` (`"SCCH"` when missing), and optionally a
**reasoning level** with `llm.reasoning` (below); no other code in the app
knows which provider serves a request. The YAML values are the **default**: a
code may carry a per-code `{provider, model, reasoning?}` **override**
(`novedu_codes.llm_provider`/`llm_model`/`llm_reasoning`; the pair is
both-or-nothing, `reasoning` an optional third member) that replaces the whole
`llm:` block for every request served under that code — WHOLESALE, so an
override without a level also drops the YAML's level. The precedence is
`effectiveLlm` (`lib/code-store.ts`), applied at every consumption site
(`docs/codes.md`), and the availability gate below runs on the EFFECTIVE
provider. Metering is
unaffected: the exporter reads the actually-resolved provider/model off the span
(the named-provider contract below), and the coding proxy meters its effective
pair explicitly.

Read before touching: `lib/llm/**`, `app/mastra/scch.ts`, `lib/scch-endpoint.ts`,
`buildCognitiveServicesCredential` in `lib/azure-credential.ts`, the `llm:` block
of any activity schema, and the optional-provider probes in `lib/health.ts`.

## The three providers

| | SCCH | Azure Foundry | OpenRouter |
|---|---|---|---|
| What | Self-hosted vLLM GPU server (free for us, Austria-only network) | Azure OpenAI resource (paid, e.g. `gpt-5.5`, `gpt-5.4-mini`) | Hosted multi-vendor router (paid, e.g. `openai/gpt-6-luna`) |
| Env | `SCCH_BASE_URL` (includes `/v1`) + `SCCH_API_KEY` | `AZURE_FOUNDRY_ENDPOINT` (bare resource endpoint; trailing slash tolerated); optional service principal `AZURE_FOUNDRY_TENANT_ID` + `AZURE_FOUNDRY_CLIENT_ID` + `AZURE_FOUNDRY_CLIENT_SECRET` or `AZURE_FOUNDRY_CLIENT_CERTIFICATE` | `OPENROUTER_API_KEY`; optional `OPENROUTER_BASE_URL` override (defaults to `https://openrouter.ai/api/v1`, already includes `/v1`) |
| API | OpenAI Chat Completions | OpenAI-compatible **v1** surface — `${endpoint}/openai/v1`, no `api-version`, the **deployment name is the `model`** | OpenAI Chat Completions |
| Auth | Static `Bearer ${SCCH_API_KEY}` | **Entra** bearer — managed identity / `az login`, or a Foundry service principal; no API key exists (see below) | Static `Bearer ${OPENROUTER_API_KEY}` |
| `llm.model` | Raw model id (e.g. `RedHatAI/gemma-4-31B-it-FP8-Dynamic`) | Deployment name (e.g. `gpt-5.4-mini`) | Namespaced `<vendor>/<model>` routing key (e.g. `openai/gpt-6-luna`) |

`model` is free text for all three; a wrong name fails at runtime. There is no live
model discovery for Foundry or OpenRouter (SCCH's dropdown discovery in
`app/mastra/scch.ts` is unchanged and SCCH-only). Foundry and OpenRouter are both
**optional**: without `AZURE_FOUNDRY_ENDPOINT` / `OPENROUTER_API_KEY` the app boots
and runs without that provider — everything provider-specific is built lazily on
first use, and `foundryConfigured()` / `openrouterConfigured()` gate the
provider-specific UI (the `/health` rows). The optionality is **enforced**: on a
server that lacks the provider the authoring gate (`lib/file-validators.ts`)
rejects such a file with a `PROVIDER_UNAVAILABLE` error, and the runtime guards
(quiz/writing `buildRequestContext` → 502, the tutor loader → a thrown reason)
catch a file that arrives anyway (externally hosted YAML, an env change) — all
through `providerUnavailableReason` (`lib/llm/availability.ts`), so no chat ever
dies on a raw "AZURE_FOUNDRY_ENDPOINT is not set" / "OPENROUTER_API_KEY is not
set". The CLI never runs this gate — its bundled `loadAndCheck*` core stays
environment-free.

**OpenRouter on the stages** (`dev.novedu.at`, `app.novedu.at`) is an allowlist,
not the whole catalogue: each stage's key belongs to an OpenRouter workspace whose
guardrail accepts only `openai/gpt-6-luna` and `openai/gpt-6.1-sol`, served BYOK-only by an Azure OpenAI resource
(`docs/azure-runtime-env.md`). The app knows nothing of that list — authoring and
the save-time gate accept any OpenRouter id, and a model outside it fails at
runtime with OpenRouter's `404` ("… matching your guardrail restrictions"), like a
wrong model name.

## The `lib/llm/` seam — where the distinction lives

The provider branch exists in exactly **three functions** —
`resolveLanguageModel`, `resolveChatEndpoint` (including its `adaptBody` dialect
hook), and `providerUnavailableReason`; every call site asks one of them and never
learns which provider answered.

- `lib/llm/provider.ts` — pure, client-safe: the `LlmProvider` type, the three
  literals, `DEFAULT_PROVIDER`, the zod `providerSchema` (default `"SCCH"`) all
  four activity schemas embed, `parseLenientProvider` for the lenient runtime
  parsers, the reasoning-level counterparts (`REASONING_LEVELS`,
  `reasoningLevelSchema`, `parseLenientReasoningLevel` — below), and the ai-sdk
  **provider names** (`"scch"` / `"azure-foundry"` / `"openrouter"`) with
  `providerFromModelProviderId` — the metering contract (below).
- `lib/llm/model.ts` — **the agent path**: `resolveLanguageModel(provider, model)`
  returns an ai-sdk chat model — `scchProvider.chatModel(model)` and the
  lazily-built OpenRouter `createOpenAICompatible(...).chatModel(model)` (the
  `@ai-sdk/openai-compatible` spelling), or the lazily-built Foundry
  `createOpenAI(...).chat(model)` (the `@ai-sdk/openai` spelling); all pin Chat
  Completions. The two packages are deliberate — see "Two ai-sdk packages" below.
  Same file, same reason: `reasoningOptionsKey(provider)` — the `providerOptions`
  key that package reads per-request options under (a pure lookup, no
  connectivity). Imports `app/mastra/scch.ts`, so only agent modules may import
  it — never the coding route.
- `lib/llm/endpoint.ts` — **the raw path** (the coding proxy):
  `resolveChatEndpoint(provider)` → `{ url, authHeader(): Promise<string>, adaptBody(body) }`.
  Deliberately side-effect-free: it imports only the three `*-endpoint` modules, not
  `app/mastra/scch.ts` (whose top-level model discovery must not run on the lean
  public coding route). `adaptBody` is the **parameter dialect** hook the proxy
  applies after `buildUpstreamChatBody`: Azure's gpt-5.x reasoning deployments
  reject `max_tokens` (it becomes `max_completion_tokens`) and non-default
  `temperature`/`top_p` (dropped), while SCCH's vLLM and OpenRouter both speak the
  classic dialect (identity — OpenRouter normalizes it for every model it fronts).
  The hook is pure and never touches `stream`/`stream_options`
  (the usage tap's `include_usage`), `model`/`messages`, or `reasoning_effort`
  (which every dialect accepts — asserted in `lib/llm/endpoint.unit.test.ts`).
- `lib/llm/availability.ts` — **the availability check** (app-only, never bundled
  by the CLI): `providerUnavailableReason(provider)` → `null` or a teacher-readable
  reason (Foundry named without `AZURE_FOUNDRY_ENDPOINT`, OpenRouter without
  `OPENROUTER_API_KEY`). Consumed by the authoring gate and the runtime guards
  (above).
- `lib/llm/foundry-endpoint.ts` — side-effect-free Foundry access (mirrors
  `lib/scch-endpoint.ts`): URL builders over `AZURE_FOUNDRY_ENDPOINT` (throwing
  only when *called* with it unset) and `foundryBearerToken()`.
- `lib/llm/openrouter-endpoint.ts` — the OpenRouter counterpart, deliberately
  IMPORT-FREE like `lib/scch-endpoint.ts`: `openrouterConfigured()` (the key alone
  decides), `openrouterBase()` (never throws — the public host is the default),
  the `/chat/completions` + `/models` URL builders, and `openrouterAuthHeader()`
  (the one function that throws on a missing key).
- `lib/llm/upstream-error.ts` — **the failure classifier**, provider-AGNOSTIC (it
  interpolates the provider name, never branches on it):
  `classifyUpstreamLlmError(error, { provider, model })` →
  `{ terminal, message, telemetry }`. See "Reporting an upstream failure" below.

Adding a provider = one branch in each of the three functions above + a name
constant/mapping in `provider.ts` + the schema enum literal (+ docs) + its
provider-options key in `reasoningOptionsKey` (`lib/llm/model.ts`, below).
Nothing else changes.

## Two ai-sdk packages — and why

The agent path builds its three providers from **two** packages — three instances,
two packages — and the split is load-bearing:

| | SCCH | OpenRouter | Azure Foundry |
|---|---|---|---|
| Package | `@ai-sdk/openai-compatible` (`createOpenAICompatible`, `app/mastra/scch.ts`) | `@ai-sdk/openai-compatible` (`createOpenAICompatible`, `lib/llm/model.ts`) | `@ai-sdk/openai` (`createOpenAI`, `lib/llm/model.ts`) |
| Chat model | `.chatModel(id)` | `.chatModel(id)` | `.chat(id)` |
| `providerOptions` key (`reasoningOptionsKey`) | the **instance name**, `"scch"` | the **instance name**, `"openrouter"` | the fixed `"openai"` |
| Reasoning text | `reasoning_content` → ai-sdk reasoning parts | `reasoning_content ?? reasoning` → ai-sdk reasoning parts | dropped (gpt-5.x emits none on Chat Completions anyway) |
| Structured output | opt-in `supportsStructuredOutputs: true` | opt-in `supportsStructuredOutputs: true` | always on |

The two `@ai-sdk/openai-compatible` instances carry the **same three flags** for
the same reasons (below) — `includeUsage: true`, `supportsStructuredOutputs: true`,
and `transformRequestBody: stripAssistantReasoning`. That last one is the
package's replay behaviour, not SCCH's, so `app/mastra/scch.ts` **exports**
`stripAssistantReasoning` and `lib/llm/model.ts` imports it: one implementation,
not a copy. SCCH's instance lives in `app/mastra/scch.ts` because it also drives
the model dropdown's discovery; OpenRouter's is built lazily in `lib/llm/model.ts`,
so an OpenRouter-less deployment never constructs it and the key is read at first
use rather than at import.

**Why SCCH is not on `@ai-sdk/openai`.** SCCH's vLLM models stream their thinking
as `delta.reasoning_content` **before** `delta.content` (one transition chunk
carries both), and put it in `message.reasoning_content` when not streaming. The
`@ai-sdk/openai` chat-completions parser silently **drops** that field, so the
thinking text never reached the browser. `@ai-sdk/openai-compatible` maps
`delta.reasoning_content ?? delta.reasoning` onto `reasoning-start` /
`reasoning-delta` / `reasoning-end` chunks (and the non-streaming field onto a
`{type: "reasoning"}` content part), which is what the rest of the pipeline —
Mastra's reasoning chunks, `@ag-ui/mastra`'s `REASONING_*` events, CopilotKit's
reasoning message — consumes (`docs/chat.md`). OpenRouter rides the same mapping:
the `?? delta.reasoning` half of it is what OpenRouter's own reasoning models
emit, so their thinking reaches the browser through the identical path (still
teacher-only — the stripping happens downstream, `docs/chat.md`).

**The version-line trap.** `@ai-sdk/openai-compatible` is **pinned exactly** in
`package.json` (`2.0.72`). The `2.x` line is the one built on `@ai-sdk/provider`
v3 — the ai-sdk v6 generation this app runs. npm's `latest` dist-tag on that
package is `3.x` (provider v4) and must NOT be installed here; a caret range
alone is not protection enough for a dependency whose major line tracks a
different SDK generation.

**`includeUsage: true` is mandatory.** `@ai-sdk/openai-compatible` sends
`stream_options.include_usage` only when the provider is built with
`includeUsage: true`. Without it a
streaming call reports no token usage, and the metering exporter reads that off
the Mastra span — so omitting it would silently zero out `usage_by_code`
(`docs/usage-metering.md`).

**`supportsStructuredOutputs: true` is mandatory.** The self-hosted vLLM honors
OpenAI-compatible `response_format: json_schema`, but `@ai-sdk/openai-compatible`
defaults the flag to `false` and then **drops the schema**: it warns
("JSON response format schema is only supported with structuredOutputs") and sends a
bare `{type: "json_object"}`. Everything that grades or judges via `structuredOutput`
— the quiz grader (`lib/quiz-actions.ts`, `lib/quiz-verdict-schema.ts`) and the
teacher-only `POST /api/eval/grade` / `POST /api/eval/judge` — would then get free-form
JSON back and fail to parse, so the schema-less fallback is a silent quality
regression, not a hard error. Reasoning is unaffected: `reasoning_content` still maps
to reasoning parts alongside a `json_schema` request, streaming and not. Both flags
are guarded in `app/mastra/scch.unit.test.ts`.

**Outgoing history carries no `reasoning_content`.** The same package that maps the
INCOMING `reasoning_content` also replays it OUTWARD: converting the history for the
next request, it re-attaches a previous turn's thinking to the assistant messages.
`stripAssistantReasoning` (`app/mastra/scch.ts`, shared by both
`@ai-sdk/openai-compatible` instances) strips that field back off with the
provider's `transformRequestBody` hook (applied on both the generate and the
stream path).
The Chat Completions dialect requires no such replay, and gemma mis-frames it: on the turn after a tool call it answers into
`reasoning_content` and leaves `content` empty, so the student sees a blank reply with
the real answer hidden in the collapsed thinking block. The strip is
**unconditional** — `model` is free text here, so a per-model branch has nothing
reliable to key on, and no house model needs its own scratchpad read back to it.
Received reasoning is untouched; only the request body changes. Guarded in
`app/mastra/scch.unit.test.ts` (construction options) and
`app/mastra/scch.wire.unit.test.ts` (the body the real package actually POSTs).
This strip is about the CURRENT turn's tool-call loop, where the reasoning is
still in memory; what Mastra SAVES carries no reasoning either, via a separate
output processor (`docs/chat.md`).

**Not the raw path.** This is the AGENT path only. The coding proxy
(`lib/coding-proxy.ts`, `lib/llm/endpoint.ts`) talks to the same endpoints with
no ai-sdk at all and is unaffected: it passes the upstream body through, so a
client asking for reasoning already gets `reasoning_content` verbatim.

## The reasoning level

Reasoning models (e.g. Foundry's gpt-5.6 deployments) accept an OpenAI
`reasoning_effort` parameter. The app models it as an optional `llm.reasoning`
field — one of `none`/`minimal`/`low`/`medium`/`high`/`xhigh` (`REASONING_LEVELS`,
`lib/llm/provider.ts`) — in every activity YAML and as the optional third member
of the per-code override (above). Absent means the parameter is **not sent**, so
the model's own default applies. The value is provider-AGNOSTIC: it is sent to
SCCH and OpenRouter too (all three providers speak the OpenAI dialect), and a
model that rejects a level fails at runtime exactly like a wrong model name. The tuple is the UNION of
the vocabularies our models speak, not a set every model accepts. Nothing narrows
it per model — `model` is free text with no discovery — so the upstream call is
the only validator, and the code form offers every level whatever the model.

Measured on one prompt against all four house models (SCCH at `temperature: 0`,
comparing the `reasoning_content` hash; Foundry by `reasoning_tokens`). Read the
SHAPE of each column, not the absolute numbers — those are prompt-specific:

| level | SCCH Qwen 3.8 27B | SCCH Gemma 4 31B | Foundry gpt-5.6-terra | Foundry gpt-5.4-mini |
|---|---|---|---|---|
| omitted | = `xhigh` (its default) | thinks, = every level below | thinks (107 rt) | no thinking (0 rt) |
| `none` | no thinking | **no thinking** | no thinking | no thinking |
| `minimal` | **400** | identical | **400** | no thinking (0 rt) |
| `low` | 1 255 chars | identical | 98 rt | 183 rt |
| `medium` | 1 845 chars | identical | 114 rt | 207 rt |
| `high` | **400** | identical | 118 rt | 259 rt |
| `xhigh` | 2 973 chars | identical | 120 rt | 365 rt |
| `max` | **400** | identical | not probed | not probed |

Three distinct behaviours, none of which the app can know in advance:

- **A real effort ladder** — Qwen 3.8 and both gpt-5.x deployments spend
  monotonically more thinking as the level rises (Qwen's `xhigh` is ~2.4× `low`).
- **A boolean** — Gemma 4 acts on `none` alone; every other level returned the
  BYTE-IDENTICAL trace, so picking `high` over `low` there buys nothing.
- **A hard 400** — Qwen rejects the OpenAI-only names (`"Supported types are
  xhigh (default), medium, and low"`) and `max`; gpt-5.6-terra rejects `minimal`
  while gpt-5.4-mini accepts it. So `minimal` is DEPLOYMENT-specific even inside
  one provider — the reason validation cannot move server-side.

`max` stays out of `REASONING_LEVELS`: Qwen 400s on it and no house model needs
it.

`none` is NOT the same as omitting the field. It SENDS `reasoning_effort:
"none"`, turning a thinking model off; an absent level sends no parameter at all
and leaves the model's own default in place. Only the first is a way to make a
thinking model answer straight away. (SCCH additionally serves some models as
separate reasoning-ON/OFF ids — e.g. `Qwen/Qwen3.8-27B-FP8 - Reasoning OFF`, a
second route to the same thing — that stays a `model` choice, not a `reasoning`
one.)

How the level reaches the wire, per path:

- **Agent path**: every agent's `model:` resolver returns `modelEntry(provider,
  model, reasoning)` (`app/mastra/model-entry.ts`); for the context-configured agents
  (writing, quiz grader + discussion, eval judge + tutor) that resolver is
  `contextModel` (`app/mastra/agent-context.ts`), reading the keys the caller set with
  `setLlmContext` (`lib/llm-context.ts`) — `modelEntry` returns the `ModelWithRetries[]`
  array form carrying `providerOptions: { <key>: { reasoningEffort } }`. The
  array form is REQUIRED: a bare-model return drops `providerOptions`, and
  Mastra's `modelSettings.reasoning` is a no-op on ai-sdk v3, so neither is an
  alternative. The `<key>` is PER PACKAGE, not per wire dialect (above): the two
  `@ai-sdk/openai-compatible` instances read their options under the ai-sdk
  **instance name** (`"scch"` / `"openrouter"`, the same constants behind the
  `scch.chat` / `openrouter.chat` metering ids), Foundry's `@ai-sdk/openai` under
  the fixed `"openai"` whatever the instance is called.
  `reasoningOptionsKey` (`lib/llm/model.ts`, beside `resolveLanguageModel`) holds
  that as a `Record<LlmProvider, string>` — exhaustive by type, so a new provider
  cannot be added without naming its key. A wrong key is silent: the option is
  simply never parsed and `reasoning_effort` never reaches the wire, so the keys
  are asserted in `lib/llm/model.unit.test.ts` and the placement — the level filed
  under whatever key the lookup names — in `app/mastra/model-entry.unit.test.ts`.
- **Raw path** (the coding proxy): `buildUpstreamChatBody` (`lib/coding-proxy.ts`)
  pins `reasoning_effort` exactly like it pins `model` — the effective level
  OVERWRITES a client-sent value; with no level configured the client's own
  `reasoning_effort` passes through untouched.

Metering is unaffected (output tokens already include reasoning tokens,
`docs/usage-metering.md`).

## Reporting an upstream failure

When a model call fails, two different audiences need two different things, and
`classifyUpstreamLlmError` (`lib/llm/upstream-error.ts`) is the one place that splits
them. It reads the ai-sdk `APICallError` — `statusCode`, `isRetryable`, and the
OpenAI-shaped `data.error.{code,type}` envelope all three providers speak — digging it out
of wrapper errors first (the ai-sdk's `RetryError`, Mastra's `cause` chain), so a
wrapped failure classifies exactly like a raw one.

- **`terminal`** — `true` when the request can never succeed as sent (a deployment name
  that does not exist, a rejected parameter), so the caller answers `4xx` and no client
  retries it. It reuses the ai-sdk's own retryability verdict, which keeps 408/409/**429**
  and 5xx retryable — a rate limit is a 4xx that must NOT become terminal. Neither is an
  upstream `401`/`403`: the provider refusing the *server's* credentials (a rotated key,
  a stale Managed-Identity role) is a server fault a token refresh may cure, so the
  caller gets a `502` that says so and retries stay live. A `403` gets wider wording —
  credentials or access rights, **or** a spending limit / usage rule on the server's
  account — because OpenRouter answers a guardrail, a used-up budget included, with
  it (a budget resets, so retrying is right there too).
- **`message`** — caller-safe: the provider and model the caller itself sent, the
  upstream status, and the upstream error *code*. The commonest case, Azure's
  `404 DeploymentNotFound`, gets its own wording because a teacher hits it routinely
  (a wrong `--llm-model`) and can fix it alone — but only a proving code
  (`DeploymentNotFound`, `model_not_found`) earns that claim. A bare `404` is worded to
  cover a model the server may not use (an OpenRouter guardrail allowlist answers with
  one) and a misconfigured server endpoint too, and a `content_filter` rejection points at
  the failing text rather than the llm settings.
- **`telemetry`** — the `recordError` attributes, and the ONLY channel for the endpoint
  URL (the Foundry resource host), which does not belong in a response body. The
  provider's free-form message reaches neither the response nor telemetry: it is the
  field most likely to echo request content, and `recordError` withholds the message
  of every error that is not a plain `Error` (`docs/telemetry.md`).

Consumed by the eval routes `POST /api/eval/grade`, `/api/eval/judge` and
`/api/eval/respond` (`docs/api.md`, `docs/cli-eval.md`). The **student**
paths deliberately do NOT use it: a student can neither fix a deployment nor be shown
infrastructure detail, so `lib/quiz-actions.ts` keeps its single generic sentence.

## Foundry auth — Entra bearer with transparent refresh

There is no Foundry API key anywhere. `foundryBearerToken()` holds ONE process-wide
`getBearerTokenProvider(buildCognitiveServicesCredential(), "https://cognitiveservices.azure.com/.default")`
(`@azure/identity`): it caches the token and refreshes it before its ~60-minute
expiry, so callers just await a fresh bearer per request and never hold a token.
(`https://ai.azure.com/.default` also works against `*.openai.azure.com`; the
Cognitive Services scope is the canonical one.) The acquisition itself is
**bounded** (`FOUNDRY_TOKEN_TIMEOUT_MS`, 15 s, via `lib/promise-timeout.ts`): a
stuck `az` subprocess, a black-holed IMDS or an unreachable Entra token endpoint
rejects instead of stalling a request indefinitely, for every caller at once —
the coding proxy, the agents' custom `fetch`, and the health probe — whichever
credential is in use.

`buildCognitiveServicesCredential()` (`lib/azure-credential.ts`) picks the
credential once, from configuration (`foundryCredentialKind()`; an empty
variable counts as unset):

| Configured | Credential | Reaches |
|---|---|---|
| none of the `AZURE_FOUNDRY_*` service-principal variables | `AzureCliCredential` (local `az login`) → `ManagedIdentityCredential` (on Azure) — the same explicit chain as the data-store credential, without a tenant pin | a Foundry resource in the tenant of that identity |
| `AZURE_FOUNDRY_TENANT_ID` + `AZURE_FOUNDRY_CLIENT_ID` + `AZURE_FOUNDRY_CLIENT_SECRET` | `ClientSecretCredential` | a Foundry resource in **any** tenant |
| `AZURE_FOUNDRY_TENANT_ID` + `AZURE_FOUNDRY_CLIENT_ID` + `AZURE_FOUNDRY_CLIENT_CERTIFICATE` | `ClientCertificateCredential` over the PEM **content** (certificate + unencrypted private key; PFX is not read) | a Foundry resource in **any** tenant |

Anything else — some of the service-principal variables, or a secret AND a
certificate — throws at first use with a message naming the variables (never
their values); it never falls back to the chain. The error reaches every caller
like a missing `AZURE_FOUNDRY_ENDPOINT` does: the coding route's config-error
path, the agent turn's failure, the `/health` row.

The service principal is an app registration in the Foundry resource's tenant.
Its settings carry Foundry-specific names on purpose: the generic
`AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` belong to user
sign-in (`auth.ts`), which is also why the chain is **never**
`DefaultAzureCredential` (its `EnvironmentCredential` would pick them up). Its
secret or certificate is the only Foundry credential material the app accepts:
locally it sits in `.env` (independent of the `AZURE_CONFIG_DIR` profile the
database needs, `docs/azure-runtime-env.md`); on a stage it comes from that
stage's Key Vault through a secret reference — for a certificate, a Key Vault
certificate with the PEM content type, whose secret value is the PEM. It never
appears in logs, telemetry or `/health`.

RBAC: whichever identity is used needs the **`Cognitive Services OpenAI User`**
role (`5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`) on the Foundry resource — the
deployed app's Managed Identity, each developer's own account for local dev, or
the service principal.

On the agent path, the bearer is injected per request by a custom `fetch` handed to
`createOpenAI` (streaming-safe); on the coding path, the route **starts**
`endpoint.authHeader()` right after the YAML load (so the token round trip overlaps
the client-body read), awaits it before the upstream fetch, and maps a failure
(missing env, no token) to its 500 config-error path.

## Server-only invariant

Endpoints, the SCCH and OpenRouter keys, the Foundry service principal's secret or
certificate, and Entra tokens live in server modules only and never
reach the browser — for every module, including the coding proxy (which keeps the
teacher prompt + pinned model server-side, docs/coding.md). `provider` is part of
the activity YAML like `model`: server-read, live, never client-trusted.

## Metering contract — provider names on spans

Every provider instance is **named** (`scch` / `azure-foundry` / `openrouter`), so
Mastra stamps `attributes.provider = "<name>.chat"` and `attributes.model` (= the
YAML's `llm.model`) on every MODEL_GENERATION span. Both packages build that id the
same way (`` `${name}.chat` ``), which is why moving SCCH from `createOpenAI` to
`createOpenAICompatible` left metering untouched — `lib/llm/model.unit.test.ts`
guards the `scch.chat` id. The usage exporter reads those
attributes and maps the name back to the app-level label via
`providerFromModelProviderId` — that is how `novedu_usage_by_code` learns its
`provider`/`model` columns (docs/usage-metering.md) with zero per-module wiring.
**Renaming a provider silently breaks that attribution** — the names are constants
in `lib/llm/provider.ts` for exactly this reason (and, for SCCH, the name doubles
as the `providerOptions` key above). The coding proxy (no Mastra)
passes `loaded.coding.provider`/`model` into `recordLlmUsage` directly.

## Health

Each optional provider's `/health` rows exist only when that provider is
configured — an SCCH-only deployment shows neither, so there is no permanently red
indicator for a provider nobody uses.

- **Foundry**, only when `AZURE_FOUNDRY_ENDPOINT` is set: `checkFoundry()`
  (`lib/health.ts`) is two-stage — it proves token acquisition (the RBAC role) and
  endpoint reachability (a model listing). Its detail names the credential kind
  (`managed identity / az login`, `service principal, secret` or `service
  principal, certificate`), never an id or a secret: a misconfigured service
  principal shows the variable names, and a token failure has the configured
  client id, tenant id and secret masked (Entra errors embed the ids). Testids
  `health-foundry` / `health-foundry-host`.
- **OpenRouter**, only when `OPENROUTER_API_KEY` is set: `checkOpenRouter()` is
  two-stage — OpenRouter's model listing is public (it answers 200 for any key or
  none), so the probe first proves the key with the key-info endpoint
  (`GET <base>/key`, an HTTP 401 for a bad key) and then lists the models for the
  count. The host row resolves `openrouter.ai`
  unless `OPENROUTER_BASE_URL` points elsewhere. Testids `health-openrouter` /
  `health-openrouter-host`.

## Testing

- **Hermetic** (`lib/llm/*.unit.test.ts`, CI): the provider schema/mapping, the
  Foundry and OpenRouter URL normalization, `resolveChatEndpoint` shapes with a
  mocked token, and `resolveLanguageModel` model ids/provider names plus the
  per-provider `reasoningOptionsKey` (building a provider does no I/O).
  `app/mastra/model-entry.unit.test.ts` covers the rest of the reasoning seam: the
  array form, the omitted-level case, and where the level is filed.
- **Live** (`@live-llm`, local only — CI has no Managed Identity, no SCCH network
  and, being secret-free, no OpenRouter key): `e2e/tutor-chat-reply.spec.ts` runs
  the same chat smoke once per provider (the Foundry and OpenRouter legs each
  author an app-hosted tutor and skip without their env var — the OpenRouter leg
  is what proves static-key auth and `vendor/model` id resolution on the agent
  path), `e2e/coding-agent.spec.ts` does the same for the raw proxy path via a
  code's LLM override, and `e2e/health.spec.ts` asserts the `health-foundry` and
  `health-openrouter` probes, each branch keyed on its own env so it asserts the
  rows' ABSENCE when the provider is unconfigured. See docs/testing.md.
