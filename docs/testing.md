# Testing strategy

Deep reference for how this repo is tested. The always-on rule is summarized in
`AGENTS.md`; this file has the full picture. Read it before adding a test,
tagging one `@live`, or changing the CI test jobs.

## Principle

Prefer fast, deterministic, **secret-free** unit/component tests that run in CI.
Reserve full-stack e2e for what genuinely needs the real wired-together app. A
test earns an `@live` tag **only** if its assertion truly needs the live
database, a real LLM, or a real mounted Azure Files share — not merely because
the code path happens to sit behind one. If the logic short-circuits before the
runtime is built (the chat gate) or is pure-prop rendering, it belongs in a fast
test.

Postgres is implied at every tier, not just `@live-db`: sessions are
database-backed (`novedu_session`), so the `setup` project
(`e2e/auth.setup.ts`) and every spec's bearer-session minting
(`mintSessionToken`, `e2e/api-auth.utils.ts`) write `novedu_user`/`novedu_session`
rows against whichever database the dev server under test is booted with — that
happens on every run, hermetic specs included. `@live-db` marks specs that need
the database for something **beyond** that baseline: seeding or inspecting the
app's own tables through `e2e/db.ts` (tutor-code minting, file CRUD, the
password-auth path) rather than merely resolving a session.

Five kinds of e2e, by the external infra they need beyond that baseline:

