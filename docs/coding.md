# Coding

Deep reference for the **coding** activity module: an **OpenAI-compatible Chat
Completions endpoint** that an external coding agent (e.g.
[little-coder](https://github.com/itayinbarr/little-coder)) points at, so a student
codes against a teacher-pinned model with a teacher-authored system prompt
layered on. It slots into the generic **codes** subsystem through the fixed seams
that subsystem exposes (`docs/codes.md`) — the generic flow (code store, create,
list, edit, bulk-delete, the availability window) is untouched. The always-on
invariants are summarized in `AGENTS.md`; this file has the full mechanics.

Read it before touching the coding libs (`lib/coding-*.ts`, `lib/coding-key-store.ts`,
`lib/llm/endpoint.ts`), the public routes (`app/api/coding/**`), the student surface
(`app/[code]/render-coding.tsx`, `app/[code]/_coding/**`), the descriptor
(`lib/code-modules/coding.ts`), the `api/coding` matcher in `proxy.ts`, or the
samples (the coding YAML under `activities/examples/`).

## What it is, and what it is NOT

- A teacher mints a `novedu_codes` row with `module: "coding"` pointing at a coding
  YAML, exactly like any other code (`/codes/new`), and shares the resulting `/<code>`
  URL exactly like a tutor/quiz/writing code. **The code string is NOT the API key.**
  A student visits `/<code>`, signs in, and leaves with a personal `nvk-…` key
  (`lib/coding-key-store.ts`) — stable across visits — which they configure their
  coding agent with alongside the base URL and a model ref.
- Unlike tutor/quiz/writing it has **no in-app chat**: there is no CopilotKit
  runtime agent and no Mastra memory. The `/<code>` web page is just a **connection
  page** showing how to point a tool at the endpoint.
- It is a **thin pass-through proxy**, not an agent. All three upstreams (SCCH,
  Azure Foundry and OpenRouter, selected by the YAML's `llm.provider` —
  docs/ai-models.md) are OpenAI-compatible; the route gatekeeps, injects the
  teacher's system prompt, pins the model, lets the provider's `adaptBody` hook
  adjust the **parameter dialect** (Azure Foundry renames `max_tokens` →
  `max_completion_tokens` and drops `temperature`/`top_p`, which its gpt-5.x
  reasoning deployments reject; SCCH and OpenRouter are the identity — OpenRouter
  normalizes the classic dialect itself. The hook lives in `lib/llm/endpoint.ts`,
  so the route stays
  provider-blind), and **pipes the response stream back unparsed**. Because the rest
  of the body is forwarded verbatim and the response is never re-serialized,
  **client-side tool calling and streaming work unchanged** (the coding agent runs
  its own file-edit / run-code tools and just exchanges `tool_calls` / `tool`
  messages through the relay).

## Access & anonymity (the security model)

- The endpoint is **public** (no Entra session — an external tool has none): two
  routes, `POST /api/coding/v1/chat/completions` and `GET /api/coding/v1/models`,
  under one auth scheme. Both are excluded from the `proxy.ts` gate alongside
  `/api/files` by the single anchored `api/coding(?:/|$)` entry (so the exclusion
  can't widen to a future `/api/coding-*` route), and both are authenticated
  by a **per-user API key** stored in `novedu_coding_keys`:
  `Authorization: Bearer nvk-<40 lowercase a-z0-9 chars>`.
- **Key format** (`lib/coding-key.ts`): `KEY_PATTERN` + `generateCodingKey` live in
  their own PURE module (no database, no app imports), so the store, the proxy's
  fast path and the e2e harness all build on the one definition.
- **Key issuance** (`getOrCreateCodingKey`, `lib/coding-key-store.ts`): a student's
  `/<code>` visit re-reads (or, on a first visit, mints) one **stable** key per
  `(code, userId)` — SELECT first, so the dominant revisit path is a single read;
  only a miss inserts, and a duplicate-key error there is resolved by re-reading
  (a concurrent first visit won the race) so the whole thing stays idempotent. The
  same key comes back every time, which is what lets the page simply re-display it.
  The store's OTHER read, **`getStoredCodingKey`**, never inserts: it answers
  `found` / `none` / `error` and is what the teacher detail page calls, so viewing
  a code cannot attribute a key row to the viewer (the teacher's own mint is the
  explicit button below). Both reads share one `(code, userId)` SELECT helper.
- **Key resolution** (`lookupCodingKey`): the route maps the bearer to its
  `(code, userId)` pair with one indexed SELECT (a malformed key — wrong prefix,
  length, or alphabet — is a miss before any database round trip), then
  re-runs **`checkCode(code)`** exactly as every other module: `401` unknown /
  `403` outside window / `503` lookup failure; a non-`coding` module → `401`. Both
  stored rows — the key row and the code row — are re-verified on **every**
  request and together are the security boundary, so a closing window or a
  deleted code kills all of that code's keys on the very next request.
- **An outage is retryable, never a bad key**: `lookupCodingKey` reports a database
  failure as its own `error` status (mirroring `checkCode`'s `lookup-failed`), so
  both lookups answer the identical `503` body. Only a real miss earns the `401`.
- **Opaque-401 uniformity**: every rejection flavor — no bearer, a malformed key,
  an unknown key, a key whose code was deleted, a key for a non-coding code, even
  a bare activity code sent as a bearer — gets the byte-identical `401` body. No
  oracle distinguishes them; a leaked code string alone opens nothing without an
  Entra sign-in.
- **Attribution**: `novedu_coding_keys` is one of **three sanctioned exceptions** to
  "`novedu_user_chats` is the only user↔chat link" (alongside `novedu_reports`,
  `docs/reports.md`, and `novedu_quiz_results`, `docs/home.md`) — key issuance always records the requesting user's id,
  disclosed by an explicit, visually prominent notice on **both** issuing surfaces:
  the student connection page (`render-coding.tsx`) and, beside the teacher's own
  "Get my API key" button, the detail page (`_coding/coding-detail.tsx`). Neither
  surface stores a user id without the notice: a teacher who only reads the detail
  page is never listed. Coding conversations themselves are still never stored —
  there is no in-app chat to attribute, and `novedu_user_chats` stays untouched.
  The `anonymous` flag stays frozen `true` and keeps its narrower meaning (no
  conversation to attribute); `readAnonymousFlag("coding")` still returns
  `{ anonymous: true, definitive: true }` and the validator still freezes
  `anonymous: true` onto the row.
- **Metering**: because the key resolves a real `userId`, the usage tap records
  `recordLlmUsage({ code, module: "coding", userId, provider, model, codingRequests: 1, … })`, which
  writes **both** independent hourly buckets — `usage_by_code` (no user) and
  `usage_by_user` (no code) — exactly like the Mastra-backed modules
  (`docs/usage-metering.md`). Never a `(user × code)` row.
- **Start page**: `listOwnKeyDates(userId)` in the key store reads the session
  user's OWN keys through the `user_id` index and returns only their Vienna-local
  issue dates — no code, no key value — for the Coding badges (`docs/home.md`).
  For the teacher dashboard, `keyHoldersOfTeacherStatement(teacherId)` is the
  subselect of `(user_id, code, issued at)` over the teacher's own coding codes
  that the teacher facts store counts into identified students; no user id leaves
  that statement.
- **Teacher visibility, read-only**: the teacher detail page lists who requested a
  key for the code and when, via `listCodingKeys`. There is **no revocation** —
  the availability window / code deletion is the only access control; a teacher
  cannot invalidate one student's key without closing the whole code.
- **Deletion**: the codes bulk delete drops a code's key rows inside its one
  transaction (`deleteCodingKeysForCodes`, called by `deleteCodesAndData`). An
  ACCEPTED race: a mint that started before that delete can commit after it,
  leaving an attributed key row for a code that no longer exists. It is harmless
  by construction — the proxy re-runs `checkCode` on every request, so the orphan
  authenticates nothing — and nothing collects it; there is no GC.
- The teacher's **system prompt and the real pinned model stay server-side** — the
  proxy injects the prompt and pins the model; neither is sent to the browser (nor
  is the provider). The connection page deliberately advertises only a generic
  model id (the proxy ignores whatever model the client sends).
- The pinned model + provider (+ optional reasoning level) are the **effective**
  spec: the code's LLM override
  (`novedu_codes.llm_provider`/`llm_model`/`llm_reasoning`, `docs/codes.md`) when
  set, the YAML's `llm:` values otherwise — `effectiveLlm` drives
  `resolveChatEndpoint`, the model pin, the `reasoning_effort` pin, and the usage
  tap alike. The teacher detail's "Model (pinned)" shows the effective model.

## The coding YAML

Authored in `/files` (kind **Coding**), convention-aligned with the other modules:

```yaml
id: beginner-typescript
name: "Beginner TypeScript Coding Buddy"
title: "TypeScript Coding Buddy (Beginners)"   # optional — shown on the connection page
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic   # the single pinned model
  # provider: Azure Foundry                    # or OpenRouter; missing ⇒ SCCH
instructions: |
  <the teacher's system prompt — appended after the coding tool's own system prompt
   so it has the final word>
```

- **`parseCoding`** (`lib/coding-yaml.ts`) is the lenient runtime read: it requires
  only `llm.model` + `instructions` and returns `{ title?, model, provider, instructions }`
  (`provider` defaults to SCCH when missing; a present-but-invalid value is
  rejected — the `parseActivityYaml` prefix shared with quiz and writing,
  `lib/activity-load.ts`). `model`, `provider` and `instructions` are **server-only**.
- **Fragments**: a coding YAML may declare **`fragment_files:`** and/or **`text_files:`**
  (the shared prompt-fragment core — `docs/prompt-fragments.md`) and place fragments
  inline in `instructions` with `{{fragment "alias.id" …}}` markers, embedding plain-text
  files (e.g. a sample solution) with `{{file "alias"}}` (spliced verbatim, never
  compiled). `loadCoding` (`lib/coding-fetch.ts`) hands the parsed YAML to the pure
  `resolveCoding` (`lib/coding-resolve.ts`), which renders the block through the
  `resolveInstructions` step it shares with writing (`lib/activity-load.ts`):
  `assembleFragmentPrompt(block, url, fetcher, { validateLibraries: false, allowedSchemes }, instructions)`,
  storing the rendered host text back as `instructions`; a
  YAML with **neither** `fragment_files` nor `text_files` returns `instructions`
  byte-verbatim (never compiled), and a fetch / consistency / assembly failure fails the
  load closed. TWO coding-specific constraints hold. **(1)** Assembly happens
  in this load/parse layer, **never** in `lib/llm/endpoint.ts` — `resolveChatEndpoint`
  stays provider-blind and side-effect-free (no Handlebars / `Fetcher` /
  `app/mastra/scch.ts` import). **(2)** The proxy loads YAML **per completion request**,
  so fragment fetches land on the streaming hot path — hence `validateLibraries: false`
  and no extra passes; the proxy still consumes one finished `instructions` string, so
  the route is unchanged.
- **Authoring validation** is the strict `CodingYamlSchema` gate
  (`lib/coding-schema.ts` is the source of truth) run by `loadAndCheckCoding`
  (`lib/coding-validate.ts`): bad YAML, a missing/misspelled field, no `llm.model`, or
  no `instructions` returns `ok: false` with a `CODING_SCHEMA_ERROR` and **blocks the
  save**, exactly like tutor/quiz/writing. The schema is `strictObject`, so it also
  rejects fields coding does not have — including `anonymous` (coding is always
  anonymous), `description`, and `placeholder`. The seam (`lib/file-validators.ts`)
  freezes `anonymous: true` onto the row regardless. `activities/coding/coding-yaml.schema.json`
  is **generated from the zod schema** (`lib/coding-schema.ts`) via `npm run generate:schemas`
  for editor IntelliSense (a modeline points each coding YAML at its raw GitHub URL);
  do not hand-edit it — a drift-guard test fails CI if it is stale.
- `activities/examples/sorting-algorithms/sorting-visualizer.yaml` is the shipped
  sample: a sorting-visualizer project buddy constrained to a beginner's knowledge
  (plain loops + `function` declarations, explicit types, no classes/arrow
  functions/`map`/`filter`/`reduce`) that scaffolds p5.js freely but leaves the
  sorting algorithm for the student to write. It is demo content — no test reads it
  (docs/testing.md); the validation tests exercise the synthetic fixtures under
  `test-fixtures/activities/coding/`.

## The proxy route

`app/api/coding/v1/chat/completions/route.ts` (`POST`, `dynamic = "force-dynamic"`):

1. `parseBearerKey` reads the personal API key from `Authorization` (the verbatim
   token — nothing stripped). An oversized body (`Content-Length` over
   `MAX_BODY_BYTES`, 2 MiB) is rejected with `413` before any DB work.
2. `lookupCodingKey(apiKey)` (`lib/coding-key-store.ts`) resolves the key to its
   `(code, userId)` pair — an unknown or malformed key gets the opaque `401`, a
   database failure the same `503` as below. `checkCode(code)` then re-verifies the
   code itself: `401` unknown / `403` outside window / `503` lookup failure; a
   non-`coding` module → `401`.
3. `loadCoding(entry.fileUrl)` (`lib/coding-fetch.ts`, via the shared
   `appHostedFetcher`) → `502` on failure.
4. `resolveChatEndpoint(loaded.coding.provider)` resolves the upstream and **starts**
   the `authHeader()` acquisition (a static key for SCCH and OpenRouter, or a bounded
   Entra token for Foundry
   — docs/ai-models.md) so the token round trip overlaps the body read; a missing env
   var or a failed acquisition is a distinct `500` (a real misconfiguration) rather
   than a misleading `502`. `lib/llm/endpoint.ts` is side-effect-free — it does
   **not** import `app/mastra/scch.ts` (whose top-level model fetch must not run on
   this lean public path) nor Handlebars / the fragment core: prompt-fragment
   assembly happens in `loadCoding` (step 3), so `resolveChatEndpoint` stays
   provider-blind.
5. `buildUpstreamChatBody` (`lib/coding-proxy.ts`) **appends** the teacher's
   `instructions` to the **end** of the client's own system message (so the teacher
   has the final word; if the client sent no system message, a leading one carrying
   only the teacher's prompt is added) and **pins** `model` — plus
   `reasoning_effort` when the effective spec carries a reasoning level
   (docs/ai-models.md), overwriting a client-sent value; without one the client's
   own `reasoning_effort` passes through untouched. Everything else
   (`messages`, `tools`, `tool_choice`, `stream`, …) passes through verbatim. The
   endpoint's `adaptBody` hook then adjusts the provider's parameter dialect (see
   above) — it never touches `stream`/`stream_options`, which carry the usage tap's
   `include_usage`.
6. `fetch` to the resolved URL with the awaited auth header, passing
   `signal: req.signal` so a client disconnect cancels the upstream generation.
7. `return new Response(upstream.body, …)` — copies the upstream `content-type` so
   streamed `text/event-stream` and non-streamed JSON both pass through; the SSE body
   is piped back **unparsed**. Upstream error statuses/bodies pass through as-is.

Errors use the OpenAI envelope `{ error: { message, type, code, param } }`
(`openaiError`), built by the shared `errorResponse` / `invalidApiKey` /
`serviceUnavailable` helpers in **`lib/coding-http.ts`** — the one home of the
opaque 401 body, so both public coding routes reject byte-identically. They live
outside `lib/coding-proxy.ts` because that module sits in the CLI-bundled
prompt-dump closure (`docs/cli-prompts.md`), which has no use for `Response`s.

## The models route

`app/api/coding/v1/models/route.ts` (`GET`, `dynamic = "force-dynamic"`): the
OpenAI-conventional models list, and the **sanctioned key-validity check** — the
cheapest authenticated call on the endpoint, so an external tool holding a stored
`nvk-…` key (e.g. a playground that remembers one) can prove the key still opens the
activity without generating a completion.

- Auth is **identical** to the completions route, step for step: `parseBearerKey`
  → `lookupCodingKey` → `checkCode` → the `coding` module check, with the same
  signals for the same states (opaque `401` / `403 key_inactive` / `503`). The
  cheap call must never become an oracle the expensive one is not — a route test
  compares both rejections byte-for-byte.
- On success it answers only the **generic advertised id** (`CODING_MODEL_ID`,
  `lib/coding-connection.ts` — the same constant the connection page shows), with
  a fixed `created: 0` and `Cache-Control: no-store`:
  `{ "object": "list", "data": [{ "id": "coding", "object": "model", "created": 0, "owned_by": "novedu" }] }`.
- It touches **nothing else**: no YAML load, no `resolveChatEndpoint`, no token
  acquisition, no upstream fetch, and no usage metering (nothing was generated).
  The teacher's real model, the provider and the system prompt therefore cannot
  leak through it. A future model allowlist would extend this list — the shape is
  already the one such a list needs.

## Surfaces

The little-coder connection block (`_coding/coding-connection.tsx`: base URL
(`<origin>/api/coding/v1`), the key, the model ref, a ready-to-paste `models.json`
snippet, a run command — each with a copy button — plus a link to little-coder's
*configuring models* docs) is **shared by both** rendering surfaces below,
parameterized by whose personal key it is fed. It receives only non-secret
values; the system prompt + real model never reach it.

- **Student `/<code>`** (`render-coding.tsx`, Entra-gated web view): calls
  `getOrCreateCodingKey(code, userId)` and feeds the resulting personal key into
  the connection block under the activity title, above an explicit **attribution
  notice** ("Requesting this activity's API key is recorded with your name for
  your teacher. Your coding conversations are not stored."). In view-as-student
  mode the key is minted under the teacher's **real** user id — testing never
  fabricates a student row.
- **Teacher `/codes/[code]`** (`_coding/coding-detail.tsx`, the module's
  `renderDetail`): the resolved config (pinned model + the server-only system
  prompt, teacher-only), the teacher's **own** connection block, and the read-only
  **issued-keys list**, an embedded `ListTable` rather than a full-page `DataList`.
  There are no conversations to review.
  - The key is **read, never minted, on view** (`getStoredCodingKey`): `found`
    renders the same connection block a student gets; `none` renders a short
    explanation, the shared `ATTRIBUTION_NOTICE` ("requesting a key records your
    name in this activity's issued-keys list; coding conversations are not
    stored") and a **"Get my API key"** button; `error` renders the shared
    `KeyUnavailableNotice`, so the button is never offered on an unproven "you
    have no key". The button is the only client component here
    (`_coding/mint-key-button.tsx`), calling the `mintCodingKeyAction` server
    action (`lib/coding-key-actions.ts`): `requireTeacherUserId()` gates it and
    supplies the attributed user id, `getCode` must find a real row whose module is
    `coding` (an unknown / deleted / non-coding code is refused WITHOUT touching
    the key table — deliberately not `checkCode`, since the window gates USE of a
    key, which the proxy re-verifies anyway, not whether a teacher may prepare one
    for a code that has not opened yet), then `getOrCreateCodingKey` +
    `revalidatePath`. The action returns **no key value**: the revalidated render
    is the secret's one delivery path.
  - The issued-keys list (`listCodingKeys`) uses the shared `studentColumn` under
    the header **"User"** (writing's savers list keeps "Student" — here a teacher
    who minted their own key legitimately appears): display name LEFT-JOINed from
    `novedu_user`, raw user-id fallback and hover title. "Requested" renders through
    the shared `LocalTime` leaf — the viewer's own timezone, exactly like every
    sibling teacher list (reports, writing savers, files, codes).
- **Create/edit `/codes/edit/[code]`**: no per-module override exists — the page
  renders the registry default `ShareLinkResult` directly, the identical `/<code>`
  share link (copy button, window note) every other module gets. Course-material
  tooling (QR codes, Quarto extensions) treats a coding activity URL exactly like
  a tutor/quiz URL.

## Pointing little-coder at it

`little-coder` (built on `pi`) is config-driven. Add a provider to
`~/.config/little-coder/models.json`:

```json
{
  "providers": {
    "novedu": {
      "api": "openai-completions",
      "baseUrl": "https://<host>/api/coding/v1",
      "apiKey": "<your personal nvk-… key from the /<code> connection page>",
      "models": [{ "id": "coding", "name": "Novedu coding", "reasoning": false,
        "input": ["text"], "contextWindow": 32768, "maxTokens": 4096,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }]
    }
  }
}
```

Then run, e.g. `little-coder --model novedu/coding -p "Write a Python program that …"`
(`-nt` disables tools for a pure chat-completion smoke test). The `models.json`
`model` id is arbitrary — the proxy pins the teacher's model server-side.

## Testing

- **`lib/coding-key.unit.test.ts`**: the key format alone — alphabet/length/prefix
  and what `KEY_PATTERN` admits.
- **`lib/coding-key-store.unit.test.ts`** (hermetic, fake-DB fluent mock): the
  malformed-key fast path (no DB call), the miss/error split of `lookupCodingKey`,
  the revisit read (one SELECT, no INSERT), the first-visit mint, a duplicate-key
  INSERT resolving to the race winner's row, a duplicate with no matching row →
  re-mint retry, the found/none/error split of `getStoredCodingKey` (and that it
  never inserts), the `listCodingKeys` join shape/ordering, and the bulk delete.
  Real concurrent get-or-create is a `@live-db` concern, out of scope here.
- Hermetic unit tests: `parseCoding` (incl. the shipped sample) `lib/coding-yaml.unit.test.ts`;
  the strict authoring validator (schema errors, the always-anonymous mapping)
  `lib/coding-validate.unit.test.ts`; the pure proxy helpers (`buildUpstreamChatBody`,
  `parseBearerKey`, `openaiError`) `lib/coding-proxy.unit.test.ts`; the descriptor + the
  validator seam + the `readAnonymousFlag` branch (`lib/code-modules/coding.unit.test.ts`,
  `lib/file-validators.unit.test.ts`). The `@novedu/cli validate --kind coding` path is
  covered in `cli/src/commands/validate.unit.test.ts`.
- **`app/[code]/render-coding.unit.test.tsx`**: the student page mints/re-displays the
  personal key and renders the attribution notice; a `null` key (store failure)
  falls back to the "temporarily unavailable" notice.
- **`app/[code]/_coding/coding-detail.unit.test.tsx`**: the teacher's own
  connection block across all three read states — key present, the button + its
  attribution notice, the unavailable notice — asserting the render NEVER calls
  `getOrCreateCodingKey`; plus the issued-keys list (the "User" header, join shape,
  user-id fallback, the `LocalTime` leaf).
- **`lib/coding-key-actions.unit.test.ts`**: the mint action's shell — the teacher
  gate (both failure reasons), an unknown / non-coding code refused without an
  insert, the happy path's mint + `revalidatePath`, and that no key value is
  returned.
- HTTP-level **integration test** of the endpoint
  (`app/api/coding/v1/chat/completions/route.unit.test.ts`, node env): drives the
  real `POST` with `Request`s, a mocked key lookup, and a mocked SCCH `fetch` —
  key/window gating (including the explicit **valid code sent as a bearer → the
  same opaque 401** case), non-coding rejection, the forwarded body transform,
  OpenAI error shapes, metering asserted **with** `userId`, and both non-streamed
  JSON and streamed SSE passthrough.
- **`app/api/coding/v1/models/route.unit.test.ts`** (node env): the models route's
  own gate, plus the two properties that define it — its rejections are compared
  **against the completions route's own responses** (the same mocks, byte-for-byte
  on the opaque 401 and the `key_inactive` 403), and a success calls no `fetch`, no
  `loadCoding` and no `recordLlmUsage`.
- **`e2e/api-gate.spec.ts`** is the hermetic HTTP half, and the only coverage of
  these routes that runs in CI: a bare request to BOTH public routes gets the
  OpenAI-shaped 401 from the route itself rather than a redirect to the Microsoft
  sign-in page (i.e. the `api/coding(?:/|$)` exclusion in `proxy.ts` is intact),
  the two rejections are byte-identical so the cheap `models` check is no oracle,
  and a non-Bearer scheme is refused like no key at all. All of it lands before
  `lookupCodingKey` touches SQL, which is what keeps it hermetic.
- The real end-to-end path is **`e2e/coding-agent.spec.ts`**: drives the REAL `pi`
  coding agent (`@earendil-works/pi-coding-agent`, a pinned devDependency —
  little-coder's engine) through the endpoint once per provider. The SCCH leg is
  `@live-db` and runs in CI against the fake LLM (`docs/testing.md`); the Foundry
  and OpenRouter legs are `@live-llm`, local only, and each self-skips without its
  env var.
  The harness (`e2e/code.utils.ts`'s `mintCodingKey`) mints a code and a
  matching per-user key row directly, its value from the app's own pure
  `generateCodingKey`, and authenticates with it (the e2e setup's sweep removes the
  code and its key rows on a later run — `docs/testing.md`); the spec asserts model identity from the
  upstream's own `model` field (the Foundry and OpenRouter legs each minting the
  per-code LLM override, so a silent fallback to the YAML default fails the test).
  Chat smoke only
  (`--no-tools`); the agent driver is `e2e/pi-agent.utils.ts`.

## Future work (deferred)

- **Model allowlist**: let the teacher permit several SCCH models and honor the
  client's `model` when allowed, widening the models route's list beyond the single
  generic id.
- **Per-key rate limiting** (`429`) to shield the SCCH GPU from a leaked key.
- **Usage metrics** (request count / token usage) on the teacher detail page.
- **Per-user quota enforcement** (e.g. bounded AI access during an exam) is out of
  scope for now; the `novedu_coding_keys` row is the natural anchor for a future
  consumed-tokens counter. Per-student-per-code numbers can't be reconstructed from
  the existing usage tables (`usage_by_code` has no user, `usage_by_user` has no
  code), so a limits project needs its own write path.
- **Key revocation** — the teacher's issued-keys list is read-only today; access
  control is only the code's availability window or deletion.
- **Student CLI key retrieval** — a future bearer route (`requireBearerUser`)
  could run `checkCode()` + the same `getOrCreateCodingKey`, so a CLI command
  could fetch the connection data without the web page. `lib/coding-key-store.ts`
  being the single issuance seam guarantees web and CLI would mint the identical
  stable key.
