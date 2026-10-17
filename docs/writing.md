# Writing

Deep reference for the **writing** activity module: a student writes Markdown in an
editor while an AI assistant gives feedback driven by a teacher-provided system
prompt. The assistant can **read** the student's live draft but **cannot and must
not change it**, the student **saves** their text server-side, and a teacher
**reads** saved texts read-only. It slots into the generic **codes** subsystem
through the fixed seams that subsystem already exposes (`docs/codes.md`) — the
generic flow (code store, runtime route, attribution, multi-delete) is untouched.
The always-on invariants are summarized in `AGENTS.md`; this file has the full
mechanics. Read it before touching the writing libs (`lib/writing-*.ts`), the
student surface (`app/[code]/_writing/**`, `app/[code]/render-writing.tsx`), the
teacher review (`app/[code]/_writing/writing-review.tsx`, `app/codes/[code]/s/**`,
`app/codes/[code]/conversation-stats.tsx`, `lib/code-stats-actions.ts`), the agent
(`app/mastra/writing-agents.ts`), the descriptor (`lib/code-modules/writing.ts`), or
the `novedu_writing_submissions` store.

## The seams it uses

Following the "adding a module" checklist in `docs/codes.md`, writing adds itself
through exactly that fixed set of seams; nothing in the generic flow changes.

- **FileKind** — `writing` joins the `FileKind` union (`lib/file-name.ts`), so the
  `/files` kind selector and `novedu_files.kind` carry it.
- **Validator** — `writingValidator` in `fileValidators` (`lib/file-validators.ts`)
  is a strict authoring gate exactly like `quizValidator`: it delegates to
  `loadAndCheckWriting` (`lib/writing-validate.ts`), which runs the `WritingYamlSchema`
  Zod check and **blocks** an invalid save, surfacing `title` and `anonymous` on
  success. Writing defaults `anonymous: false` (below). The `readAnonymousFlag`
  `writing` branch (same file) stays a **lenient** live read for the runtime
  attribution path — deliberately separate from this strict gate. The same validator
  backs `/files` save, code-create, and `novedu-cli validate --kind writing`.
- **CodeModule descriptor** — `lib/code-modules/writing.ts` exports `writingModule:
  CodeModuleDef` with `fileKind: "writing"` (create validation derives from it via the
  registry's `validateCodeFile`), a `runtime` (`agentId: "writing"`,
  `buildRequestContext` loading the YAML and setting the instructions + model on the
  `RequestContext`), and a `renderDetail` (the teacher review, below).
- **Registry + label** — one line in `codeModules` (`lib/code-modules/registry.ts`),
  `"writing"` in `CODE_MODULES`, and the label `{ badge: "Writing", countColumn:
  "Conversations" }` in `codeModuleLabels` (`lib/code-modules/types.ts`).
- **Render case** — a `case "writing"` in the `switch (entry.module)` of
  `app/[code]/page.tsx` delegating to `RenderWriting`
  (`app/[code]/render-writing.tsx`).
- **Agent** — the `writing` agent (`app/mastra/writing-agents.ts`), registered in
  `app/mastra/index.ts`.
- **Types/parser/loader** — `lib/writing-types.ts` (client-safe public shape),
  `lib/writing-yaml.ts` (the lenient parser + the public projection), and
  `lib/writing-fetch.ts` (the shared loader).
- **Authoring** — a `writing` option in the `/files/new` kind selector
  (`app/files/new/create-file-form.tsx`).
- **Store + actions** — `lib/writing-store.ts` (the only access to the new table)
  and `lib/writing-actions.ts` (the save action).
- **Delete** — `deleteCodeRows` (`lib/code-stats-store.ts`) drops a code's
  `novedu_writing_submissions` rows alongside its `user_chats` / `recent_codes`,
  so single and bulk code-delete both clean up saved texts.

The runtime route (`app/api/copilotkit/[[...slug]]/route.ts`) needs **no change**:
it already dispatches by `module`, gates the agent id, and builds the
`RequestContext` from the descriptor. `resourceId` stays the **code** for every
module, writing included.