- **Hermetic e2e** — no infra beyond the dev server (and the session rows every
  spec's auth setup already writes): the sign-in gate, routing, device-flow
  wire shapes, teacher/student permissions, client-side validation. Untagged.
  **Run in CI.**
- **`@live-db` e2e** — read or write the app's own tables through `e2e/db.ts`
  beyond session minting (tutor-code minting, file CRUD, the password-auth
  path). **Run in CI** against an ephemeral `postgres:18` service container
  reached with password auth (see "DB-backed `@live-db` in CI" below), and
  locally against real Azure Database for PostgreSQL. Query plans are not
  asserted: on test-sized tables the planner's choice depends on whatever rows
  happen to be there and says nothing about production.
- **`@live-llm` e2e** — need a **real model or a specific provider** (the
  provider smoke tests — per provider for the tutor chat in
  `e2e/tutor-chat-reply.spec.ts` and for the **coding-agent** override legs in
  `e2e/coding-agent.spec.ts`, which drive the real `pi` coding agent through the
  public coding endpoint — vision, a real thinking model's reasoning stream, the
  health probe, and the **eval
  judge** probes in `e2e/eval-judge.live.spec.ts` — one test per eval kind (quiz
  feedback, tutor responses), because the one assertion of that feature that cannot be
  faked is whether a real judge flags planted violations and leaves compliant output
  alone, and `evalJudge` has no other real-backend coverage in the repo, unlike the
  grader which `e2e/quiz-image.spec.ts` smokes indirectly. For the **tutor** kind the judge is
  the only check there is, so a regression means a tutor eval reports nothing at all).
  No provider is reachable from CI: the SCCH endpoint is **geo-blocked to
  Austria** and cannot be containerized, Azure Foundry needs a **Managed
  Identity / `az login`** with the `Cognitive Services OpenAI User` role
  (docs/ai-models.md), and OpenRouter needs an `OPENROUTER_API_KEY` that CI does
  not have and will not get (`qa.yml` stays secret-free, docs/ci-security.md) — so
  these are **excluded from CI** and run locally only.
  Each optional provider's legs additionally self-skip on its own env var. The
  **Foundry** legs (the `tutor-chat-reply` "via Azure Foundry" case, the
  `health-foundry` assertions, the `coding-agent` "via Azure Foundry" override
  case) key on `AZURE_FOUNDRY_ENDPOINT`; the **OpenRouter** legs
  (`tutor-chat-reply` "via OpenRouter › sending a message gets a non-empty reply
  from an OpenRouter tutor" — the agent path, proving static-key auth and
  `vendor/model` id resolution — `coding-agent` "via OpenRouter › pi gets a
  non-empty reply from the overridden OpenRouter model" — the coding-proxy path
  through a code's LLM override — and the `health-openrouter` assertions) key on
  `OPENROUTER_API_KEY`. The judge deliberately has no Foundry leg:
  it resolves its model through the same `resolveLanguageModel` branch the tutor
  leg already drives (see `e2e/eval-judge.live.spec.ts`'s header for what that
  knowingly gives up).
  (Such a test is tagged `@live-llm` ONLY — the DB it also uses is implied — so a
  `--grep @live-db` run never selects it.) Every other LLM-backed spec runs against
  the **fake LLM** (see "Fake LLM" below) and is tagged by what it needs beyond it:
  `@live-db` when it touches the app's tables through `e2e/db.ts`, otherwise
  untagged.
- **`@live-storage` e2e** — need a REAL **mounted Azure Files share**
  (`e2e/image-mount-smoke.live.spec.ts`, gated on `IMAGE_SMOKE_ROOT`): the one
  manual, opt-in smoke proving the app-hosted image subsystem works against the
  actual SMB mount rather than a temporary filesystem root. It cannot be
  containerized in fork CI (it needs the real mounted share, e.g.
  `/novedu-files`), so it is **excluded from CI** and run locally only —
  exactly like `@live-llm`. The rest of the image subsystem's wired coverage
  (`e2e/image-management.live.spec.ts` — upload, list, resolve, delete, the
  shared-authenticated-asset and SVG-safety policies) needs no real mount at
  all: it runs against a temporary filesystem root the harness provisions
  itself, so it is tagged `@live-db` and **runs in CI**. (A `@live-storage` test
  is tagged that ONLY — the DB it also uses is implied — so a `--grep @live-db`
  run never selects it.)
- **`@live-telemetry` e2e** — need the REAL **Application Insights query API**
  (`e2e/diagnostics.live.spec.ts`, gated on `APPLICATIONINSIGHTS_CONNECTION_STRING`
  in `.env` plus an `az login` identity with Reader on that resource): the one
  proof that the endpoint accepts the diagnostics page's KQL (`docs/diagnostics.md`).
  CI has neither the resource nor a credential, so it is **excluded from CI** and
  run locally only. Tagged `@live-telemetry` ONLY — the DB it also uses is implied.

Every live test carries **`@live`** (so the local `--grep @live` smoke runs them
all) **plus exactly one** of `@live-db` / `@live-llm` / `@live-storage` /
`@live-telemetry`. CI runs hermetic + `@live-db` (the fake-LLM-backed specs among
them) and excludes the other three via `npm run test:e2e:ci`
(`--grep-invert "@live-llm|@live-storage|@live-telemetry"`).
Real credentials (Azure Postgres / SCCH / a real mounted Azure Files share /
Application Insights) must
never run on a fork `pull_request`; the CI container's Postgres password is a
non-secret dummy — see `docs/ci-security.md`.

## Layers & tools

| Layer | Tool (vitest project) | File glob | Env | In CI |
| --- | --- | --- | --- | --- |
| Unit | Vitest `unit` | `**/*.unit.test.{ts,tsx}` | Node (or `jsdom` per-file) | ✅ |
| Component | Vitest `component` | `**/*.browser.test.tsx` | Playwright Chromium (real browser) | ✅ |
| CLI unit | Vitest `unit` | `cli/src/**/*.unit.test.ts` | Node — colocated, rides the root `unit` glob | ✅ |
| CLI integration | Vitest (`cli/vitest.config.mts`) | `cli/test/*.test.ts` | the built binary + the offline fixtures server | ✅ |
| Hermetic e2e | Playwright | `e2e/*.spec.ts` (untagged) | dev server + the Postgres it boots against (session minting only) + the fake LLM | ✅ |
| `@live-db` e2e | Playwright | `e2e/*.spec.ts` tagged `@live-db` | same Postgres, read/written beyond session minting (container in CI / Azure Postgres local) | ✅ |
| `@live-llm` e2e | Playwright (`playwright.live-llm.config.ts`) | `e2e/*.spec.ts` tagged `@live-llm` | real DB + a real model / specific provider | ❌ local only |
| `@live-storage` e2e | Playwright | `e2e/*.spec.ts` tagged `@live-storage` | real DB + a mounted Azure Files share | ❌ local only |
| `@live-telemetry` e2e | Playwright | `e2e/*.spec.ts` tagged `@live-telemetry` | real DB + the App Insights query API (`az login`) | ❌ local only |

- The `component` project pins **`maxWorkers`** (≤ 4) and its own
  `sequence.groupOrder`. Browser mode's default of `min(12, cpus - 1)` tabs
  saturates the Vite server on a many-core machine until some tester clients
  miss their 60s connect deadline — and a tab lost that way is never failed,
  only waited on, so the run HANGS rather than erroring. Two projects may differ
  in `maxWorkers` only when they sit in different sequence groups, hence the
  explicit order (unit first). The `--maxWorkers` CLI flag does NOT reach the
  browser pool; it reads the project config.
- Config: **`vitest.config.mts`** defines the `unit` + `component` projects;
  **`playwright.config.ts`** the e2e suite in fake mode (with `e2e/auth.setup.ts`
  minting session cookies — see `docs/auth.md`), **`playwright.live-llm.config.ts`**
  its real-LLM variant (see "Fake LLM").
- Unit tests run in Node. The few that need a DOM declare
  `// @vitest-environment jsdom`; real browser behaviour belongs in a component
  test.
- The `component` project loads **no global CSS**: tests see the UA stylesheet
  plus inline styles only, which is all a behavioral test needs. A test that
  **measures layout** (sizes, positions, wrapping, overflow) must itself
  `import "@/app/globals.css"` — without it the UA's own rules (e.g.
  `dialog { height: fit-content }`) can satisfy geometry assertions vacuously.
  This stays a per-file opt-in, not a `setupFiles` default: 20+ behavioral
  files don't need it, and Tailwind only generates utilities used in
  `app`/`components` — a class that appears only in a test compiles to
  nothing, so harness geometry uses inline styles (`docs/styling.md`) and a
  global import would not make test-side classes real anyway. Prove any new
  layout assertion is non-vacuous: reintroduce the fault it guards and watch
  it fail (see `tests/component/list-overflow.browser.test.tsx`,
  `dialog-shell.browser.test.tsx`, `image-lightbox.browser.test.tsx`).

## House conventions

- **Every test starts clean.** `vitest.config.mts` sets `clearMocks`,
  `unstubEnvs` and `unstubGlobals`, so mock call history, `vi.stubEnv` and
  `vi.stubGlobal` are reset before each test — no file resets them itself. A
  `beforeEach` only sets defaults. Mock implementations are not reset, so a
  default that some test overrides belongs in `beforeEach`.
- **Env only through `vi.stubEnv`**, never `process.env.X = …` (a write
  survives the reset; `tests/test-conventions.unit.test.ts` guards this).
  `tests/setup.unit.ts` stubs `AUTH_SECRET` for every unit test. A stub made
  outside a test or `beforeEach` (module scope, `vi.hoisted`, `beforeAll`) is
  reset before the first test — fine for a value read once at import or setup,
  wrong for one the code reads again during a test.
- **No assertion behind a condition.** `if (r.ok) expect(…)` skips its checks
  when `r` failed, and `expect(r.ok && r.x).toBe(false)` passes when it failed.
  Narrow with Vitest's `assert(r.ok)`, then assert unconditionally.
- **e2e timeouts come from the config.** `playwright.config.ts` allows 120 s per
  test and 30 s per assertion, because the suite runs against `next dev`, which
  compiles each route on its first hit. A spec sets its own limit only to go
  above these (LLM round-trips).
- **e2e specs leave their rows behind.** Codes and files a spec creates stay in
  the database; the `setup` project (`e2e/auth.setup.ts`) sweeps the `e2e-…` codes
  and files older than an hour, with everything keyed by them. Images are not swept.

## Test fixtures

Tests own their fixtures — **nothing under test reads `activities/`** (that folder
is demo content, free to restructure, and — an accepted trade-off — validated by
no test or CI check; `qa.yml` and `docker-publish.yml` skip a change confined to
it). The one exception is the committed `activities/**/*-yaml.schema.json`, which
the drift guard `lib/schema-gen/generated-schemas.unit.test.ts` compares with a
fresh generation. Fixtures are deliberately
**synthetic**
(ids like `test-tutor`, content built from `MARKER` strings) so they never read as
real activities. Two homes, by what the layer needs:

- **Inline (unit)** — the `lib/tutors` unit tests (`parse` / `consistency` /
  `assemble` / `fragment` / `load`) share an in-code synthetic tutor + two fragment
  libraries defined as YAML string constants in **`lib/tutors/test-fixtures.ts`**.
  No files, no `node:fs` — the data sits next to the tests.
- **On disk (CLI + e2e)** — **`test-fixtures/activities/{tutors,quizzes,writings,coding}/`**
  holds the minimal synthetic YAML the two layers that genuinely need a file/URL
  use: the CLI (`validate <path>`) and e2e (the app fetches a YAML by URL). See
  `test-fixtures/README.md`.

e2e gets those files over HTTP from a tiny static server, **`test-fixtures/serve.mjs`**,
wired as a **second Playwright `webServer`** — so specs run fully offline (no
GitHub); the dev server fetches the URLs server-side, so `127.0.0.1` resolves.
The fixed port lives in ONE place, `e2e/fixtures.constants.ts`: the Playwright
config health-checks it and passes it to the server's env, and `e2e/code.utils.ts`
builds its URLs from the same constant. The CLI integration test imports
`startFixturesServer` (ephemeral port) for its served-URL cases.

Hermetic fixtures pin a fake **`model: test-model`** (nothing calls an LLM). The
LLM-backed fixtures — `tutors/live-tutor.yaml`, `tutors/vision-tutor.yaml`,
`writings/test-writing.yaml`, `coding/live-coding.yaml` — carry a **real** model
id, so the same file works against the live SCCH endpoint in real mode; the fake
LLM answers whatever model id it is asked for.

## Fake LLM

**`fake-llm/server.mjs`** is an OpenAI-compatible stand-in for a real model, built
on CopilotKit's aimock (`@copilotkit/aimock`, an exact-pinned devDependency). It
never pretends to be real: its default reply says it comes from Novedu's fake LLM.
It lets every LLM-backed spec that does not test a specific provider or real model
behaviour run in CI.

**Two run modes.** A run is all-fake or all-real, never mixed:

| Mode | Scripts | Config | The LLM | Selects |
| --- | --- | --- | --- | --- |
| fake (default) | `test:e2e`, `test:e2e:ci`, `test:e2e:db`, … | `playwright.config.ts` | the fake, started as the FIRST `webServer`; the app's dev server gets `SCCH_BASE_URL` / `SCCH_API_KEY` pointing at it | everything except `@live-llm` and `@demo` (the config's `grepInvert`) |
| real | `test:e2e:live-llm` | `playwright.live-llm.config.ts` | the providers `.env` configures | only `@live-llm` |

