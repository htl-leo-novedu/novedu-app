# CLI / API bearer authentication & management API

Deep reference for the app's second auth channel: CLI commands (and any other
non-browser client, e.g. a future MCP server) calling app API routes with a
**session token as a bearer** instead of a session cookie. Read it before touching
`lib/api-auth.ts`, `app/api/me/**`, `app/api/codes/**`, `app/api/files/**`
(the bearer handlers), `app/api/images/**`, `app/api/reports/**`,
`app/api/eval/**` (grade, judge and respond), the public `app/api/version/route.ts` (listed here because the
CLI reads it), the services
they share with the web actions (`lib/code-service.ts`, `lib/file-service.ts`,
`lib/image-service.ts`), the CLI commands (`cli/src/auth.ts`, `cli/src/api.ts`,
`cli/src/commands/{login,logout,whoami,codes,files,images,reports,eval}.ts`,
`cli/src/conversation-export.ts`), `app/device/page.tsx`,
`lib/device-actions.ts`, or when adding a bearer-protected endpoint. Cookie sessions,
teacher roles and student mode live in `docs/auth.md`.

## The model

The CLI is not a separate credential system — it authenticates as a **better-auth
session**, obtained through the app's own OAuth **device authorization** flow
(the `deviceAuthorization` plugin on the `auth` instance, `auth.ts`) instead of the
browser's cookie-based sign-in. `login` asks the server for a device code, a human
approves it at `/device` in a browser that already has a session, and the CLI polls
until the server hands back the resulting **session token** — the very same token
value the browser carries in its cookie. Every later command sends that token as
`Authorization: Bearer <token>`; the server resolves it with `auth.api.getSession`,
so a signed-out or expired session stops working on this channel immediately, with
no separate token-refresh machinery to reason about.

These are the same **fixed 30-day sessions** the browser gets (`docs/auth.md`): a session
is never extended by use, so a machine that has been signed in for 30 days runs `login`
again. That also means resolving a bearer emits no session `Set-Cookie` for
`nextCookies()` to write into a bearer route's response.

- One human-assisted `novedu-cli login` stores the session token in
  `~/.novedu/sessions.json`; every later command sends it non-interactively. The
  primary CLI user is a coding agent (see `.agents/skills/novedu-tutor-cli`), so
  non-interactive operation after the single login is a design requirement.
- **Student mode does not exist on the bearer path** (it is a cookie): the
  session always reflects the caller's real role.
- `logout` revokes the session server-side (best effort — `auth.api.signOut`
  over the bearer, JSON-only) and always removes the local token, so it
  succeeds even when the server is unreachable or nothing was stored.
- Only the `Authorization` header is forwarded to `auth.api.getSession`
  (`lib/api-auth.ts`), so a browser cookie can never authenticate this channel.

## The device flow

`POST /api/auth/device/code` (JSON `{ client_id: "novedu-cli" }`, no cookie sent so
no Origin check applies) starts a sign-in attempt and returns:

```
{ device_code, user_code, verification_uri, verification_uri_complete, expires_in: 1800, interval: 5 }
```