## Writing YAML

A writing activity is a `novedu_files` row of `kind: "writing"` (authored on
`/files/new`, kind **Writing**) whose URL becomes a code's `file_url`. It is parsed
**leniently** by `parseWriting` (`lib/writing-yaml.ts`), the one place a writing
YAML is read — a small typed read of just the essentials, not a `lib/tutors`-style
Zod gate:

```yaml
id: essay-feedback
name: Persuasive Essay Feedback
title: Write your persuasive essay        # optional welcome heading
description: |                            # optional, shown to the student
  Draft your essay on the left. Ask the assistant on the right for feedback —
  it reads your text but never edits it.
anonymous: false                          # DEFAULT false for writing (see below)
llm:
  model: <model-id>
instructions: |                          # the teacher-provided system prompt
  You are a writing coach. Use the getCurrentText tool to read the student's
  current draft; it also returns word, character, and paragraph counts you can
  use to check length limits. Give feedback on structure, argument, and clarity.
  Never rewrite or edit the student's text; only advise.
placeholder: ""                          # optional starter text for the editor
```

`parseWriting` returns a friendly message (not structured errors) when an essential
field is missing — `llm.model` and `instructions` are required; the student page
shows that as a notice. The YAML / `llm` part of that read (`llm.model`,
`llm.provider`, `llm.reasoning`) is the `parseActivityYaml` prefix every lenient
parser shares (`lib/activity-load.ts`). **`instructions` (the teacher's system prompt) and `model`
are SERVER-ONLY.** The client-safe projection — `toPublicWriting` →
`WritingPublic` (`lib/writing-types.ts`) — carries only `title`, `description`, and
`placeholder`; the render component MUST call it before sending anything to the
browser, so the prompt and model never cross the wire.

A writing YAML may also declare **`fragment_files:`** and/or **`text_files:`** (the
shared prompt-fragment core — `docs/prompt-fragments.md`) and place fragments inline in
the still-required `instructions` with `{{fragment "alias.id" …}}` markers and embed
plain-text files with `{{file "alias"}}` (spliced verbatim, never compiled). `loadWriting`
renders the block through the shared `resolveInstructions` (`lib/activity-load.ts`, the
same step coding uses), i.e. `assembleFragmentPrompt(block, baseUrl, fetch, { validateLibraries: false }, instructions)`
— the hot path — and stores the rendered host text back as `instructions`; a fetch /
consistency / assembly failure fails the load closed. A YAML with **neither**
`fragment_files` nor `text_files` declared returns `instructions` byte-verbatim (never
compiled) and does not fetch.

`lib/writing-fetch.ts` (`loadWriting`) is the single loader shared by the render
component, the save action, the runtime descriptor's `buildRequestContext`, and
`readAnonymousFlag`, so they all read the same activity the same way. Like the quiz
loader it resolves app-hosted URLs (`<origin>/api/files/<name>`) straight from the
database through the shared `appHostedFetcher` (`docs/files.md`) — never a loopback
fetch — and fetches anything else (e.g. a GitHub-hosted file) for real, uncached,
so YAML edits show immediately. Origin is resolved leniently
(`resolveAppOriginOr("")`): on the read/serve path it degrades to a network fetch
rather than hard-failing the way the authoring validator does.

## Privacy default — the writing divergence

Tutor and quiz default `anonymous: true`. **Writing defaults `anonymous: false`** —
review and the Save feature need attribution, so writing opts IN to attribution by
default. This is the one place a module diverges from the app-wide
anonymous-by-default stance. A teacher who wants ephemeral writing sets `anonymous:
true` in the YAML, which **disables saving** (no Save button, no prefill, no
leave-warning — the editor is purely ephemeral; the lightbox and chat still work).

The default lives in **one place** — `asBool(root.anonymous, false)` in
`parseWriting` — and every reader inherits it: the live runtime attribution path
(`readAnonymousFlag`), the save action's defense-in-depth re-read, the render
component's prefill decision, and the frozen copy on `novedu_codes.anonymous` at
create time (via the validator). A YAML-read failure still falls back to the
privacy-safe `anonymous: true` (non-definitive, so it is not cached), consistent
with the rest of the codes subsystem.

## Data model — `novedu_writing_submissions`

One active row per `(code, student)`, **upserted on save** (single version, NO
history — a save overwrites). Relationships are **by value**; there are **no
foreign keys** between `novedu_*` and `mastra_*` (`docs/database.md`), so saved
texts outlive a deleted code unless the code-delete path drops them explicitly
(it does — `deleteCodeRows`).

| column | type | meaning |
| --- | --- | --- |
| `code` | `varchar(32)` | the writing code (= `novedu_codes.code`, same width) |
| `user_id` | `varchar(64)` | the student's session user id |
| `text` | `text` | the saved Markdown |
| `text_updated_at` | `timestamptz` | last save time, UTC |

**Primary key `(code, user_id)`** enforces "one saved text per student per code"
and doubles as the per-code lookup index (code prefix) for the teacher review. Rows
exist only for **non-anonymous** writing codes — an anonymous activity stores
nothing.

## Store — `lib/writing-store.ts` (server-only)

The **only** module that touches `novedu_writing_submissions`, so the upsert and
the per-code reads live in one place. The reads never throw (a DB problem reads as
`null` / an empty list, which callers turn into a graceful message); the save
surfaces the error to its action.

- `getSubmission(code, userId)` — the student's saved row, or `null` (none saved /
  DB error). Backs the render component's prefill.