- The fake starts first because the app lists the SCCH models once at boot
  (`app/mastra/scch.ts`). Its port lives in `e2e/fake-llm.constants.ts`.
- Fake mode **never reuses** a running dev server: one already on `:3000`
  normally talks to a real model, so the run fails with port-in-use instead of
  silently hitting it — stop your `npm run dev` first. Real mode may reuse it.
- Only SCCH is redirected; Foundry and OpenRouter keep whatever `.env` sets (the
  specs that use them are all `@live-llm`). The SCCH env override in
  `playwright.config.ts` is the fake's only coupling point — no app code knows
  about it.
- **What stays real:** a spec is `@live-llm` only if its purpose is a specific
  provider or real model behaviour (the provider smoke tests, vision, the eval
  judge, the health probe). Everything else uses the fake.

**Markers.** The fake's behaviour is driven by markers in the **last user
message**, never by a spec's wording. The first matching rule wins
(`fake-llm/markers.mjs`, unit-tested in `fake-llm/markers.unit.test.ts`):

| # | Request | Reply |
| --- | --- | --- |
| 1 | model id contains `no-such-model` | HTTP 404 `model not found` |
| 2 | grader request + `[grade:correct\|partial\|incorrect]` | that verdict, feedback `Fake LLM verdict: <result>.` |
| 3 | grader request without a marker | `correct` |
| 4 | any other `response_format: json_schema` request | HTTP 400 `fake LLM: no fixture for this structured request` |
| 5 | a tool result after the last user message | `Fake LLM received the tool result: <tool result>` |
| 6 | `[tool:<name>]` or `[tool:<name> <json-args>]` | one call to that tool, with the arguments (default `{}`) |
| 7 | `[reasoning:<text>]` | that reasoning, then the default reply |
| 8 | `[reply:<text>]` | exactly that text |
| 9 | anything else | `This reply comes from Novedu's fake LLM, not a real model. You wrote: <first 80 chars>` |

