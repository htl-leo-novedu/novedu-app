<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Global rules

- Do **not** push to GitHub unless the user explicitly asks.
- `CLAUDE.md` is a symlink to **`AGENTS.md`** — edit `AGENTS.md`.
- ALL documentation (`docs/**`, `teacher-docs/**`, READMEs, activity guides) describes the **current state only** — no change history, no migration notes, no version-gated remarks ("needs ≥ x", "since version y"). The app is an MVP under heavy development; assume the latest app and CLI are what everyone runs. Describing a live compatibility *mechanism* is fine (e.g. "an outdated CLI rejects unknown provider names — use `npx @novedu/cli@latest`"); naming versions is not.
- Load the **`mastra`** skill before any Mastra work; never rely on cached APIs. Register every agent/tool/workflow/scorer in `app/mastra/index.ts`; use the `dev`/`build` package scripts, never raw `mastra dev`/`mastra build`.
- Research current docs before non-trivial work with **Drizzle** ([llms.txt](https://orm.drizzle.team/llms.txt)), **Tailwind v4** (context7 via `ctx7` — CSS-first, differs from training data), or **Recharts** (context7 `/recharts/recharts`).

## Security & privacy invariants

The highest-cost rules to break. They always apply, regardless of subsystem; the linked doc has the full mechanics.

- Teacher-only server actions / route handlers: **`requireEffectiveTeacher()`** (or `requireTeacherUserId()` in the file/CRUD actions) — **never** `session.user.isTeacher` or `requireTeacher()`, which ignore "view as student" mode.
- The session user id is **`novedu_user.id`** — migration-seeded user rows carry the Entra `oid` as their id; the `oid` itself lives in `novedu_account.account_id`. A demo build's `credential` accounts carry `account_id` = the user id (`demo-teacher-1`, …), as better-auth's email sign-in requires.
- The **demo login** (one-click sign-in as four seeded personas with a public password) exists ONLY in demo builds: `NOVEDU_AUTH_MODE=demo`, frozen at build time through `next.config.ts`'s `env` (every branch site is the literal `process.env.NOVEDU_AUTH_MODE === "demo"`, demo modules load only by `await import()` inside it — grep-guarded), and CI proves the Entra build's compiled output free of it (`scripts/ci/check-demo-markers.mjs`). A demo build serves only an allowlist of `/api/auth` paths (everything else `404`s), refuses to build or boot with any Entra setting or a `novedu.at` `AUTH_URL`, and each build refuses a database holding the other mode's accounts (`docs/auth.md`, "Demo mode").
- Student access to any activity = **`checkCode()`** on the stored `novedu_codes` row + the **stateless-HMAC `x-thread-token`** over `(code, userId, threadId)`, both re-verified on **every** server touch. No signed links (`docs/codes.md`).
- The activity YAML's `anonymous` default is module-specific: tutor/quiz `true`, **writing `false`**, coding and cloze always anonymous (`docs/writing.md`).
- The quiz grader **`quizEvaluator`**, the cloze grader **`clozeEvaluator`**, the eval judge **`evalJudge`** and the eval tutor **`evalTutor`** are **never web-reachable by students** (the runtime route 404s every agent id but the code module's own, its per-request runtime registers only that one agent, and the auth-only `GET /api/copilotkit/info` lists only the modules' student-facing agents). `clozeEvaluator`'s only callers are the `gradeCloze` / `explainCloze` actions. Besides `submitAnswer`, the others' only callers are the teacher-only `POST /api/eval/grade` / `POST /api/eval/judge` / `POST /api/eval/respond`, which supply their system prompts client-side — the server-only quiz `evaluation` prompts never leave the server (`docs/codes.md`, `docs/cli-eval.md`).
- A cloze exercise's **reference answers and `evaluation` are server-only** (the browser gets only `toPublicCloze`, and the references only after a grading, as "a possible answer"), and **`explainCloze` trusts only token-signed verdicts** — the result token `gradeCloze` signs over `(code, userId, attemptId, answers, verdicts)`; never client-supplied ones (`docs/cloze.md`).
- Besides better-auth's own `/api/auth/*` endpoints (sign-in, OAuth callback, device code/token, sign-out; in a demo build only the allowlisted email sign-in, sign-out, session read and device code/token) and the unauthenticated build-identity probe `GET /api/version` (build version, SHA, time, CLI version — nothing else; `docs/api.md`), exactly **two public, non-Entra API surfaces**: `GET /api/files/<name>` (raw YAML) and the coding routes `POST /api/coding/v1/chat/completions` + `GET /api/coding/v1/models`, both authenticated by a per-user API key from `novedu_coding_keys` under one identical gate (key row + code row re-verified every request — `docs/files.md`, `docs/coding.md`). The teacher guide is not served by the app: it is a separate public static site at `docs.novedu.at`, and the app only 308-redirects its former `/docs/*` paths there (`docs/teacher-docs.md`).
- All other CLI/API routes are **session-token bearer**: proxy-excluded per-path and gated **only** by `requireBearerUser`/`requireBearerTeacher` (`lib/api-auth.ts`) over `auth.api.getSession` — the session resolved on every request, the role is the server-owned `novedu_user.is_teacher`, **no student mode on this channel**; auth never enters the `lib/*-service.ts` pipelines. `docs/api.md` lists every route.
- **LLM connectivity is server-only** behind `lib/llm/` — the provider branch exists ONLY in `resolveLanguageModel`, `resolveChatEndpoint`, and `providerUnavailableReason`; endpoints, keys, and Entra tokens never reach the browser. Foundry auth is passwordless Entra — never `DefaultAzureCredential`, never an API key. A code's **LLM override pair** is both-or-nothing via `effectiveLlm`, availability-gated on the effective provider (`docs/ai-models.md`).
- A thinking model's **reasoning is teacher-only on the live chat**: the `/api/copilotkit` route picks `ReasoningStrippingRunner` unless `effectiveTeacherForSession()` proves an effective teacher, so `REASONING_*` frames are never written to a student's stream. **Fails closed**; view-as-student gets a student's stream (`docs/chat.md`).
- Image bytes are served ONLY by the cookie-session `GET /api/image-content/<id>`, which re-checks the active row on every request (incl. a `304`), sends `nosniff` + a sandboxing `Content-Security-Policy` on every response, and applies NO further authorization beyond a live session — no `checkCode()`, no thread token; teacher-hosted images are shared authenticated assets, not per-code resources. SVG renders only via `<img src>`, never inline markup (`docs/images.md`).
- Telemetry carries **no** message / prompt / PII content on either backend. The backend is chosen ONCE at boot by the pure resolver `lib/telemetry-mode.ts` — `OTEL_SDK_DISABLED` > `OTEL_EXPORTER_OTLP_ENDPOINT` (standard OTLP) > `APPLICATIONINSIGHTS_CONNECTION_STRING` (Azure Monitor) > off — behind the single facade `lib/telemetry.ts`; startup logs name only the mode. `cli/src/**` never imports the facade or any OTel SDK (grep-guarded) (`docs/telemetry.md`).
- Usage metering writes two **independent** hourly buckets — `usage_by_code` (no user) and `usage_by_user` (no code). **Never** a `(user × code)` row; ids + counts only, never content (`docs/usage-metering.md`).
- Fork-PR CI stays **secret-free**; never add `pull_request_target` (`docs/ci-security.md`).
- Production Postgres is always passwordless Entra / Managed Identity; password auth is dev/test only (`docs/database.md`).

## Subsystem map

Deep reference lives in `docs/` — those docs are **not** auto-loaded, so read the linked doc BEFORE working in that area. The bullets below are ONLY the invariants that must hold even when you don't open the doc; everything else lives there.

### Auth, teacher roles & student mode → `docs/auth.md`

Read before touching: `auth.ts`, `lib/auth-*.ts`, `lib/demo-*.ts`, `lib/db/auth-mode-preflight.ts`, `lib/session.ts`, `lib/db/auth-schema.ts`, `proxy.ts`, `app/sign-in/**`, `app/device/**`, `lib/device-actions.ts`, `NOVEDU_AUTH_MODE`, `compose.yaml`, sessions, teacher gating, student mode.

- `compose.yaml` is a demo-only environment (the `:demo` image, Postgres, the fake LLM; ports on loopback only) — it never sets an Entra variable, which the demo build's env lock would refuse anyway.
- Entra ID via better-auth (a demo build: the demo login instead — one sign-in mode per build and per database, "Demo mode" in the doc); the gate is `proxy.ts` at the repo root (Next 16's rename of `middleware`, Node.js runtime; a session-cookie presence check). Every page/action/route re-validates the session itself. Teacher gating: see the security block.

### CLI / API bearer auth → `docs/api.md`

Read before touching: `lib/api-auth.ts`, the bearer handlers under `app/api/**`, `cli/src/auth.ts`, `cli/src/api.ts`, `cli/src/commands/**`, or when adding a bearer-protected endpoint.

- Adding a bearer endpoint = `requireBearer*` gate + its own path-bounded `proxy.ts` exclusion + a `docs/api.md` entry.
- Server-facing CLI commands (`login`/`logout`/`whoami` + the bearer management commands) are JSON-only (success on stdout, failures on stderr, exit 1); the sanctioned exceptions: `codes sync` and `eval` print human reports and keep JSON behind `--json`, `codes export` streams JSON Lines on stdout (or into `--out`, with a JSON summary on stdout). The offline `validate` and `prompts` print human text by default, JSON behind `--json`.
- The CLI signs in through the app's own OAuth device flow (`cli/src/auth.ts`, `app/device/**`): `login` requests a device code, the person approves it at `/device`, and the CLI stores the resulting session token per server origin in `~/.novedu/sessions.json`.

### Activity registry & `codes sync` → `docs/registry.md`

Read before touching: `lib/registry-schema.ts`, `cli/src/registry.ts`, `cli/src/sync.ts`, the `sync` subcommand, or the fake `/api/codes` in `test-fixtures/serve.mjs`.

- Sync NEVER modifies or deletes an existing code: changed parameters mint a NEW code; the old one is only reported as superseded. No server-side change — matching is client-side.

### Codes → `docs/codes.md`

Read before touching: `app/[code]/**`, `app/codes/**`, `app/api/copilotkit/**`, `lib/code-*.ts`, `lib/code-modules/**`, `lib/file-validators.ts`, `lib/quiz-*.ts`, `lib/thread-token.ts`.

- `checkCode()` gates EVERY student-facing server touch and must be re-run on each: the `/[code]` dispatcher, the CopilotKit route, both public coding routes (`chat/completions` + `models`), and the student server actions (`lib/{tutor,writing,report}-actions.ts`, `lib/quiz-verify.ts`). The conversation export `GET /api/codes/<code>/conversations` is NOT one of them — a **creator-only** bearer read (`created_by` = the bearer user) whose store never joins `novedu_user_chats`/`novedu_user`, so it carries no student identity for any code (`docs/api.md`).
- Fixed layering: **FileKind** → validator (`lib/file-validators.ts`) → **CodeModule** descriptor; adding a module touches only the documented seams.
- Editing a code changes only note + window + the LLM override pair — never the module, `file_url`, or the frozen `anonymous`.
- `novedu_user_chats` is the only user↔chat link, written only for non-anonymous activities. THREE sanctioned exceptions: `novedu_reports` stores the reporter's user id even on anonymous codes behind an explicit on-form notice (`docs/reports.md`), `novedu_coding_keys` stores the requester's user id behind an explicit on-page notice (`docs/coding.md`), and `novedu_quiz_results` stores a student's saved quiz or cloze counts only on their explicit choice (a quiz's Finish page, a cloze first round's results) behind an on-page notice (`docs/home.md`). The quiz-result store has NO teacher reader — `lib/quiz-result-store.ts` is its only access and its importers (incl. `lib/cloze-actions.ts`, `saveQuizResult` only) are guard-tested.
- A tutor tab resumes its current thread after a reload: the `{ threadId, token }` pair sits in `sessionStorage` (never `localStorage` or the URL), `resumeTutorThread` re-verifies the token and a **server-enforced 60-minute idle limit**, sign-out clears the pairs (`docs/chat.md`). Nothing new is persisted; anonymous tutors stay unlinkable. "Previous conversations" exists only when BOTH the frozen `novedu_codes.anonymous` AND the live YAML flag are `false`, lists only the session user's own threads under the current code, and reopens one only with their `novedu_user_chats` row. `lib/tutor-history-store.ts` is the student-side reader of `novedu_user_chats` (and of a thread's stored messages); it never returns a user id and is imported only by the tutor actions, the history gate and the snapshot runner (guard-tested).
- `precheckAnswer` (the quiz pre-check) re-derives the env gate and the quiz's `immediate_feedback` on every call, returns only a hint enum, and `evaluation` still never leaves the server; Jev is a connectivity site behind `lib/llm/jev-client.ts`, not an `LlmProvider`.

### Reports → `docs/reports.md`

Read before touching: `lib/report-*.ts`, `lib/quiz-verify.ts`, `components/report-button.tsx` + its mounts, `app/reports/**`, `app/api/reports/**`, `cli/src/commands/reports.ts`, `novedu_reports`.

- Reports are ALWAYS attributed to the reporter's user id (the sanctioned exception above); the store never joins `novedu_user_chats`; telemetry stays content-free.
- **`lib/quiz-verify.ts` must never gain `"use server"`** — it would mint an endpoint leaking the quiz `evaluation` prompts.

### Prompt fragments → `docs/prompt-fragments.md`

Read before touching: `lib/prompt-fragments/**`, `lib/tutors/**`, or a consumer's fragment wiring (`lib/{quiz,writing,coding,cloze}-fetch.ts`).

- `lib/prompt-fragments/` is the ONE home of Handlebars: `handlebars` is imported by exactly three files (grep-guarded); every consumer only calls `assembleFragmentPrompt`.
- `text_files` content is spliced **verbatim, never compiled**; an activity declaring neither file list gets its host text byte-verbatim.

### Tutor tools → `docs/tutor-tools.md`

Read before touching: `lib/tutor-tools/**`, `app/mastra/tutor-tools.ts`, the tutor schema's `tools:` field, `app/mastra/tutor-agent.ts` tools resolver.

- `lib/tutor-tools/` is the pure, CLI-bundled catalog (names, schemas, executors with injected effects) — it sits inside the prompt-dump grep-guard closure; the Mastra `createTool` binding lives ONLY in `app/mastra/tutor-tools.ts`.
- Tool grants are top-level `tools:` (enum-validated, default `[]`) — independent of `llm:` and the per-code LLM override; the platform never mentions tools in the prompt (authors do, in `tutor_instructions`).

### Writing → `docs/writing.md`

Read before touching: `lib/writing-*.ts`, `app/[code]/_writing/**`, `app/codes/[code]/s/**`, `app/mastra/writing-agents.ts`, `novedu_writing_submissions`.

- The feedback agent has **no write tool** — it cannot edit the student's text by construction.
- Student-authored Markdown is untrusted: always the sanitized `MarkdownRenderer` (no `rehype-raw`).

### Coding → `docs/coding.md`

Read before touching: `app/api/coding/**`, `app/[code]/_coding/**`, `lib/coding-*.ts` (incl. the key store `lib/coding-key-store.ts`), `lib/llm/endpoint.ts`, the `api/coding` matcher in `proxy.ts`.

- No in-app chat, no Mastra — a thin pass-through proxy. `lib/llm/endpoint.ts` stays side-effect-free and must NOT import `app/mastra/scch.ts` or the fragment core.
- Auth is a per-user API key resolved in the route beside `checkCode`: `lookupCodingKey` (`lib/coding-key-store.ts`) maps the bearer to its `(code, userId)` pair, then `checkCode` re-verifies the code itself — both stored rows, re-checked on every request. Both public routes run that gate identically and reject through the shared `lib/coding-http.ts` helpers, so the cheap `GET .../models` key check is never an oracle the completions route is not.

### AI models & LLM providers → `docs/ai-models.md`

Read before touching: `lib/llm/**`, `app/mastra/scch.ts`, `app/mastra/model-entry.ts`, `lib/scch-endpoint.ts`, the `llm:` block of any activity schema.

- Adding a provider = one branch in each of the THREE functions (security block) + a name constant + the schema enum literal + its `providerOptions` key in `reasoningOptionsKey` (beside `resolveLanguageModel` in `lib/llm/model.ts`). Jev (the quiz pre-check classifier) is NOT a provider: no branch in the three functions, not selectable in any `llm:` block, and `@typesafe-ai/sdk` is imported by exactly `lib/llm/jev-client.ts` (grep-guarded).
- The ai-sdk provider names (`scch`/`azure-foundry`/`openrouter`) are the metering contract — renaming breaks usage attribution.
- The agent path uses TWO ai-sdk packages across THREE instances: SCCH and OpenRouter on `@ai-sdk/openai-compatible` (exact-pinned `2.x`, the ai-sdk-v6 line — it alone maps `reasoning_content`, and needs `includeUsage: true` for metering; both share the exported `stripAssistantReasoning`), Foundry on `@ai-sdk/openai`. `providerOptions` keys differ accordingly.

### Chat (CopilotKit surface) → `docs/chat.md`

Read before touching: `app/module-chat.tsx`, the per-module chat components, the transcript `conversation-view.tsx`, `lib/runtime-headers.ts`, `app/api/copilotkit/reasoning-runner.ts`, `app/api/copilotkit/run-error-runner.ts`, `app/mastra/reasoning-processor.ts`, `lib/image-normalize.ts`, `lib/image-report.ts`, `app/image-check/**`.

- `ModuleChat` is the single live-chat primitive; the read-only `ConversationView` is NOT a `ModuleChat` — no agent ever runs there.
- Reasoning is stripped server-side for non-teachers (security block). The runner delegates to a 4-method abstract `AgentRunner` — a guard test reads that method list off the installed package's type declaration, so **wrap any new method before a CopilotKit bump** (in all three decorators: reasoning stripping, failure reporting, and the tutor's `HistorySnapshotRunner`).
- A tutor `connect` is answered by `HistorySnapshotRunner` (innermost, around `InMemoryAgentRunner`) with a framed `MESSAGES_SNAPSHOT` from the database (within the idle limit, or a per-user tutor's thread the student owns), the in-process replay filtered by stored message ids and a historic `RUN_ERROR` closed as `RUN_FINISHED`. It rests on undocumented CopilotKit / AG-UI / Mastra behaviour, guarded in CI against the fake LLM by the reload round-trip `e2e/tutor-reload-roundtrip.spec.ts` (and reasoning visibility by `e2e/reasoning-visibility.spec.ts`); **before any `@copilotkit/*`, `@ag-ui/*` or `@mastra/*` bump, also run `npm run test:e2e:live-llm` locally** — a real thinking model's reasoning stream and the provider smoke tests, which the fake cannot cover. The global `messageView.cursor` note ("Generating…") shows for the whole run, for everyone.
- Reasoning is **live-only**: `reasoningStrippingProcessor` (`app/mastra/reasoning-processor.ts`) is on the `outputProcessors` of every agent with `memory:`, so `mastra_messages` never stores a reasoning part. Adding a memory-backed agent means adding it there too.
- EVERY student photo (tutor + quiz) goes through `normalizeStudentImage` in the browser before it is inlined. Two DIFFERENT limits: `MAX_RAW_IMAGE_BYTES` (30 MB) bounds what may be PICKED, `MAX_IMAGE_BYTES` (5 MB) what may be SENT — CopilotKit checks `maxSize` against the ORIGINAL file, so it carries the RAW one. Canvas code never enters `lib/answer-images.ts` (a `"use server"` module imports it).
- A failed turn is in-band on an already-200 stream, so it is reported by the `RunErrorReportingRunner` decorator, which wraps BOTH runner variants; the `RUN_ERROR` message itself never reaches telemetry.

### Cloze ("Fill the gaps") → `docs/cloze.md`

Read before touching: `lib/cloze-*.ts`, `lib/code-modules/cloze.ts`, `app/[code]/render-cloze.tsx`, `app/[code]/_cloze/**`, `app/mastra/cloze-agents.ts`, `activities/cloze/**`, the cloze sample under `activities/examples/`.

- The reference answers inside `text` are **server-only**, exactly like `evaluation`: the browser only ever receives `toPublicCloze` (a whitelist — title, description, the text with numbered placeholders, gap numbers + hints; guard-tested) and, after a grading, the references as "a possible answer".
- The module has **no `runtime`** (like coding): grading is `gradeCloze` → `explainCloze` (`lib/cloze-actions.ts`), each re-running `checkCode()`. `explainCloze` runs only for a **result token** (`lib/cloze-result-token.ts`, HMAC from `AUTH_SECRET` over code, user, attempt, answers, verdicts) that `gradeCloze` signed — it never trusts client verdicts. **`lib/cloze-verify.ts` must never gain `"use server"`** (it returns the loaded exercise, references and `evaluation` included).
- Both prompts come from the pure builders (`lib/cloze-grading-prompt.ts`, `lib/cloze-feedback-prompt.ts`) the prompt dump calls too; feedback passes the grounding filter (`lib/cloze-grounding.ts`) before reaching the browser. Telemetry is content-free (ids, counts, durations).
- The teacher's statistics are `novedu_cloze_gap_counts` — per (code, gap, reference) verdict counters of **first submissions only**, never a user id or answer text; `lib/cloze-counts-store.ts` is its only access and deletes with the code.
- The runner renders the text through the sanitized `MarkdownRenderer` plus a rehype plugin that swaps each placeholder for a gap widget (`app/[code]/_cloze/cloze-text.tsx`); model feedback is rendered as plain text, never Markdown.
- `lib/cloze-gaps.ts` is the ONE gap parser — validator, runtime parser and every later consumer go through it; a plain line scan for `[[answer]]` / `[[answer|hint]]` / `[[]]` with no Markdown awareness and no escape. A cloze file is always anonymous (`readAnonymousFlag` → `true`), and the validator, schema and gap parser are CLI-bundled (grep-guard closure).

### App-hosted YAML files → `docs/files.md`

Read before touching: `app/files/**`, `app/api/files/**`, `lib/file-store.ts`, `lib/file-service.ts`, `lib/yaml-files.ts`, `novedu_files`.

- `novedu_files` is temporal/append-only; `lib/file-store.ts` is the only access. `lib/yaml-files.ts` is the client-safe facade and must not import the store.
- App-hosted URL resolution goes through the shared `appHostedFetcher` — never a loopback fetch.

### App-hosted images → `docs/images.md`

Read before touching: `app/images/**`, `app/api/images/**`, `app/api/image-content/**`, `lib/image-*.ts`, `components/content-image.tsx`, `novedu_images`.

- Bytes live under the operator-provisioned `IMAGE_STORAGE_ROOT`; the adapter (`lib/image-fs.ts`) never creates the root, `images/`, or its sentinel — no fallback directory, ever. Upload is ONE request per channel (server action / bearer multipart POST) — no slot, no confirm step. `GET /api/image-content/<id>` is the one deliberate cookie-session transport beside `/api/copilotkit` and the teacher-only `/api/health` probe in an otherwise bearer-authenticated API namespace — not a public API exception, and not a precedent for a fourth.

### Student YAML GUI module → `docs/yaml-gui-student-contribution.md`

Read before touching: `app/files/gui/**`, `lib/yaml-files.ts`.

- `app/files/gui/_studio/**` is student-owned client-side React; the `page.tsx` shells are app-owned. The students' only app import is `@/lib/yaml-files`.

### Styling → `docs/styling.md`

Read before touching: `app/globals.css`, `components/ui/**`, `lib/utils.ts`, `app/layout.tsx`, `components/app-chrome.tsx`, or any non-trivial `className` work.

- Tailwind v4, CSS-first: all config in `app/globals.css`; light-only. App CSS stays inside the declared layers — an unlayered rule silently breaks CopilotKit's utilities.
- A recipe used in ≥2 places becomes a cva primitive in `components/ui/`, consumed via `cn()`; no `@apply`.
- The status bar is rendered by the root layout through `AppChrome`, which drops it on the bare routes `/sign-in` and `/device`.

### Filtered lists → `docs/filtered-lists.md`

Read before touching: `components/data-list.tsx`, `components/list-*.tsx`, `lib/db/text-filter.ts`, or a list page's `searchParams`.

- Filtering happens in the database via URL search params — never in memory. Delete is bulk-only; no per-row or edit-page delete anywhere.

### Postgres, Drizzle & credentials → `docs/database.md`

Read before touching: Mastra storage (`app/mastra/index.ts`), `lib/db/`, migrations, `instrumentation.ts`, `scripts/db/*`.

- Every consumer takes the ONE pool from `getPool()` (`lib/db/pool.ts`) — the one auth seam; app tables use the `novedu_` prefix in `public`, Mastra's live in schema `mastra`; **no foreign keys** between `novedu_*` and `mastra_*`.
- Both stages and local development share ONE server (`psql-novedu`), one database per stage; each stage's app role is a plain login role (not the database owner) that owns the tables it creates at boot instead of holding table-level DML grants. Local development runs against `novedu_dev` as the group `novedu-dev`, whose sessions act as `ca-novedu-dev` by role default — never point a local boot at `novedu_prod` (`docs/database.md`).

### Telemetry → `docs/telemetry.md`

Read before touching: `instrumentation.ts`, `lib/telemetry*.ts`, `compose.telemetry.yaml`, the `@opentelemetry/*` / `@azure/monitor-opentelemetry` dependencies, any `recordError`/`emitEvent` call site.

- Off unless a destination is set; disabled / Azure / OTLP selection and the single facade: see the security block. Exactly one backend per process; a failed start stays off, never falls back.
- The OTLP path passes the `NodeSDK` ONLY instrumentations + the fixed detector set `env, host, os, serviceinstance` (never `process` / `all`) + a conditional `novedu-chat` service name — every exporter/processor/reader/sampler is the SDK's environment setup. Never opt into `headersToSpanAttributes` or `enhancedDatabaseReporting`; no diag logger of our own; no shutdown/flush handling (Next owns signals).
- The OTel packages are lockstep 0.x — bump `sdk-node`, the three instrumentations, the exact `@opentelemetry/api-logs` pin (it must equal the version the Azure distro pulls, or the global logger ends up on two copies) and the Azure distro together; the distro, `sdk-node` and the three instrumentations (`http`, `pg`, `runtime-node`) sit in `serverExternalPackages`.
- The Aspire dashboard (`compose.telemetry.yaml`, pinned tag) is the local OTLP receiver for an app running on the host.

### Usage metering → `docs/usage-metering.md`

Read before touching: `lib/usage-store.ts`, `app/mastra/usage-exporter.ts`, `lib/usage-context-keys.ts`, the capture points.

- Written off the response path by the never-throwing `lib/usage-store.ts`. Anonymity: see the security block.

### Usage dashboard → `docs/dashboard.md`

Read before touching: `app/usage/**`, `lib/usage-stats-store.ts`, `lib/usage-range.ts`, the shared chart building blocks `components/charts/**` + `components/dashboard-{ui,skeletons}.tsx`.

- Teacher-only, server-first read surface over `usage_by_code` — no `/api/usage/*` route; all windows UTC.

### Start page, achievements, saved quiz results & Settings → `docs/home.md`

Read before touching: `app/page.tsx`, `app/_home/**`, `app/settings/**`, `app/[code]/_quiz/save-result.tsx`, `lib/achievements/**`, `lib/home-data.ts`, `lib/home-cache.ts`, `lib/student-facts-store.ts`, `lib/teacher-facts-store.ts`, `lib/achievement-store.ts`, `lib/achievement-actions.ts`, `lib/quiz-result-store.ts`, `lib/user-settings-*.ts`, `novedu_achievements`, `novedu_quiz_results`, `novedu_user_settings`.

- Progress (XP, streak, calendar, badges) is served ONLY to the session user about themselves — no teacher view, no comparison; every statement is keyed by the session user id.
- `lib/achievements/catalog.ts` is server-only (guard-tested): hidden badges reach page data only once earned. Achievement ids never contain a code.
- A failed fact group is never read as zero; the page renders earned state only from stored grants, and new grants are inserted before the load returns.
- Saved quiz results are written only by `saveQuizResult` (and, for a cloze first round, `saveClozeResult` through the same store function) on the student's explicit choice (or their own "Always" setting), in one transaction under a `(user, code)` advisory lock with the code row `FOR SHARE`; the code delete locks its rows `FOR UPDATE` first. Settings act only on the session user's own row.
- `/` picks the shell by the EFFECTIVE role (`effectiveTeacherForSession`): view-as-student gets the student page. The teacher dashboard's statements are restricted to codes with `created_by` = the session user (or, for the teacher badges, the session user's own report resolutions and file versions), count students by the frozen `anonymous` flag (as `getCodeStats`), and return counts and dates only — never a student id or name. Both audiences share `novedu_achievements` and the strip/Badges components; the two catalogs' ids never collide.

### LLM diagnostics → `docs/diagnostics.md`

Read before touching: `app/diagnostics/**`, `lib/diagnostics-*.ts`, `buildMonitorCredential` in `lib/azure-credential.ts`.

- Teacher-only, server-first read surface over the app's own App Insights telemetry — gated by `requireTeacherPage()`, no API route, no `proxy.ts` change; the five queries run once per render (`app/diagnostics/load.ts`) and never throw.
- The connection string stays server-only (only its `ApplicationId` is extracted); hosts are mapped to provider NAMES server-side — no endpoint URL reaches the browser or the copied report. KQL is built from validated dates and the bin enum only.

### Azure access & the old environment on standby → `docs/azure-access.md`

Temporary — delete this entry together with the doc once the old environment is decommissioned. Read before running any `az` command against either Azure environment, changing how the app runs locally, or when a login has expired.

- Production is the prod stage (`app.novedu.at`). The old App Service environment is a standby fallback: its app is replaced by a redirect of `novedu.at` to `app.novedu.at`, and its database and file share are NEVER written to — no app, no local boot, no script. Rollback is the documented two-setting switch, only in an emergency.
- The new environment is reached ONLY through the second `az` profile: `AZURE_CONFIG_DIR=~/.htl-azure-novedu az …`, subscription `Novedu`; a local `.env` sets the same variable (absolute path) so the app's `az` credential reaches `novedu_dev`. A command without the variable hits the default profile — the old tenant.
- Device-code login is blocked in that tenant, and `az login` over SSH falls back to it silently: use the tunnelled browser flow from the doc. Tokens and secret values never pass through a Claude session.

### Azure runtime environment → `docs/azure-runtime-env.md`

Read before touching: `scripts/db/provision-stage.*`, any `az` work on `rg-novedu-*`, `.github/actions/deploy-stage/**`, `.github/workflows/promote.yml`, or `docker-publish.yml`'s `deploy-dev` job.

- Both stages run the same image, deployed by the pipeline: every publish goes to dev (`dev.novedu.at`), production (`app.novedu.at`) only via the manual `promote.yml`, which also publishes the teacher guide (built from the promoted image's commit) to the shared Static Web App `swa-novedu-docs` (`docs.novedu.at`). Dev holds a copy of the old environment's data (no chat messages, no credentials) — real student and teacher data, treated like production. `AUTH_URL` must name the stage's custom domain or sign-in breaks.
- Those stages run on SCCH ONLY: never set `AZURE_FOUNDRY_ENDPOINT` / `OPENROUTER_API_KEY` there. The SCCH key is the only secret shared between the stages; every other secret is per stage, in that stage's Key Vault.
- One replica per stage is a HARD limit (dev 0–1, prod exactly 1): the Drizzle migrator takes no lock and `lib/db/pool.ts`'s 20 connections are sized against B1ms's 50.
- No identity of one stage ever holds a right on the other stage's resources or database; Postgres there is Entra-only (password auth disabled) and stage isolation is a privilege (`revoke connect`), not a network rule.

### CI / GitHub Actions security → `docs/ci-security.md`

Read before touching: `.github/workflows/`, or adding a secret / real infra to CI.

- Public teaching repo: fork PRs run untrusted code. `qa.yml` stays secret-free; secrets live only in `docker-publish.yml`'s two image-publishing jobs, `build-and-push` and `build-and-push-demo`.
- Azure deploys (`deploy-dev`, `promote.yml`) are OIDC-only — no stored Azure credential (the docs Static Web App's deployment token is fetched at runtime, never stored); don't widen a federated subject or the `production` environment's `main`-only branches. No job that can obtain the production Azure identity runs `npm ci` or a build.

### Testing → `docs/testing.md`

Read before adding a test or tagging one `@live`, or touching `fake-llm/**` (incl. its `Dockerfile`) or `scripts/ci/compose-smoke.mjs`.

- Prefer fast, secret-free tests; `@live` only when the real DB/LLM/storage is genuinely needed, always with exactly one of `@live-db`/`@live-llm`/`@live-storage`/`@live-telemetry`. CI runs hermetic + `@live-db` only — LLM-backed specs among them run against the fake LLM (`fake-llm/`); `@live-llm` is only for a specific provider or real model behaviour (`npm run test:e2e:live-llm`, local). `@demo` specs run only against a demo build — the Playwright config picks the suite by `NOVEDU_AUTH_MODE` (CI: the `e2e-demo` job).
- Mock the I/O seams, but keep security-critical pure modules (e.g. `lib/thread-token.ts`) real.

### CLI prompt dumps → `docs/cli-prompts.md`

Read before touching: `lib/prompt-dump.ts`, `lib/{quiz,writing,coding,cloze}-resolve.ts`, the prompt builders, `cli/src/commands/prompts.ts`.

- Every dumper CALLS the production builders/loaders — never a copy (grep-guarded in `lib/prompt-dump.unit.test.ts`).
- CLI-bundled `lib/**` must import **nothing** from `app/**`, the DB, or `lib/llm/model.ts`, and carry no `"use server"` — the grep-guard walks the whole transitive closure.
- Changing anything in that bundled closure warrants a CLI release (`docs/cli-publish.md`) — published CLIs carry a frozen copy.

### CLI evals (quiz + tutor) → `docs/cli-eval.md`

Read before touching: `lib/eval-schema.ts`, `lib/eval-validate.ts`, `lib/quiz-feedback-judge.ts`, `lib/tutor-judge.ts`, `cli/src/eval-run.ts`, `cli/src/report-md.ts`, `cli/src/retry.ts`, `cli/src/commands/eval.ts`, `app/api/eval/**`, `app/mastra/eval-agents.ts`, or the fake grader/judge/tutor in `test-fixtures/serve.mjs`.

- The eval file is a discriminated union on `kind`: omitted / `quiz` = golden answers, `tutor` = scripted conversations. The kind is INFERRED from each file — no flag — and a batch may mix them.
- The CLI assembles every prompt OFFLINE (via `dumpPrompts`) and fans out; the teacher-only `POST /api/eval/grade` grades exactly ONE answer and `POST /api/eval/respond` generates exactly ONE tutor turn per request — stateless, nothing persisted. Access model: see the security block.
- The **judge** REPORTS and never gates for BOTH kinds (a flag changes no exit code), and DEGRADES rather than aborting when the judge model fails. `POST /api/eval/judge` is kind-agnostic — both prompts and the criteria arrive in the body — so a further eval kind reuses it with no server change.
- The tutor kind's exit code reflects **run health only** (invalid files, `errored`, `skipped`); the Markdown report is the deliverable.

### CLI publishing → `docs/cli-publish.md`

Read before touching: `cli/package.json`, `.github/workflows/publish-cli.yml`, changing CLI-bundled `lib/**` code, or cutting a CLI release.

- Publishes as `@novedu/cli` via OIDC trusted publishing on a `cli-v*` tag — no `NPM_TOKEN`; the tag must match `cli/package.json`.
- A change to CLI-bundled `lib/**` (validators, prompt builders, schemas) is release-worthy even with no `cli/` diff: bump `cli/package.json` and publish, or teachers keep running the old code (`docs/cli-publish.md`).

### Teacher docs & docs site → `docs/teacher-docs.md`

Read before touching: `teacher-docs/**`, `.agents/skills/novedu-teacher-docs/**`.

- `teacher-docs/src/content/docs/` is the **human-owned source of truth** — edit chapters directly (by hand or via the `novedu-teacher-docs` skill); read the chapter's entry in `docs/teacher-docs-notes.md` before editing; keep chapters current by reasoning over the git diff with `teacher-docs/CHAPTERS.md` as the map.
- The corpus is authoritative and site-agnostic; the site adapts to it, never modifies it, and ships publicly at `docs.novedu.at` (an Azure Static Web App, released by `promote.yml`) — HTML pages plus the llms.txt surface (`llms.txt`, `llms-full.txt`, per-chapter `.md` twins).
- A new corpus section directory must be declared in `teacher-docs/CHAPTERS.md` **and** `teacher-docs/src/lib/sections.ts` — the site build throws on an undeclared one.