- `saveSubmission({ code, userId, text })` — the **upsert**: a single `INSERT …
  ON CONFLICT (code, user_id) DO UPDATE` stamping `text_updated_at = now`. The
  PK `(code, userId)` means a student can only ever write their own single row.
- `listSavers(code, { search? })` — the students who saved, **newest save first**,
  each with a count of their qualifying conversations (a correlated subquery joining
  the Mastra tables by value — one round trip, no N+1) and their **display name**
  (a LEFT JOIN on `novedu_user`, `null` ⇒ the caller shows the raw user id; see
  `docs/auth.md`). The optional DB-side `search` matches the name **or** the user id. It
  carries **no text bodies** (the list never loads essay content); the student page
  loads one student's text on demand. Anonymous codes hold no rows, so the list is
  empty.

For the teacher dashboard, `writersOfTeacherStatement(teacherId)` is the subselect of
`(user_id, code, last save)` over the teacher's own non-anonymous writing codes that
the teacher facts store counts into identified students (`docs/home.md`); no user
id or text leaves that statement.

There is **no delete here**: a code's saved texts are dropped inline by
`deleteCodeRows` (`lib/code-stats-store.ts`) on code delete, not through this store
(see **Lifecycle**).

## Save action — `lib/writing-actions.ts` (`"use server"`)

`saveWriting({ code, text })` is the student's only writing server action. The whole
app is behind the sign-in gate, so any caller is authenticated; the writing **code**
authorizes the activity and is **re-verified on every save** (`checkCode`), so a
code outside its window stops accepting saves mid-session. A student may write
**only their own** `(code, user_id)` row — the row key is the session user id, never
client-supplied. The action:

1. trims the text and `checkCode`s the code (rejection → a human-readable message);
2. confirms `entry.module === "writing"`;
3. resolves the session user id (no session → "Please sign in");
4. **re-reads the `anonymous` flag LIVE from the YAML** (`loadWriting`) and
   **rejects** the save when the activity is anonymous — defense in depth, so an
   anonymous writing code never accumulates attributed rows even if a client tries;
5. `saveSubmission(...)`.

Nothing is graded or echoed back — the result is just `{ ok }` or `{ ok: false,
message }`.

## Student writing activity (`/<code>`)

`app/[code]/page.tsx` does the upstream gating (`checkCode`, the server-minted
`threadId` + `x-thread-token`) and dispatches `case "writing"` to `RenderWriting`
(`app/[code]/render-writing.tsx`, a server component). It loads the YAML (uncached,
so edits show immediately), ships **only** the `WritingPublic` projection to the
client, and — when the activity is **not** anonymous — prefills the student's
previously saved text from `getSubmission(code, userId)` so a reload restores work.

