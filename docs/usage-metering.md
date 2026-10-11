# Usage metering

Per-hour usage accounting: token counts, tool calls, and discrete activity counts,
attributed **either** to a code **or** to a user — never both at once. Backs cost /
operational monitoring now and per-student token quotas later. `usage_by_code` has a
read surface — the teacher usage dashboard at `/usage` (`docs/dashboard.md`);
`usage_by_user` is read only for the user themselves, by their private start page
(`docs/home.md`) — anything else queries it directly (SQL / Log Analytics).

Read before touching: `lib/usage-store.ts`, `app/mastra/usage-exporter.ts`,
`lib/usage-context-keys.ts`, the `observability` block in `app/mastra/index.ts`, and
the capture points in `app/api/copilotkit/[[...slug]]/route.ts`, `lib/quiz-actions.ts`,
`lib/writing-actions.ts`, `lib/cloze-actions.ts`, and `app/api/coding/v1/chat/completions/route.ts` +
`lib/coding-proxy.ts`.

## The two tables (and why two)

`novedu_usage_by_code` (PK `code, hour`, plus a denormalized `module`) and
`novedu_usage_by_user` (PK `user_id, hour`) are stored **independently**. There is
deliberately **no `(hour × code × user)` fact table**.

The app is anonymous-by-default (tutor/quiz default `anonymous: true`;
`novedu_user_chats` is written only when a code opts out — see `docs/codes.md`).
Storing "user X used N tokens **on code Y**" would recreate exactly the user↔code
link the anonymity invariant forbids. Storing "user X used N tokens **this hour**"
(no code) meters the student for future quotas **without** revealing which activity
they did. So `usage_by_code` carries no user and `usage_by_user` carries no code (and
no module) — neither table ever links a student to an activity, even though the
runtime knows the student's user id for anonymous codes (it is only ever stored against an hour
bucket). Trade-off: "student X's usage on code Y" is unanswerable, by design.

Columns: `input_tokens_new` / `input_tokens_cached` / `output_tokens` are `bigint`
token sums (`output_tokens` already includes reasoning tokens); `tool_calls` /
`user_messages` / `quiz_answers` / `writing_saves` / `coding_requests` /
`cloze_submissions` are `int` counts — the last four reveal only the *kind* of
activity in an hour, never which activity. `hour` is the
UTC top-of-hour bucket. `usage_by_code` additionally carries two nullable
attribution columns — `provider` (the LLM provider label: `SCCH`,
`Azure Foundry` or `OpenRouter`) and `model` (the raw model id / deployment name) — which only the
LLM recorder knows (see the write seam); a NULL `model` means "metered before
models were recorded". They exist on `usage_by_code` ONLY: on `usage_by_user` even
a coarse provider signal would hint which activity a student did. No foreign keys
(same rule as the other `novedu_*` tables); never garbage-collected. Migrated by
Drizzle at startup like every `novedu_*` table.

## The write seam — `lib/usage-store.ts`

The **only** access to both tables. Mirrors `lib/user-chat-store.ts` discipline: it
**never throws** — a failed upsert is reported through `reportStoreFailure`
(`lib/store-failure.ts`: a fixed `usage: <op> failed` message plus the SQLSTATE,
logged and sent to `recordError` — never the raw error, whose Drizzle message
embeds the user id among the bound values), then dropped (a lost increment can
never break a chat, a grade, a save, or the coding proxy). All writes run **off
the response path** (the exporter is async; the route/action counters use
`after()`; the coding tap is fire-and-forget).

- `recordLlmUsage({ code, module, userId?, provider?, model?, inputNew, inputCached, output, toolCalls, codingRequests?, at? })`
  — increments `usage_by_code` always, and `usage_by_user` **only when `userId` is
  present** (every current caller passes one). `provider`/`model` feed
  `usage_by_code` alone; `codingRequests` (the coding proxy passes `1`) counts the
  request in the same increment as its tokens.
