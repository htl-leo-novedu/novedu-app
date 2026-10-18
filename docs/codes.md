# Codes

Deep reference for how students reach an **activity** — a tutor chat, a quiz, or a
writing activity — and how teachers mint and manage the **codes** that hand them
out. The always-on
invariants are summarized in `AGENTS.md`; this file has the full mechanics. Read
it before touching the entry points (`app/page.tsx`, `app/[code]/**`), the
teacher surfaces (`app/codes/**`), the runtime route
(`app/api/copilotkit/[[...slug]]/route.ts`), the validator/module seams
(`lib/file-validators.ts`, `lib/code-modules/**`), the create pipeline
(`lib/code-service.ts`), the quiz libs (`lib/quiz-*.ts`, incl. `lib/quiz-fetch.ts`),
or the `novedu_*` stores in `lib/code-*.ts`. The document-level fragment block every
activity kind embeds is the shared prompt-fragment core (`lib/prompt-fragments/**`,
`docs/prompt-fragments.md`). The
bearer API channel (`GET`/`POST /api/codes`, `novedu-cli codes`) is documented
in `docs/api.md`.

## The model

A **code** is a `[a-z0-9-]` string (1–32 chars; `generateCode()` mints 10 random
`[a-z0-9]`, 36^10 ≈ 3.6 × 10^15 — unguessable) minted by a teacher on
`/codes/new` and stored as a row in the `novedu_codes` table:

| Column | Meaning |
| --- | --- |
| `code` (PK) | the code, `varchar(32)` (sized for future teacher-defined memorable codes) |
| `module` | the dispatch discriminator — `tutor` \| `quiz` \| `writing` \| `coding`, picks the renderer + agent (the `coding` module has no in-app agent — it is an OpenAI-compatible endpoint; see `docs/coding.md`) |
| `created_by` | session user id (`novedu_user.id`) of the creating teacher |
| `file_url` | URL of the activity YAML — a public http(s) URL, or an uploaded file's `<origin>/api/files/<name>` (normalized via `URL.href`) |
| `valid_from` / `valid_until` | availability window, UTC `timestamptz`, **both bounds inclusive**. Each is **nullable** — a null `valid_from` opens the code immediately, a null `valid_until` never expires it (both null = always valid). `checkCode` / `windowStatus` coalesce a null bound to `DISTANT_PAST` / `DISTANT_FUTURE` |
| `note` | teacher's label, shown in their code list and as the recents label (≤ 200 chars) |
| `origin` | **documentation-only**: where the code was created (DEV vs PROD rows). Lookups never read it — a code created on localhost works in production, since all environments share the database |
| `anonymous` | the activity YAML's `anonymous` flag (default is module-specific — tutor/quiz `true`, writing `false`, coding always `true`), **frozen at create time** — a later YAML edit does NOT update it. Governs whether the stats page shows per-student data |
| `llm_provider` / `llm_model` / `llm_reasoning` | the code's optional **LLM override**: when set, it replaces the activity YAML's whole `llm:` block for every request served under this code. The pair is **both-or-nothing** — either both NULL (the YAML's `llm:` block applies) or both set; model ids are provider-specific, so validation rejects a lone half. `llm_reasoning` is the optional third member (a `REASONING_LEVELS` literal, docs/ai-models.md): it requires the pair, and an override WITHOUT one drops the YAML's level too (wholesale). Surfaced as `CodeEntry.llm` and applied via `effectiveLlm` (`lib/code-store.ts`); a corrupt stored pair is logged and read as no override, a corrupt stored reasoning is logged and dropped while the pair survives. Editable on `/codes/edit` (NOT frozen) |
| `created_at` | creation time |

Indexes: PK on `code`; `created_by` (the teacher list); `module` (the
module-filtered list).

**The stored row is the security boundary.** There is no signature and no
stateless link form: an activity opens if (and only while) a row with that code
exists and "now" is inside its window. The single check lives in `checkCode()`
(`lib/code-store.ts`) and is used by every gate (the student entry route, the
runtime route, the public coding routes, and the module server actions — quiz,
writing, tutor), each re-checking on **every** server touch
— one PK SELECT on the pooled connection — so an open activity stops accepting
input the moment its window closes (403 / error with a human-readable reason).
The module server actions open with the shared student gate
`verifyStudentActivity(code, module)` (`lib/activity-gate.ts`, no `"use server"`):
session user → `checkCode` → the code's module, refusing with one neutral message
table (`CODE_REJECTION_MESSAGES`, shared with the runtime route) whichever activity
the student is in.
Malformed codes are pattern-rejected without a database round-trip — which also
gives every unknown single-segment URL (`/whatever`) a clean "unknown code" page,
since `app/[code]` catches all non-static top-level paths.

## Three layers: FileKind → validator → CodeModule

The subsystem is cleanly split so a new activity (or a pure library kind) slots
in without touching the core.

**Layer 1 — `FileKind`** (`lib/file-name.ts`): `tutor | fragment | quiz | writing | coding`.
Drives the `/files` editor kind selector and `novedu_files.kind`.

**Layer 2 — the validator registry** (`lib/file-validators.ts`):
`fileValidators[kind].validate(url, fetcher) → { ok, errors?, warnings, title?,
description?, anonymous? }` is the **single source of truth** for "is this YAML
valid, and what metadata does it carry." It is consumed by `/files` save + the
standalone **Validate** button (fetcher resolves the editor buffer + app-hosted
siblings) AND by code-create (fetcher = `appHostedFetcher`; url = the row's
`file_url`).

The four activity kinds share one validator body (`activityValidator`): the kind's
strict check, then the app-only provider gate, then the metadata — `title` and
`description` default to `null` and `anonymous` to the privacy-safe `true` when the
kind's check carries none. Each check starts with the shared `loadAndValidate`
(scheme gate, fetch, YAML, the kind's Zod schema — `docs/prompt-fragments.md`).

- `tutor` → the THOROUGH gate (`loadAndBuildTutorPrompt`, `validateLibraries:
  true`): every fragment in every referenced library is strict-rendered, surfacing
  `title`/`description`/`anonymous`.
- `fragment` → `loadAndCheckFragmentFile`: a real validator with **no module** —
  the canonical "validator without a module." A future pure library kind likewise
  adds only a validator entry.
- `quiz` → `loadAndCheckQuiz` (`lib/quiz-validate.ts`): a strict authoring gate —
  the `QuizYamlSchema` Zod check plus a duplicate-question-id pass — that **blocks**
  an invalid save and surfaces `anonymous`/`title`. The lenient runtime `parseQuiz`
  (`lib/quiz-yaml.ts`) is a separate, deliberately permissive read for the student
  path. The same validator backs `/files` save, code-create, and the
  `novedu-cli validate --kind quiz` command.
- `writing` → `loadAndCheckWriting` (`lib/writing-validate.ts`): the same kind of
  strict `WritingYamlSchema` gate, differing only in that writing defaults
  `anonymous: false` — see `docs/writing.md`. Its fragment gate over `instructions`
  is `checkInstructions` (`lib/activity-load.ts`), shared with coding.
- `coding` → `loadAndCheckCoding` (`lib/coding-validate.ts`): the same kind of strict
  `CodingYamlSchema` gate (bad YAML, missing field, no `llm.model`, no `instructions`
  → blocks the save), differing only in that it carries **no** anonymity flag — coding
  is always anonymous, so the seam freezes `anonymous: true` (the schema has no
  `anonymous` field to read). The lenient runtime read is `parseCoding`
  (`lib/coding-yaml.ts`) — see `docs/coding.md`.

**Layer 2, read-only sibling — the prompt-dump registry** (`lib/prompt-dump.ts`):
`promptDumpers[kind].dump(url, fetcher, opts)` answers the other file-level
question — "which exact LLM prompts does this YAML produce?" — for the four
prompt-producing kinds (`PromptKind = Exclude<FileKind, "fragment">`). Like the
validators it derives from the FILE alone, and it never re-implements assembly:
every dumper calls the production builders/loaders. It backs the
`novedu-cli prompts` command — see `docs/cli-prompts.md`.

**Layer 3 — the `CodeModule` registry** (`lib/code-modules/`): the registry of
shareable activities.

- `types.ts` is **client-safe** (`CodeModule = "tutor" | "quiz" | "writing" |
  "coding"` + display labels) so client components and the `/codes` module filter
  can name modules without importing server code.
- `registry.ts` is **server-only** (`codeModules: Record<CodeModule,
  CodeModuleDef>`). Each descriptor carries a `fileKind` (which Layer-2 validator
  to reuse) and only what is genuinely activity-specific:
  - Create-time validation is **not** a descriptor field — it is derived from
    `fileKind` by `validateCodeFile(module, fileUrl, fetcher)` (literally
    `fileValidators[fileKind].validate`), so a module never redefines validation and
    can't wire the wrong validator.
  - `runtime` — `{ agentId, buildRequestContext(entry) }`: which Mastra agent the
    runtime route runs and how its per-request `RequestContext` (system prompt +
    model) is built. **Optional**: `coding` omits it (it has no in-app agent), and
    the CopilotKit route 404s any module without a `runtime`.
  - `renderDetail(entry, searchParams)` — **the** teacher detail body on
    `/codes/[code]`. Each module owns it entirely; there is no privileged "stats
    shell" a module overrides. tutor/quiz share the `ConversationStats` component by
    calling it; writing renders its savers list; coding shows its config, its own
    connection block, and the issued-keys list. Descriptors call these server
    components as **plain functions** (returning `ReactNode`), so no JSX lives in
    the server-only registry.
  - There is **no per-module result override** — every module's create/edit screen
    shows the same **`ShareLinkResult`** (the `/<code>` share link with a copy
    button), rendered directly by the `/codes/edit/[code]` page.
- `tutor.ts`, `quiz.ts`, `writing.ts`, `coding.ts` are the descriptors. `writing` is
  the Markdown-writing-with-AI-feedback module (`docs/writing.md`): its `renderDetail`
  is the savers-first teacher review (saved text first, chat second), and its agent
  reads the student's live draft through the read-only `getCurrentText` frontend tool
  but has no tool to change it. `coding` is the OpenAI-compatible coding-endpoint
  module (`docs/coding.md`): it has **no `runtime`** and is reached only through its
  own public `/api/coding/v1` routes, authenticated by a per-user API key from
  `novedu_coding_keys` — the code string itself opens nothing.

Student **rendering** is also NOT a registry seam: it is a thin `switch (entry.module)`
in `app/[code]/page.tsx` delegating to each module's own server component
(`render-tutor.tsx`, `render-quiz.tsx`, `render-writing.tsx`, `render-coding.tsx`).
(The *teacher* detail body IS a registry seam — `renderDetail` above — but
descriptors keep JSX out by calling components as plain functions.)

**Adding a module** (an activity kind) never changes the **generic flow** — the code
store, the runtime route and attribution all dispatch by `module`/`fileKind` — and
create validation (from `fileKind`) and the share-link result (the default) come for
free. A kind is built from the shared steps, not from a copy of another kind: its loader
on `loadActivity`/`loadActivityFrom` and `parseActivityYaml` (+ `resolveInstructions` /
`checkInstructions` for a single `instructions` host text, `lib/activity-load.ts`), its
authoring check on `loadAndValidate`, its server actions behind `verifyStudentActivity`
(`lib/activity-gate.ts`), a context-configured agent on `lib/llm-context.ts` +
`app/mastra/agent-context.ts`. The full seam list (✱ = an exhaustive `Record`/`switch`,
so the compiler names it; the rest are lists to extend by hand):

- **Kind and module:** `FILE_KINDS` (`lib/file-name.ts`); `CODE_MODULES` +
  `codeModuleLabels` ✱ (`lib/code-modules/types.ts`; a new badge tone also in
  `components/ui/badge.tsx`); `MODULE_ICONS` ✱ (`components/module-badge.tsx`),
  `MODULE_ROW_ACCENT` ✱ (`app/codes/_list/columns.tsx`, and its classic-list copy in
  `app/codes/_classic/classic-codes-list.tsx`), `KIND_TONES` ✱ (`app/files/page.tsx`)
  and the `/files/new` kind options (`app/files/new/create-file-form.tsx`).
- **Descriptor and render:** `lib/code-modules/<kind>.ts` + its `codeModules` line ✱
  (`renderDetail`, and `runtime` when it has an in-app chat); the student render case
  ✱ in `app/[code]/page.tsx` + its `render-<kind>.tsx`.
- **Loading and validation:** the Zod schema + its `schemaRegistry` entry
  (`lib/schema-gen/index.ts`, which emits `activities/<dir>/<kind>-yaml.schema.json`);
  the lenient parser, resolver and app loader (`lib/<kind>-{yaml,resolve,fetch}.ts`);
  the authoring check (`lib/<kind>-validate.ts`); its `fileValidators` entry ✱ (via
  `activityValidator`) and `readAnonymousFlag` case ✱ (`lib/file-validators.ts`).
- **Prompts and agents:** the dumper ✱ (`promptDumpers`) + its dump type in the
  `PromptDump` union (`lib/prompt-dump.ts`, plus a `promptSections` case when it has
  more than one `system` prompt); an agent is
  registered in `app/mastra/index.ts`, and a memory-backed one takes `chatMemory()` +
  `reasoningStrippingProcessor`.
- **Per-code data:** a kind that stores its own rows per code joins the code delete
  (`deleteCodeRows` in `lib/code-stats-store.ts`); one without Mastra threads needs its
  own count in `getInteractionCounts` (same file) for the `/codes` list.
- **Metering and achievements:** the per-module counters (`lib/usage-store.ts` + their
  columns in `lib/db/schema.ts`) and their readers — the activity-day predicates and
  sums in `lib/student-facts-store.ts` / `lib/teacher-facts-store.ts`, the `UsageDay`
  fields in `lib/achievements/derive.ts`; the student achievement families
  (`lib/achievements/catalog.ts`, a family's colours in `app/_home/badge-disc.tsx` +
  the `--fam-*` tokens in `app/globals.css`). `KIND_COUNT`
  (`lib/achievements/teacher.ts`) follows `CODE_MODULES`, so a new module raises the
  "Full Toolkit" bar.
- **CLI and registry:** a `runValidate` case ✱ + its `formatOutcome` case and a
  `format<Kind>Result` (`cli/src/commands/validate.ts`, `cli/src/format.ts`);
  `GROUP_MODULES` (`lib/registry-schema.ts`); the kind lists in the CLI help texts
  (`validate`, `prompts`, `codes create --module`, `files upload --kind`),
  `cli/package.json`'s description and `cli/README.md`. Evals only if the kind gets
  them: `EVAL_KINDS` (`lib/eval-schema.ts`) + `evalRunners` (`cli/src/eval-run.ts`).
- **Tests:** fixtures under `test-fixtures/activities/<dir>/`; the kind table in
  `lib/file-validators.unit.test.ts`; `PURE_MODULES` in `lib/prompt-dump.unit.test.ts`
  for a new CLI-bundled module.
- **Docs:** `docs/<kind>.md` + its AGENTS.md subsystem-map entry; the teacher-guide
  chapter (`teacher-docs/CHAPTERS.md`).

**Adding a pure library kind** = one `FILE_KINDS` entry + one Layer-2 validator, no
module; the `fragment` kind proves the asymmetry is real.

## Student entry & runtime dispatch

`app/[code]/page.tsx` is a thin **dispatcher** (server component):

1. `checkCode(code)` → on failure render `app/code-error.tsx` (`unknown-code` /
   `not-started` / `expired` / `lookup-failed`, with the window bounds in local
   time where known).
2. record/clean up the user's recent codes (off the response path).
3. mint a server-side `threadId` and sign the thread-ownership token `(code,
   userId, threadId)`.
4. `switch (entry.module)` → delegate to the module's render component, which
   loads the activity YAML (uncached, so edits show immediately) and renders the
   surface (`render-tutor.tsx`, `render-quiz.tsx`, `render-writing.tsx`,
   `render-coding.tsx`).

The chat **runtime route** (`app/api/copilotkit/[[...slug]]/route.ts`) uses ONE
header scheme: **`x-code`** (+ `x-thread-token`; headers, not a query string,
because CopilotKit appends sub-paths like `/info` to the runtime URL). It
`checkCode`s the header, reads `module` off the row, looks up
`codeModules[module].runtime` to pick the agent id and build the
`RequestContext`, and runs that one agent: any other agent id in the path 404s, and
the per-request CopilotKit runtime **registers only that agent**
(`MastraAgent.getLocalAgent`, never Mastra's whole registry), so the internal
agents (`quizEvaluator`, `evalJudge`, `evalTutor`) are not even known to it.
`resourceId` is the **code** for every module. One access check, one header scheme,
module-driven agent selection.

The tutor agent additionally resolves the YAML's opt-in **built-in tools**
(top-level `tools:`, default `[]`) per request, alongside its prompt and model —
see `docs/tutor-tools.md`. Tool grants live in the YAML only; the code row and
the runtime route know nothing about them, and the per-code LLM override never
affects them.

Every consumption of the activity's `llm:` block goes through
`effectiveLlm(entry, activityLlm)` (`lib/code-store.ts`): the code's LLM override
wins wholesale when set (its optional reasoning level included). The five sites:
the tutor agent (the descriptor puts it on the RequestContext as
`tutor-provider-override`/`tutor-model-override`/`tutor-reasoning-override`;
`app/mastra/tutor-agent.ts` applies it), the quiz
discussion + writing `buildRequestContext`s, the quiz grader (`submitAnswer`),
and the coding proxy. Each gates `providerUnavailableReason` on the EFFECTIVE
provider. Usage metering needs no extra wiring — the exporter reads the actually
resolved provider/model off the MODEL_GENERATION span (`docs/ai-models.md`), and
the coding proxy meters the effective pair explicitly.

Past those checks the route makes its **one role-dependent choice**: which
CopilotKit `AgentRunner` feeds the SSE writer. An effective teacher gets the
library's own `InMemoryAgentRunner`; everyone else gets `ReasoningStrippingRunner`
(`app/api/copilotkit/reasoning-runner.ts`), which drops every AG-UI `REASONING_*`
frame from both `run` and `connect`, so a thinking model's chain of thought is
never written to a student's stream. It **fails closed** (stripping is the
default; only a proven effective teacher opts out) and honours "view as student".
This is a display gate only — it does not touch the code / thread-token access
model above, which is identical for every caller. Full mechanics: `docs/chat.md`.

The runtime route additionally enforces **thread ownership**: every
thread-touching request (`agent/{id}/run`, `agent/{id}/connect`,
`agent/{id}/stop/{threadId}`) must carry an `x-thread-token` whose HMAC-SHA256
over `(code, userId, threadId)` (key derived from `AUTH_SECRET`,
`lib/thread-token.ts`) matches the **session user**, so a leaked threadId (even
with its token) is useless to anyone else. This is the ONLY thread isolation
there is — Mastra fetches threads by id without checking the resourceId — and it
is stateless on purpose; an ownership table would break the anonymity promise
below. All runtime endpoints the app does not use (`/threads/*`, `/transcribe`,
…) return 404, and `/info` does not advertise them: its runner is the
`ReasoningStrippingRunner`, which does not claim local thread-endpoint support, so
`threadEndpoints.list`/`inspect` report `false`.

## URLs & the code field

- An activity lives at **`/<code>`** — no query parameters. Teachers hand out
  `https://<host>/<code>`; the code alone also works.
- **`/`** is the start page (`docs/home.md`). On the student page (and for a
  teacher in view-as-student mode) its Continue section holds the code field
  (`CodeEntryForm`, `app/code-entry.tsx`): it accepts a bare code or a pasted full
  URL (the client extracts the last path segment; format-only validation against
  `[a-z0-9-]{1,32}`), with the user's **recently used codes** as one-click
  shortcuts below it. The teacher dashboard has no code field.
- Recents live in SQL (`novedu_recent_codes`, PK `user_id` + `code`,
  `last_used`), recorded server-side after every successful open and capped at the
  newest 10 per user. Recently used (`app/_home/recent-list.tsx`) lists them via an inner join with
  `novedu_codes` (label = `note`, fallback code) — so codes whose row was deleted
  disappear by themselves. Clicking a recent code that turns out dead
  (`unknown-code` / `expired`) removes the row server-side; `not-started` and
  transient `lookup-failed` keep it.

## Creating & editing codes

`/codes/new` ("New code", teacher-only via `requireTeacherPage()` on the page +
`requireTeacherUserId()` in the action; reached from the "New code" button on
`/codes`, or with `?module=<kind>&file=<url>` pre-filled from the YAML Files
"Create code" shortcut — `/share-tutor` and `/share-quiz` both 308-redirect
here): a **module** selector + the file URL + optional note + window as
`datetime-local` (converted to unix seconds IN THE BROWSER — the only place the
teacher's timezone is known) + the optional **LLM override** (below). **Either
window field may be left blank** for an
open-ended code (no start / no end → a null bound). The create pipeline lives in
**`lib/code-service.ts`** (`createCodeForUser` — a plain server module that takes
the verified `userId`; auth never enters it): it validates the input, gates an
LLM override's provider, then runs `validateCodeFile(module, …)` (the Layer-2
validator for the module's `fileKind`), **freezes** `anonymous`/`title` from the
result, and inserts the row. TWO thin channel shells call it with identical
semantics: the web form's `createCodeAction` (`lib/code-actions.ts`,
`requireTeacherUserId` + FormData + redirect) and the bearer
`POST /api/codes` (`requireBearerTeacher` + JSON — `docs/api.md`).

The **LLM override** section is two free-text fields (provider + model) plus a
**reasoning** select ("Provider default" — no level sent — + the
`REASONING_LEVELS`, of which `none` explicitly sends `reasoning_effort: "none"`)
and a **quick-pick** row: a select ("LLM quick pick", no `name`, so it is never
submitted) over `LLM_OVERRIDE_PRESETS` (`lib/llm/presets.ts` — OpenRouter
`openai/gpt-6-luna` and `openai/gpt-6.1-sol`, each at
reasoning `medium`, then SCCH Gemma 4 and SCCH Qwen 3.8 27B with no level), an
**Apply** button and a **Clear** button. Choosing a pick changes nothing; Apply
(disabled until a pick is chosen) fills all three fields — a pick without a level
puts reasoning back on "Provider default" — and they stay free text afterwards;
Clear empties all three. The list is a convenience, never an allowlist: every
pick is offered whatever the server has configured, and the save-time gate below
refuses an unconfigured provider.
Left blank, the code serves the activity YAML's `llm:` values. Filled, the
override replaces the whole `llm:` block for every request under the code (the
pair is both-or-nothing and a reasoning level requires it: the server rejects a
half-filled pair, an unknown provider, an unknown level, or a level without the
pair, and gates the override's provider through `providerUnavailableReason` at
save time so an override naming an unconfigured provider cannot be stored). The
override swaps
ONLY the LLM — the system prompt, `anonymous`, and everything else still come
from the YAML (a tutor YAML's `llm.imageInput` still gates the attachment UI, so
pick a vision-capable override model for a vision tutor). **A storage failure is a
hard error** — without a row there is nothing to hand out. On success the action
**redirects to `/codes/edit/<code>`**, which renders `ShareLinkResult` directly —
the standard `/<code>` share link (copy button), the same for every module including
coding. The origin comes from `CODE_ORIGIN` (read
first), then `TUTOR_CODE_ORIGIN` (fallback), then the request's forwarded/host headers
(fine for dev); it is display-only.

The form has three groups: the activity (module, YAML URL, note), its LLM, and the
availability window. The LLM group opens with the activity YAML's own `llm:` block in
a read-only field, **Activity's LLM (from the YAML)**, in BOTH modes —
`provider · model · reasoning`, the reasoning reading "provider default" when the YAML
pins none — directly above the override fields, so a teacher sees what an override
would replace without opening the file. The form reads it through the
teacher-only server action `readActivityLlmAction` (`lib/code-actions.ts`,
`requireTeacherUserId`, http(s) URLs only), which calls `loadActivityLlm`
(`lib/activity-llm.ts`, the loader of the `/codes` "YAML model" column: the server
fetcher, so app-hosted YAML comes from the database; capped at 10 seconds; `null` on
any failure). It reads when the form opens with a URL (edit's frozen URL, or a
pre-filled `?file=`) and whenever the URL field is left holding a URL other than the
last one read; only the newest read settles the field. Every failure shows the same
warning ("Couldn't read the model from this YAML file.", plus "Creating the code
checks the file and shows what's wrong." on `/codes/new`). The field is display only:
it never fills or gates the override, and create validates the file on its own. It is
always rendered at one input's height, its text cut to one line (the whole text in its
tooltip), and asks for a URL until there is one — pressing **Create code** straight
from the URL field starts a read on that mousedown, and a field growing then would
move the button out from under the click. Next dispatches server actions
one at a time per client, so a save sent while a slow outside host is still being
read waits for that read (at most the 10-second cap).

A publication that embeds MANY activities does not mint them one by one: an
**activity registry** file lists every activity under a stable key and
`novedu-cli codes sync` reconciles it with the server (reuse a matching code,
mint what has none) into a committed key → code lock file — `docs/registry.md`.
It is a pure client of `GET`/`POST /api/codes`; nothing in this document changes
for it.

**Editing** (`/codes/edit/[code]`, the SAME `CodeForm` in `mode="edit"` →
`updateCodeAction` → `updateCode`) changes only the **note**, the
**availability window**, and the **LLM override** (set or cleared as a
whole, reasoning level included; same validation + availability gate as create). The module and the file
URL are shown **read-only** and
are never submitted, so the frozen `anonymous` flag (which the file implies) stays
valid and no YAML re-validation is needed.

`/codes` ("Codes", teacher-only) lists **ALL** codes across modules — any
effective teacher may see and manage every code (RBAC planned) — via `listCodes({
search, createdBy, module })`, newest first, active + not-yet-started (`upcoming`
badge) + already-expired (`expired` badge), since codes are not garbage-collected.
Filtering (a text contains-match over note/code, an **owner** `<select>` — the
signed-in teacher by default — and a **module** `<select>`) happens **in the
database** through URL search params, never in memory — the shared filtered-list
concept (`docs/filtered-lists.md`).
Each row: a **Module** badge, note (fallback code, `file_url` tooltip), the
**owner** (the creating teacher's `novedu_user.name`, the raw user id when
they have none), window in local time (an open bound shows as **"No start"** /
**"No end"**), an
**interaction** count (qualifying Mastra threads under
`resourceId = code` — `getInteractionCounts`, ONE aggregate query for the whole
filtered set, no per-row query), a stats link, an Open link (active codes only), a
Copy button, and an **Edit** link. Deletion is the list's **"Delete Selected"**
multi-delete (tick the rows, confirm; it wipes each selected code and all of its
conversation data — see Lifecycle and `docs/filtered-lists.md`).

## Chats, memory & the join model

The Mastra memory **`resourceId` is the code** (set in the runtime route), and
`threadId` is a per-chat UUID generated **server-side**, pinned into
the CopilotKit client via CopilotChat's `threadId` prop (explicit mode — the shared
`ModuleChat` primitive owns this frontend wiring; see `docs/chat.md` for why the
prop, not the configuration provider) and proven back to the runtime by the
`x-thread-token` ownership token.

**Resume on reload (tutor only).** A tutor tab keeps its current
`{ threadId, threadToken }` in `sessionStorage` (`lib/tutor-thread-storage.ts`): it
survives a reload of that tab and is gone with the tab, so two tabs are two
conversations (a duplicated tab inherits its source's entry and shares its thread).
On mount the chat asks `resumeTutorThread` (`lib/tutor-actions.ts`), which re-runs
the gate (session, `checkCode`, `module === "tutor"`), re-verifies the token over
`(code, session user, threadId)` and requires the thread's last stored message to be
less than **60 minutes** old (`lib/tutor-history-gate.ts`), or, in a per-user tutor,
that the student owns it (a conversation reopened from "Previous conversations",
below); every refusal is the same opaque `{ ok: false }`, and the chat then uses
the thread `app/[code]/page.tsx` minted for this load. The messages themselves reach the browser with the chat's
`connect`, answered from the database by the runtime's snapshot runner
(`docs/chat.md`). Nothing new is persisted and no user↔thread link is written, so an
anonymous tutor stays unlinkable. Sign-out clears every stored pair in the tab. A
teacher in "view as student" resumes under their own `novedu_user.id` (student mode
changes only the role, never the user id).

**Previous conversations (per-user tutors only).** A tutor whose code is
history-enabled offers the student a list of their own earlier conversations with
THIS code and lets them reopen one and continue it (`listTutorThreads` /
`openTutorThread`, `lib/tutor-actions.ts`). History is on only when BOTH copies of
the `anonymous` flag are `false` (`historyEnabled`, `lib/tutor-history-gate.ts`):
the copy frozen on `novedu_codes.anonymous` decides what the teacher sees, the live
YAML flag decides whether `recordUserChat` writes rows, and they differ only when a
teacher edits the YAML after creating the code:

| frozen | live | rows written | teacher sees names | history |
| --- | --- | --- | --- | --- |
| false | false | yes | yes | **on** |
| false | true | no (new threads) | yes (old rows) | off |
| true | false | yes | no | off |
| true | true | no | no | off |

So the history appears exactly when conversations are recorded AND the teacher sees
names, and both Start-over wordings and the dialog's notice are true in every
combination. The render takes the live flag from the YAML it already built; the
actions read it with `readAnonymousFlag` (an unreadable YAML counts as anonymous).

This is the **student-side read path** of `novedu_user_chats`
(`lib/tutor-history-store.ts`): `listOwnTutorThreads(userId, code)` starts from the
session user's rows for the code, inner-joins `mastra_threads` on `id` and
`resourceId = code` (a thread without Mastra rows, e.g. after a half-failed code
delete, drops out), keeps threads with at least one user message, and returns at
most 50 (newest last activity first, plus a `more` flag) with the student's message
count and a preview of their first message computed IN SQL (its text parts and
whether it had a photo; the whole `content`, which may hold a multi-megabyte data
URL, is never selected). `ownsTutorThread(userId, code, threadId)` is the ownership
proof `openTutorThread` requires before it signs a token for that thread (no time
limit; every refusal carries the same message). The user id always comes from the
session and is never returned. Reopening creates no thread, so it adds no
"interaction" to the teacher's statistics.

Three places mint a thread, all server-side and all re-verifying the code first:
`app/[code]/page.tsx` on every page load (tutor + writing), `startDiscussion`
(`lib/quiz-actions.ts`) when a student opens a discussion on a graded question, and
`startNewTutorThread` (`lib/tutor-actions.ts`) behind the tutor chat's **start
over** button. A minted thread is never *replaced* — the abandoned one stays in
`mastra_messages` and remains readable by the teacher.

Relationships across the
Drizzle- and Mastra-owned tables are **by value — never foreign keys**
(`docs/database.md`):

```
novedu_codes.code        = novedu_user_chats.code = mastra_threads.resourceId
novedu_user_chats.thread_id = mastra_threads.id   = mastra_messages.thread_id
novedu_user_chats.user_id   = novedu_user.id (the student)
novedu_codes.created_by     = novedu_user.id (the teacher)
novedu_reports.code         = novedu_codes.code   (the reported activity)
novedu_reports.user_id      = novedu_user.id (the reporting student — see below)
```

- **All chats/discussions for a code**: `SELECT * FROM mastra_threads WHERE
  resourceId = '<code>'`.
- **user → userchat → history**: filter `novedu_user_chats` by `user_id`, join
  `mastra_threads`/`mastra_messages` via `thread_id`.

`novedu_user_chats` is the ONLY place tying users to chats — with **three
sanctioned exceptions**: `novedu_reports`, where a student who files a report
voluntarily waives anonymity (their user id is stored even under an anonymous code,
behind an explicit on-form notice; `docs/reports.md`); `novedu_coding_keys`,
where requesting a coding activity's personal API key stores the requester's user id
behind an explicit on-page notice (`docs/coding.md`); and `novedu_quiz_results`,
where a student who chooses to save a finished quiz's counts on the Finish page
(behind the notice that only they can see it) stores them with their user id even
under an anonymous code. That store has no teacher reader at all — not even an
aggregate — and is deleted with its code (`docs/home.md`). The teacher dashboard
counts a teacher's identified students through `chattersOfTeacherStatement`
(`lib/user-chat-store.ts`, non-anonymous codes only) beside the writing and key
stores' subselects; only counts and dates leave that statement (`docs/home.md`). It is
privacy-gated by the activity YAML's **`anonymous` flag, whose default is
module-specific** (tutor/quiz default `true`; **writing defaults `false`** —
`docs/writing.md`): when anonymous, nothing is written — chats cannot be attributed
to a student. Only an activity with `anonymous: false` records `(thread_id, code,
user_id)`; `recordUserChat` (`lib/user-chat-store.ts`, called from the runtime route
off the response path via `after()` — only after a token-verified run got a 2xx —
deduped per thread) reads the flag **live** from the YAML behind the stored
`file_url`, dispatching by the code's file kind (tutor → `loadAndBuildTutorPrompt`,
quiz → `loadQuiz`, writing → `loadWriting`, via `readAnonymousFlag`). It is
privacy-safe on a YAML load failure, which is retried rather than cached. The per-user `novedu_recent_codes` shortcuts are deliberately
separate — they say "this user opened this code", never which chat is theirs.

Note two SEPARATE reads of the same `anonymous` flag. The RUNTIME attribution path
above always reads it **live** from the YAML (so toggling an activity to
`anonymous: false` starts attributing immediately). The STATS page instead reads
the copy **frozen onto `novedu_codes.anonymous` at create time** — it only decides
whether to surface per-student numbers, and freezing keeps that decision stable
for a code's lifetime even if the YAML changes later.

Caveat: with `resourceId = code`, any *resource-scoped* Mastra memory (working
memory, semantic recall) would be shared across all students using the same code.
Today only per-thread `lastMessages` is configured — keep it that way or re-think
the scoping first.

**Only the new turn is persisted per run.** CopilotKit/AG-UI re-sends the ENTIRE
client-side history on every run, and the runtime route forwards it untouched. The
`@ag-ui/mastra` bridge recalls the thread from memory and drops every incoming
message whose id is already stored (message ids survive the round-trip), so the
agent is handed — and Mastra appends — only the new user message + its reply. Two
edges of that diff: when every incoming message is already stored, or the recall
throws, the bridge forwards the full history; Mastra's Postgres store upserts
messages by id, so that run stores no duplicate rows, but the model sees the
re-sent history on top of the recalled window for that one turn. Otherwise the
model's whole view of the conversation is the recalled `lastMessages` window
(currently **40** ≈ 20 exchanges — `chatMemory()` in `app/mastra/agent-context.ts`,
shared by every chat agent); raise it if longer sessions must see further back. Older conversations (recorded when
Mastra stored the re-sent history under fresh ids) hold telescoped duplicates; the
viewer collapses them on read (see below).

## Stats & conversation viewer

Teacher-only, under the `/codes` prefix (so the root `/[code]` student catch-all
never collides). Both pages are **role-gated, not owner-gated**:
`requireTeacherPage()` + `getCode(code)` (no `created_by` check) — any effective
teacher may read ANY code's stats/conversations (a larger RBAC feature is
planned). This is NOT the thread-ownership token, which remains the student-side
isolation and is unaffected.