The client surface is `app/[code]/_writing/**` (the `_writing` underscore keeps it
out of routing). `WritingSurface` is a **split screen filling the viewport** — both
columns span the full available height (the editor and the chat scroll internally,
the page does not):

- **Left** — the **same** CodeMirror editor used at `/files`
  (`app/files/yaml-editor.tsx`), in **Markdown** mode (`language="markdown"`)
  instead of YAML, and in `fill` mode (`fill` prop → the editor spans the column
  height instead of the `/files` fixed `420px`). Markdown mode **wraps** long lines
  (`EditorView.lineWrapping`) so prose flows instead of scrolling sideways, and it
  drops the editor's "Upload file…" button (`upload={false}` — a student writes in
  place, not by uploading). The editor buffer is the single source of truth for the
  draft; every edit mirrors it into a `currentTextRef` the chat's read-only tool reads.
- **Right** — a **collapsible** feedback chat (`WritingChat`) that fills the column.
- **Divider** — the vertical bar between the columns is both the **toggle** (a
  ›/‹ button that collapses the chat so the editor widens, and re-expands it;
  default expanded) and a **resize handle** (dragging it shifts the editor/chat
  width split, clamped 25–75%). The bar stays put when collapsed, showing ‹ to
  reopen. Resize is a mouse-only enhancement for the side-by-side layout.