- A **grader request** is a `json_schema` request whose schema has a top-level
  `result` property (`QUIZ_VERDICT_SCHEMA`, `lib/quiz-verdict-schema.ts`). **A new
  structured-output caller needs its own rule in `fake-llm/markers.mjs`**; until
  then the fake fails it loudly with the 400.
- The echoes (rules 5 and 9) let a spec assert that its input reached the model.
- A malformed tool marker (bad JSON) is ignored, so the later rules apply.
- Streamed replies arrive in 10-character chunks 40 ms apart, so a run stays in
  flight long enough to observe the chat's "generating" note.
- Usage is estimated from the text length, so usage metering works unchanged.
- `/v1/models` lists one model, **`novedu-fake`** (its own fixture in
  `fake-llm/server.mjs`, answering exactly like the catch-all). Every other model
  id gets the same replies, so an activity's real model id works unchanged.

**Container image.** `fake-llm/Dockerfile` (built from the repo root) packages
`server.mjs` and `markers.mjs` with aimock at the root `package.json` pin, so the
image and the e2e suite run the same fake. The server listens on `127.0.0.1`
unless `FAKE_LLM_HOST` names another address; the image sets `0.0.0.0` and port
`4010`. `docker-publish.yml`'s `build-and-push-demo` job publishes it as
`ghcr.io/htl-leo-novedu/novedu-app:fake-llm` (amd64 + arm64) for
`compose.yaml`, which runs it beside the `:demo` image (README, "Try Novedu
locally").

**Compose smoke test.** The `demo` leg of `qa.yml`'s `prod-build` boots
`compose.yaml` on the demo image it just built and a fake image built from the PR
(`NOVEDU_IMAGE` / `NOVEDU_FAKE_LLM_IMAGE`), waits for every healthcheck, then runs
`scripts/ci/compose-smoke.mjs`: the demo teacher signs in, and the health probes
for the database, SCCH (the fake) and the image root must pass. Run it locally
the same way against `docker compose up -d --wait`.

## Demo login `@demo`

The demo login (`docs/auth.md`, "Demo mode") exists only in a demo build, so its specs
need a demo server and every other spec an Entra one. **`playwright.config.ts` picks the
suite by the build's sign-in mode**, read the way the app reads it (the environment,
then `.env*`, through `parseAuthMode`):