- `recordUserMessage` / `recordQuizAnswer` / `recordWritingSave` /
  `recordClozeSubmission` — `+1` on their counter in both tables; they carry no
  provider/model.

Each write is a **single `INSERT … ON CONFLICT … DO UPDATE`** statement: the
`INSERT` supplies the deltas as the bucket's initial values, and on a
conflicting `(code, hour)` / `(user_id, hour)` key the `DO UPDATE SET` adds
each counter onto the existing value in place (`col = table.col +
excluded.col`), so two concurrent writers on one bucket both land in one
round trip. `module` is required for the `usage_by_code` INSERT; it is
constant per code, so whichever recorder inserts first sets it.
`provider`/`model` are NOT increments and only the LLM recorder knows them —
and a user-message counter usually creates the `(code, hour)` bucket BEFORE
the generation finishes — so the INSERT sets them when known and the LLM
recorder's `ON CONFLICT` clause **COALESCE-fills a NULL**
(`provider = COALESCE(table.provider, excluded.provider)`, same for `model`;
first writer WITH the knowledge wins; a bucket straddling a republished YAML
keeps its first-seen value — negligible for a cost aggregate).

## Capture points

| Metric(s) | Where | How |
|---|---|---|
| tokens + tool calls — tutor, quiz discussion, writing, quiz grader, cloze grading + feedback | Mastra observability exporter | `MODEL_GENERATION` + tool-call spans, attributed via `requestContext` |
| tokens + coding requests — coding proxy | the coding route | taps the passthrough response for the `usage` chunk; both tables, `coding_requests` `+1` per metered response |
| tokens — CLI evals | `POST /api/eval/grade`, `POST /api/eval/respond` and `POST /api/eval/judge` | the same exporter path (they run `quizEvaluator` / `evalTutor` / `evalJudge`), all tagged with the `cli-eval` sentinel keys below — grading, tutor-generation and judging tokens land in the SAME buckets on purpose (`docs/cli-eval.md`) |
| user messages | CopilotKit route (`run`) | `after()` → `recordUserMessage` |
| quiz answers | `submitAnswer` (`lib/quiz-actions.ts`) | `after()` → `recordQuizAnswer` on a successful grade |
| writing saves | `saveWriting` (`lib/writing-actions.ts`) | `after()` → `recordWritingSave` after a successful save |
| cloze submissions | `gradeCloze` (`lib/cloze-actions.ts`) | `after()` → `recordClozeSubmission` after every successful grading, practice rounds included |
| quiz pre-checks | `precheckAnswer` (`lib/quiz-actions.ts`) | **not metered** (experimental; the `(code, hour)` buckets cannot separate classifier tokens from grader tokens without new columns — a content-free `quiz.precheck` event carries the experiment's use and latency instead, `docs/telemetry.md`) |

Agent attribution rides three RequestContext keys — `usageCode`, `usageUserId`,
`usageModule` (`lib/usage-context-keys.ts`) — set on the per-request RequestContext:
the CopilotKit route sets them on `built.context` before `getLocalAgent`; the quiz
grader sets them on the RequestContext it builds for `submitAnswer`, and the cloze
actions on the one they build for each `clozeEvaluator` call. `usageUserId` is
set for **all** codes including anonymous ones (it only ever reaches `usage_by_user`).

**CLI evals** (`novedu-cli eval`, `docs/cli-eval.md`) ride the identical
pipeline with a **sentinel attribution**: `usageCode = "cli-eval"`,
`usageModule = "eval"`, `usageUserId` = the teacher's user id. No pipeline change was
needed — each route just sets the three keys like every other agent seam. `cli-eval`
is deliberately **not** a `novedu_codes` row: minted codes are 10 random characters,
so a collision is impossible, and a teacher's eval spend lands in its own
`usage_by_code` row (and its own module group) instead of being mistaken for a
class's usage. `usage_by_user` still gets the teacher's own bucket, unlinked as
always.

## The observability exporter — `app/mastra/usage-exporter.ts`

A custom `ObservabilityExporter` (from `@mastra/observability`) registered on the
Mastra instance under one config named `usage`, with `default: { enabled: false }` (no
built-in storage/platform exporters) and `requestContextKeys` for the three keys, so
Mastra snapshots them onto every span. This is the **Mastra-native** path because
`@ag-ui/mastra` drops `usage` from the AG-UI event stream, so tapping the outgoing
SSE would miss tokens.

On `span_ended` the pure `mapSpanToUsage`:

- `MODEL_GENERATION`: reads `attributes.usage` — the `UsageStats` shape in
  `@mastra/core@1.47.0`: `inputCached = inputDetails.cacheRead ?? 0`,
  `inputNew = inputTokens − inputCached`, `output = outputTokens`. Uses
  `MODEL_GENERATION` **only** (never `MODEL_STEP`) to avoid double-counting. The
  same span's typed `attributes.model`/`attributes.provider` (stamped by Mastra
  from the resolved ai-sdk model — the **named-provider contract**, see
  `docs/ai-models.md`) yield the `provider`/`model` attribution:
  `providerFromModelProviderId` maps
  `"scch.chat"`/`"azure-foundry.chat"`/`"openrouter.chat"` back to
  the app-level labels; an unmapped id passes through raw so a naming regression
  stays visible. No extra RequestContext keys are involved.