- **`/codes/[code]`** — a thin **dispatcher**: it gates, loads `getCode(code)`,
  renders the shared chrome (back-link + which code + an "LLM override:
  provider · model" line when the code carries one; the coding detail
  additionally shows the EFFECTIVE pinned model), then hands the body to
  `codeModules[entry.module].renderDetail(entry, searchParams)`. Each module owns its
  detail. tutor/quiz render the shared **`ConversationStats`** component
  (`getCodeStats(code, anonymous)`): the interaction count (labelled per module —
  "Conversations" for tutor, "Discussions" for quiz), and for non-anonymous codes
  (the frozen `anonymous` flag) the number of distinct students; then a table of every
  interaction (first/last message time, the student when recorded, user-message count),
  each row linking to the viewer. The student is shown by **display name** —
  `getCodeStats` LEFT-JOINs `novedu_user` and the cell falls back to the raw user id
  (kept as the hover `title`) when no name is recorded yet (see `docs/auth.md`).
  "Interaction" = a Mastra thread with ≥ 1 `role = 'user'` message (opened-but-silent
  threads do not count). **Writing** renders its savers list instead
  (`docs/writing.md`), or falls back to `ConversationStats` when anonymous. Anonymity
  is enforced **at the data layer**: `ConversationStats` passes the code's frozen
  `anonymous` flag into `getCodeStats`, which for an anonymous code forces every
  `userId` **and resolved name** to `null` and `studentCount` to `0` *before
  returning* — so it cannot surface who a student is even if `novedu_user_chats` holds
  rows (the
  documented case where the YAML was toggled to non-anonymous AFTER the code was
  minted). The `!anonymous` rendering checks are belt-and-braces on top of that.