- **Responsive** — at/above Tailwind's `md` breakpoint (`48rem`) the columns sit
  side by side with the divider. Below it they **stack** vertically (`max-md:`
  pane utilities: fixed min heights, divider hidden — no collapse, no resize) —
  the chat is always shown, so a chat collapsed on a wide screen is never
  stranded after shrinking to a narrow one. The JS (`SIDE_BY_SIDE_QUERY`
  `matchMedia`) and the `max-md:`/`md:` utilities share that `48rem` value —
  change one, change both. The runtime width split flows through the
  `--editor-grow`/`--chat-grow` CSS variables (set in a `style` prop, consumed by
  the panes' static arbitrary-value flex utilities). The surface keeps a horizontal gutter at
  every width so it is never flush with the window edges.

Behaviour:

- **Prefill** — non-anonymous + a saved row → the editor opens with the saved text;
  otherwise it opens from the activity's optional `placeholder`.
- **Activity prompt** — the YAML `description`, rendered as Markdown above the
  editor. Past 250 characters it collapses to a teaser (first 250 chars + "…") with
  a **more** link that opens the full prompt in a lightbox, keeping vertical space
  for the editor.
- **Save button** — calls `saveWriting`; shown **only** when non-anonymous. A dirty
  flag (`buffer !== lastSaved`) drives its enabled state ("Save" / "Saving…" /
  "Saved") and a `beforeunload` **unsaved-changes warning**. There is **no
  autosave**. On success the baseline advances to the trimmed buffer (mirroring the
  action's own trim) so the dirty flag settles instead of staying dirty over
  trailing whitespace.
- **"Read formatted" lightbox** — a native modal `<dialog>` (Escape, a Close
  button, and a backdrop click all close it) rendering the **current buffer**
  through the shared `MarkdownRenderer` — the same renderer the chat uses. The
  buffer is **untrusted** student input, so it goes through that **sanitized**
  pipeline (below). It and the full-prompt view share one `Lightbox` component
  (the `<dialog>` open/close + chrome) in `writing-surface.tsx`.
- **When `anonymous: true`** — no Save button, no prefill, no leave-warning; the
  editor is purely ephemeral. The lightbox and the AI chat still work.

## AI feedback via a read-only frontend tool

This is the keystone frontend tool. The chat
(`WritingChat`) **consumes the shared `ModuleChat` primitive** (`docs/chat.md`) —
it hands it `agentId="writing"`, `providerKey={code}` (navigating between codes
remounts it → a fresh thread per code, matching the per-code memory scope), the
server-minted `threadId`, and the `x-code` + `x-thread-token` headers. The provider,
the pinned-`threadId` explicit mode, message rendering/streaming/input, and the
`MarkdownRenderer` for assistant messages all live in `ModuleChat`, not here; the
one thing `WritingChat` adds is the `getCurrentText` tool below.

The one writing-specific addition is the **`getCurrentText`** frontend tool,
registered with `useFrontendTool` (`@copilotkit/react-core/v2`) inside an inner
component rendered **within** the provider (the hook must run in the CopilotKit
context). It takes **no parameters**; its handler returns the **live editor
buffer** through `currentTextRef` (never a stale closure — read on call, not
captured), **plus live length statistics** computed from that buffer by the pure
`computeTextStats` (`lib/writing-stats.ts`): `charactersIncludingWhitespace`,
`charactersExcludingWhitespace`, `words`, and `paragraphs`. The assistant uses
them to check a prompt's length requirements (e.g. a min/max word count) against
the draft. `@ag-ui/mastra` forwards the declared tool to the `writing` agent; when
the agent calls it, the browser returns `{ text, …stats }` for the current draft
(whether or not it has been saved).

**The "AI cannot edit the text" guarantee.** The `writing` agent
(`app/mastra/writing-agents.ts`) has **no** write/edit tool — it is read-only **by
construction**. The only tool it can call is the browser-side, parameter-less
`getCurrentText`, which returns the draft and its length stats and changes
nothing; there is no server-side capability that mutates the student's draft. The teacher's `instructions` reinforce
read-only feedback, but the guarantee does not depend on the prompt — it is
structural.

## The writing agent — `app/mastra/writing-agents.ts`

The `writing` agent is configured **entirely per request** from the
`RequestContext`: the descriptor's `buildRequestContext` loads the YAML and sets
`WRITING_INSTRUCTIONS` (the teacher's system prompt) and `WRITING_MODEL` (resolved
against the shared `scchProvider`). The keys are distinct from the other agents' so
a request for one can never satisfy another (defense in depth on top of the runtime
route's agent gating). It is **memory-backed** exactly like `tutorAgent` and the
quiz discussion agent — `lastMessages` window (40), **no** semantic recall — so a
thread persists and earlier turns reach the model through the recalled window.
`resourceId = the code`, set by the runtime route.

Because `getCurrentText` is the only tool and it cannot mutate, and because the
agent is just another `runtime.agentId` on its descriptor, the runtime route gates
it like every other module agent: only `agent/writing/*` for a valid writing code
runs it; every unused endpoint 404s.

## Teacher review (read-only)

The writing review inverts the usual emphasis: the **saved text** is the point, the
chat is secondary. The descriptor's `renderDetail` (`codeModules.writing.renderDetail`,
the per-module detail seam — `docs/codes.md`) IS the `/codes/[code]` body: for an
attributed code it calls the `WritingSaversList` server component
(`app/[code]/_writing/writing-review.tsx`); for an anonymous code (which has no
savers) it falls back to the shared `ConversationStats`. Both are called as **plain
functions**, so no JSX lives in the server-only `.ts` descriptor.

- **Savers list** — `WritingSaversList` calls `listSavers(code, { search })` and
  renders a filtered `DataList` (newest save first): the shared `studentColumn`
  showing the display name (`listSavers` LEFT-JOINs `novedu_user`; the raw user id
  is the fallback and stays the hover `title` — see `docs/auth.md`), a
  **Saved** time, a **Conversations** count, and a **View** link to the student's
  page. A `ListFilterBar` search filters by name OR user id in the DB. There is **no saved-text length column** — that
  would load every essay body; length lives on the student page instead.
- **Student page** — `/codes/[code]/s/[userId]`
  (`app/codes/[code]/s/[userId]/page.tsx`) is the reading view: it loads the code
  (a notice unless it is a non-anonymous writing code), the student's `getSubmission`,
  the savers order (for **Prev/Next** across the class set), and
  `listStudentConversations`. It shows the saved text **full width** through the
  sanitized `MarkdownRenderer`, a word/character header from `computeTextStats`, and
  the student's conversations below.
- **Conversation lightbox** — `StudentConversations`
  (`app/codes/[code]/s/[userId]/student-conversations.tsx`, a client component) lists
  the student's conversations; opening one shows the read-only transcript in a
  `<dialog>`, **lazy-loading** it via the `loadConversationTranscript` server action
  (`lib/code-stats-actions.ts`, teacher-gated) and rendering the existing
  `ConversationView`. Transcripts the teacher never opens are never fetched, and a
  reopened one is served from a per-thread cache.

Access is **role-gated, not owner-gated**, consistent with the rest of `/codes/**`:
the `/codes/[code]` page and the student page both call `requireTeacherPage()`, and
the transcript action calls `requireEffectiveTeacher()`, so any effective teacher may
review any code. An anonymous writing code accumulates no rows, so it shows the
conversation-stats fallback instead of a savers list.

## Sanitization — untrusted student Markdown

Student-authored text is **untrusted** and is rendered in two places — the student's
"read formatted" lightbox and the teacher's student-text page — both through the
shared `MarkdownRenderer` (`app/markdown-renderer.tsx`). That renderer is `react-markdown`
with `remark-gfm` / `remark-math` / `rehype-katex` and **no `rehype-raw`**:
react-markdown does **not** parse raw HTML and allowlists URL schemes, so a
`<script>` or other raw-HTML payload in a student's draft does not survive
rendering. This is consistent with the app's SVG-via-`<img>`-only invariant — no raw
HTML / script passthrough. Keep student content on this sanitized path; do not add
`rehype-raw` to a renderer that displays it.

## Lifecycle

Saved texts are **not** garbage-collected. A `novedu_writing_submissions` row
persists until its student overwrites it (the upsert) or the **code** is deleted.
On code delete, `deleteCodeRows` (`lib/code-stats-store.ts`) drops the code's
submissions alongside its `user_chats` / `recent_codes` rows (the code row last),
so the list's "Delete Selected" (`deleteCodesAndData`, one Drizzle transaction — the
only delete path; `docs/filtered-lists.md`) cleans up saved texts with no separate
path. There are no foreign keys, so the explicit drop is what keeps a deleted code's
texts from lingering. Drizzle migrations apply at
startup — see `docs/database.md`.

## Testing

The overall approach (layers, the `@live` boundary, the no-infra patterns) is in
**`docs/testing.md`**. Writing-specifics:

- **Unit** — the new pure seams: the `writing` validator stub, the
  `readAnonymousFlag` default-`false` branch, `parseWriting` + `toPublicWriting`
  (the server-only `instructions`/`model` are dropped), the descriptor / module
  dispatch (the runtime-route gate accepts `writing` and builds its context, and
  still 404s a non-runtime agent id), and the `anonymous ⇒ no save` rejection in
  `saveWriting` (mock the store / YAML seams). Markdown sanitization is asserted (a
  `<script>` / raw-HTML payload does not survive rendering).
- **Component** — browser/render tests for the student surface (editor prefill, the
  collapse toggle, the Save button shown only when non-anonymous, the dirty state,
  the lightbox rendering sanitized Markdown) AND for the teacher review: the savers
  `DataList` (rows/links/empty/no-match), the student page (gating + the notice
  branches, the word/char header, Prev/Next, the text routed through
  `MarkdownRenderer`), the conversation lightbox (lazy-loads once, caches, error
  state), and the shared `ConversationStats` (summary/table + privacy gating).
- **E2E** — `@live` Playwright flows through a minted writing code: (1) `@live-db` —
  write → save → reload restores → the teacher savers list → open the student to read
  the saved text; (2) `@live-db` — the assistant reads the draft via `getCurrentText`
  (the fake LLM calls the tool on a marker and echoes its result); (3) `@live-db` —
  the full round-trip (write → ask the coach and get SOME reply →
  save → the savers list → the student text is retrievable), built straight on the
  published sample YAML. The SQL test runs hand-written SQL against the ephemeral
  Postgres container, checking the table's `(code, user_id)` upsert key, newest-first
  ordering and per-code delete. Minting a writing code passes `anonymous: false` so the
  review dispatches to the savers list.
