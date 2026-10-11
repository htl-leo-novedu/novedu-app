# Reports

Deep reference for the **reports** feature (GH issue #24): a student who hits
exceptional behavior — good or bad — in an AI interaction flags it to a teacher in
one or two clicks, picking a **reaction** and an optional description; teachers
triage the flags in a global **`/reports` inbox** and mark them resolved. Two
surfaces produce reports — the three chat surfaces (tutor chat, quiz discussion,
writing feedback chat) and each **graded quiz answer**; the coding module has no
in-app UI and is excluded, and a cloze exercise has no Report button. The always-on invariants are summarized in `AGENTS.md`;
this file has the full mechanics. Read it before touching `lib/report-types.ts`,
`lib/report-store.ts`, `lib/report-actions.ts`, `lib/quiz-verify.ts`,
`components/report-button.tsx` and its four mounts (`app/tutor-chat.tsx`,
`app/[code]/_quiz/quiz-discussion.tsx`, `app/[code]/_writing/writing-chat.tsx`,
`app/[code]/_quiz/quiz-runner.tsx`), the inbox (`app/reports/**`), the
`BulkActionButton` in `components/list-selection.tsx`, or the `novedu_reports` store.

## The decision that shapes everything: always attributed

A report is **always attributed to the reporting student** — the reporter's user id
is stored on the row **even under an anonymous code**. This is a deliberate,
student-initiated **waiver of anonymity**, not a leak: the report button carries a
**mandatory, visually prominent notice** — "Reports are not anonymous — your name
and this conversation/answer will be shared with your teacher." — so a student only
ever files a report knowing their identity travels with it. It is created **only**
by that explicit action, never implicitly.

This is one of **three sanctioned exceptions** to the "`novedu_user_chats` is the
only user↔chat link" invariant (`AGENTS.md`, `docs/codes.md`, `docs/auth.md`) —
the siblings are `novedu_coding_keys`, where requesting a coding activity's personal
API key stores the requester's user id behind an explicit on-page notice
(`docs/coding.md`), and `novedu_quiz_results`, a student's own saved quiz or cloze
first-round counts (`docs/home.md`). The discipline that keeps reports honest: the store surfaces
**only the reporter's own** identity. It LEFT-JOINs `novedu_user` (for the
reporter's display name) and `novedu_codes` (for the note/creator), but **never
joins `novedu_user_chats`** or any path that would reveal a *different* student
behind a reported thread — the anonymity promise for everyone but the reporter
stays intact. `getCodeStats`' anonymity zeroing is untouched.

## Data model — `novedu_reports`

**ONE table with a `kind` discriminator** (`"chat"` | `"quiz-answer"`), not two —
the inbox is a single merged, filterable, bulk-resolvable list, so the
discriminator costs only nullable snapshot columns (the same trade
`novedu_codes.module` makes). Surrogate uuid PK like `novedu_files`/`novedu_images`.
Relationships are **by value**; there are **no foreign keys** between `novedu_*` and
`mastra_*` (`docs/database.md`), so a report outlives a deleted code unless the
code-delete path drops it explicitly (it does — see **Lifecycle**).

| column | type | meaning |
| --- | --- | --- |
| `id` | `varchar(36)` PK | surrogate `randomUUID` |
| `kind` | `varchar(16)` | `"chat"` \| `"quiz-answer"` — picks which snapshot columns are populated |
| `code` | `varchar(32)` | the reported activity's code (= `novedu_codes.code`, same width) |
| `user_id` | `varchar(64)` | the reporting student's session user id — **ALWAYS set** |
| `reaction` | `varchar(16)` | one of the four reactions (below), stored verbatim |
| `description` | `text` | optional free text; empty string when none |
| `created_at` | `timestamptz` | when filed, UTC |
| `thread_id` | `varchar(64)` | **chat only** — the reported Mastra thread (null for quiz) |
| `question_id` | `varchar(450)` | **quiz only** — the reported question's id |
| `question_text` | `text` | **quiz only** — the SERVER's authoritative question text |
| `answer_text` | `text` | **quiz only** — the student's graded answer (client-sent) |
| `feedback_text` | `text` | **quiz only** — the grader's feedback (client-sent) |
| `verdict` | `varchar(16)` | **quiz only** — `correct` \| `partial` \| `incorrect` |
| `had_images` | `boolean` | **quiz only** — whether the graded answer carried photos; flagged, **never stored** |
| `resolved_at` | `timestamptz` | resolution timestamp — **resolved ⇔ NOT NULL** (single source of truth) |
| `resolved_by` | `varchar(64)` | the resolving teacher's user id (null while open) |

Indexes: `ix_novedu_reports_code` (the per-code drill-down),
`ix_novedu_reports_resolved_by` (partial, the reports a teacher resolved — their
start page's Listener badge, `docs/home.md`),
`ix_novedu_reports_user_id_resolved` (partial, `user_id` — a reporter's own
resolved reports, their start page's Bug Hunter badge) and
`ix_novedu_reports_resolved_at` (open vs. resolved — the open rows are the working
set). The schema header comment restates the sanctioned-exception rule.

### The reaction vocabulary

A fixed **four-level** scale, defined once in the client-safe `lib/report-types.ts`
(`REPORT_REACTIONS`, in display order best → most urgent) so the button, the store,
and the inbox share one definition: `good`, `omg`, `bad`, `holysh` ("Holy sh.."),
the **urgent tier**, styled distinctly. Teacher-UI badge tones (`report-detail-button.tsx`,
`ReactionBadge`): good→green, omg→purple, bad→orange, **holysh→red solid**. Open
`holysh` rows also float to the top of the inbox and get a red left stripe.

## Submit flow — chat reports

`submitChatReport({ code, threadId, threadToken, reaction, description })` in
`lib/report-actions.ts` (`"use server"`). The whole app is behind the sign-in gate, so
the caller is authenticated; the reporter's user id comes from the **session, never from
input**. Steps:

1. `getSession()` → the session `userId` (no session → "Please sign in").
2. `isReportReaction` narrows the reaction; the description is trimmed and capped at
   `REPORT_DESCRIPTION_MAX`; `threadId` must match `/^[A-Za-z0-9-]{1,64}$/`.
3. `checkCode(code)` re-verifies the code is valid and in-window (same rejection
   wording as the quiz actions, via `CODE_REJECTION_MESSAGES`) — an expired code
   blocks reporting mid-session, consistent with `submitAnswer`.
4. **`verifyThreadToken(threadToken, { code, userId, threadId }, getThreadTokenSecret())`**
   — this is the **first server action to call `verifyThreadToken`**, its designed
   use. The stateless HMAC over `(code, sessionUserId, threadId)` proves the reporter
   owns the reported thread; a leaked token+threadId is useless to anyone but its
   owner. Mismatch → a generic "cannot be reported" message.
5. The soft cap (`countChatReports`, below).
6. `insertChatReport` + a **content-free** telemetry event.

A chat report needs **no snapshot** — the transcript is re-readable server-side at
`/codes/<code>/c/<threadId>` — so it stores just the pointer. A report may reference
a **zero-message thread** (the transcript page already handles it), so no LLM call is
required to file or verify one.

## Submit flow — quiz-answer reports

`submitQuizReport({ code, questionId, answer, result, feedback, hadImages,
reaction, description })`. Quiz grading persists **nothing** (the memory-less
`quizEvaluator`), so a quiz report must **carry its own snapshot**. Steps 1–2 mirror
the chat action (reaction + description validation), then:

- **`verifyAndLoadQuestion({ code, questionId })`** from `lib/quiz-verify.ts` does
  auth + `checkCode` + `module === "quiz"` + `loadQuiz` + find-the-question, all
  server-side, and returns the **server-authoritative** question.
- The snapshot mixes **server-trusted** and **client-sent** data — an accepted trust
  trade, the same one `startDiscussion` makes (nothing server-side exists to check a
  graded turn against):
  - `question_text` = **the server's `question.question`** — immune to client
    tampering and to later YAML edits.
  - `answer_text` / `feedback_text` = the student's own graded turn, client-sent,
    trimmed and **size-bounded** (`QUIZ_SNAPSHOT_MAX`, ~32k) so a tampered client
    can't store an unbounded blob.
  - `verdict` = `result`, which must be one of `correct` | `partial` | `incorrect`
    — **rejected, never coerced**, if unknown.
  - `had_images` flags whether the graded answer carried photos; the bytes are
    **never** stored.
- Soft cap (`countQuizReports`), `insertQuizReport`, content-free telemetry.

### Why `lib/quiz-verify.ts` exists (the `"use server"` hazard)

`verifyAndLoadQuestion` is shared by grading (`lib/quiz-actions.ts`, a
`"use server"` module) and quiz reports (`lib/report-actions.ts`). **Exporting it
from a `"use server"` module would mint a public server-action endpoint** that
returns the loaded `Quiz` — which carries the server-only `evaluation` grading
prompts (they may embed the expected answer). So it lives in `lib/quiz-verify.ts`,
a **server-only module deliberately WITHOUT the `"use server"` directive**, together
with `CODE_REJECTION_MESSAGES` and `effectiveImageInput`, and both callers import it
as plain server code. **`lib/quiz-verify.ts` must never gain the `"use server"`
directive** — that would open exactly that endpoint.

## Telemetry — content-free

Both submit actions emit `report.submitted` on success with **metadata only**:
`{ kind, reaction, code }`. The event **never** carries the description, the quiz
snapshot, or any student content (`docs/telemetry.md`).

## Soft caps

`MAX_REPORTS_PER_TARGET` (3, in `lib/report-types.ts`) caps how many reports one
student may file **per target** — per `(thread, user)` for chat, per `(code,
question, user)` for quiz. `countChatReports` / `countQuizReports` do the check; a DB
error there returns `undefined` and the action **declines** rather than filing an
unbounded row. It is a soft, per-student cap (a friendly "your teacher will take a
look" message), not a global rate limit.

## Store — `lib/report-store.ts` (server-only)

The **only** module that touches `novedu_reports`. Follows the `writing-store.ts`
conventions: **reads never throw** — a DB error reads as `undefined`, which the
callers turn into a graceful message; `insert*`/`set*`/`delete*` return `false` on
error.

- `insertChatReport` / `insertQuizReport` → `boolean`.
- `countChatReports` / `countQuizReports` → `number | undefined` (the soft-cap checks).
- `listReports({ status, reaction?, search?, codeCreatedBy? })` → `ReportListRow[] |
  undefined` — the inbox query, filtered **in the database** (`docs/filtered-lists.md`)
  by resolution status (`open` = `resolved_at IS NULL`, `resolved` = NOT NULL, `all`),
  reaction, a `containsAny` free-text search (description, reporter user id + name,
  code, code note), and — for "Only my codes" — the code's creating teacher. LEFT-JOINs
  `novedu_user` (reporter name, user-id fallback) and `novedu_codes` (note/creator) **by
  value**; a report whose code was deleted still lists (both joins yield `null`). It
  **NEVER joins `novedu_user_chats`**. Ordered so open `holysh` reports float to the
  top (a raw `sql` CASE), then newest first.
- `getReportById(id)` → `ReportListRow | null | undefined` — the **single-row twin
  of `listReports`**, with the same `novedu_user` / `novedu_codes` LEFT JOINs by
  value and the same `novedu_user_chats` prohibition; `null` = not found,
  `undefined` = DB error, never throws. Backs the bearer `GET /api/reports/<id>`
  (below).
- `setReportsResolved(ids, resolved, teacherId)` — bulk resolve/reopen. Resolving
  stamps `resolved_at = now` + `resolved_by = teacherId` on the **open** reports
  only — an already-resolved report keeps its first resolver and time (the
  resolver's Listener badge, `docs/home.md`); reopening **nulls both** columns
  (`resolved_at` is the single source of truth). No-op for an empty id list.
- `deleteReports(ids)` — bulk DELETE, the inbox's "Delete Selected".
- Start-page facts (`docs/home.md`), each one statement that returns dates and
  counts, never a reporter or content, and never throws:
  `listOwnResolvedReportDates(userId)` (the local dates the user's OWN reports were
  resolved — Bug Hunter) and `loadTeacherReports(teacherId, resolvedCap)` (open
  reports per own code plus the reports the teacher resolved — the dashboard's
  Open reports and Listener; one row of scalar subselects,
  `teacherReportsStatement`).

## Teacher inbox — `/reports`

A global, **teacher-only** filtered list (`app/reports/page.tsx`) over all reports,
built on the shared filtered-list concept (`docs/filtered-lists.md`) exactly like
`/codes` and `/files`: DB-side filtering via URL search params, `DataList` +
`ListFilterBar`, `SelectionProvider` + `selectionColumn`, bulk-only actions, a
sibling `loading.tsx`.

- **Gate** — `isEffectiveTeacher()` → `AccessDenied`. It is **role-gated, not
  owner-gated** (any effective teacher can review any code's reports), and honors
  student mode: a teacher "viewing as student" is denied like a student.
- **Params** — `status` (default `open`), `reaction`, `q`, `mine` (default ON →
  `codeCreatedBy` = the session user id).
- **Columns** — the multi-select `selectionColumn` (key = **report id**), Reaction
  badge, Kind badge, Code (note‖code, link to `/codes/<code>`), Student (display name
  ?? user id, user id as hover title), Created (`LocalTime`), Status badge (open=orange /
  resolved=green). The **description is not a list column** (it can be long) — it lives
  only in the detail dialog; the `q` search still matches it DB-side. Actions: chat rows
  link to the existing transcript `/codes/<code>/c/<threadId>?from=reports` — the
  **`from`** param is a **closed enum**, only the literal `reports` switches the
  transcript's back link to "Back to reports" → `/reports` (any other value keeps the
  default "Back to stats" → `/codes/<code>`; a raw URL is never accepted). Every row
  also gets a **detail dialog** (`report-detail-button.tsx`, description + its own
  origin-tagged transcript link) — the whole snapshot already rides on the row, so it is
  a dialog, not a `/reports/[id]` route. Open `holysh` rows get a red left stripe.
- **Detail dialog trust boundary** — the quiz **question** (server-authoritative) and
  **feedback** render through the sanitized `MarkdownRenderer`; the **student's
  answer** is untrusted free text and renders as plain `whitespace-pre-wrap`, never
  through markdown.
- **Toolbar** — two `BulkActionButton`s ("Mark resolved", "Reopen", no confirm) plus
  `DeleteSelectedButton itemNoun="report"`. `BulkActionButton` is the additive,
  non-delete generalization of the selection layer (`docs/filtered-lists.md`).
- **Nav** — `components/nav-menu.tsx` adds `{ href: "/reports", label: "Reports",
  teacherOnly: true }`.

Per-code report surfacing (a link from `/codes/[code]`) is deferred follow-up.

## Bearer channel — CLI/API triage

Reports are also reachable over the Entra **bearer** channel (`docs/api.md`), so a
coding agent driving `novedu-cli` can run the triage-and-fix loop
(`reports list` → `reports show <id>` → fix the activity YAML → `files upload` →
`reports resolve <id…>`). Three teacher-only routes under `app/api/reports/**`
(each self-gated with `requireBearerTeacher()`) back the `reports list/show/resolve`
CLI group; the full route conventions and wire shapes live in `docs/api.md`. The
reports-specific invariants:

- **Resolve-only scope.** The channel exposes list, detail, and **resolve** — and
  nothing else. **Reopen and delete stay web-only, deliberately:** an agent should
  never destroy a student's report, and a mis-resolution is corrected by a human in
  the `/reports` inbox. There is no report-submission route either — reports are
  filed only by authenticated students in the app, never by the CLI.
- **`resolved_by` is the token's user id.** `POST /api/reports/resolve` calls the existing
  `setReportsResolved(ids, true, userId)` with the verified token's user id, so a report an
  agent resolves is attributed exactly like the web action — to the teacher who ran
  `novedu-cli login`. Unknown / already-resolved ids are silent no-ops — an
  already-resolved report keeps its first resolver (the same update the inbox uses).
- **The identity discipline carries over.** The API surfaces only the **reporter's
  own** identity (`userId` + `displayName`), never a different student behind a
  reported thread — `getReportById` is the single-row twin of `listReports` and, like
  every read in this store, **never joins `novedu_user_chats`**. The report is
  explicitly non-anonymous toward teachers (the sanctioned waiver above); the channel
  is teacher-only, so nothing widens who can see it.
- **Transcript embedding — chat reports only.** `GET /api/reports/<id>` on a `chat`
  report embeds the conversation via `getConversationMessages(code, threadId)`
  (`lib/code-stats-store.ts`), the same collapsed sequence the web transcript page
  renders and already scoped to the reported thread by its Mastra `resourceId` — so
  the agent gets the report and its transcript in one call. A **quiz-answer** report
  carries no `messages`: its server-authoritative snapshot (question text, answer,
  feedback, verdict) is already on the row, and — as everywhere — that snapshot never
  contains the server-only quiz `evaluation` prompts. Report detail is the bearer
  channel's per-thread transcript access, open to any teacher; whole-code transcripts
  are a separate, stricter surface — the conversation export
  `GET /api/codes/<code>/conversations` (`docs/api.md`), open ONLY to the code's
  creator and carrying no student identity.

## Lifecycle

Reports are **not** garbage-collected; a row persists until a teacher deletes it
("Delete Selected") or the **code** is deleted. On code delete, `deleteCodeRows`
(`lib/code-stats-store.ts`) drops the code's reports alongside its `user_chats` /
`recent_codes` / `writing_submissions` **inside the one Drizzle transaction** (the
code row last), so the list's bulk delete (the only delete path — `docs/filtered-lists.md`)
cleans up reports with no separate path. There are **no foreign keys**, so this
explicit drop is what keeps a deleted code's reports from lingering.

## Testing

The overall approach (layers, the `@live` boundary) is in `docs/testing.md`.
Reports-specifics:

- **`lib/report-actions.unit.test.ts`** (hermetic) — mocks `@/auth`,
  `@/lib/code-store`, `@/lib/quiz-verify`, `@/lib/report-store`, and telemetry, but
  keeps **`lib/thread-token` REAL** (the security-critical pure module, per
  `docs/testing.md`) and signs genuine tokens with a test secret. Covers: missing /
  invalid / wrong-user token, unknown reaction, over-cap description, soft cap,
  expired code; and for quiz — the server-authoritative question text (client copy
  ignored), unknown question, invalid verdict rejected, session user-id attribution,
  content-free telemetry; plus the teacher bulk actions (resolve / reopen / delete,
  non-teacher blocked, non-uuid id list rejected).
- **`lib/report-store.unit.test.ts`** — the insert shapes (chat vs. quiz snapshot),
  the count helpers, `listReports` filter-building, the resolved-at resolve/reopen
  semantics, and the never-throw (`undefined` / `false`) error paths, over a mocked
  `getDb`.
- **`tests/component/report-button.browser.test.tsx`** — the dialog opens with the
  reactions, the mandatory attribution notice is present (worded per kind), submit is
  gated on a reaction, the correct action gets the right payload (chat token / quiz
  snapshot), success + error states, and the description counter/cap.
- **`app/reports/page.unit.test.tsx`** — the teacher gate (a non-teacher / student-mode
  teacher is denied **without** querying), row rendering, the default filters (status
  `open`, only-my-codes on), the reaction + `mine=0` params, an unknown reaction
  ignored, and the store-error notice.
- **`e2e/reports.spec.ts`** — the `@live` + `@live-db` end-to-end (mints a tutor code
  via `e2e/code.utils.ts`; no LLM needed, since a report can reference a zero-message
  thread): a student submits a report (asserting the attribution notice), the teacher
  sees the row in `/reports`, then marks resolved → reopen → delete selected.