- **`/codes/[code]/s/[userId]`** — the writing module's per-student reading page (one
  student's saved text + their conversations in a lightbox); see `docs/writing.md`.
- **`/codes/[code]/c/[threadId]`** — a READ-ONLY transcript. The server loads the
  messages (`getConversationMessages`, which re-checks the thread's `resourceId =
  code`) and converts each stored Mastra message to an AG-UI `Message` (text
  rebuilt from `parts`; `file` parts become inline images). It then **collapses
  any replayed history** (`collapseReplayedRuns`): conversations that stored the
  full replayed history as telescoping runs `R1 ⊂ R2 ⊂ … ⊂ Rk` would otherwise
  show each turn many times; a run is dropped only when it is an exact element-wise
  prefix of the next, so a clean conversation passes through untouched. The client
  (`ConversationView`) renders them read-only with no agent ever run or connected —
  the frontend rendering (the shared message components, the agent-less provider)
  is `docs/chat.md`. Its `CopilotKitProvider` still pings `/api/copilotkit/info`
  once on mount; that ping succeeds (200) because the runtime route serves **`/info`
  as auth-only metadata** — the student-facing agent list + capabilities, no chat
  data, gated by authentication ALONE — even though the viewer sends no `x-code`
  header. The list is every module's `runtime.agentId`, derived from the registry
  (CopilotKit's client resolves a chat's agent from it and throws for an id it does
  not find, so every `ModuleChat` agent must appear); the internal agents never do. The DATA
  endpoints (`run`/`connect`/`stop`) stay gated by the code AND the thread-ownership
  token. Keep this split in mind when touching the runtime route.
- **Conversation export** — not a page but the bearer route
  `GET /api/codes/<code>/conversations` behind `novedu-cli codes export`
  (`docs/api.md`): every conversation of ONE code as cursor pages, for handing to an
  LLM. Unlike the pages above it is **creator-only** (`created_by` must equal the
  bearer user) and carries **no identity for any code** — no user id, name or
  pseudonym, whatever the frozen `anonymous` flag says; its store
  (`lib/conversation-export-store.ts`) reads only the Mastra tables and never joins
  `novedu_user_chats` or `novedu_user`. Same "interaction" definition and the same
  `collapseReplayedRuns` as the viewer (with an export-shaped key), tool calls kept as
  `tool` parts, photos reduced to `{ mimeType, bytes }` inside Postgres, and at most
  the last 500 messages per conversation (`truncated: true` beyond that). tutor, quiz
  discussions and writing chats export; writing *submissions* do not, and coding
  stores no conversations (an empty export). It is NOT a `checkCode()` site — the
  caller is a teacher on the bearer channel, not a student.

Privacy note: this lets a teacher read the *content* of conversations under their
codes. By design that is allowed — `anonymous` only hides *who* a student is
(the user id), never the message text; the thread-ownership HMAC remains the
student-side isolation and is unaffected.

## Quizzes (the `quiz` module)

A quiz is a code with `module: "quiz"`; its `file_url` points at a `novedu_files`
row of `kind: "quiz"`. Teachers author the quiz YAML on `/files/new` (kind
**Quiz**) — stored with **zero** schema change — and mint a quiz code on
`/codes/new` (module **Quiz**, the file pre-filled from the `/files` "Create code"
shortcut). Students reach it at `/<code>` like any other activity; the runner +
in-page discussion live in `app/[code]/_quiz/`.

- **Quiz YAML** (sample: `activities/examples/sorting-algorithms/sorting-quiz.yaml`, parsed leniently by `parseQuiz` in
  `lib/quiz-yaml.ts`, which starts with the `parseActivityYaml` prefix every lenient
  parser shares, `lib/activity-load.ts`): `id`, `name`, optional `title`/`description` (student
  welcome), `anonymous` (default `true`), `shuffle` (default `true`), optional
  **`question_count`** (attempt length, below), `llm.model`
  (grades AND drives the discussion) with optional `llm.provider` (missing ⇒ SCCH;
  every module's YAML has it — docs/ai-models.md) and optional `llm.imageInput`
  (photo answers, below), optional `discussion.instructions`, optional
  **`quiz_files`** live includes (below), and
  `questions[]` each with `id`, optional `title`, `question` (markdown), an
  optional content `image` (below), an optional `imageInput` override, and
  `evaluation` (the SERVER-ONLY grading prompt). It may also carry an optional
  top-level **`instructions`** host text (rendered once and prepended to both the
  grader and the discussion) with inline `{{fragment "alias.id" …}}` and `{{file
  "alias"}}` markers, plus the **`fragment_files:`** and **`text_files:`** declarations
  the markers draw from (the shared prompt-fragment core — `docs/prompt-fragments.md`).
- **The rendered `instructions` feed BOTH grader and discussion.** The quiz has
  TWO host texts — the top-level `instructions` and `discussion.instructions` —
  rendered **once** at load in a single pass (`loadQuiz`, `lib/quiz-fetch.ts`,
  `validateLibraries: false` — the hot path; `assembleFragmentPrompts` fetches the
  document's fragment/text files once and expands each host's inline
  `{{fragment}}`/`{{file}}` markers in textual order) into the server-only
  `Quiz.instructionsPreamble` and the rendered `Quiz.discussionInstructions` (a
  fetch / consistency / assembly failure in EITHER host fails the load closed).
  `buildGradingPrompt` (`lib/quiz-actions.ts`) prepends the preamble ahead of the
  fixed grading frame + the question's `evaluation`, and
  `buildDiscussionInstructions` (`lib/code-modules/quiz.ts`) prepends it ahead of
  the discussion system prompt — so a shared safety/persona fragment governs both.
  `evaluation` stays a plain per-question string — no markers there;
  `instructionsPreamble` is server-only and `toPublicQuiz` never copies it (nor
  `discussionInstructions`).
- **Compound quizzes (`quiz_files`) — LIVE includes.** A quiz may reference other
  quiz files (each entry an alias `id` + http(s)-or-relative `url`, mirroring
  `fragment_files` refs; the alias additionally may not contain `/`) and pull in
  **ALL** of their questions, fresh on every load — the canonical use is a
  final/overall quiz over per-chapter quizzes, which never goes stale when a
  chapter is edited. Semantics, all implemented at IMPORT time inside `loadQuiz`
  (`lib/quiz-fetch.ts`) so downstream a compound quiz is just a `Quiz` with more
  questions:
  - **Namespacing:** imported question ids become `"<alias>/<id>"` — collisions
    across chapters are impossible; the strict gate rejects OWN ids containing `/`
    (`QUIZ_QUESTION_ID_RESERVED_SLASH`) so an own id can never masquerade as an
    imported one. Aliases have their own namespace (they never appear in `{{…}}`
    markers) and must be unique (`DUPLICATE_QUIZ_INCLUDE_ALIAS`).
  - **Per-source preamble travels — for GRADING only:** the source quiz's rendered
    `instructions` preamble (resolved with the SOURCE's own
    `fragment_files`/`text_files`, relative to the SOURCE url) lands on each
    imported question as the server-only `QuizQuestion.sourcePreamble`, so a
    question grades identically in its chapter quiz and in the compound.
    `buildGradingPrompt` inserts it between the compound's `instructionsPreamble`
    and the grading frame. The DISCUSSION prompt uses only the compound file's own
    `instructions` + `discussion.instructions` (`buildDiscussionInstructions`) —
    chapter preambles never enter it, exactly like every other include-level field
    the compound governs. `toPublicQuiz` strips `sourcePreamble` exactly like
    `evaluation`.
  - **Materialization:** each imported question's `imageInput` becomes the
    source-effective boolean (`question override ?? source quiz-level
    llm.imageInput`), and a relative `image.src` is absolutized against the SOURCE
    url (hosted names + absolute URLs pass through).
  - **Everything else of an included quiz is IGNORED** — `llm`, `anonymous`,
    `shuffle`, `discussion`, `title`, `description`, `question_count` all stay
    governed by the compound quiz's own top level (incl. the code's LLM override
    via `effectiveLlm`, and the compound's own frozen `anonymous`).
  - **One level deep, fail closed:** an included quiz declaring `quiz_files` fails
    the load/validation (`QUIZ_INCLUDE_NESTED`) — no recursion, no cycles. At
    runtime ANY include problem (bad ref, duplicate alias, unfetchable, not a
    quiz, nested) fails the whole load with a friendly notice — the final exam
    never silently shrinks. The authoring gate (`loadAndCheckQuiz`) fetches every
    include and runs the FULL strict check on it, wrapping failures as
    `QUIZ_INCLUDE_UNREADABLE` (alias + URL); a quiz with neither own questions nor
    includes is `QUIZ_NO_QUESTIONS` (own `questions` may be empty when includes
    supply the pool). `QuizCheckResult.questionCount` is the RESOLVED pool size
    (own + imported), so `/files` save and code-create metadata show the real exam
    size.
- **Attempt length (`question_count`)** — how many questions ONE attempt asks
  (any quiz, not just compound). Omitted ⇒ every pool question exactly once
  (default); may exceed the pool (drill mode — questions repeat). The sequence is
  built CLIENT-side from the public projection by the pure, client-safe
  `buildQuestionSequence` (`lib/quiz-sequence.ts`, injectable RNG,
  deterministically unit-tested; `QuizRunner` only calls it): with `shuffle: true`,
  repeated independently-shuffled passes over the pool with no immediate repeat
  across a pass boundary (unless the pool has one question), truncated to the
  count — count < pool is a random subset per attempt, count > pool covers the
  pool evenly before repeating; with `shuffle: false`, sequential cycling
  (`1…N, 1…N, …`) truncated — count < pool means "the first N, in order". The
  progress label reads "Question x of `question_count`".
- **Skipping** — before a verdict the student may
  "Skip for now". The walk is the pure, client-safe `lib/quiz-attempt.ts`
  (`QuizRunner` only calls it): the sequence is N SLOTS (positions, not
  questions — drill mode repeats a question across slots), `pending` is a queue
  whose head is the current slot. Answering removes the head; skipping moves it
  to the TAIL ("back of the line"), so skipped slots return after every unseen
  slot, FIFO, and may be skipped again; the last pending slot cannot be skipped.
  After every transition, if the new head asks the question just shown, the
  first later slot asking a different question moves to the front (keeps the
  no-immediate-repeat guarantee). The attempt length never changes; progress
  counts completed slots, so a skip does not advance it. A skipped slot's draft
  (text + photos) is parked in memory per slot and restored on return; the
  summary names skipped slots never answered. Skips never reach the server — no
  action, no metering, no telemetry. Grading stays
  per-question and stateless (a repeated question is graded again) and there is
  **no server-side attempt enforcement** — attempt/result recording remains future
  work. `toPublicQuiz` puts the EFFECTIVE `questionCount` (authored value ??
  resolved pool size) on `QuizPublic`.
- **An optional question `image`** is an
  `ImageRef` from the **image subsystem** (`docs/images.md`) — it carries no
  secret (unlike `evaluation`), so it survives `toPublicQuiz` and is resolved
  server-side (`resolveImageRef`) to a `ResolvedImage` rendered above the question
  markdown by `<ContentImage>`. Its `src` resolves in **three cases**: a hosted
  image **name** (`hosted: true` → looked up in `novedu_images`, turned into its
  `/api/image-content/<id>` byte-route URL), an **absolute** `http(s)` URL (used
  as-is), or a path **relative** to the quiz's own `file_url`. An optional **`credit`** ("Content
  Credentials") is shown small below the image — for a hosted image it defaults to
  the credit set at upload, and a per-question `credit` overrides it. Example:

  ```yaml
  questions:
    - id: compass-rose
      image:
        hosted: true            # look src up by NAME in the app-hosted image store
        src: sample-compass-rose
        alt: A compass rose showing the four cardinal directions.
        credit: Compass rose — CC BY 4.0   # optional, shown small below the image
      question: |
        Which direction is at the top of a standard map?
      evaluation: |
        North is at the top. …   # SERVER-ONLY, never reaches the browser
  ```
- **Photo answers (`imageInput`)** — students may attach photos (e.g. a
  handwritten derivation) to an answer. Two-level gate: quiz-level
  **`llm.imageInput`** (default `false`, same name/placement as the tutor's
  flag) sets the default; a per-question **`imageInput`** overrides it. The
  effective flag is resolved server-side into the public projection
  (`toPublicQuiz` → `QuizQuestionPublic.imageInput`) and **re-derived on every
  server action** — the client copy is never trusted. **Two different size
  limits** live in the shared, DOM-free **`lib/answer-images.ts`**
  (`MAX_IMAGE_BYTES` 5 MB per image, ≤ 3 per answer — the tutor imports the same
  constants) and the browser-only **`lib/image-normalize.ts`**
  (`MAX_RAW_IMAGE_BYTES` 30 MB): the first bounds what may be SENT, the second
  what may be PICKED, and normalization sits between them (below). Every pick
  runs through **`normalizeStudentImage`** client-side; both quiz actions
  re-validate server-side (`validateAnswerImages`, images rejected outright when
  the effective flag is false, and only `image/jpeg` / `image/png` accepted —
  the only two containers the normalizer emits). Transport is **base64 data URLs
  through the existing server actions** (no blob storage) — `next.config.ts`
  raises the global server-action `bodySizeLimit` to 25 MB for the 3×5 MB
  base64-inflated worst case. **Image-only answers are allowed** (Submit gates on trimmed text OR ≥ 1
  photo). Grading sends ONE multimodal user message (text part + one image part
  per photo) to `quizEvaluator`; nothing is persisted — the photos are discarded
  after grading. `startDiscussion` seeds the same photos as stored **`file`
  parts** (data URL in `data`) on the student-answer seed, so the discussion
  agent recalls them from memory and the read-only transcript viewer
  (`lib/conversation-collapse.ts`) renders them with zero changes — a teacher
  sees the photo by design (`anonymous` hides *who*, never *what*). Caveat
  (documented, not enforced — same as tutor): a code's LLM override on an
  image-input quiz must be a **vision-capable** model. Covered hermetically in
  `lib/quiz-actions.unit.test.ts` + `tests/component/quiz-runner.browser.test.tsx`;
  the real vision round-trip is `e2e/quiz-image.spec.ts` (`@live-llm`,
  CI-excluded).
- **`evaluation` never reaches the browser.** `toPublicQuiz` strips it (and
  `model`, `anonymous`, `discussion`) before anything reaches the client; the
  runner ships only the `QuizPublic` projection. Verdict vocabulary is the internal
  enum `correct | partial | incorrect` (`lib/quiz-types.ts`, client-safe), shown to
  students via `verdictLabel` as **"correct / partly correct / wrong."**
- **Grading** runs the memory-less **`quizEvaluator`** agent
  (`app/mastra/quiz-agents.ts`): `submitAnswer` (`lib/quiz-actions.ts`) verifies
  the **code** (`checkCode`), re-loads the quiz, finds the question, builds the
  grading prompt (frame + the question's `evaluation`) onto a `RequestContext`, and
  runs the agent with `structuredOutput: { schema: QUIZ_VERDICT_SCHEMA }`. No
  `Memory` → a `generate()` persists nothing. **The grader is never web-reachable
  by students** — it is not any module's `runtime.agentId`, so
  `agent/quizEvaluator/*` 404s on the runtime route (whose runtime never registers
  it, and whose `/info` never lists it), and `submitAnswer` is its only
  student-facing caller. The **one other caller** is the teacher-only bearer route
  `POST /api/eval/grade` (`novedu-cli eval`, `docs/cli-eval.md`), which supplies its
  OWN system prompt from the client: the server-only `evaluation` prompts still
  never leave the server, and that route persists nothing either.
- The two eval agents (`app/mastra/eval-agents.ts`) are registered under the same
  rule: **`evalJudge` and `evalTutor` are never web-reachable by students** — neither
  is any module's `runtime.agentId`, so `agent/evalJudge/*` and `agent/evalTutor/*`
  404 on the runtime route exactly as `quizEvaluator` does, and their ONLY callers
  are the teacher-only bearer routes `POST /api/eval/judge` and
  `POST /api/eval/respond` (`docs/cli-eval.md`). Both are a step safer still: every
  prompt they run comes from the client, so no server-held `evaluation` prompt is
  involved at all, and both agents are memory-less while the routes persist nothing.
  `evalTutor` additionally binds the tutor's real `tools:` grant, which is harmless
  by construction — the catalog's executors are pure / injected-effect
  (`docs/tutor-tools.md`) and an eval run is teacher-initiated.
- **Discussion** is **non-negotiably in-page**: clicking "Chat about this" opens a
  native modal `<dialog>` over the page (`quiz-runner.tsx` drives
  `showModal()`/`close()`; Escape, a Close button, and a backdrop click all close
  it; closing keeps the thread so "Continue discussion" reopens it, and Next /
  Finish drop it). `startDiscussion` (`lib/quiz-actions.ts`, verifies the code)
  mints a `threadId`, signs the thread-token `(code, userId, threadId)`, and
  persists **three seed messages** (question / answer / verdict+feedback) into a
  Mastra thread (`resourceId = the code`) via the discussion agent's memory; it
  returns only `{ threadId, threadToken }`. The modal shows the graded **feedback**
  on top, then a live `CopilotChat` (agentId `"quizDiscussion"`) that starts
  visually empty (explicit-threadId `connect` replays only the in-process run
  cache) while the model recalls the full seeded context from memory. The seeds
  never reach the client, so a follow-up run carries only the new turn.

## Lifecycle

- Codes are **not** garbage-collected. A code and all of its conversation data
  persist until a teacher deletes it on `/codes` via **"Delete Selected"** — the
  only delete path (`deleteCodesAndData`): for each selected code, the Mastra
  threads/messages via Mastra's own `deleteThread`, then the `novedu_*` rows batched
  in one Drizzle transaction with the Mastra deletes per code outside it (the shared
  multi-delete layer — `docs/filtered-lists.md`; see also `docs/database.md`). An
  expired code stays listed: its activity no longer opens (`checkCode`), but its
  stats remain reachable until it is deleted.
- Drizzle migrations apply at startup — see `docs/database.md`.

## Testing

The overall approach (layers, the `@live` boundary, the no-infra patterns) is in
**`docs/testing.md`**. Code-specifics:

- `e2e/code.utils.ts` mints codes (`mintCode({ module, file, … })`, plus a
  `mintTutorCode` wrapper) by inserting rows directly into `novedu_codes` (loads
  `.env` like Next does), so any browser spec that mints or resolves a code needs
  the live database and is tagged `@live` plus `@live-db` (runs in CI, its LLM
  calls answered by the fake LLM) — or `@live-llm` (local only) when it needs a
  real model or a specific provider.
- The security-critical paths run in CI with **no** DB, because the gate
  short-circuits before any runtime is built: the runtime gate
  (`app/api/copilotkit/[[...slug]]/route.unit.test.ts`, real thread-token HMAC,
  asserts module dispatch, that the grader 404s, that a run/connect runtime registers
  only the module's agent, and — through the real CopilotKit runtime — that `/info`
  lists only the student-facing agents and no thread endpoints), the dispatcher's consumption of
  `checkCode` (`app/[code]/page.unit.test.tsx`) and the tutor render
  (`render-tutor.unit.test.tsx`), the Layer-2 validator seam and the Layer-3
  module dispatch, plus the rejection/error UI
  (`app/code-error.unit.test.tsx`) and the window/pattern logic
  itself (`lib/code-store.unit.test.ts`).
- The **LLM override** is covered in CI end to end across its seams: validation +
  persistence + `effectiveLlm` (`lib/code-store.unit.test.ts`), the save-time
  availability gate (`lib/code-service.unit.test.ts`), each apply point (the
  module descriptor tests, `app/mastra/tutor-agent.unit.test.ts`,
  `lib/quiz-actions.unit.test.ts`, the coding route test), the quick-pick list
  (`lib/llm/presets.unit.test.ts`) and its Apply/Clear behaviour in the form
  (`tests/component/code-form.browser.test.tsx`), the create page's untagged
  smoke (`e2e/permissions.spec.ts`, "the New Code page is accessible" — no page
  or console errors, quick pick shown, Apply disabled), and the form round-trip
  in the `@live-db` CRUD spec (quick-pick apply → stored → shown → cleared).
- The chat flows **through codes** live in `e2e/quiz.spec.ts`,
  `e2e/tutor-chat-reply.spec.ts` and `e2e/writing.spec.ts` — `@live-db` against the
  fake LLM in CI, except the per-provider tutor smokes (`@live-llm`, local-only).

## Future work (deferred)

- **Custom/memorable codes** (the `code` column + the centralized code seam in
  `lib/code-store.ts` are already sized for them).
- Result/attempt recording for per-question aggregates; finer-grained RBAC.
