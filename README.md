<picture>
  <source media="(prefers-color-scheme: dark)" srcset="novedu-brand-assets/svg/novedu-n-and-text-light.svg">
  <img src="novedu-brand-assets/svg/novedu-n-and-text.svg" alt="Novedu" width="320">
</picture>

# Novedu

A prototype web app for **YAML-defined AI learning activities**. A teacher authors an
activity as YAML (hosted on a public URL or in-app), mints a short **code** for it, and
hands out `https://<host>/<code>`; a student opens the code and the app renders the right
experience for that activity's **module**. The activity — persona, rules, model, questions,
prompt — comes from the YAML, not from the app.

Four modules share one generic "codes" pipeline (access, storage, attribution):

- **tutor** — a chat with an LLM configured entirely by a *tutor-definition YAML*.
- **quiz** — LLM-graded open-ended questions, with an opt-in follow-up discussion chat; questions can let students answer with photos (`imageInput`, e.g. handwritten work). The grader is server-only.
- **writing** — a split-screen Markdown editor where an AI assistant gives feedback (it can *read* the draft but never edit it) and the student saves their text.
- **coding** — an OpenAI-compatible Chat Completions endpoint an external coding agent (e.g. little-coder) points at; each student mints a personal API key on the code's page and uses it as the bearer key, and the teacher's system prompt + model are injected server-side.

All four kinds share **prompt fragments** — reusable, parameterized system-prompt pieces (persona, safety, ground rules) assembled from **fragment libraries**. Written once, they are pulled into any activity and prepended to its instructions (for a quiz, to both the grader and the discussion chat). See [`docs/prompt-fragments.md`](docs/prompt-fragments.md).

Students can voluntarily **report** an AI interaction — a chat or a graded quiz answer — with a reaction and an optional note; teachers triage the reports in the `/reports` inbox or via the CLI. See [`docs/reports.md`](docs/reports.md).

It is a prototype: access is gated behind Microsoft Entra ID sign-in, and agent memory/storage is persisted to
Azure Database for PostgreSQL (authenticated via Entra — no password required).

It runs in two stages on Azure Container Apps: **production** at `https://app.novedu.at`
(the latest stable release, for activities used in class) and **dev** at
`https://dev.novedu.at` (every merge to `main`, for trying new features and activities).
The public teacher guide lives at `https://docs.novedu.at` (an Azure Static Web App,
updated with each promotion to production).
See [`docs/azure-runtime-env.md`](docs/azure-runtime-env.md).

## What's in here