- `TOOL_CALL` / `CLIENT_TOOL_CALL` / `MCP_TOOL_CALL`: `+1` tool call, no tokens,
  no provider/model (nothing to COALESCE-fill).

The auto-applied `SensitiveDataFilter` is left on (privacy-safe default); it uses
**exact** field-name matching and processes only `attributes`/`metadata`/`input`/
`output`, so the three attribution keys survive. The exporter reads **ids + counts
only**, never span `input`/`output` (prompt content) — the telemetry no-PII invariant.

## The coding proxy

The coding route (`app/api/coding/v1/chat/completions`) is a non-Mastra passthrough,
so it is metered separately: `buildUpstreamChatBody` sets
`stream_options.include_usage: true` when the client streams (non-streamed responses
already carry `usage`), and the route **tees** the upstream body — one branch to the
client byte-for-byte, the other read in the background to extract the final `usage`
(`extractCodingUsage`) and `recordLlmUsage({ code, module: "coding", userId,
provider, model, … })`. The `userId` comes from resolving the caller's personal
API key (`lookupCodingKey`, `lib/coding-key-store.ts` — `docs/coding.md`); provider
+ pinned model come straight from the loaded coding YAML (this path has no Mastra
span to read them from). With `userId` present, this writes **both** buckets —
`usage_by_code` (no user) and `usage_by_user` (no code) — exactly like the
Mastra-backed modules; the passthrough (streaming + client tools) is unchanged.
The same call passes `codingRequests: 1`, so each response whose `usage` was
found counts as one coding request in both buckets (a response without a `usage`
chunk is metered not at all). The start page reads that counter per user
(`docs/home.md`).

## Cached input tokens

`input_tokens_cached` counts prefix-cache hits — the model reusing a cached prompt
prefix (a large system prompt + prior turns) instead of re-encoding it, so a busy code
often has far more cached than new input. SCCH's vLLM reports these as
`usage.prompt_tokens_details.cached_tokens`; Mastra surfaces the value as
`usage.inputDetails.cacheRead`, and the exporter records it as `input_tokens_cached`,
with the remainder (`inputTokens − cacheRead`) as `input_tokens_new`. The coding proxy
reads the OpenAI field directly. All input tokens (cached + new) still bill; the split
is for cost visibility.

## Testing

- Unit (hermetic): `hourBucket` truncation and the increment column mapping against a
  mocked executor (`lib/usage-store.unit.test.ts`), the pure span→delta mapping over
  fake spans (`app/mastra/usage-exporter.unit.test.ts`), and the coding usage
  extractor + `include_usage` request shaping (`lib/coding-proxy.unit.test.ts`).
- The real UPSERT / concurrent double-increment is a `@live-db` concern (a real
  Postgres database), consistent with `docs/testing.md`.