- **Entra** (the default): the suite above; `@demo` specs are excluded.
- **Demo** (`NOVEDU_AUTH_MODE=demo`): ONLY `@demo` specs, against a **production
  build** — the web server runs `npm run build && npm run start` (up to ten minutes to
  boot) — so the build-time switch, better-auth's production rate limiting and the real
  boot (env lock, provenance preflight, persona seed) are what is tested. No `setup`
  project, no minted storage state, no fake LLM and no fixtures server: the specs sign in
  as the seeded personas themselves.

So a local `npm run test:e2e` never runs one suite against the other mode's server.
A demo run needs a database of its own (`docs/auth.md`: a demo build refuses a database
with Entra accounts, and vice versa) and empty Entra settings, e.g.:

```
NOVEDU_AUTH_MODE=demo AZURE_CLIENT_ID= AZURE_CLIENT_SECRET= AZURE_TENANT_ID= TEACHER_GROUP_ID= \
  DATABASE_URL=postgresql://postgres:pw@localhost:5432/novedu_demo npm run test:e2e:ci
```

The demo build overwrites `.next`. The `@demo` specs:

- `e2e/demo-login.spec.ts` — the sign-in page (no console errors, the four buttons, the
  DEMO ribbon without "×"), a teacher persona to the teacher home and back out, a student
  persona to the student home, the closed endpoints (`change-password`, `sign-up/email`,
  `list-sessions`, `revoke-sessions`, `update-user` answer **404** while signed in, with a
  valid origin and body — the allowlist, not an incidental 400/401), eight sign-ins in
  quick succession from one address, and the CLI device flow for a persona.
- `e2e/demo-boot.spec.ts` (`@demo @live @live-db`) — the provenance preflight and the
  seed, called directly against the server's database inside a transaction that is
  rolled back: both preflight halves, accountless e2e users accepted, a `microsoft`
  account refused; the seed idempotent (an unchanged hash), resetting a tampered role and
  password (checked with `verifyPassword`), and refusing a persona email held by another
  row.

The Entra suite carries the counterpart: `e2e/sign-in.spec.ts` asserts that
`POST /api/auth/sign-in/email` answers `400 EMAIL_PASSWORD_DISABLED`. Ids starting with
`demo-` belong to the demo personas, beside the e2e principals' `e2e-` prefix.

## Scripts

| Script | Runs |
| --- | --- |
| `npm run test` | Vitest `unit` + `component` (`test:unit` / `test:component` for one) |
| `npm run test:cli` | Builds the CLI, then its integration suite (`cli/test/*`) |
| `npm run test:e2e` | Playwright in fake mode: all specs except `@live-llm` and `@demo` (needs `az login` + `.env` for `@live`); with `NOVEDU_AUTH_MODE=demo`, only `@demo` ("Demo login" above) |
| `npm run test:e2e:ci` | Playwright minus `@live-llm`/`@live-storage`/`@live-telemetry` — hermetic + `@live-db`, the fake-LLM-backed specs included (CI runs this) |
| `npm run test:e2e:live-llm` | Playwright in real mode: `@live-llm` only, against `.env`'s real providers |
| `npm run test:e2e:db` | Playwright `@live-db` only (against a local Postgres container) |
| `npm run test:e2e:storage` | Playwright `@live-storage` only — the manual mounted-share smoke, skips cleanly without `IMAGE_SMOKE_ROOT` |
| `npm run test:e2e:telemetry` | Playwright `@live-telemetry` only — the diagnostics page against real App Insights, skips cleanly without `APPLICATIONINSIGHTS_CONNECTION_STRING` |
| `npm run qa` | `check` + `typecheck` + `test` + `test:cli` + `build` + `docs:build` (`qa:e2e` adds e2e) |

Run the local-only smoke (with `az login` done and `.env` populated) — the first
command covers `@live-db` / `@live-storage` / `@live-telemetry` in fake mode, the
second the real-LLM specs:

```
npm run test:e2e -- --grep @live
npm run test:e2e:live-llm
```