| Area | Description |
| --- | --- |
| **Next.js 16 app** (`app/`) | App Router UI. `app/page.tsx` is the start page — by effective role a student's code field, progress and badges, or a teacher's dashboard over their own codes ([`docs/home.md`](docs/home.md)); students and teachers set their preferences on `/settings`; `app/[code]/page.tsx` checks the code and **dispatches by its `module`** to the tutor/quiz/writing/coding renderer. Teachers create, list, and edit **codes** under `/codes` (new at `/codes/new`, edit at `/codes/edit/<code>`), author **app-hosted YAML files** under `/files` and **images** under `/images`, triage **student reports** under `/reports` ([`docs/reports.md`](docs/reports.md)), and see usage on the `/usage` dashboard. See [`docs/codes.md`](docs/codes.md). Lists filter in the DB — see [`docs/filtered-lists.md`](docs/filtered-lists.md). |
| **Prompt-fragment core** (`lib/prompt-fragments/`) | The shared, framework-agnostic pipeline every activity kind builds on: fetch → parse YAML → Zod schema-validate → consistency-check → assemble with Handlebars. `assembleFragmentPrompt` resolves a document-level fragment block into a prompt string (a structured result, never throws); tutor, quiz, writing, and coding all call it. Handlebars is confined to this module (grep-guard enforced). Fragment files can be referenced by absolute `http(s)` URL or by a path **relative** to the activity YAML, and fragment inputs may declare **defaults**. See [`docs/prompt-fragments.md`](docs/prompt-fragments.md) and [`activities/tutors/README.md`](activities/tutors/README.md) (the authoring guide). |
| **Mastra agents** (`app/mastra/`) | The `tutor`, `quizDiscussion`, and `writing` agents resolve their instructions + model per request and persist conversations via Mastra `Memory`; the server-only `quizEvaluator` grader and the eval agents `evalJudge` + `evalTutor` are never web-reachable by students (their only web callers are the teacher-only `/api/eval/*` routes). Agents are registered in `app/mastra/index.ts`. Storage is **Azure Database for PostgreSQL** via `@mastra/pg`, on the app's one shared pool, authenticated with Microsoft Entra ID (`az login` locally, Managed Identity on Azure). (The `coding` module has **no** Mastra agent — it is a thin proxy.) |
| **CopilotKit + AG-UI** | The chat UI is CopilotKit (`@copilotkit/react-core/v2`). Mastra agents are served to it through the AG-UI route handler at `app/api/copilotkit/[[...slug]]/route.ts`. See [`docs/chat.md`](docs/chat.md). |
| **Coding proxy** (`app/api/coding/**`, `lib/coding-proxy.ts`, `lib/coding-key-store.ts`) | A **public**, OpenAI-compatible `POST /api/coding/v1/chat/completions` (plus `GET /api/coding/v1/models` as the sanctioned key-validity check) that authenticates with a **per-user API key** minted on the code's page (`novedu_coding_keys`; key row + code row re-verified on every request), appends the teacher's system prompt, pins the model, and streams the upstream's response straight back. See [`docs/coding.md`](docs/coding.md). |
| **Images** (`app/images/**`, `lib/image-*.ts`) | Teacher-uploaded images stored under a configured filesystem root (`IMAGE_STORAGE_ROOT` — an Azure Files mount in production), streamed through the app on upload and served through the app's own cookie-session route `GET /api/image-content/<id>` — no signed URL of any kind, no direct-to-storage traffic. See [`docs/images.md`](docs/images.md). |
| **Usage metering** (`lib/usage-store.ts`, `app/mastra/usage-exporter.ts`) | Per-hour token / tool-call / activity counts written off the response path into two anonymity-preserving tables (`novedu_usage_by_code`, `novedu_usage_by_user`), surfaced on the teacher `/usage` dashboard. See [`docs/usage-metering.md`](docs/usage-metering.md) and [`docs/dashboard.md`](docs/dashboard.md). |
| **LLM providers** (`lib/llm/`, `app/mastra/scch.ts`, `lib/scch-endpoint.ts`) | Three OpenAI-compatible upstreams behind one server-only seam: a self-hosted vLLM GPU server ("SCCH", the default) plus two optional ones — **Azure Foundry** when `AZURE_FOUNDRY_ENDPOINT` is set (passwordless Entra auth, no API key) and **OpenRouter** when `OPENROUTER_API_KEY` is set. The activity YAML's `llm:` block picks provider + model + an optional reasoning level, and a code can override the whole block; endpoints, keys, and tokens stay server-side. See [`docs/ai-models.md`](docs/ai-models.md). |
| **Auth** (`auth.ts`, `proxy.ts`, `lib/api-auth.ts`) | **better-auth** with Microsoft Entra ID as the sign-in provider (the gate is `proxy.ts`, Next 16's name for middleware, which checks only for a session cookie). Any signed-in user passes the gate; teacher-only operations are gated by `TEACHER_GROUP_ID` membership (`session.user.isTeacher`), enforced server-side via `requireEffectiveTeacher()` (which honors "view as student" mode). Sessions are database-backed (`novedu_session`, no cookie cache). See [`docs/auth.md`](docs/auth.md). A second, cookie-free channel serves CLI/API clients: the same **session token as a bearer**, obtained by the CLI's own OAuth device flow, validated on every request by `lib/api-auth.ts` (`requireBearerUser` / `requireBearerTeacher`; no student mode on this channel). See [`docs/api.md`](docs/api.md). |
| **Teacher docs** (`teacher-docs/`) | The teacher-facing guide as a **hand-maintained Markdown corpus** (`teacher-docs/src/content/docs/` — human-owned chapters, kept current from code changes by hand or via the `novedu-teacher-docs` skill) and an **Astro Starlight site** that renders it (the rest of `teacher-docs/`, an npm workspace) — as HTML pages plus an [llms.txt](https://llmstxt.org) surface for AI agents (`/llms.txt`, `/llms-full.txt`, and a `.md` twin of every chapter). Served **publicly at `https://docs.novedu.at`** from an Azure Static Web App, released by `promote.yml` from the promoted image's commit; the app 308-redirects `/docs/*` there. `npm run docs:dev` for local authoring; the corpus-contract test + site build are the consistency checks. See [`docs/teacher-docs.md`](docs/teacher-docs.md). |
| **API routes** (`app/api/`) | `copilotkit` (chat runtime), `coding/v1/chat/completions` + `coding/v1/models` (**public** OpenAI-compatible endpoints, per-user API key auth), `files/<name>` (**public** GET: serve an app-hosted YAML file as raw text; **bearer** PUT: upsert for `novedu-cli files upload`), `files` + `codes` (**bearer**, teacher-only: list/create/sync for the CLI — see [`docs/api.md`](docs/api.md)), `images` + `images/<name>` (**bearer**, teacher-only: image upload/list for the CLI), `eval/grade` + `eval/judge` + `eval/respond` (**bearer**, teacher-only: stateless one-shot grading / judging / tutor turns for `novedu-cli eval`), `reports` + `reports/<id>` + `reports/resolve` (**bearer**, teacher-only: report triage for the CLI; a chat report's detail embeds the conversation transcript), `auth` (sign-in), `me` (**bearer-token** identity probe backing `novedu-cli whoami`), `version` (public build-identity probe), `health` (teacher-gated probe). |

### Request flow

1. User signs in via Microsoft Entra ID (enforced by `proxy.ts`).
2. A teacher creates a **Code** on `/codes/new` (module + activity YAML + availability
   window + note, stored in the `novedu_codes` SQL table) and hands out
   `https://<host>/<code>`.
3. A student opens `/<code>` (or types the code on `/`); the server checks the stored
   row + window and renders the experience for the code's `module` (tutor chat, quiz
   runner, writing editor, or the coding connection details).
4. In-app chat (tutor / quiz discussion / writing) sends the code on the **`x-code`**
   header to `/api/copilotkit`, which re-checks it on every request, dispatches to the
   module's agent, and scopes Mastra memory by the code (`resourceId`). A per-student
   **`x-thread-token`** HMAC binds each thread to its owner. See [`docs/codes.md`](docs/codes.md).
5. The **coding** module has no in-app chat: the student mints a personal API key on
   the code's page, and an external agent calls `POST /api/coding/v1/chat/completions`
   with that key as its bearer token. See [`docs/coding.md`](docs/coding.md).

## Try Novedu locally (Docker Compose)

To look around without an Entra app registration, a model endpoint or a clone of
this repo, download [`compose.yaml`](compose.yaml) and run it with Docker:

```bash
curl -fsSLO https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/main/compose.yaml
docker compose up -d --wait
```

Then open `http://localhost:3000` and pick one of the four demo people — two teachers,
two students. The stack is the **`:demo` image** (the demo login, "Demo login and the
`:demo` image" below), a Postgres database of its own, and Novedu's **fake LLM**: every
chat reply says that it comes from a fake model and echoes what you wrote, so the flows
work but the answers are not real.

- **It is not for production.** Anyone who can reach the app can sign in as anyone, and
  the passwords in the file are public. All ports are published on `127.0.0.1` only;
  never expose the stack to a network, and use sample data only.
- **The CLI** works against it: `npx @novedu/cli@latest login --server http://localhost:3000`.
- **A real model:** set `OPENROUTER_API_KEY` before `docker compose up` (or put it in a
  `.env` file next to `compose.yaml`) and put `provider: OpenRouter` and an OpenRouter
  model id in an activity's `llm:` block, or in a code's LLM override
  ([`docs/ai-models.md`](docs/ai-models.md)). Activities without a provider stay on the
  fake.
- **Run from a clone,** Compose reads the repo's own `.env` for the `${…}` values in
  `compose.yaml`: a personal `OPENROUTER_API_KEY` or `AUTH_SECRET` there reaches the
  demo app too. Entra settings in `.env` never do — `compose.yaml` does not reference
  them.
- **Ports and images:** `NOVEDU_PORT` (app, 3000), `NOVEDU_PG_PORT` (Postgres, 5432) and
  `NOVEDU_FAKE_LLM_PORT` (fake LLM, 4010) move the published ports; `NOVEDU_IMAGE` and
  `NOVEDU_FAKE_LLM_IMAGE` replace the images (e.g. a local `docker build`).
- **Apple silicon:** the app image is amd64-only and runs under emulation — slower to
  start, otherwise the same.
- **Reset:** `docker compose down -v` deletes the database and the uploaded images.

## Prerequisites

- **Node.js 24+** (developed against v24.15).
- A reachable **OpenAI-compatible model endpoint** (the SCCH vLLM server) for activity chats.
  **Optional:** an **Azure Foundry** resource (passwordless Entra) and/or an
  **OpenRouter** API key as additional providers — see
  [`docs/ai-models.md`](docs/ai-models.md).
- A **Microsoft Entra ID app registration** for sign-in.
- An **Azure Database for PostgreSQL** server for persistent agent memory/storage,
  with your Entra identity granted a database role (the app authenticates via Entra —
  no password). Locally that identity is your `az login`; on Azure it is the app's
  Managed Identity. (A password-carrying `DATABASE_URL` also works as a
  **dev/test-only** fallback for environments without Entra — see
  [Storage](#notes--caveats-prototype) below — but **production always uses
  passwordless Entra**.)
- **Optional:** a writable directory for the app-hosted image subsystem
  (`IMAGE_STORAGE_ROOT`) — any ordinary filesystem path works; production mounts
  an Azure Files share there, but the app itself has no Azure Storage dependency.

## Configuration (`.env`)

Create a `.env` file in the project root with the following keys. **None of these are
exposed to the browser** — they are read only in server-side modules.

```bash
# --- Self-hosted vLLM (OpenAI-compatible) endpoint that serves activity chat models ---
SCCH_BASE_URL=https://your-vllm-host/v1
SCCH_API_KEY=your-vllm-api-key

# --- Azure Foundry (optional) — second LLM provider ---
# Bare resource endpoint of an Azure OpenAI / Foundry resource. Unset => the app
# runs without it (Foundry activities are rejected at authoring time and guarded at
# runtime). Auth is passwordless Entra — your `az login` identity locally, the
# Managed Identity on Azure; there is NO API key. See docs/ai-models.md.
AZURE_FOUNDRY_ENDPOINT=https://your-foundry-resource.cognitiveservices.azure.com

# --- OpenRouter (optional) — third LLM provider ---
# The key alone makes the provider configured. Unset => the app runs without it
# (OpenRouter activities are rejected at authoring time and guarded at runtime).
OPENROUTER_API_KEY=your-openrouter-api-key
# Optional override of the OpenAI-compatible base URL (a proxy, a self-hosted
# gateway). It already includes /v1. Default: https://openrouter.ai/api/v1
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# --- Quiz immediate feedback (optional, experimental) ---
# A case-insensitive `true` turns on the live hint pill shown while a student types
# a quiz answer. Requires OPENROUTER_API_KEY (the classifier rides that key): set
# without it, the app logs one warning at boot and the feature stays off. Not
# metered. See docs/codes.md, "Immediate feedback".
# QUIZ_IMMEDIATE_FEEDBACK=true

# --- Microsoft Entra ID sign-in (better-auth) ---
AZURE_TENANT_ID=your-entra-tenant-id
AZURE_CLIENT_ID=your-entra-app-client-id
AZURE_CLIENT_SECRET=your-entra-app-client-secret

# Signs the session cookie/token and derives the thread-ownership HMAC key
# (lib/thread-token.ts). Generate one with:
#   openssl rand -base64 32
AUTH_SECRET=your-generated-secret

# Object id of the Entra group whose members are treated as teachers
# (gates teacher-only operations such as creating codes). Tenant-specific
# configuration, not a secret. Required — the app fails to start without it.
TEACHER_GROUP_ID=your-entra-teacher-group-object-id

# --- Postgres (Azure Database for PostgreSQL) — Mastra memory + app tables (novedu_*) ---
# A postgresql:// URL. Required to chat — codes and the agents' memory live in this
# database. The app picks the auth mode from the URL itself:
#   * Omit the password to use passwordless Microsoft Entra auth (your `az login`
#     identity locally, the app's Managed Identity on Azure) — an Entra access token
#     is fetched and used as the password on every new connection. ← USE THIS IN
#     PRODUCTION. Developers log in under the admin group's name `novedu-dev` against
#     the dev stage's database (docs/database.md); the stages use their identity names
#     ca-novedu-dev / ca-novedu-prod.
#   * Include a password (`postgresql://user:pw@host/db`) for classic password auth —
#     a DEV/TEST/CI-ONLY fallback for environments that can't do Entra (e.g. a remote
#     coding agent, a CI service container). NEVER use a password in a production URL.
#   * Any `sslmode` other than `disable` (e.g. `sslmode=require`) turns on TLS with
#     certificate verification (needed for Azure; a local container typically omits it).
#
# Passwordless (Entra), against the dev stage's database on Azure (needs a firewall
# rule for your IP and AZURE_CONFIG_DIR below):
# DATABASE_URL=postgresql://novedu-dev@psql-novedu.postgres.database.azure.com/novedu_dev?sslmode=require
#
# Password auth, against a local container (dev/test only):
DATABASE_URL=postgresql://postgres:Test-Passw0rd!@localhost:5432/novedu
# Entra tenant of the Postgres server, used for the local `az login` credential. Only
# relevant on the Entra path (ignored when the URL carries a password). A SEPARATE
# setting from AZURE_TENANT_ID above (the user sign-in tenant), even though both name
# the same tenant. Optional — if unset, the az credential uses its ambient default
# tenant.
STORAGE_TENANT_ID=your-data-store-tenant-id
# The az profile the local `az login` credential uses — the new environment's profile,
# as an ABSOLUTE path (.env does not expand `~`; docs/azure-access.md). Entra path only.
# AZURE_CONFIG_DIR=/home/<you>/.htl-azure-novedu

# --- Public origin ---
# Public origin the generated code URLs (`https://<origin>/<code>`) and the coding
# endpoint's connection snippet point at, e.g. https://novedu.example.org
# RECOMMENDED IN PRODUCTION: without it the origin is derived from the request's
# x-forwarded-host/-proto headers, which is only as reliable as the proxy chain
# (and falls back to http://). Optional for local dev (localhost works). Display-only:
# a code works on ANY origin that talks to the same database.
# (TUTOR_CODE_ORIGIN is read as a fallback name.)
CODE_ORIGIN=https://your-public-origin

# --- Images (optional) — filesystem root for teacher-uploaded images ---
# An absolute directory path OUTSIDE the repo (never e2e/.image-root — the
# Playwright harness wipes that on every run). The app streams upload bytes into
# this directory and serves them back itself; it never creates the directory or
# its sentinel file, so run `npm run images:init-root` once against it before
# using the Images page. Unset => the app boots with a warning and every image
# operation reports "unavailable" until this is set. See docs/images.md.
IMAGE_STORAGE_ROOT=/absolute/path/outside/the/repo

# --- Telemetry (optional) — OpenTelemetry, one of two backends (docs/telemetry.md) ---
# Neither variable set => telemetry is fully OFF (no SDK, no exporter, no network
# sink). NO message/prompt/PII content is ever sent on either backend.
#
# Standard OTLP export — selects the standard path. Point it at any OTLP receiver;
# locally that is the Aspire dashboard from `docker compose -f compose.telemetry.yaml up -d`.
# Every other OTEL_* variable is the SDK's own (protocol, headers, sampler, …).
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
# Azure Monitor / Application Insights — selects the Azure path, but ONLY when the
# OTLP endpoint above is unset (OTLP wins when both are present). This is a
# SECRET — keep it out of the repo and CI.
# APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=...;IngestionEndpoint=...
# The service name on either backend (App Insights cloud_RoleName). Defaults to
# novedu-chat on the OTLP path when unset.
OTEL_SERVICE_NAME=novedu-chat
```

Notes:

- The app **fails fast at startup** if any required sign-in variable is missing — the
  `AZURE_*` Entra credentials, `TEACHER_GROUP_ID`, and `AUTH_SECRET` (`auth.ts`).
- If `SCCH_BASE_URL` / `SCCH_API_KEY` are unset, the app still starts but no SCCH chat
  models are available (a warning is logged).
- `AZURE_FOUNDRY_ENDPOINT` and `OPENROUTER_API_KEY` are **optional**: the app boots
  without either. Activities naming an unconfigured provider are rejected at
  authoring time and gated at runtime with a readable reason, never a raw
  missing-env error (`docs/ai-models.md`). `/health` shows a provider's rows only
  when it is configured.
- `QUIZ_IMMEDIATE_FEEDBACK` is **optional and off by default**: only a
  case-insensitive `true` together with `OPENROUTER_API_KEY` shows the live hint
  pill (icon + label) beside a quiz answer box, and a quiz may still switch it off with
  `immediate_feedback: false`. The hint is a quick check, never the grade, and its
  calls are not metered. See `docs/codes.md` ("Immediate feedback").
- Telemetry is **optional** and off unless a destination is set:
  `OTEL_EXPORTER_OTLP_ENDPOINT` selects standard OTLP export (Aspire locally, any
  receiver or Collector elsewhere), `APPLICATIONINSIGHTS_CONNECTION_STRING` selects
  Azure Monitor / App Insights; OTLP wins when both are set, and
  `OTEL_SDK_DISABLED=true` switches everything off. No conversation content is ever
  sent. See `docs/telemetry.md`.
- `IMAGE_STORAGE_ROOT` is **optional but expected in every developer's `.env`**:
  unset (or unprovisioned) means the app still boots, logs a warning, and the
  `/images` upload/list surface reports "unavailable" until it is set AND
  `npm run images:init-root` has been run against it once. The app never creates
  the directory or its sentinel itself. See `docs/images.md`.
- `DATABASE_URL` is **required to chat**: codes and the agents' memory live in the
  database, so creating/opening an activity fails if it is unset (the rest of the app
  still boots; activity validation without the app is the CLI's `validate` command).
  When set, the app's own `novedu_*` tables are migrated by Drizzle at startup and
  Mastra's `mastra.*` tables are created right after (`instrumentation.ts`), so the
  configured role needs `CREATE` on the `public` and `mastra` schemas and must own the
  tables it creates — see `docs/database.md` ("Privilege model").
- Schema changes to the `novedu_*` tables: edit `lib/db/schema.ts`, run
  `npm run db:generate`, and commit the generated migration in `drizzle/`.
- Codes are **not** garbage-collected: a code and all of its conversation data persist
  until a teacher deletes it on `/codes`. An expired code stays listed (its activity no
  longer opens, but its stats remain reachable). See `docs/codes.md`.
- In your Entra app registration, add the redirect URI
  `http://localhost:3000/api/auth/callback/microsoft` (and the equivalent for any
  deployed origin).

### Changing the public domain

The public origins are deliberately **not** a single constant — most of these are
deployment settings rather than code. The app domain and the teacher guide's docs
domain are independent; the rows marked **Docs domain** belong to the latter, all
others to the app. Moving a domain therefore means touching all of its rows:

| Where | What it controls |
| --- | --- |
| `AUTH_URL` — environment variable of each stage's container app, **not in the repo** | better-auth's `baseURL` and trusted origin (unset locally — better-auth infers the base URL from the request instead). Also what makes the session cookie carry the `__Secure-` prefix under https (`__Secure-novedu.session_token`). Sign-in breaks if it still names the old domain. |
| Entra app registration redirect URI | The callback URL for the new origin (see the bullet above). |
| `CODE_ORIGIN` — env / app setting | Origin shown in generated code URLs (`https://<origin>/<code>`) and in the coding endpoint's connection snippet; read by `lib/app-origin.ts` (`TUTOR_CODE_ORIGIN` is read as a fallback name). Display-only — falls back to the request's `x-forwarded-host`. |
| `cli/src/server-url.ts` → `DEFAULT_SERVER` | The CLI's default server. A *default* only: `--server` and `NOVEDU_SERVER` override it per invocation. |
| `teacher-docs/astro.config.mjs` → `site` | **Docs domain.** Canonical origin baked into the teacher guide's `llms.txt` links, sitemap and canonical tags (build-time). |
| `lib/teacher-guide.ts` → `TEACHER_GUIDE_URL` | **Docs domain.** The app's links to the guide (nav menu, environment ribbon) and the target of the `/docs/*` redirects in `next.config.ts`. |
| `cli/src/main.ts` → `DOCS_URL` | **Docs domain.** The guide URLs in the CLI's help text. |
| `swa-novedu-docs` custom domain + DNS CNAME | **Docs domain.** The Static Web App's hostname (`docs/azure-runtime-env.md`). |
| `novedu_codes.file_url` rows | App-hosted YAML URLs are stored absolute and served from the app's own database only when they start with `CODE_ORIGIN`; a stage whose hostname changes needs them rewritten (`docs/azure-runtime-env.md`). |
| Stage GitHub variables `DEV_BASE_URL` / `PROD_BASE_URL` | The URL the deploy step polls for the new version (`docs/azure-runtime-env.md`). |

`grep -rn 'novedu\.at'` finds every in-repo occurrence, including the docs prose and
test fixtures that only mention it as an example.

## Running the app

```bash
# 1. Install dependencies
npm install

# 2. Create .env (see Configuration above)

# 3. Start the dev server
npm run dev
```

Then open **http://localhost:3000**, sign in with Microsoft Entra ID, and — as a teacher —
create a code on `/codes/new` (see `activities/` for samples).

### Production build

```bash
npm run build
npm run start
```

### Demo login and the `:demo` image

Without an Entra app registration, run a **demo build**: the sign-in page offers two
demo teachers and two demo students, one click each, and a ribbon on every page says
that anyone who can reach the instance can sign in as anyone — use sample data only.
From source, put `NOVEDU_AUTH_MODE=demo` in `.env.local` together with empty
`AZURE_CLIENT_ID=`, `AZURE_CLIENT_SECRET=`, `AZURE_TENANT_ID=` and `TEACHER_GROUP_ID=`
lines and a `DATABASE_URL` naming a database of its own (a demo build refuses a database
that ever had a Microsoft sign-in, and an Entra build refuses a demo database), then
restart `npm run dev` — the mode is fixed when the server starts. The published Docker
image also comes as **`rstropek/novedu-chat-mvp:demo`** (and `:<version>-demo`): the
same app built in demo mode, which the image can never leave. It needs only
`DATABASE_URL` (password auth), `AUTH_SECRET`, `AUTH_URL` (the address visitors open,
e.g. `http://localhost:3000` — without it the browser's sign-in fails the origin check)
and the LLM settings, and refuses to start with any Entra setting or a `novedu.at`
`AUTH_URL`. [`compose.yaml`](compose.yaml) runs it with all of that set ("Try Novedu
locally" above). See [`docs/auth.md`](docs/auth.md), "Demo mode".

For `npm run dev` without Azure, start only the infrastructure from `compose.yaml` —
its Postgres and the fake LLM — and point `.env.local` at it:

```bash
docker compose up -d --wait postgres fake-llm
```

```bash
# .env.local — wins over .env
NOVEDU_AUTH_MODE=demo
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_TENANT_ID=
TEACHER_GROUP_ID=
# Any random string of 32+ characters, for example from `openssl rand -base64 32`.
AUTH_SECRET=your-random-secret
# Port 5432 unless NOVEDU_PG_PORT moves it.
DATABASE_URL=postgresql://novedu:novedu-demo-not-a-secret@localhost:5432/novedu
SCCH_BASE_URL=http://127.0.0.1:4010/v1
SCCH_API_KEY=fake-llm
# Provision it once with `npm run images:init-root -- <the same path>`.
IMAGE_STORAGE_ROOT=/absolute/path/outside/the/repo
```

That database is a demo database (an Entra build refuses it), and it is the same one the
full stack's app uses. Start the infrastructure before `npm run dev` — the app lists the
fake's models once at boot.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the Next.js dev server. |
| `npm run build` / `npm run start` | Production build / serve. |
| `npm run check` | Biome lint + format check. (`check:fix` to auto-fix.) |
| `npm run lint` / `npm run format` | Biome lint only / format-write only. |
| `npm run typecheck` | All three workspaces: `tsc --noEmit` (app) + `tsc -p cli` + `astro check` (docs site). |
| `npm run test` | Vitest (unit + component). (`test:unit` / `test:component` for one project.) |
| `npm run test:e2e` | Playwright end-to-end tests against the fake LLM (all specs except `@live-llm`). |
| `npm run test:e2e:ci` | Hermetic + `@live-db` (against a Postgres container and the fake LLM); skips `@live-llm`, `@live-storage` and `@live-telemetry`. (`test:e2e:db` / `test:e2e:storage` run one live group.) |
| `npm run test:e2e:live-llm` | The `@live-llm` specs against the real providers in `.env`. |
| `npm run db:generate` | Generate a Drizzle migration after editing `lib/db/schema.ts` (commit the result in `drizzle/`). |
| `npm run qa` | `check` + `typecheck` + `test` + `test:cli` + `build` + `docs:build`. (`qa:e2e` adds the e2e suite.) |
| `npm run docs:dev` | Serve the teacher guide locally at `:4321/` (Astro Starlight; `docs:build` / `docs:preview` for the static build). |
| `npm run cli` | Run the `@novedu/cli` companion CLI (workspace under `cli/`): `validate` activity YAML, `prompts` to dump the exact LLM prompts an activity produces, `eval` to run quiz/tutor evals, `login` / `logout` / `whoami` to sign in, and the teacher management commands `codes create/list/sync`, `files upload/list`, `images upload/list`, and `reports list/show/resolve` (JSON in/out) against the app's bearer-protected APIs. |

> Use the `dev` / `build` npm scripts rather than invoking `next` or `mastra` directly.

> Testing layers, the `@live-db` / `@live-llm` / `@live-storage` split (and how DB-backed
> live tests run in CI against a Postgres container), and the patterns for testing the
> chat gate without a database or LLM are documented in [`docs/testing.md`](docs/testing.md).

## Activities

The `activities/` directory contains sample YAML for each module — `tutors/`, `quizzes/`,
`writings/`, and `coding/` — each with its own `README.md` authoring guide (see also
[`activities/README.md`](activities/README.md)). The `@novedu/cli` package (`cli/`) validates
an activity file with the exact checks the app enforces, dumps the prompts an activity
produces (`prompts`), runs evals against golden answers or scripted conversations
(`eval`), signs in (`login` / `logout` / `whoami` — `login` prints a link to open and
approve in the browser), and lets teachers
manage the app over its bearer-protected APIs — `codes create/list/sync`,
`files upload/list`, `images upload/list`, and
`reports list/show/resolve`, JSON in/out
(`npm run cli` locally; published as `@novedu/cli` — see [`docs/api.md`](docs/api.md) and
[`cli/README.md`](cli/README.md)).

## Related projects

This repository is the **server side** of Novedu — where teachers author activities and
students connect. A companion repository provisions the **student coding environments**
that consume the [`coding`](docs/coding.md) module:

- **[`novedu-dev-venv-generator`](https://github.com/Teaching-HTL-Leonding/novedu-dev-venv-generator)**
  (`vcoding-env`) — one idempotent `deploy.sh` spins up *N* disposable, browser-based Azure
  VMs, each running [code-server](https://github.com/coder/code-server) (VS Code in the
  browser) plus the [pi.dev](https://pi.dev) coding agent. The agent is pre-wired to this
  app's coding endpoint (`POST /api/coding/v1/chat/completions`), authenticating with a
  per-user API key minted for the activity **Code**, so a student's in-browser agent codes
  against the teacher's chosen model and system prompt — no local setup.

**Typical workflow:** a teacher creates a `coding` **Code** here (`/codes/new`), then runs
`./deploy.sh <CODE>` in the generator to hand each student a ready-to-hack browser IDE whose
coding agent talks back to this activity. The two repos are the server and client halves of
the same coding-workshop flow.

## Documentation

Per-subsystem deep references live in [`docs/`](docs/): codes & modules
([`codes.md`](docs/codes.md)), the start page, achievements, saved quiz results and
Settings ([`home.md`](docs/home.md)), the registry and `codes sync`
([`registry.md`](docs/registry.md)), tutor tools ([`tutor-tools.md`](docs/tutor-tools.md)),
CLI prompt dumps and evals ([`cli-prompts.md`](docs/cli-prompts.md),
[`cli-eval.md`](docs/cli-eval.md)), LLM diagnostics ([`diagnostics.md`](docs/diagnostics.md)),
the Azure stages ([`azure-runtime-env.md`](docs/azure-runtime-env.md),
[`azure-access.md`](docs/azure-access.md)), the shared [`prompt-fragments.md`](docs/prompt-fragments.md),
[`writing.md`](docs/writing.md), [`coding.md`](docs/coding.md), student reports
([`reports.md`](docs/reports.md)),
the chat surface ([`chat.md`](docs/chat.md)), app-hosted [`files.md`](docs/files.md) and
[`images.md`](docs/images.md), usage [`usage-metering.md`](docs/usage-metering.md) +
[`dashboard.md`](docs/dashboard.md), [`auth.md`](docs/auth.md), the CLI/API bearer
channel ([`api.md`](docs/api.md)), LLM providers ([`ai-models.md`](docs/ai-models.md)),
[`database.md`](docs/database.md), [`telemetry.md`](docs/telemetry.md),
[`testing.md`](docs/testing.md), [`filtered-lists.md`](docs/filtered-lists.md),
[`styling.md`](docs/styling.md), the student YAML GUI module
([`yaml-gui-student-contribution.md`](docs/yaml-gui-student-contribution.md)),
CI security ([`ci-security.md`](docs/ci-security.md)), CLI publishing
([`cli-publish.md`](docs/cli-publish.md)), and the
teacher guide corpus + docs site ([`teacher-docs.md`](docs/teacher-docs.md)).
`AGENTS.md` is the slim router that ties them together.

## Notes & caveats (prototype)

- **Storage** — Mastra memory/storage is persisted to Azure Database for PostgreSQL
  (`@mastra/pg`, on the app's one shared pool). The `DATABASE_URL` drives the auth
  mode: classic password auth when the URL carries a password, otherwise passwordless
  Microsoft Entra auth (an Entra access token used as the password, via an explicit
  `az login`/Managed Identity credential chain; tokens are fetched and auto-refreshed
  per new connection). **When to use which:** production is **always** passwordless
  Entra (no secret in the URL); password auth is a **dev/test/CI-only** fallback for
  environments that can't do Entra (e.g. a remote coding agent or CI service
  container). Never put a password in a production `DATABASE_URL`. The chat agents'
  memory requires this store, so `DATABASE_URL` must be set to chat — there is no
  in-memory fallback. Memory is scoped by **code**: the code is the Mastra
  `resourceId`, so every thread is grouped under it. A user↔chat link is written to
  `novedu_user_chats` **only** for activities that opt out of anonymity
  (`anonymous: false`); the default is module-specific (tutor/quiz default anonymous,
  writing does not). See `docs/codes.md`. Three sanctioned exceptions record a user
  beside a code, each behind an explicit on-page notice: a voluntary **report** always
  records the reporter (`docs/reports.md`), a **coding key** records its holder
  (`docs/coding.md`), and a student's **saved quiz result**, stored only on their own
  choice and read only by them (`docs/home.md`). Full mechanics —
  the credential chain, the one shared pool, the privilege model — are in
  `docs/database.md`.
- **Anonymity & metering** — usage is metered into two independent hourly tables that
  never link a user to a code (`usage_by_code` has no user, `usage_by_user` has no code),
  so the anonymity invariant holds even though the runtime knows the user id. See
  `docs/usage-metering.md`.
- **SSRF** — validating an activity (saving a file, minting a code) fetches
  teacher-supplied URLs server-side. The prototype only restricts the scheme to
  `http(s)`; a production deployment should also allow-list hosts, block private IP
  ranges, and disable redirects.
- **Authorization** — the Entra gate admits any signed-in user, but teacher-only
  operations (creating/listing codes, authoring files/images, the
  usage dashboard, the teacher dashboard on `/`) are gated by membership in `TEACHER_GROUP_ID`, surfaced as
  `session.user.isTeacher` and enforced server-side via `requireEffectiveTeacher()`
  (`lib/student-mode.ts`, which also honors "view as student" mode). The public coding
  endpoints instead authenticate with a per-user API key (`docs/coding.md`). The public teacher
  guide is a separate static site (`docs/teacher-docs.md`). See `docs/auth.md`.