`user_code` is an 8-character code (charset `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, no
dash — ambiguous characters excluded) that a person types or, via
`verification_uri_complete`, follows as a link straight to `/device?user_code=…`.
Codes are normalized on lookup (non-alphanumerics stripped, uppercased), so pasting
`abcd-efgh` still works.

Approving requires a **claim step first**: visiting `/device?user_code=…` while
signed in calls `auth.api.deviceVerify({ query: { user_code }, headers })`, which
binds the code to that signed-in user — `deviceApprove`/`deviceDeny` refuse a code
nobody has claimed yet, and a *different* signed-in user opening the same link sees
only `{ user_code, status }` (no `client_id`), so the `/device` page renders no
buttons for them. `app/device/page.tsx` calls `deviceVerify` server-side before
rendering, which is also why the plugin's per-IP rate limit on that GET (5 per 30
min, production only) never bites a legitimate approval.

`POST /api/auth/device/token` is **JSON-only** (415 on form-encoded bodies). The CLI
polls it with
`{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code, client_id: "novedu-cli" }`
every `interval` seconds. Every error response is HTTP 400 with either
`{ error, error_description }` (OAuth-shaped: `authorization_pending` while waiting,
`slow_down` when polling faster than `interval` — bump the interval, don't reset the
timer — `expired_token` and `access_denied`, both one-shot: the `novedu_device_code`
row is deleted, so a later poll answers `invalid_grant` instead) or `{ message, code:
"VALIDATION_ERROR" }` for a malformed request (wrong `grant_type`, missing fields) —
the CLI's error parser tolerates both shapes. On success:
`{ access_token, token_type: "Bearer", expires_in, scope }` — `access_token` **is**
the raw better-auth session token, there is no separate refresh token; the session's
`user_agent`/`ip_address` are taken from this poll request.

`client_id` is always the literal `novedu-cli`, validated server-side by
`validateClient` in the `deviceAuthorization` plugin config; `verification_uri` is
always `/device`.

## Server: `lib/api-auth.ts` — the one seam

Every bearer route gates itself through this module and nothing else (the
analogue of `checkCode()` for codes):

- **`requireBearerUser(request)`** reads the `Authorization` header, rejects
  anything that isn't `Bearer <token>` shaped, then forwards **only that
  header** — nothing else the request carried, a session cookie above all — to
  `auth.api.getSession({ headers: new Headers({ authorization: header }) })`.
  A `null` result (missing/expired/unknown token) throws. On success it returns
  `{ userId, name, isTeacher }`, where `userId` is `novedu_user.id` (the same
  stable user id every other surface keys on — `docs/auth.md`) and `isTeacher`
  is the server-owned `novedu_user.is_teacher` column, recomputed from the ID
  token's `groups` claim at sign-in time — never anything the caller supplies,
  and a groups **overage fails closed** (not a teacher).
- **`requireBearerTeacher(request)`** additionally requires the teacher role —
  the gate for teacher-only endpoints.
- Every rejection throws a typed **`ApiAuthError`** (`status` 401 or 403) with
  a deliberately generic message. Route handlers return the error status with a
  `WWW-Authenticate: Bearer` header and the generic
  `{ message: "Unauthorized" | "Forbidden" }` body — the same `{ message }` key
  as every other failure on this channel; validation detail never reaches the
  client.

## Routes & conventions

Shared conventions: every **bearer** handler is `force-dynamic`, answers
`Cache-Control: no-store`, and maps store-level DB failures (`undefined`
returns) to `503 { message }`. (`GET /api/version` below is listed for
completeness — it is public and shares none of this except `force-dynamic`.) EVERY failure body on this channel — including
the generic 401/403 (sent with `WWW-Authenticate: Bearer` on an
`ApiAuthError`) and the 500 fallback — is `{ message }` or
`{ errors: ValidationError[] }` (the identical structured detail the web forms
render); there is no third key for scripts to probe. All timestamps are ISO 8601 UTC or `null`; every
`url` field is built from the request-time `resolveAppOrigin()` (never the
stored `origin` column, which is operator-only).

The four list routes (`/api/codes`, `/api/files`, `/api/images`, `/api/reports`) are
deliberately **unpaged**: the CLI reads each result whole, so they call the store
without `paging` and return every match as a bare JSON array. The teacher list PAGES
do paginate in SQL (`docs/filtered-lists.md`) — that is a UI concern, not a wire one.
The ONE paged route is the conversation export (see **Pagination** below): its
result is a code's whole conversation history, which no single response may hold.

### Pagination

Only `GET /api/codes/<code>/conversations` pages, with an opaque **cursor**:

- `limit` — `1..50`, default `25`; anything else (non-integer, out of range) is
  `400 { message }`. The cap is server-enforced, so each request costs at most one
  page of threads, never the whole code; with the per-conversation message cap (see
  the route) that bounds every response.
- `after` — the previous response's `nextCursor`, passed back verbatim. It is
  base64url of the last thread's exact `createdAt` text and id; clients never build
  or parse it. A malformed cursor is `400`. A forged one can only move the walk
  within the same code — the code is a separate `WHERE` clause.
- `nextCursor` — present on every response; `null` means the walk is done. A page
  may hold fewer than `limit` items and still carry a cursor, so clients loop on
  `nextCursor`, never on the item count.
- Order is stable (thread `createdAt`, then id), so a walk never repeats or skips
  a thread that existed when it started.

**Cookie-session routes.** This namespace is bearer-only with exactly THREE
deliberate exceptions, none of them list routes above: `/api/copilotkit` (the
chat runtime, `docs/chat.md`), the teacher-only `/api/health` probe
(`docs/dashboard.md`), and `GET /api/image-content/<id>` (the image byte route,
`docs/images.md`) — a signed-in browser's `<img src>` and `fetch` calls carry a
session cookie, not a bearer token, so these three stay on the cookie channel
instead. `/api/image-content` in particular carries **no proxy-matcher
exclusion at all** (unlike every bearer route below, which needs one to reach
callers with no session cookie) — it sits behind the default cookie gate like
any page, and its handler re-validates the session itself on top of that.

- **`GET /api/version`** (`app/api/version/route.ts`) — the ONE route in this list
  that is **public and unauthenticated** (proxy-excluded, no bearer gate): the
  build-identity probe for CD triage. Answers
  `{ version, gitSha, builtAt, cliVersion }` — the first three baked into the image
  as env vars (`lib/version.ts`), `cliVersion` the `version` of `cli/package.json`
  as a build-time static JSON import (the file is absent from the standalone
  output, so a runtime read would not work). CLI and server share this repo, so
  `cliVersion` is the CLI release matching the `lib/**` code this server runs —
  `novedu-cli eval` compares it against its own and warns on a mismatch
  (`docs/cli-eval.md`). Everything here is public by construction: the repo is
  public and the CLI is published on npm.
- **`GET /api/me`** (`app/api/me/route.ts`) — the identity probe backing
  `novedu-cli whoami`: any valid token gets
  `{ name, userId, isTeacher }` (it reports the teacher flag rather than
  requiring it — a diagnostic for misconfigured accounts).
- **`GET /api/codes?q=&mine=&module=`** (`app/api/codes/route.ts`,
  teacher-only) — the `/codes` list's filters, with the bearer channel's OWN
  ownership param: `q` contains-matches note/code, `mine` defaults **on**
  (`mine=0` widens to all teachers; `createdBy` = the token's user id), `module`
  optional. The web page spells the same narrowing `?owner=` (a user id, or `all`)
  and has no `mine` — `docs/filtered-lists.md`. Bare JSON
  array, newest first, of
  `{ code, url, module, note, fileUrl, anonymous, validFrom, validUntil, llm, createdBy, ownerName, createdAt }`
  (`url` the shareable link, `llm` the override
  `{ provider, model, reasoning? }` or `null`, `ownerName` the creator's display
  name or `null` — the name the `/codes` list shows).
- **`POST /api/codes`** (same file, teacher-only) — mints a code through the
  SAME pipeline as the web form (`createCodeForUser`,
  `lib/code-service.ts`). JSON body
  `{ module, fileUrl, validFrom?, validUntil?, note?, llm?: { provider, model, reasoning? } }`
  (`reasoning` a `REASONING_LEVELS` literal, only valid with the pair — docs/ai-models.md);
  the window bounds must be ISO 8601 **with an explicit offset or `Z`** — a
  naive datetime is rejected with 400 (it would otherwise silently be
  interpreted in the server's timezone). `201` + the same code object shape.
- **`GET /api/codes/<code>/conversations?limit=&after=`**
  (`app/api/codes/[code]/conversations/route.ts`, teacher-only, **creator-only**) —
  one page of every conversation students had under ONE code — the whole-code
  export a teacher hands to an LLM, backing `novedu-cli codes export`. Stricter than the role-gated web transcript pages: the
  token's user must be the code's `createdBy`, else `403 { message }`; an unknown
  code is `404` (existence is not secret — `GET /api/codes?mine=0` lists every
  code). Paged per **Pagination** above. Answers
  `{ code: { code, module, note, fileUrl, anonymous }, conversations, nextCursor }` —
  the `code` block repeats on every page (`note` is `null` when empty), each
  conversation is `{ threadId, startedAt, endedAt, truncated, messages }`, each message
  `{ role: "user" | "assistant", createdAt, content }` with `content` a string when
  text-only, else an array of `{ type: "text", text }`,
  `{ type: "image", mimeType, bytes }` and `{ type: "tool", name, args, result }`
  parts in stored order. A conversation is a thread with ≥ 1 user message; replayed
  history is collapsed as in the web transcript. A conversation carries at most its
  **last 500** stored messages (`MAX_MESSAGES_PER_CONVERSATION`,
  `lib/conversation-export.ts`) — the cap is applied in SQL, so one huge thread cannot
  exhaust server memory — and `truncated: true` marks one whose older messages were
  cut (`startedAt` is then the first KEPT message; a truncated conversation stays in
  the export even if the cut removed all its user messages). **No identity** for any code (the
  store, `lib/conversation-export-store.ts`, never joins `novedu_user_chats` or
  `novedu_user`), and photos are stripped inside Postgres — the base64 never leaves
  the database. Coding codes store no conversations and answer an empty page. One
  content-free `conversations.export.page` event (`code`, `limit`, `returned`) per
  request.
- **`GET /api/files?q=&mine=`** (`app/api/files/route.ts`, teacher-only) —
  the `/files` list's filters, with the bearer channel's own ownership param
  (`q` over name/title/description; `mine` default on, where the web page
  spells it `?owner=`). Bare JSON array of active
  versions **without content**:
  `{ name, kind, title, description, createdBy, ownerName, createdAt, url }`
  (`ownerName` as on `GET /api/codes`; `url` the
  public download URL; download itself needs nothing new — the per-name GET
  is public).
- **`PUT /api/files/<name>`** (`app/api/files/[name]/route.ts`, teacher-only;
  the GET on the same URL stays public) — **upsert** via `upsertFileForUser`
  (`lib/file-service.ts`): create if the name is free (`kind` then required —
  a missing one fails naming the five kinds), else a new version validated
  against the **stored** kind; a supplied `kind` that mismatches the stored
  one fails **loudly** with `409` (never silently ignored; a create race on
  the name is 409 too). Body `{ kind?, content }`; `200` with
  `{ name, kind, url, action: "created" | "updated" }`.
- **`GET /api/images?q=&mine=`** (`app/api/images/route.ts`, teacher-only) —
  the `/images` list's filters, with the bearer channel's own ownership param
  (`q` over the name; `mine` default on, where the web page spells it
  `?owner=`). Bare JSON array of active versions
  `{ id, name, mimeType, byteSize, credit, createdBy, createdAt, url }` — `id`
  is the per-version row id and `url` the absolute
  `/api/image-content/<id>` link, which only resolves bytes for a **signed-in
  browser session** (`docs/images.md`) — not a programmatic download endpoint.
  Unlike `/api/files` there is **no public GET** anywhere under this prefix.
- **`POST /api/images/<name>`** (`app/api/images/[name]/route.ts`,
  teacher-only) — ONE `multipart/form-data` request that carries the bytes to
  the app and returns the confirmed result — no slot, no confirm step. Fields:
  `file` (exactly one file part), `mime` (PNG/JPEG/SVG, exactly one string),
  `credit` (optional, at most one string). The request is bounded twice: the
  whole multipart envelope is capped at **6 MiB** by a streamed byte counter
  (`readBoundedFormData`, `lib/bounded-form.ts` — `Content-Length` is only a
  fast reject, never trusted alone) and the image itself at `MAX_IMAGE_BYTES`
  (5 MB) by `createImageForUser` (`lib/image-service.ts`), the same pipeline
  the web form's server action calls. `201` with
  `{ id, name, mimeType, byteSize, credit }` (the measured size). **Create-only,
  no upsert** — images are immutable; a taken name is `409` (delete + re-upload
  in the web app is the way to replace one); `400` for a bad body/name/MIME/size,
  `413` above 6 MiB, `503` when storage is unavailable.
- **`GET /api/reports?status=&reaction=&q=&mine=`** (`app/api/reports/route.ts`,
  teacher-only) — the `/reports` inbox's exact filters and defaults over
  `listReports`: `status` `open` (default) | `resolved` | `all`; `reaction` one
  of `good` | `omg` | `bad` | `holysh` (optional); `q` the inbox's DB-side
  contains-search (description, reporter user id + name, code, code note);
  `mine` defaults **on** (`mine=0` widens to all teachers; `codeCreatedBy` = the
  token's user id). An unknown `status` or `reaction` is rejected **`400 { message }`**
  — scripts fail loudly where the forgiving web UI silently ignores. Bare JSON
  array in the inbox order (open `holysh` first, then newest first) of the full
  `ReportListRow` parity shape
  `{ id, kind, code, codeNote, userId, displayName, reaction, description, createdAt, threadId, questionId, questionText, answerText, feedbackText, verdict, hadImages, resolvedAt, resolvedBy }`.
  The report is explicitly non-anonymous toward teachers (the sanctioned waiver,
  `docs/reports.md`); `codeNote`/`displayName` are `null` for a deleted code /
  unknown user, the quiz-only snapshot columns `null` for a chat report and the
  chat-only `threadId` `null` for a quiz report.
- **`GET /api/reports/<id>`** (`app/api/reports/[id]/route.ts`, teacher-only) —
  the same report object for one id (`getReportById`, the single-row twin of
  `listReports`). For `kind: "chat"` it additionally embeds the transcript:
  `{ …report fields…, messages: [{ id, role, content }] }` from
  `getConversationMessages(code, threadId)` (`lib/code-stats-store.ts`, the same
  collapsed sequence the web transcript page renders; text messages only). A
  quiz-answer report has **no** `messages` key — its snapshot is already on the
  row. A malformed (non-UUID) or unknown id → **`404 { message }`**; a chat
  report whose code/thread was deleted returns `messages: []` (the report itself
  still shows); a store/transcript DB error → `503`.
- **`POST /api/reports/resolve`** (`app/api/reports/resolve/route.ts`,
  teacher-only) — bulk resolve by id. JSON body `{ ids: ["<uuid>", …] }` —
  non-empty, every entry UUID-shaped (the web bulk actions' guard); anything
  else → **`400 { message }`**. Stamps `resolved_at = now` + `resolved_by` = the
  token's user id via `setReportsResolved(ids, true, userId)`; unknown / already-resolved
  ids are silent no-ops (an already-resolved report keeps its first resolver). `200` with `{ ok: true }`; store
  failure → `503`. **Resolve is the only mutation on this channel — reopen and
  delete stay web-only** (an agent should never destroy a student's report;
  `docs/reports.md`).
- **`POST /api/eval/grade`** (`app/api/eval/grade/route.ts`, teacher-only) — grades
  ONE golden answer for `novedu-cli eval` (`docs/cli-eval.md`). Body
  `{ llm: { provider?, model, reasoning? }, system, answer }` (`provider` defaults
  to SCCH; an unknown provider or reasoning level is `400`, never silently
  defaulted/dropped); `200` with
  `{ result: "correct" | "partial" | "incorrect", feedback, usage? }`, the OPTIONAL
  `usage: { input, cachedInput, output }` carrying this call's tokens when the model
  reported any (`input` includes the cached part; the field is omitted entirely when
  there is no usage — `docs/cli-eval.md`). It runs the **exact**
  production grading path — the memory-less `quizEvaluator` with
  `QUIZ_VERDICT_SCHEMA` structured output over `buildAnswerMessage(answer.trim())`,
  the same call `submitAnswer` makes — and **persists nothing** (no queue, no run
  history: one request = one graded answer, so the CLI can fan out and retry).
  Failures: `400` for a malformed body, an unknown provider, a provider this
  deployment cannot serve (`providerUnavailableReason` — deliberately terminal so
  the CLI does not retry it), an answer that is empty after trimming, or an upstream
  model call that can never succeed as sent — a deployment name that does not exist
  answers `400` naming the model and the upstream error code
  (`classifyUpstreamLlmError`, `lib/llm/upstream-error.ts`), also terminal; `413`
  above the **256 KB** body cap; `401`/`403` from the bearer gate; `502` when the
  grader returns no structured object or fails for a reason worth retrying (outage,
  rate limit, timeout — opaque by design; an upstream `401`/`403`, the provider
  refusing the server's own credentials, also stays `502` but says so explicitly so
  nobody chases a model-name typo through a credential outage). The endpoint URL and
  the provider's free-form text never cross back to the caller; only the endpoint URL
  goes to Application Insights (`docs/ai-models.md`), the free-form text is withheld
  by `recordError` (`docs/telemetry.md`). Stated plainly: this is a **teacher-scoped,
  verdict-schema-constrained LLM pass-through** — a teacher may send arbitrary
  `system`/`answer` text through it. That is a deliberate property under this repo's
  trust model (teachers already author every activity prompt), and it is why the
  gate is `requireBearerTeacher` and the grading prompt comes from the client so the
  server-held quiz `evaluation` prompts never leave the server. Usage is metered
  under the `cli-eval` pseudo-code + `eval` module (`docs/usage-metering.md`).
- **`POST /api/eval/judge`** (`app/api/eval/judge/route.ts`, teacher-only) — audits ONE
  grader **feedback** text for `novedu-cli eval`'s feedback judge (`docs/cli-eval.md`).
  Body `{ llm: { provider?, model, reasoning? }, system, subject, criteria }`, where
  `system` is the
  judge prompt, `subject` the assembled `(grading prompt, answer, verdict, feedback)`
  block, and `criteria` **1–8** names matching `/^[a-z_]{1,40}$/`; `200` with
  `{ issues: [{ criterion, note }], usage? }`, an **empty `issues` array meaning the
  feedback is acceptable** (there is deliberately no `ok` flag) and the same optional
  `usage` shape the grade route reports. It runs the memory-less **`evalJudge`** agent
  with `judgmentSchema(criteria)` as structured output and **persists nothing**.
  **Kind-agnostic by construction:** both prompts AND the taxonomy arrive in the body,
  and the criteria become the model's enum — so another eval kind can reuse this endpoint
  with no server change, and the model can never name a criterion the caller cannot
  render. Failure matrix identical to the grade route (`400` malformed body / unknown or
  unavailable provider / terminal upstream model error; `413` above 256 KB; `401`/`403`
  from the gate; `502` for no structured judgment (including one cut off by the
  8192-token output cap, `JUDGE_MAX_OUTPUT_TOKENS`) or a retryable upstream failure — its
  opaque wording names judging, not grading). Same trust argument as the grade route, one
  step stronger: `evalJudge` is never web-reachable by students (the CopilotKit runtime
  route 404s every agent id but the code module's own), the gate has no student mode, and
  **no** server-held quiz `evaluation` prompt is involved at all. Usage is metered under
  the same `cli-eval` pseudo-code + `eval` module as the gradings it audits.
- **`POST /api/eval/respond`** (`app/api/eval/respond/route.ts`, teacher-only) — generates
  ONE tutor turn for `novedu-cli eval`'s **tutor** kind (`docs/cli-eval.md`). Body
  `{ llm: { provider?, model, reasoning? }, system, tools, messages }`, where `system` is the tutor's
  assembled system prompt, `tools` the catalog names of its `tools:` grant (`[]` for a
  tool-less tutor) and `messages` the scripted conversation as
  `[{ role: "user" | "assistant", text }]` — **1–200 turns**, each non-empty, the teacher's
  `student`/`tutor` roles already mapped to the wire ones; `200` with
  `{ text, toolCalls, usage? }`, `text` the generated turn as **plain text** (no structured
  output, hence no truncation-retry wrapper), `toolCalls` the **names** of the tool calls
  the generation made — in call order, duplicates preserved, `[]` when none and **always
  present**, so a client can tell "called nothing" from a server that cannot report tool
  calls at all (names only: arguments and results are deliberately never returned) — and
  `usage` the same optional shape its siblings report. It
  runs the memory-less **`evalTutor`** agent with the client's prompt and the real tool
  instances (`selectTutorTools`), and **persists nothing** — the whole conversation arrives
  in the body, so no thread and no storage is involved. Failure matrix identical to the
  grade route, plus one of its own: a `tools` entry the catalog does not know is `400`
  naming it (terminal — the runtime throws on the same input, so retrying cannot help).
  Same trust argument as the judge route: `evalTutor` is never web-reachable by students
  (the CopilotKit runtime route 404s every agent id but the code module's own), the gate
  has no student mode, and the prompt comes from the client. Real tool calls DO execute —
  harmless by construction: the catalog's executors are pure / injected-effect
  (`docs/tutor-tools.md`) and the run is teacher-initiated. Usage is metered under the same
  `cli-eval` pseudo-code + `eval` module as the gradings and judgings beside it.
- **Proxy exclusion, per route:** bearer routes must not hit the cookie gate
  (a CLI has no session), so each one gets its own **path-bounded** entry in
  the `proxy.ts` matcher (`api/me(?:/|$)`, `api/codes(?:/|$)`,
  `api/reports(?:/|$)`, `api/images(?:/|$)`, `api/eval(?:/|$)` — which bounds ALL THREE
  eval routes) — never a blanket `/api` prefix. The files handlers ride
  the public `api/files` exclusion and self-gate. Adding a bearer endpoint = new route
  file gated by `requireBearerUser`/`requireBearerTeacher` + its own matcher
  exclusion + documentation here. `tests/unit/api-surface.test.ts` checks every `api/`
  matcher exclusion is path-bounded (`(?:/|$)`), probes which paths run the proxy,
  and fails on any `app/api/**/route.ts` handler that neither calls a
  `requireBearer*` gate nor is one of the documented non-bearer exceptions.
- **The service seam:** the bearer write routes and the web server actions
  execute the identical policy pipeline through `lib/code-service.ts` /
  `lib/file-service.ts` / `lib/image-service.ts` (plain server modules; auth
  never enters them — each channel gates itself and passes the verified
  `userId` in). Listing needs no
  service: `listCodes` / `listFiles` / `listImages` are already transport-agnostic, and every
  `reports` operation is likewise a bare `lib/report-store.ts` call (the added
  `getReportById` plus the existing `listReports` / `setReportsResolved`) — no
  service layer, auth never enters the store.

## CLI: `cli/src/auth.ts` + commands

- The CLI knows nothing about Entra — it only ever talks to the Novedu server's
  own device-flow endpoints and stores what they return (plain `fetch`, no auth
  package dependency). Sessions are stored **per server origin** in
  `~/.novedu/sessions.json` (`{ [origin]: { token, name } }`, directory `0700`,
  file `0600` — the token is a live credential): `http://localhost:3000/` and
  `http://localhost:3000/x` share one entry, while production and a dev server
  stay separate. `serverOrigin`/`readSessions`/`writeSessions`/`storedSession`/
  `rememberSession`/`forgetSession` in `cli/src/auth.ts` are the whole seam;
  writing the file also removes an obsolete `~/.novedu/token-cache.json` if one
  is still there.
- **`NOVEDU_TOKEN`** short-circuits the session file with a caller-supplied
  bearer token, checked by `getAccessToken` before the stored session. It
  exists for tests and CI/agent environments with no browser to approve a
  device code — the token is still validated by the server on every request,
  so this weakens nothing; it is not a substitute for `login`, and `logout`
  deliberately ignores it (it only ever revokes the *stored* session, never one
  injected through the environment).
- **Management commands** (`cli/src/commands/codes.ts`, `files.ts`,
  `images.ts`, `reports.ts`; shared plumbing in `cli/src/api.ts`):
  `codes create/list`, `files upload/list`, `images upload/list`,
  `reports list/show/resolve` — thin flag→request mappers
  over the routes above, **JSON-only** output: success bodies pretty-printed on
  **stdout** (exit 0), every failure — auth, network, or the server's
  `{ message }`/`{ errors }` verbatim — as JSON on **stderr** (exit 1); both
  streams are jq-processable. `files upload <name>` reads YAML from
  `--file <path>` or stdin; `list` defaults to only-mine (`--all` widens, UI
  parity). No client-side pre-validation — the server runs the identical
  pipeline; offline checking stays the `validate` command's job.
- Three commands are exceptions to the JSON-only output rule: `codes sync` and
  `eval` print human reports (JSON behind `--json`), `codes export` streams JSON
  Lines. Their hard failures still follow the rule (JSON on stderr, exit 1).
- **`codes sync <registry-file>`** is the first exception to the JSON-only output
  rule: it reconciles a whole **activity registry** (`docs/registry.md`) in a
  single run — one `GET /api/codes`, then a `POST /api/codes` per entry that has
  no matching code — so it prints a per-entry report and keeps the JSON contract
  behind `--json`. It adds no route and no server behavior: matching is entirely
  client-side over the listing's `fileUrl` / `module` / window / `llm` fields.
  Hard failures (invalid registry, no token, unreachable server, unwritable
  lock) stay JSON on stderr with exit 1; a single entry's rejection is reported
  in the run's report instead — `performApiRequest({ quiet: true })` hands the
  failure payload back rather than printing it.
- **`codes export <code> [--out <file>]`** (`cli/src/conversation-export.ts`) is
  the third exception: it walks the creator-only, paged
  `GET /api/codes/<code>/conversations` (`limit=50`, `after` = the previous
  `nextCursor`, until `null`) and writes **JSON Lines** — one header line
  `{ type: "export", format: "novedu-conversations/1", code, module, note, fileUrl, anonymous, exportedAt }`
  (the code block of page one plus the CLI clock), then one
  `{ type: "conversation", … }` line per conversation as the pages arrive (one page
  in flight; writes wait for `drain`). Without `--out`, stdout carries ONLY that
  stream (a closed pipe ends it quietly, exit 0); there is no `--json`, the output
  already IS line-delimited JSON. With `--out`, the file is opened before the first
  request, receives the stream, and stdout gets the summary
  `{ code, file, conversations, messages }`. A failure (any non-2xx — the server's
  `{ message }` relayed by `performApiRequest` — network, a malformed page envelope
  (checked before any of the page is written), a cursor that does not move, a write
  error, including one that happens while the next page is in flight) is JSON on
  stderr, exit 1; in stdout mode the lines already written stay, in
  `--out` mode the partial file is removed.
- **The `images` group** (`cli/src/commands/images.ts`) drives the two
  `/api/images` routes. `images upload <name> --file <path> [--credit <text>]`
  reads the file, derives the MIME from its extension (`imageMimeFromExtension`,
  the one client-side check), builds ONE `FormData` (`file`, `mime`, optional
  `credit`), and sends it as ONE bearer `POST /api/images/<name>` — `runApiRequest`
  passes a `FormData` body straight to `fetch`, which sets its own multipart
  boundary, so the CLI never sets `content-type` itself. A failure is exactly
  one JSON error on stderr (exit 1). `images list [--search <q>] [--all]`
  mirrors `files list`, printing each row's `id` and its authenticated `url`
  verbatim (opening it needs a signed-in browser). Create-only like the route:
  no overwrite, no delete (web-only).
- **The `reports` group** (`cli/src/commands/reports.ts`) drives the three
  `/api/reports` routes for the report-triage loop
  (`reports list` → `reports show <id>` → fix the activity YAML →
  `files upload` → `reports resolve <id…>`; `docs/reports.md`):
  `reports list [--status <open|resolved|all>] [--reaction <good|omg|bad|holysh>] [--search <q>] [--all]`
  (defaults to **open** reports on **my** codes, `--all` → `mine=0`, `--search`
  → `q`, `--status`/`--reaction` pass through verbatim — the server rejects
  unknown values, no client-side enum check); `reports show <id>` prints the
  single report, transcript embedded for a chat report so an agent gets
  everything in one call; `reports resolve <id…>` sends every id in one
  `POST /api/reports/resolve`. Reopen and delete are deliberately **not** here —
  they stay web-only.
- **`eval <evalPathOrUrl…>`** (`cli/src/commands/eval.ts`) is the second exception
  to the JSON-only rule, for the same reason as `codes sync`: it makes MANY requests
  (one `POST /api/eval/grade` per golden answer, or one `POST /api/eval/respond` per
  scripted conversation, × `--repeats`, bounded by
  `--concurrency`, plus — unless `--no-judge-feedback` — one `POST /api/eval/judge` per
  successful repeat) and prints a run report, keeping the machine-readable batch
  shape behind `--json` / `--out`. Which generation endpoint it calls follows the eval
  file's own `kind`; a batch may mix both. It both talks to the
  server and does substantial offline work: the prompts are assembled locally
  through the app's own dump seam. Per-case failures are handled by the command
  (`performApiRequest({ quiet: true })` + the `status` / `authFailed` markers:
  retry 5xx and network, abort the whole run on 401/403); hard failures — no usable
  eval file, half an `--llm-*` pair, an unwritable `--out` — stay JSON on stderr with
  exit 1. It is also the one command that probes **`GET /api/version`** (public, no
  token) before grading, warning on stderr when the server's `cliVersion` is not this
  CLI's or cannot be read — advisory only, never an exit code. See `docs/cli-eval.md`.
- **`login [--server <url>]`** tries a silent identity check first (`GET
  /api/me` with any stored token — `{ status: "already-signed-in", name, server }`,
  exit 0, so an agent re-running it never blocks). Otherwise it starts the device flow:
  `requestDeviceCode` prints the verification link and the 8-character code
  (on **stderr** — stdout stays JSON-only), tries to open the link in the
  system browser (`openBrowser`/`browserCommand`, ignored on failure — the
  link was already printed), then `pollDeviceToken` waits for the human to
  approve it at `/device`, honoring the server's `interval`/`slow_down`
  back-off and giving up once the code's `expires_in` window passes. The
  resulting session token is **stored first** via `rememberSession`, keyed by server
  origin, and only then probed for the display name with a follow-up `/api/me`
  call — the session already exists server-side, so discarding the token over a
  hiccup in that probe would orphan a 30-day row and force another human
  approval. A failed probe prints `name: null` plus a one-line stderr hint and
  still exits 0. A stored session that cannot be checked at all because the
  server is UNREACHABLE aborts with exit 1 instead of starting a second device
  flow (`fetchIdentity` separates "rejected" from "unreachable" — see below).
- **`logout [--server <url>]`** calls `POST /api/auth/sign-out` with the
  **stored** bearer (best effort — 3 s timeout, JSON body `{}` since the
  endpoint is JSON-only, errors swallowed) and always removes the local
  session afterward via `forgetSession`, printing `{ status: "signed-out", server }` even when
  nothing was stored or the server could not be reached — sign-out must never
  leave a stale local credential behind just because the network is down.
- **`whoami [--server <url>]`** resolves the token via `getAccessToken` and calls
  `GET /api/me` through the shared `fetchIdentity`, printing
  `{ name, userId, isTeacher, server }` on stdout. Every failure — nothing
  stored, a rejected token, an unreachable server — is `{ message }` on stderr
  with exit 1.
- **`fetchIdentity` (`cli/src/auth.ts`)** is the one `/api/me` caller, and it keeps the
  two failures apart because `login` acts on them differently: `null` means the server
  REJECTED the token (401/403 — the device flow has to run), while an unreachable server,
  a 5xx or a body that is not an identity THROWS with a message naming the server.
- Not-signed-in state is the typed `NotSignedInError` →
  `Not signed in — run "novedu-cli login".`, exit 1. `performApiRequest` reports it
  back as a failure carrying `authFailed: true` (and NO `status`, since nothing was
  sent), alongside the HTTP `status` it sets on a non-2xx — the two markers a
  many-request command needs to tell "retry", "give up on this item" and "abort the
  whole run" apart.

## Testing (hermetic; validation stays real)

- **Unit:** `lib/api-auth.unit.test.ts` mocks `@/auth` (`tests/mock-auth-session.ts`'s
  `bearerSession` builds the `{ session, user }` shape `auth.api.getSession`
  resolves to) and runs the verdict matrix — no/malformed `Authorization` header
  → 401 without calling `getSession` at all, a header but a `null` session → 401,
  a valid session → `{ userId, name, isTeacher }`, the teacher gate's 403, and
  that a cookie-only request (no `Authorization` header) never authenticates.
- **Route unit tests** (`app/api/codes/route.unit.test.ts`,
  `app/api/files/route.unit.test.ts`, the PUT cases in
  `app/api/files/[name]/route.unit.test.ts`, the two images routes —
  `app/api/images/route.unit.test.ts`,
  `app/api/images/[name]/route.unit.test.ts` — and the three reports
  routes — `app/api/reports/route.unit.test.ts`,
  `app/api/reports/[id]/route.unit.test.ts`,
  `app/api/reports/resolve/route.unit.test.ts`) keep the auth gate REAL by
  mocking `@/auth`'s `auth.api.getSession` the same way and mock the
  services/stores underneath: the 401/403 matrix, filter parsing + the `mine`
  default, naive-timestamp rejection, the 400/409/503 mapping, and the wire
  shapes. The reports specs additionally mock `lib/report-store` +
  `getConversationMessages` and assert the 400 on unknown enum values /
  malformed `ids`, the 404 cases, the chat-embeds-`messages` / quiz-doesn't /
  deleted-code → `[]` shapes, and that resolve passes the token's user id as
  `teacherId`. `app/api/eval/grade/route.unit.test.ts` mirrors this and mocks
  `@/app/mastra` (like `lib/quiz-actions.unit.test.ts`): the 401/403 matrix, the
  400 matrix (bad body, unknown provider, unavailable provider,
  empty-after-trim answer), the 413 cap, the 200 wire shape, the 502s, and — the
  production-parity assertion — that the agent receives `buildAnswerMessage` of
  the TRIMMED answer plus the `QUIZ_EVAL_*` and usage-sentinel RequestContext
  values. `app/api/eval/judge/route.unit.test.ts` mirrors it for the feedback
  judge, adding the `criteria` bounds/regex matrix and the kind-agnostic
  assertion: the structured-output schema handed to the agent accepts exactly
  the CALLER's criteria and rejects everything else.
  `app/api/eval/respond/route.unit.test.ts` mirrors both for the tutor
  generator, adding the message-shape matrix, the terminal 400 on an unknown
  tool name, and the production-parity assertion that the scripted turns reach
  the agent verbatim and in order alongside the `EVAL_TUTOR_*` and
  usage-sentinel RequestContext values.
  `app/api/codes/[code]/conversations/route.unit.test.ts` pins the export route the
  same way (mocked `getCode` + `listConversationPage`): the 401/403 matrix, the
  `limit`/`after` 400s BEFORE any lookup, the creator-only 403 without a store call,
  404/503, and the wire shape with its content-free event. Its store has a
  fake-`execute` unit test (`lib/conversation-export-store.unit.test.ts`: the
  `limit + 1` cursor rule, the cursor clause, the per-conversation cap and its
  `truncated` flag, and the SQL-text guard that neither
  statement names a `novedu_*` table and `content` is read only through the jsonb
  rebuild), and the pure mapping/collapse/cursor helpers have their own
  (`lib/conversation-export.unit.test.ts`).
- **e2e:** `e2e/api-me.spec.ts`, `e2e/api-codes.spec.ts`, `e2e/api-images.spec.ts`
  and `e2e/api-reports.spec.ts` exercise the routes over HTTP with an empty
  cookie state, which also proves the proxy-matcher exclusions (a regression
  turns the expected 401 into a sign-in redirect); `e2e/api-gate.spec.ts`
  covers the two exclusions no per-feature spec owns — `/api/eval/{grade,judge,respond}`
  and the public `/api/coding/v1/*` — table-driven, one row per route, so a
  bearer route added without a gate spec is visible rather than silently
  uncovered (add the row with the route); every spec here mints its token
  through `mintSessionToken` in the single `e2e/api-auth.utils.ts` helper — it
  upserts a `novedu_user` row and inserts a matching `novedu_session` row (an
  `expired: true` option backdates `expires_at` for the expiry cases) and
  returns the raw token, so there is no keypair or JWKS setup anywhere in this
  path. The @live-db `e2e/api-management.live.spec.ts` runs the full
  file-upsert → list → code-create → list lifecycle against the real database,
  and the @live-db `e2e/api-reports.live.spec.ts` files a chat report through
  the real UI (a zero-message thread, no LLM) then drives `GET /api/reports` →
  `GET /api/reports/<id>` (with `messages`) → `POST /api/reports/resolve` → the
  `status=resolved` listing. The @live-db `e2e/api-conversations.live.spec.ts`
  seeds Mastra threads straight into the database (a real `data:` photo, an
  assistant-only thread, a stored tool result, a tied and two microsecond-apart
  thread timestamps — no LLM), walks `GET /api/codes/<code>/conversations` with
  `limit=1` to its `null` cursor without skipping or repeating a thread, and asserts
  the photo arrives only as `{ mimeType, bytes }`, the assistant-only thread is
  absent, no identity appears, and another teacher's code is `403`; a second case
  seeds 502 messages and gets the last 500 back, marked `truncated`.
- **CLI unit tests** (`cli/src/auth.unit.test.ts`) exercise the device-flow
  request shape, the pending→success and `slow_down`/expired/denied poll
  outcomes, and the sessions-file round trip (mode `0600`, per-origin keys,
  `NOVEDU_TOKEN` precedence, a stray `token-cache.json` beside it being deleted) against a
  fake `fetchImpl`/`sleep` — no real network or timers.
  `login.unit.test.ts`/`logout.unit.test.ts` mock `../auth` and assert the
  already-signed-in short-circuit, the printed link/code, and that `logout`
  ignores a failing server-side sign-out. `codes sync` additionally has
  offline integration coverage against a fake `/api/codes` in
  `test-fixtures/serve.mjs`, reached with the test-only `NOVEDU_TOKEN`
  override (checked before the session file — it only skips the interactive
  login; the server still validates the token on every request). See
  `docs/registry.md`. `codes export` has the same kind of coverage
  (`cli/test/export.integration.test.ts` against the fake
  `GET /api/codes/<code>/conversations`): the stdout stream is exactly a header plus
  one line per conversation across two pages, `limit=50` and the cursor are sent
  verbatim, `--out` writes the identical stream plus the JSON summary, and a 403 /
  unknown code / unwritable `--out` exit 1 with JSON on stderr and no file left
  behind; `cli/src/conversation-export.unit.test.ts` stages what the binary run
  cannot — a sink failing mid-walk or with a full buffer (no hang), a cursor that does not
  move, malformed page envelopes — over a mocked API seam. The `codes`/`files` command tests pin the flag→request
  mapping, stdin/--file reading, and the stdout/stderr JSON split;
  `cli/src/commands/reports.unit.test.ts` does the same for
  `reports list/show/resolve` (the defaults, `--all` → `mine=0`, the multi-id
  resolve body, and the exit codes), and `cli/src/commands/images.unit.test.ts`
  pins the ONE multipart request (exact `file`/`mime`/`credit` fields, no
  `content-type` header set by the CLI), the 400/409/503 mapping, and the
  extension→MIME rejection with zero fetches.