The kept `@live` set is deliberately small. The **`@live-db`** ones — a valid code
opens the chat, a mid-session window-close keeps the chat on screen, a teacher
creating a code, the file CRUD lifecycle plus the list **multi-delete** ("Delete
Selected" over several files) (`e2e/file-and-tutor-code-crud.spec.ts`, which writes
the real `novedu_files` table), the **image lifecycle**
(`e2e/image-management.live.spec.ts`, which writes `novedu_images` against a
temporary filesystem root — no real Azure Files needed), and the **database
auth-matrix** (`e2e/db-auth.live.spec.ts`, below) — also run **in CI** against a
container (next section), as do the specs that run against the fake LLM (the quiz,
writing, tool, persistence, metering, reload and coding-proxy flows). The
**`@live-llm`** ones — the per-provider chat smokes, the vision round-trips, the
health probe, the coding-agent override legs, the eval judge probes — stay
**local** (the SCCH endpoint is geo-blocked to Austria). The
**reasoning-visibility** set (`e2e/reasoning-visibility.spec.ts`) reads the raw
`/api/copilotkit` SSE bodies to prove an effective teacher receives `REASONING_*`
frames while a teacher in view-as-student mode and a real student receive
**zero**. Its three legs run in CI (`@live-db`) against the fake LLM, which streams
reasoning on a `[reasoning:…]` marker for every session; a `@live-llm` twin of the
teacher leg keeps a real thinking model's stream covered locally. Beneath it sits
the hermetic set: the runner (including the `AgentRunner` method-list guard), the
route's runner choice, and the persistence processor —
`app/api/copilotkit/reasoning-runner.unit.test.ts`,
`app/api/copilotkit/[[...slug]]/route.unit.test.ts`,
`app/mastra/reasoning-processor.unit.test.ts` — see `docs/chat.md`.

The shared list **multi-delete** layer's pure interaction (checkboxes, select-all,
the confirm/spinner/clear flow over a mocked action) is a fast **component** test —
`tests/component/list-selection.browser.test.tsx` — not an `@live` one; only the
wired DB delete needs the container.

## DB-backed `@live-db` in CI (Postgres container)

The `@live-db` tests run on every PR (QA) and on `main` (CD) with **no secret**.
The `e2e` job in `.github/workflows/qa.yml` (reused by `docker-publish.yml`, so one
change covers both) starts an **ephemeral `postgres:18` service container** and
connects with **password auth** — the container's `POSTGRES_PASSWORD` is a
non-secret DUMMY literal, so secret-freeness / fork-safety holds
(`docs/ci-security.md`).

Flow: the service container starts (the `postgres:18` image creates
`POSTGRES_DB` itself, and GitHub's service-container health check waits on
`pg_isready`) → `scripts/ci/wait-for-db.mjs` polls until the container accepts
connections, and nothing else → `npm run
test:e2e:ci` runs hermetic + `@live-db` against the **same** dev server and
container — the hermetic specs' session minting (`e2e/auth.setup.ts`,
`mintSessionToken`) writes `novedu_user`/`novedu_session` rows here too, it just
never touches any other app table; the Playwright `webServer` boots `npm
run dev`, whose startup creates the `mastra` schema, applies the `novedu_*`
migrations and creates the `mastra.*` tables (`instrumentation.ts`). The app's
SCCH provider points at the fake LLM (see "Fake LLM"), so the LLM-backed
`@live-db` specs run here too — no secret involved. The `db-auth` Entra test detects the
password-carrying URL and **skips** in CI (CI already covers the password path
itself through every other `@live-db` spec).

The `@live-db` image lifecycle (`e2e/image-management.live.spec.ts`) needs one
more piece of infra, also provisioned for free: the `setup` project's second
spec, `e2e/image-root.setup.ts`, wipes and re-provisions a repo-local directory
(`e2e/.image-root`, gitignored, mirroring `e2e/.auth/`) via the same
`initImageRoot` helper `npm run images:init-root` uses, and
`playwright.config.ts` points the `npm run dev` webServer's
`IMAGE_STORAGE_ROOT` at it — so the image lifecycle needs no Azure Files mount
in CI or locally. A dev server reused from an earlier run (`reuseExistingServer`)
keeps whatever root IT booted with; `e2e/image-root.utils.ts`'s
`assertServerImageRoot`, called at the top of every image-storage spec, fails
with an actionable message instead of a confusing 404/503 when the running
server's root does not match.

Reproduce it locally against a throwaway container:

```
docker run -e POSTGRES_PASSWORD=Test-Passw0rd! -e POSTGRES_DB=novedu -p 5432:5432 \
  -d postgres:18
export DATABASE_URL=postgresql://postgres:Test-Passw0rd!@localhost:5432/novedu
npm run test:e2e:db
```

## Database auth-matrix `@live` test

`buildPoolConfig()` (the one auth seam, see `docs/database.md`) supports two
ways to reach Postgres: passwordless **Entra ID** (production, and local dev
via `az login`) and a **password URL** (the dev/test/CI fallback — never prod;
full policy in `docs/database.md`). `e2e/db-auth.live.spec.ts` connects
through the real seam with a **password-less** `DATABASE_URL`, asserts
`buildPoolConfig` produced a function-valued `password` (proving the Entra
path was taken), and queries `SELECT current_user, current_database()` to
confirm *which* principal authenticated — so the Entra path can't silently
regress to something else. It **skips** when `DATABASE_URL` carries a
password (CI's ephemeral container, which covers the password path through
every other `@live-db` spec instead). The fast, secret-free companion that
locks down the branch *selection* is `lib/db/pool.unit.test.ts`.

Run just this spec with: `npm run test:e2e -- e2e/db-auth.live.spec.ts`.

## Testing the chat gate and server components WITHOUT infra

The chat runtime route and the chat page consume security-critical inputs but
their decisions are fast to test — the gate returns 401/403/404 before any
runtime is built, and the page maps a check result to a view. The pattern (see
`app/api/copilotkit/[[...slug]]/route.unit.test.ts` and
`app/[code]/page.unit.test.tsx`):

1. `vi.mock` the I/O seams — `@/lib/session` (the cookie-session gate), the
   `novedu_*` stores, `@/app/mastra`, and (past the gate) the CopilotKit
   runtime / Mastra agent factory. Bearer routes mock `@/auth` instead — see
   `docs/api.md`.
2. Keep the **security-critical pure module REAL** — e.g. `lib/thread-token.ts`
   (the HMAC), so the test exercises the actual check, not a stub of it.
3. Drive real `Request` objects through the exported handler, or call the
   `async` server component directly and render its element with
   `renderToStaticMarkup`; assert status / JSON / HTML.

This is how the thread-ownership, window-enforcement, and rejection-rendering
behaviors run in CI without infra.

## Auth session minting

Nothing here signs a real JWT or generates a keypair — every test-side session is
a row in the database plus, for the cookie channel, a signed cookie value derived
from that row:

- **e2e cookie sessions** (`e2e/auth.setup.ts`, the Playwright `setup` project)
  writes a fresh `novedu_user` + `novedu_session` row for each of the two test
  principals on every run (first sweeping any expired `e2e-%` sessions; live
  ones stay, so an overlapping run is not signed out), then
  mints the cookie value with better-auth's own `makeSignature`
  (`better-auth/crypto`, via `e2e/session-cookie.ts`): `${token}.${sig}`
  URL-encoded, under the `novedu.session_token` cookie name. Playwright's
  `storageState` injects it exactly like a real sign-in would have set it. See
  `docs/auth.md`.
- **e2e bearer sessions** — `mintSessionToken({ teacher, userId, name, expired })`
  in `e2e/api-auth.utils.ts` does the same user-plus-session-row write (default
  ids `e2e-api-teacher` / `e2e-api-user`; `expired: true` backdates
  `expires_at`) and returns the raw token for use as a `Bearer` header — no
  cookie, no signing, since the bearer channel accepts the raw token directly.
  `e2e/api-me.spec.ts`, `api-gate`, `api-codes`, `api-images`, and
  `api-reports` stay in the **hermetic** tier despite this write — it only ever
  touches the auth tables, never the app's own — as do the cookie-free
  `e2e/sign-in.spec.ts`; the claim/approve/poll round trip in
  `e2e/device.spec.ts` is tagged `@live @live-db` instead, because it drives a
  real device-authorization row through the server to completion rather than
  only minting a session.
- **Route unit tests** for both channels mock `@/auth`'s `auth.api.getSession`
  directly (`tests/mock-auth-session.ts`'s `bearerSession` builds the `{ session,
  user }` shape it resolves to) rather than minting anything real; cookie-side
  unit tests instead mock `@/lib/session` (`getSession`/`requireTeacher`) — see
  "Testing the chat gate" above. There is no keypair or JWKS file anywhere in
  this repo's test setup.

## Telemetry tests

All secret-free and hermetic — no Aspire, no Azure, no network beyond loopback
(`docs/telemetry.md`). They ride `npm run test:unit`:

- `lib/telemetry-mode.unit.test.ts` — the selection table: order, OTLP-wins
  precedence, `OTEL_SDK_DISABLED`, whitespace values, per-signal variables not
  enabling the path, reasons that never echo a value.
- `lib/telemetry.unit.test.ts` — the facade with both initializers mocked:
  which one starts, idempotency across concurrent/repeated calls, a failed start
  staying off (no fallback, endpoint redacted from the log); plus the helpers
  against REAL in-memory providers from the SDK — `emitEvent()`'s record shape
  (body, `eventName`, attributes) and `recordError()` exporting a root span even
  under a dropped parent (with a child-span control that does not export) and
  withholding a foreign error's message.
- `lib/telemetry-azure.unit.test.ts` — the distro boundary mocked; exactly one
  `useAzureMonitor()` call with only the connection string.
- `lib/telemetry-otlp.unit.test.ts` — the fixed detector set (no `process.*`
  attributes), the three instrumentations with bare defaults, the conditional
  `novedu-chat` service name, nothing signal-specific passed to `NodeSDK`.
- `lib/telemetry-otlp-delivery.unit.test.ts` — the REAL `NodeSDK` configured
  from environment variables (`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, so the
  receiver needs no protobuf decoding) exporting to an in-process HTTP server
  (`tests/otlp-receiver.ts`): `/v1/{traces,logs,metrics}` deliveries,
  `service.name`, no `process.*` resource attributes, the `eventName` on the
  wire, the runtime-node `nodejs.*` / `v8js.*` measurements.
- `lib/telemetry-otlp-unreachable.unit.test.ts` — the same SDK through the
  facade against a port nothing listens on: startup succeeds, ordinary HTTP
  traffic round-trips, no unhandled rejection.
- `lib/telemetry-pg-canary.unit.test.ts` — the pg instrumentation with no
  database: a query with a bound string exports its `$1` statement and never the
  literal (or the password).
- `lib/telemetry-isolation.unit.test.ts` — grep-guard: `cli/src/**`'s transitive
  import closure never reaches the facade, an OTel SDK / instrumentation /
  exporter package, or the Azure distro. The closure walk itself (specifier
  scan, `@/`-and-relative resolution, visit-once queue) is the shared
  `tests/import-graph.ts`, which `lib/prompt-dump.unit.test.ts` uses too; each
  guard supplies its own roots and its own per-module verdict through the
  `walkClosure` callback.

Each real-SDK case lives in its own file on purpose: a `NodeSDK` registers global
providers that cannot be replaced within a worker, and Vitest's per-file
isolation keeps them from leaking. `sdk.shutdown()` flushes every batch processor
and forces a final metric collection, so the delivery assertions need no batch-
delay tuning.

**Manual acceptance check** (never part of any suite; run once per change to the
telemetry code):

1. `docker compose -f compose.telemetry.yaml up -d`; open the dashboard login URL
   from `docker compose -f compose.telemetry.yaml logs aspire`.
2. `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev`; the app log
   shows `telemetry: mode=otlp`.
3. Sign in at `http://localhost:3000` with a teacher account; upload a
   self-contained tutor YAML at `/files/new`, mint a code for it at `/codes/new`,
   open `/<code>`, send one message, get a reply.
4. In the dashboard: resource `novedu-chat` is listed; Structured Logs shows
   `app_started`; Traces shows the chat turn as ONE trace with nested SERVER
   spans (never sibling request spans), `pg.query:*` spans whose `db.statement`
   carries `$1` placeholders and no bound values, and a `fetch POST <LLM
   endpoint>` client span; the resource has no `process.command_args` /
   `process.owner`; HTTP spans carry no header attributes; Metrics shows
   `nodejs.eventloop.*`, `v8js.memory.*` and `http.server.duration`.
5. `docker compose -f compose.telemetry.yaml stop`; the app still answers
   `/api/version` and a chat turn.
6. `docker compose -f compose.telemetry.yaml start`; a further request shows up
   in the dashboard after the next export.
7. `docker compose -f compose.telemetry.yaml down`.

No real student content is used at any step.

## CI

`.github/workflows/qa.yml` sets `NOVEDU_AUTH_MODE=entra` for the whole workflow and
runs `check` → `typecheck` → `test:unit` → `test:component` → `test:cli` → `build` →
`check-demo-markers.mjs .next --expect absent` (the Entra build carries none of the demo
login, `docs/auth.md`), plus a separate hermetic e2e job (`test:e2e:ci`), the
**`e2e-demo`** job (`NOVEDU_AUTH_MODE=demo`, the workflow's Entra placeholders blanked,
the same Postgres container: `test:e2e:ci` runs the `@demo` suite against a demo
production build, then `check-demo-markers.mjs .next --expect present` is the positive
control), and a PR-only `prod-build` matrix that builds both Docker images (no push) and
checks each one's compiled output for the demo markers — absent from the Entra image,
present in the demo image; the demo leg also boots `compose.yaml` on its image and runs
the Compose smoke test ("Fake LLM" above). Every job is **secret-free**; that is a hard security
invariant, not a convenience — see **`docs/ci-security.md`**.

## Subsystem specifics

- **Tutor codes / the chat gate** → `docs/codes.md` (Testing section).
- **Auth & e2e session cookies** → `docs/auth.md`.
- **Telemetry** → `docs/telemetry.md` (and the "Telemetry tests" section above).
- **LLM diagnostics** → `docs/diagnostics.md` (Testing section).
