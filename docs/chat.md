# Chat (the CopilotKit surface)

Deep reference for the **live chat** — the single most reused surface in the app.
Every module's chat (tutor feedback, the writing assistant, the quiz discussion)
is **one shared primitive**, `ModuleChat`, plus that module's own slots; the
read-only conversation transcript is a deliberately separate surface. The
always-on invariants are summarized in `AGENTS.md`; this file has the full
mechanics. Read it before touching `app/module-chat.tsx`, the consumers
(`app/tutor-chat.tsx`, `app/_tutor/welcome-view.tsx`,
`app/[code]/_writing/writing-chat.tsx`, `app/[code]/_quiz/quiz-discussion.tsx`),
the read-only transcript (`app/codes/[code]/c/[threadId]/conversation-view.tsx`),
the runtime-header helper (`lib/runtime-headers.ts`), the student-photo pipeline
(`lib/image-normalize.ts`, `lib/image-report.ts`,
`components/image-error-notice.tsx`, `app/image-check/**`), or the failure-
reporting runner (`app/api/copilotkit/run-error-runner.ts`).

This is the **frontend** seam only. The backend — the `/api/copilotkit` route and
the per-module `CodeModuleRuntime` — lives in `docs/codes.md` and is untouched by
anything here.

## The one primitive (`ModuleChat`)

`app/module-chat.tsx` (a `"use client"` component) owns the dangerous, duplicated
CopilotKit wiring so each module supplies only what is unique to it. It owns:

- the **`CopilotKitProvider`** pointed at `runtimeUrl="/api/copilotkit"`, with the
  runtime `headers` prop and a `key` set to `providerKey` (the remount boundary);
- the **`@copilotkit/react-core/v2/styles.css`** import (once, here);
- the **`CopilotChat`** element with the server `threadId` pinned in explicit mode,
  the module's `agentId`, and the passthrough slots `labels` / `chatView` /
  `attachments`;
- the **markdown renderer** — `messageView={{ assistantMessage: { markdownRenderer:
  MarkdownRenderer } }}` (`MarkdownRenderer` from `./markdown-renderer`), so every
  module's assistant messages render math and code the same way;
- the **base chat container** — a `<div>` holding `CopilotChat`, with the fill
  recipe built in (`min-h-0 flex-1 overflow-hidden *:h-full`: fill the available
  height, never push the page taller, let CopilotChat own the internal scroll);
  the optional `className` prop is a cn-merged delta on top.

Modules supply the rest through props/slots:

| Slot | Type | What it carries |
| --- | --- | --- |
| `agentId` | `string` | the module runtime's agent id (must match the registered agent) |
| `threadId` | `string` | the server-minted Mastra thread id (pinned in explicit mode) |
| `headers` | `RuntimeHeaders` | the `x-code` + `x-thread-token` pair (below) |
| `providerKey` | `string` | the provider remount boundary — code (writing), threadId (quiz), or `code:threadId` (tutor, whose "start over" moves the thread half) |
| `className` | `string?` | optional height/padding deltas, cn-merged onto the built-in chat container |
| `children` | `ReactNode?` | rendered INSIDE the provider, before the chat — frontend tools, feedback headers |
| `labels` | passthrough | welcome-greeting override (tutor) |
| `chatView` | passthrough | welcome-screen view override (tutor) |
| `attachments` | passthrough | image-upload config (tutor, vision-capable model — normalized, below) |

`children` render **inside** the provider and **before** the chat container, so a
slot that needs the CopilotKit React context — the writing tool registrar, the
quiz feedback header — works. The primitive is layout-agnostic: it renders
`{children}` + the chat `<div>` as a bare fragment, so a module that needs to lay
them out together (e.g. quiz's discussion body) wraps `<ModuleChat>` in its own
container — the provider emits no DOM, so that wrapper stays the surface's root.

```tsx
// className carries only writing's deltas (column flex + horizontal padding) —
// the fill recipe is ModuleChat's own.
<ModuleChat agentId="writing" providerKey={code} threadId={threadId} headers={headers} className="flex flex-col px-3">
  <GetCurrentTextTool currentTextRef={currentTextRef} />
</ModuleChat>
```

## The threadId gotcha

The single canonical explanation lives in `app/module-chat.tsx`, right above the
`CopilotChat` element. In short: the server-issued `threadId` MUST go through
**`CopilotChat`'s `threadId` prop** (explicit mode), **not** through
`CopilotChatConfigurationProvider` with `hasExplicitThreadId={false}`. The latter
looks equivalent but strands the agent mid-run — messages cleared, the chat stuck
"running" — on the first send. Explicit mode also fires a `connect` request on
mount, token-checked exactly like a `run`: for a fresh thread the runtime replays the
(empty) in-process history; for a tutor thread resumed after a reload the snapshot
runner answers it with the stored conversation (below).

Because the explanation now lives in one place, no module duplicates it. The one
deliberate interaction with it is the tutor welcome view (below), which overrides
the view's explicit-threadId gating flags to re-show the welcome screen — and that
override is documented next to itself in `app/_tutor/welcome-view.tsx`.

## Runtime headers

`lib/runtime-headers.ts` is the pure, client-safe seam that names the two runtime
headers and builds the object the provider's `headers` prop expects:

```ts
export const RUNTIME_CODE_HEADER = "x-code";
export const RUNTIME_THREAD_TOKEN_HEADER = "x-thread-token";
export type RuntimeHeaders = { "x-code": string; "x-thread-token": string };
export function buildRuntimeHeaders(code: string, threadToken: string): RuntimeHeaders;
```

`x-code` identifies the activity; `x-thread-token` is the stateless-HMAC
thread-ownership token over `(code, userId, threadId)`. Both are sent on **every**
runtime request (headers, not a query string, because CopilotKit appends sub-paths
like `/info` to the runtime URL) and both are **re-verified server-side on every
runtime touch** — never a bare DB lookup. The token is what isolates one student's
thread from another's; its derivation and the reasons it is stateless are in
`docs/codes.md`. The backend route reads the same header names literally, so the
constants here are the load-bearing contract.

Render sites build the pair once and hand it down: `app/[code]/render-tutor.tsx`
and `app/[code]/render-writing.tsx` pass `buildRuntimeHeaders(code, threadToken)`
into their chat components, and the quiz runner builds it for the discussion modal.

## How each module consumes it

Each consumer is a thin shell around `ModuleChat` that adds only its own DOM and
slots; none of them re-implement message rendering, streaming, input, the
provider, or the threadId decision.

**Tutor** (`app/tutor-chat.tsx`) wraps `ModuleChat` (`agentId="tutor"`, a
`providerKey` of `code:threadId`) in the tutor-specific shell: the dismissible
**image-upload error notice** and the toolbar row (**previous conversations** for a
per-user tutor + **start over** + the shared `ReportButton`). It passes `labels` (the optional welcome greeting),
a `chatView` from `useTutorWelcomeView(...)` (`app/_tutor/welcome-view.tsx` — the
fragile welcome-screen override, pinned to a CopilotKit version in a comment next
to itself), and, when the tutor's `llm.imageInput` is set, an `attachments` config
(vision-capable model, `onUpload` running the normalizer below, `onUploadFailed`
driving the notice). Tutor needs
no height/padding delta, so it passes no `className`: `ModuleChat`'s base container fits it.

It is also the only surface that **owns its thread after mount**. The server props
merely seed a `thread` state (`{ threadId, threadToken, restoring }`), decided after
mount (see "Resuming a conversation" below); the runtime headers, the report target
and the provider key are all derived from that state, so a restart or a resume moves
them together. Every thread change is written to the tab's `sessionStorage`.

### "Start over" (tutor only)

`app/_tutor/start-over-button.tsx` is an `IconButton` (`aria-label` + `title` —
the app has no tooltip component) that opens a `DialogShell` confirmation in one of
two wordings, keyed by `historyEnabled`: an anonymous tutor's ("Start over?": the
conversation is gone for the student for good, the teacher can still read it but
cannot see whose it was) and a per-user tutor's ("Start a new conversation?": the
current one is kept and can be reopened under Previous conversations). It then
calls **`startNewTutorThread`** (`lib/tutor-actions.ts`). That action re-runs the
full gate — session user id, `checkCode`, `module === "tutor"` — and returns a fresh
`(threadId, threadToken)` pair. `TutorChat` swaps it in, the `providerKey` changes,
the provider remounts, and CopilotKit's in-browser message list is discarded.

The round-trip is not optional: the ownership token is an HMAC over
`(code, userId, threadId)` keyed off `AUTH_SECRET` (server-only), so the browser
cannot mint one — and clearing the transcript client-side (`agent.setMessages([])`)
would leave the **same** threadId, whose last 40 messages the tutor still recalls.
It grants nothing new either: `app/[code]/page.tsx` already mints a fresh thread on
every page load. The new pair replaces the tab's stored one, with `restoring` off (a
fresh thread has nothing to restore).

Two consequences worth knowing:

- the abandoned thread is **not deleted** — it stays in `mastra_messages`, the
  teacher can still read it, and a report already filed against it still resolves;
- a restart yields a second thread, so a student who chats before *and* after shows
  as **two interactions** in the code's stats (`lib/code-stats-store.ts` counts
  threads with ≥1 user message) and gets a second `novedu_user_chats` row on
  non-anonymous codes. A restart with nothing sent stays invisible.

### Resuming a conversation (tutor only)

An accidental reload must not throw a student's conversation away. The tab
remembers its current `{ threadId, threadToken }` in `sessionStorage`
(`lib/tutor-thread-storage.ts`, keys `novedu.tutorThread.<code>`; every access
try/caught, so blocked storage simply turns the feature off). Why that is safe —
the token verifies only for the session user, the browser cannot mint one — is in
`lib/thread-token.ts`; the server-side rules are in `docs/codes.md`.

**The client flow** (`app/tutor-chat.tsx`). Storage is browser-only, so the server
render and the first client render both show a "deciding" placeholder (no
`ModuleChat`, no toolbar) and an effect decides:

- nothing stored → the server-minted thread from the props, written to storage;
- a stored pair → "Restoring your conversation…" while `resumeTutorThread` checks
  it; `{ ok: true }` mounts the chat on the stored thread with `restoring: true`;
  a refusal or a thrown action (network) drops the entry and falls back to the
  server-minted thread.

`restoring` feeds the welcome view: `useTutorWelcomeView` passes it as the view's
`isConnecting`, which holds the welcome screen back until the snapshot lands.
CopilotChat's own `isConnecting` cannot be used — it clears after the provisional
agent's first connect, before the real connect that carries the snapshot. If that
connect brings nothing, the student sees an empty chat with a working composer.
Sign-out (`components/user-menu.tsx`) calls `clearAllTutorThreads()` in the form's
`onSubmit`, before the action posts, so the next person on the tab inherits nothing.

**The snapshot runner** (`app/api/copilotkit/history-snapshot-runner.ts`). An
`AgentRunner` decorator the route puts INNERMOST for tutor codes only —
`RunErrorReporting(ReasoningStripping(HistorySnapshot(InMemory)))` for students,
`RunErrorReporting(HistorySnapshot(InMemory))` for teachers — so the other two
decorators see its frames like any other. `run`, `isRunning` and `stop` delegate
untouched. On `connect` it reads the thread from the database
(`loadThreadForChat`, `lib/tutor-history-store.ts`: messages joined through
`mastra_threads` with `resourceId = code`, mapped by `toAguiMessage` +
`collapseReplayedRuns`, ids unchanged) and, when the **resume rule** allows it,
answers with

```
RUN_STARTED{runId:"restore-<uuid>"} · MESSAGES_SNAPSHOT · RUN_FINISHED
```

followed by the inner connect, filtered. Facts it rests on (verified against the
installed packages, none of them documented API):

- the browser wipes the agent's messages on the first connect of a thread and then
  applies the stream; a `MESSAGES_SNAPSHOT` replaces the local list;
- the client verifier wants run framing: `RUN_STARTED` first, nothing but a new
  run after `RUN_FINISHED`, and nothing at all after `RUN_ERROR`;
- `InMemoryAgentRunner` keeps a process-global, LRU-bounded store of past runs and
  replays them on `connect`; the client APPENDS a replayed `TEXT_MESSAGE_CONTENT`
  to an existing message, so an unfiltered replay would double the text;
- ids line up: a user message keeps its client-minted id in `mastra_messages`, an
  assistant reply streams under its stored id (or `<id>-agui-text` for text after a
  tool call), and a tool call names that id as its `parentMessageId`;
- a failed run that emitted any event is replayed with a terminal `RUN_ERROR`.

So the filter drops every `TEXT_MESSAGE_*` / `REASONING_*` event of a stored id (or
its `-agui-text` twin), every tool call parented on a stored message with its
args/end/result, and the reasoning of every run that already FINISHED (reasoning is
never stored, so the snapshot cannot place it; replayed, it would land as a stray
block below the restored conversation; only teachers receive reasoning at all). It
turns a HISTORIC `RUN_ERROR` into a `RUN_FINISHED` of the same run (a LIVE one, the
in-flight run failing, passes), and an in-flight run keeps its reasoning. Historic vs live: the in-memory
runner pushes its history into a `ReplaySubject` before `connect` returns, so what
arrives during the subscribe call is history — pinned by the unit test. Result: a
cold process gets the snapshot only; a warm one the snapshot plus bare run frames
(and any run whose save failed); a reload mid-answer gets the snapshot plus the
live reply. The database is read BEFORE subscribing to the inner connect, so a run
finishing in between is replayed rather than lost. A refused rule, an empty thread
or a database error fall back to the plain inner connect, never a `RUN_ERROR`.

**The resume rule** (`lib/tutor-history-gate.ts`): the action accepts a thread whose
last stored message is under 60 minutes old; the runner allows 5 minutes of grace
on top (the gap between the action's check and the connect). Past that, both accept
only a thread the student may reopen anyway (`ownerMayReopen`: a history-enabled
code and their own `novedu_user_chats` row), so a conversation reopened from
Previous conversations survives a reload too; that branch reads the YAML, but only
runs past the limit. The connect is already token-verified, so a hand-crafted
client holding an old token gets no more from `connect` than the actions would
allow.

Consequences worth knowing:

- continuing a restored thread is an ordinary run: the client re-sends the
  snapshotted history, and `@ag-ui/mastra` drops the re-sent messages by id; the
  tutor still recalls only its `lastMessages` window (40), while the student sees
  every message;
- restored photos ride the connect stream as the data URLs the student sent
  (≤ 5 MB each);
- a duplicated tab inherits `sessionStorage` and shares the thread; two
  simultaneous sends then hit the in-memory runner's "Thread already running", an
  ordinary turn error;
- a reload mid-answer after more than 60 minutes of silence fails the resume (it
  reads the last STORED message), and the in-flight reply lands in the abandoned
  thread;
- `CopilotChat` connects twice per mount (provisional agent, then the real one):
  two database reads, harmless.

**Before any `@copilotkit/*`, `@ag-ui/*` or `@mastra/*` bump**, wrap any new
`AgentRunner` method in all three decorators, and run `npm run test:e2e:live-llm`
locally. CI already runs the reload round-trip `e2e/tutor-reload-roundtrip.spec.ts`
— the only test of the replay filter against a real browser in a warm process —
and `e2e/reasoning-visibility.spec.ts` against the fake LLM (`docs/testing.md`);
the local real-LLM run adds what the fake cannot: a real thinking model's
reasoning stream (the `@live-llm` twin of the reasoning-visibility teacher leg)
and the provider smoke tests.

### Previous conversations (per-user tutors only)

`app/_tutor/previous-conversations-button.tsx` is rendered only when `TutorChat`
gets `historyEnabled` (`app/[code]/render-tutor.tsx`: frozen AND live `anonymous`
false, `docs/codes.md`). An `IconButton` with the `HistoryIcon` (left of Start over)
opens a `DialogShell` (`size="fit"`, `w-[min(36rem,92vw)]`) that calls
`listTutorThreads` every time it opens:

- a notice first: this tutor is not anonymous, the teacher sees the conversations
  and that they are the student's;
- full-width row buttons, newest last activity first: the time
  (`formatConversationTime`, `lib/conversation-time.ts`, the browser's locale and
  zone: "Today, 14:32", "Yesterday, 09:10", "Mon, 6 Oct, 11:05", "6 Oct 2025,
  11:05"), the student's message count, and the preview as plain text
  (`line-clamp-2`; "📷 Photo" for a photo-only first message, "(no text)" for none);
- the current thread sits where its time puts it, marked "Current" and disabled; a
  fresh, still-empty current thread has no row;
- a footer when there are more than 50; states for loading, empty ("No earlier
  conversations with this tutor yet."), and a list failure with **Try again**.

Picking a row calls `openTutorThread` (spinner in that row, the others disabled).
On success the dialog closes and `TutorChat` switches to the returned
`{ threadId, threadToken }` with `restoring: true`, writing it to the tab's storage;
the messages arrive with the remounted chat's `connect`, where the snapshot runner's
ownership branch admits it however old it is. A refusal shows "This conversation
can't be opened." inline and leaves the chat as it was. Switching mid-answer behaves
like Start over: the provider remounts and the browser drops the stream.

**Writing** (`app/[code]/_writing/writing-chat.tsx`) wraps `ModuleChat`
(`agentId="writing"`, `providerKey={code}`) with one child — the keystone,
read-only **`getCurrentText`** frontend tool. The tool lives in an inner
`GetCurrentTextTool` component that calls `useFrontendTool` and renders `null`; it
must be a `ModuleChat` child so the hook runs inside the provider's React context.
The handler returns the **live** editor buffer through a ref (never a stale
closure) **plus its length statistics** (character / word / paragraph counts, from
`lib/writing-stats.ts`, for checking length requirements), the tool takes **no
parameters**, and the `writing` agent has no write tool — so the assistant is
read-only by construction (`docs/writing.md`).

**Quiz** (`app/[code]/_quiz/quiz-discussion.tsx`) wraps `ModuleChat`
(`agentId="quizDiscussion"`, `providerKey={threadId}` — a fresh thread per
question) with the graded **feedback header** as its child: when `feedback` is set,
a `<div>` rendering it through `MarkdownRenderer`, above the chat. It wraps
`<ModuleChat>` in its own discussion-body flex container so the feedback + chat
share a column inside the modal. The thread was already minted and seeded server-side, so
the live chat starts visually blank while the model recalls the seeded context
from memory (`docs/codes.md`).

## The read-only transcript

`app/codes/[code]/c/[threadId]/conversation-view.tsx` (`ConversationView`) is the
teacher's read-only conversation viewer, and it is **not** a `ModuleChat`. It has
**no agent, no `threadId`, and no runtime headers**: it renders the stored messages
directly with the same message components the live chat paints internally
(`CopilotChatUserMessage` / `CopilotChatAssistantMessage`), through the same
`MarkdownRenderer`, so bubbles, markdown, math and code match — but there is no
chat input and nothing runs or connects an agent.

It shares only two things with the live chat: `runtimeUrl="/api/copilotkit"` (its
`CopilotKitProvider` needs one, and pings `/info` once on mount — served as
auth-only metadata listing only the modules' student-facing agents) and the
`MarkdownRenderer`. It does not fit `ModuleChat`'s
contract (it has none of the chat slots and would have to defeat the threadId
pinning), so folding it in would add branches for a fundamentally different,
agent-less surface. It stays separate on purpose.

## Adding a 4th module's chat

The chat itself is a one-liner — render `<ModuleChat agentId="…" providerKey={…}
threadId={…} headers={…} />` from the module's render component, adding
`children` only if the module needs a slot inside the provider (a frontend tool,
a header) and `className` only for module-specific deltas. Everything else
(provider, headers, the threadId decision, the markdown renderer, the base
container) comes for free. The `agentId` must be the module descriptor's
`runtime.agentId`: `/info` lists exactly those ids (derived from the registry), and
the client throws for a chat whose agent `/info` does not list.

Wiring the new module into the rest of the app — the descriptor, the registry
line, the label, the render case, the validator/`readAnonymousFlag` branch, the
agent, and the store — is the **codes** "adding a module" checklist in
`docs/codes.md`. Chat is just the surface that checklist's render case mounts.

## Markdown rendering

`ModuleChat` swaps CopilotKit v2's default Streamdown renderer for the custom
`MarkdownRenderer` (`app/markdown-renderer.tsx`) via the `markdownRenderer` slot.
The swap is deliberate: Streamdown defaults to `singleDollarTextMath: false` (so
inline `$...$` is not treated as math) **and** runs `rehype-sanitize`, which strips
KaTeX's class names and breaks rendered math — and CopilotKit does not expose
Streamdown's plugin config. The custom renderer is `react-markdown` with
`remark-gfm` / `remark-math` / `rehype-katex` (inline + block math) and renders
fenced code through `./code-block`. Dropping the sanitize step is safe here:
react-markdown does not parse raw HTML and allowlists URL schemes — the same
sanitized path the writing lightbox and teacher review rely on for untrusted
student Markdown (`docs/writing.md`). It runs with **no `rehype-raw`**; keep it
that way.

## Reasoning display (teacher-only)

A thinking model's chain of thought shows up in the live chat as its own message,
above the answer it belongs to — **for effective teachers only**. A student never
receives it: it is not hidden with CSS, it is **never written to their stream**,
so there is nothing to find in devtools either.

### The path

The model streams `reasoning_content` (or `reasoning`), `@ai-sdk/openai-compatible`
turns it into ai-sdk reasoning parts (SCCH and OpenRouter — the two instances on
that package, `docs/ai-models.md`), Mastra emits
`reasoning-start`/`-delta`/`-end` chunks, `@ag-ui/mastra` maps those to AG-UI
`REASONING_*` events, the `/api/copilotkit` runtime passes them through
type-agnostically, and `@ag-ui/client` assembles a message with
**`role: "reasoning"`**. CopilotKit's message view renders such a message through
its `messageView.reasoningMessage` slot; we leave that slot unset, so the default
`CopilotChatReasoningMessage` paints it: a collapsible block labelled "Thinking…"
while it streams and "Thought for Ns" once done, auto-expanded during streaming
and auto-collapsed after, re-openable by click.

The default already renders the thinking text **smaller and muted**
(`text-sm text-muted-foreground`) against the assistant answer's full-size `prose`
— the visual distinction we want — so there is deliberately no `reasoningMessage`
override and no CSS of our own. The consequence of leaving it default: reasoning
content renders through **CopilotKit's own Streamdown**, not our
`MarkdownRenderer`, so KaTeX math inside a chain of thought is not typeset. That
is accepted: the thinking block is a peek behind the curtain, not the answer.
Reasoning is shown but never replayed to the model — the next request's history
carries no `reasoning_content` (`docs/ai-models.md`).

### The gate (server-side, fail-closed)

The decision is made **once per request in the runtime route** and enforced in
the runtime, not in React:

- **`app/api/copilotkit/reasoning-runner.ts`** — `ReasoningStrippingRunner`, an
  `AgentRunner` decorator around the route's base runner (below). AG-UI's
  abstract `AgentRunner` has exactly four methods; `run` (the live turn) and
  `connect` (the replay/reconnect stream) are the **only two paths into the SSE
  writer**, so both are `filter`ed (rxjs) against the `EventType` enum's whole
  reasoning family — the five `REASONING_*` events `@ag-ui/mastra` actually
  emits, plus `REASONING_MESSAGE_CHUNK` / `REASONING_ENCRYPTED_VALUE` — and the
  legacy `THINKING_*` names, which the enum no longer defines but
  `@ag-ui/client` still upgrades to `REASONING_*` in the browser.
  `isRunning` / `stop` delegate untouched.
  Dropping each START…END group **symmetrically** keeps the browser's
  `verifyEvents` validator happy, and the filter sits downstream of the runtime's
  own verifier, so it cannot trip server-side validation either. It lives beside
  the route (not in `lib/`) to stay clear of the CLI-bundled closure
  (`docs/cli-prompts.md`). A future CopilotKit that adds a fifth event-producing
  method would bypass the filter, so the method list is **guarded by a test**:
  `reasoning-runner.unit.test.ts` reads the four abstract methods off the
  installed `AgentRunner`'s type declaration and fails the build when they change
  (the abstract methods erase at runtime, so the declaration is the contract).
- **`app/api/copilotkit/[[...slug]]/route.ts`** — past the existing gates it
  computes `effectiveTeacherForSession(session)` (concurrently with the
  thread-ownership check and the `RequestContext` build, since it needs only the
  session already in hand) and passes `runner: showReasoning ? baseRunner : new
  ReasoningStrippingRunner(baseRunner)`, wrapped in the `RunErrorReportingRunner`
  below (which observes and alters nothing, so the reasoning decision is still the
  one that reaches the writer). `baseRunner` is the library's own
  `InMemoryAgentRunner`, for the tutor module wrapped in `HistorySnapshotRunner`. A
  teacher gets that base runner — the very one the filter wraps — so their stream
  is the unmodified behaviour. This is the route's only role-dependent branch
  and it changes **nothing** about access — the `checkCode` + `x-thread-token`
  model is identical for every caller (`docs/codes.md`).
- **Fail-closed.** The default is stripping. Only a *proven* effective teacher
  gets reasoning; any error in the check leaves the stripping runner in place.
- **View-as-student sees a student's stream.** The gate is
  `effectiveTeacherForSession` (`lib/student-mode.ts`, `docs/auth.md`) — real
  teacher **and** not simulating — never the raw `session.user.isTeacher` claim.
  A teacher in student mode gets no reasoning; that is the point of the mode.

### Reasoning is never persisted

Reasoning is a **live-only** artefact: worth watching while the answer forms,
never part of the record. `app/mastra/reasoning-processor.ts` exports the shared
`reasoningStrippingProcessor`, wired into the `outputProcessors` of every agent
that has `memory:` configured (tutor, quiz discussion, writing). Its
`processOutputResult` drops the `reasoning` parts — and the flattened
`content.reasoning` string — from the messages about to be saved.

Mastra runs output processors **after** the response has streamed and **before**
the memory processors persist it (`[Your outputProcessors] → [Memory
Processors]`), so this reaches storage ONLY: a teacher's live stream was written
chunk by chunk while the model was talking and is untouched. The hook that would
alter the live stream, `processOutputStream`, is deliberately not implemented.

So a reload, a transcript, an export or a raw SQL read can never surface a
scratchpad — for anyone. The CURRENT turn's reasoning still exists in memory
while the agentic loop runs, which is why the outgoing request body is scrubbed
separately (`stripAssistantReasoning`, `app/mastra/scch.ts` —
`docs/ai-models.md`).

### The generation note

CopilotKit suppresses its loading cursor while a reasoning message is the last
message (`showCursor = isRunning && lastMessage?.role !== "reasoning"`), so with
reasoning stripped the cursor renders for the entire run. `ModuleChat` overrides
the `messageView.cursor` slot with a small muted note — **"Generating…"**
(`GenerationCursor`, `text-sm text-muted-foreground`, testid
`chat-generating-note`) — instead of the library's pulsing dot.

That slot is **global**: it shows during *all* generation for *every* consumer
(tutor, writing, quiz discussion) and every provider, including models that
produce no reasoning at all, and for a teacher for the part of the run that is
not the thinking block. So the wording has to hold for a whole run on any model —
it describes the run, not a phase of it.

### Two things that follow from where this sits

- **Whether there is a thinking block at all is the provider's + model's answer,
  not a setting here.** SCCH's vLLM models emit reasoning text and so show one.
  **OpenRouter** rides the same `reasoning_content ?? reasoning` mapping, so an
  OpenRouter model that returns reasoning text shows one too — under the identical
  rules, teacher-only. **Foundry** emits none: gpt-5.x returns no reasoning *text*
  on the Chat Completions surface (only reasoning *tokens* in usage), so a Foundry
  activity shows no thinking block however `llm.reasoning` is set — for teachers
  either. Any activity run with `reasoning: none` (or SCCH's "… - Reasoning OFF"
  model id) likewise shows none.
- **The read-only transcript shows none.** Nothing is stored to show:
  `mastra_messages` carries no reasoning at all (below). `toAguiMessage`
  (`lib/conversation-collapse.ts`) additionally rebuilds each stored row from its
  **`text`** parts only — the teacher reads the conversation, not the model's
  scratchpad.

## Student photos (`lib/image-normalize.ts`)

Every photo a student picks — in the tutor chat and in the quiz's photo answers
alike — is **decoded, straightened, bounded and re-encoded in the browser**
before it is base64-inlined into a run. `normalizeStudentImage` is the one entry
point; `lib/answer-images.ts` keeps the constants and the server-authoritative
`validateAnswerImages` and stays free of DOM code, because `lib/quiz-actions.ts`
(`"use server"`) imports it.

Three things a phone hands over that the pipeline must handle (GitHub #26):

- **Resolution.** 24.5 MP (5712×4284, the iPhone default) is ~3 MB of JPEG and
  ~4 MB of base64 in the run body — and the image is REPLAYED from Mastra memory
  on every following turn of the thread. Capped at `MAX_NORMALIZED_EDGE` (2000 px
  on the longest edge), a real photo lands under 1 MB; the cap is about payload,
  not legibility, since a vision tower resizes to its own fixed budget anyway.
- **EXIF `Orientation`.** Every browser applies it when decoding — verified
  identical in Chromium, Firefox and WebKit, including that `imageOrientation:
  "none"` is ignored — but a server-side decoder (PIL, inside a vLLM server) does
  not. A photo the student saw upright could reach the model rotated 90°, which
  destroys OCR of a textbook page. Re-encoding bakes the rotation into the pixels
  and drops the tag.
- **HEIC.** An iPhone photo-library pick through `accept` is transcoded to JPEG
  by Safari; a pick through the Files app is not, and stock Pillow cannot open
  HEIC at all. Safari decodes it natively, so those files normalize to JPEG on
  the platform that produces them; anywhere else the decode fails and the
  magic-byte sniff is what lets the message name the format and the setting to
  change.

Two consequences worth holding onto:

- **`MAX_RAW_IMAGE_BYTES` (30 MB) and `MAX_IMAGE_BYTES` (5 MB) are different
  limits.** The first bounds what may be PICKED, the second what may be SENT.
  CopilotKit tests its `maxSize` against the ORIGINAL `File`, **before**
  `onUpload` runs, so it must carry the raw ceiling — passing the send cap there
  is the bug that rejects an ordinary phone photo outright. The send cap is
  enforced inside the normalizer, on its output.
- **The accept string carries dot-extensions** (`IMAGE_ACCEPT_WITH_EXTENSIONS`),
  not just `image/*`. Files handed over by the iOS Files app and some document
  providers have an EMPTY `File.type`, and CopilotKit's accept check (a prefix
  test on that field) drops them before the sniffing could identify them.

A file that is already fine is **passed through untouched**, so a crisp
screenshot is not softened by a pointless round-trip. "Fine" means JPEG or PNG,
within the edge cap, under the send cap, carrying **no orientation tag**, and —
for a PNG — **no possibility of alpha** (IHDR colour type 0/2 and no `tRNS`).
Neither condition is optional:

- a rotated photo that skipped the canvas would arrive sideways, because the tag
  travels with it and the server-side decoder ignores tags;
- a transparent PNG that skipped the canvas would arrive **black**, because the
  server-side decoder drops the alpha channel WITHOUT compositing, leaving
  transparent pixels at their stored RGB.

Anything else goes through the canvas, where transparency is flattened onto
**white** first. The output format is then chosen by whether a resize happened:
a PNG that needed nothing but flattening stays a **lossless PNG** (a screenshot
of an exercise must not go through a JPEG encoder for no reason), while anything
resized is a photo by nature and becomes JPEG. A flattened PNG can come out
larger than the original, so JPEG is the fallback if it exceeds the send cap.
Re-encoding also strips all EXIF, **including GPS**, from a photo taken at a
student's kitchen table.

### When a photo is rejected

`components/image-error-notice.tsx` is the shared notice for both surfaces. It
shows one sentence per rejected file and a **"Details for your teacher"**
disclosure holding a copyable report (`lib/image-report.ts`) — the container the
bytes really are, whether the platform reported a MIME type at all, what the
decoder said, and what the browser can do. The report is **content-free**: no
pixels, and the filename is reduced to its extension and length.

**`/image-check`** (`app/image-check/`) is the same report as a standalone page,
for the case the notice cannot cover: a photo that uploads fine and is merely
misread produces no error to expand. Signed-in but not teacher-only — the point
is to have the student run it on the phone that produced the problem — and it
runs the PRODUCTION normalizer with no option overrides, so its verdict is the
chat's verdict. Nothing leaves the browser.

## Failure reporting (`RunErrorReportingRunner`)

A turn that dies inside the agent does so **in-band**: the route has already
answered 200 and the stream is open, so a handler-level `try/catch` sees nothing
at all. `app/api/copilotkit/run-error-runner.ts` is an `AgentRunner` decorator
that watches both an AG-UI `RUN_ERROR` event and an errored observable, reports
each to `recordError`, and passes every frame through untouched and in order.

- It wraps **both** runner variants. Wrapping only the student one is the easy
  mistake — teachers' failures would then be the invisible half.
- **Content discipline** (`docs/telemetry.md`): a `RUN_ERROR` message is agent-
  or provider-authored text that may quote the request, so only its **length** and
  the short `code` beside it are recorded. A thrown error goes to `recordError`, which
  keeps the message only of a plain `Error` and withholds every other one (an
  ai-sdk or provider error exports just its type and stack frames).
- It is subject to the same 4-method `AgentRunner` guard as the reasoning runner:
  a CopilotKit bump that adds a fifth event-producing method must wrap it in
  **all three** decorators (with the tutor's `HistorySnapshotRunner`).

The route additionally rejects a run/connect whose **declared** `Content-Length`
exceeds `MAX_RUN_BODY_BYTES` (24 MB) with a 413, before the body is read. The
browser may pick files larger than it may send, and this check is the only size
gate on this path.

## Backend seam

Out of scope for this chapter. The `/api/copilotkit` route, the per-module
`CodeModuleRuntime` (agent selection, `RequestContext` building), the `x-code` /
`x-thread-token` re-verification, thread ownership, and the new-turn-only
persistence rule all live in `docs/codes.md`. `ModuleChat` only talks to that route
through `runtimeUrl` + the runtime headers.

## Tests

The common chat logic is tested **exactly once**, against `ModuleChat`; the per-module
tests **mock `@/app/module-chat`**, so they assert only what is unique to the
module.

- **`tests/component/module-chat.browser.test.tsx`** — the single home of the
  shared-wiring assertions: the provider gets `runtimeUrl="/api/copilotkit"` + the
  exact `headers`; `CopilotChat` gets the explicit-mode `threadId`, the passed
  `agentId`, and a `messageView.assistantMessage.markdownRenderer`; `children`
  render inside the provider as direct members (no extra wrapper); `labels` /
  `chatView` / `attachments` pass through verbatim.
- **`tests/component/writing-chat.browser.test.tsx`** — the writing-unique
  `getCurrentText` keystone: the tool registers with `name: "getCurrentText"`,
  `agentId: "writing"`, **no `parameters`**, and `config.handler()` returns the
  **live** ref value (mutating the ref changes the result — proves a ref read, not a
  stale closure). Plus the one boundary check that it hands `ModuleChat`
  `agentId="writing"`, `providerKey={code}`, `threadId`, and the headers.
- **`tests/component/quiz-discussion.browser.test.tsx`** — the quiz-unique feedback
  header: the feedback markdown renders as the `ModuleChat` child (real
  `MarkdownRenderer`), empty feedback renders no block, and it hands `ModuleChat`
  `agentId="quizDiscussion"`, `providerKey={threadId}`, `threadId`, and the headers.
- **`tests/component/tutor-chat.browser.test.tsx`** — mocks `ModuleChat` and covers
  only the tutor-unique cases: the props it hands `ModuleChat` (incl.
  `title`→`labels`, `imageInput`→`attachments` with `onUploadFailed`, a
  `chatView`), the welcome-view composition, the dismissible upload-error
  notice, and **start over** — nothing moves before the student confirms; a
  confirmed restart moves `threadId` + `providerKey` + headers + the report target
  together (proven by driving a real report through the mocked action) and clears
  the upload notice; a failed one shows the reason and leaves the chat untouched.
- **`lib/image-normalize.unit.test.ts`** — the PURE half: the magic-byte sniff
  (every container a phone or laptop produces, the ISO-BMFF brands that separate
  HEIF from AVIF, SVG text) and the JPEG EXIF walk (both byte orders, EXIF
  present with no orientation tag, out-of-range values, a truncated segment).
- **`lib/image-normalize.browser.test.tsx`** — the half only a real browser can
  prove, in Playwright Chromium against canvas-built files: the edge cap and
  aspect ratio, **alpha flattened onto white** (the black-homework bug), the
  JPEG and PNG pass-throughs, the re-encode forced by an orientation tag (and the
  swapped dimensions that prove the browser baked it in), a HEIC named by its
  bytes, a non-image, and the raw pick ceiling. Chromium-only, like every
  component test — the cross-engine orientation behaviour it relies on was
  verified separately in Firefox and WebKit and is noted in the file.
- **`lib/image-report.unit.test.ts`** — the copyable block: a verdict for every
  failure reason, and the content-free guarantee (extension and name length, never
  the filename).
- **`app/api/copilotkit/run-error-runner.unit.test.ts`** — synthetic Observables,
  no Mastra: an in-band `RUN_ERROR` and an errored stream are both reported, the
  run-error MESSAGE never reaches telemetry (only its length), every frame passes
  through untouched, `connect` is watched as well as `run`, and a successful turn
  reports nothing.
- **`e2e/image-check.spec.ts`** — hermetic (no DB, no LLM): the page is behind the
  default-deny matcher, and ONE three-photo pick proves the wiring the page alone
  owns — normalize → diagnose → one numbered report section per file. That pick
  carries a 4000×3000 photo (resized to 2000×1500), a mislabelled non-image
  (MISMATCH by its bytes) and a HEIC (named as HEIF), so accepted and rejected
  verdicts render side by side and the report carries extensions, never filenames.
  The per-branch verdicts themselves belong to `lib/image-normalize.browser.test.tsx`
  and `lib/image-report.unit.test.ts`; do not restate them here.
- **`e2e/image-attachment.spec.ts`** — the `@live` round-trips: the original
  red-PNG case, plus a **multi-megapixel** photo generated in the page, which is
  the payload-size regression the tiny fixture can never catch.
- **`app/api/copilotkit/history-snapshot-runner.unit.test.ts`** — the REAL
  `InMemoryAgentRunner` with a fake AG-UI agent and every connect stream run
  through AG-UI's `verifyEvents`: the exact three-event snapshot on a cold
  connect; the plain inner stream (never a `RUN_ERROR`) when nothing is stored,
  the thread is idle past limit + grace, or the store fails; a warm replay of
  stored ids reduced to bare run frames (text, `-agui-text`, tool call by
  `parentMessageId`); an unstored run replayed in full; an in-flight run's live
  events; a finished run's reasoning dropped while an in-flight run keeps its
  reasoning (early part and live remainder); a historic `RUN_ERROR` closed as
  `RUN_FINISHED` while a live one passes;
  the synchronous-history assumption asserted against the real runner. The
  4-method guard in `reasoning-runner.unit.test.ts` covers all three decorators,
  and the route suite asserts the runner chain per audience and module.
- **`tests/component/tutor-chat.browser.test.tsx`** (restore) — the deciding and
  restoring placeholders, an accepted resume mounting the stored thread with
  `restoring` (`isConnecting` on the view), a refused or thrown one falling back
  to the server thread and replacing the entry, and Start over storing its thread.
  **`tests/component/user-menu.browser.test.tsx`** proves sign-out clears the
  stored threads before the action runs.
- **`e2e/tutor-resume.live.spec.ts`** (`@live-db`, CI) — seeds a conversation
  under the tab's stored thread: a reload restores it without the welcome screen;
  backdated 61 minutes, the reload starts fresh. Plus the anonymous-tutor smoke.
  **`e2e/tutor-reload-roundtrip.spec.ts`** (`@live-db`, CI, against the fake LLM;
  guards the bumps above) — one copy of each message after reloads in a warm process,
  and a failed-then-good thread that still reloads without a verifier error.
- **`lib/tutor-actions.unit.test.ts`** — `startNewTutorThread` with the session and
  `checkCode` mocked but **`lib/thread-token` real**: the minted token verifies for
  `(code, session user, new thread)` and for nothing else (another user, another
  code), each call yields a different thread, and every rejection branch
  (signed-out, the four `checkCode` reasons, a non-tutor module) returns its
  message. The code is re-checked on every call. `resumeTutorThread` accepts only
  the owner's token on a thread last written under 60 minutes ago and answers
  every other case (malformed id before any lookup, another user / code / thread,
  no messages, 60 and 61 minutes, a store failure, a bad code, no session) with
  exactly `{ ok: false }`. Beside it: the resume rule
  (`lib/tutor-history-gate.unit.test.ts`), the tab storage
  (`lib/tutor-thread-storage.unit.test.ts`), the store's conversions
  (`lib/tutor-history-store.unit.test.ts`) and its importer guard
  (`lib/tutor-history-isolation.unit.test.ts`).
- **History (per-user tutors)** — `lib/tutor-actions.unit.test.ts` also covers
  `listTutorThreads` / `openTutorThread`: refused for each of the three "history
  off" flag combinations and an unreadable YAML; the list passes only the session
  user id to the store; open refuses without the ownership row, on an empty thread
  or a store failure, always with the same message, and its token verifies only
  for `(code, session user, thread)`. Beside it: `lib/tutor-history-preview.unit.test.ts`,
  `lib/conversation-time.unit.test.ts`, the gate's four flag combinations and
  ownership branch, the store's list conversions, `render-tutor.unit.test.tsx`
  (`historyEnabled` per the both-flags rule), and the browser suites
  `tests/component/previous-conversations.browser.test.tsx` (rows, "Current",
  photo / empty previews, footer, empty and error states with Try again, open
  success and refusal), `tests/component/start-over-button.browser.test.tsx` (both
  wordings) and the history cases in `tutor-chat.browser.test.tsx`.
  **`e2e/tutor-history.live.spec.ts`** (`@live-db`, CI) seeds conversations of the
  e2e student on two codes plus another user's: the dialog lists only this code's
  own, a five-day-old one reopens with its messages and survives a reload; plus the
  per-user smoke.
- **`tests/unit/runtime-headers.unit.test.ts`** — `buildRuntimeHeaders(code, token)`
  returns `{ "x-code": code, "x-thread-token": token }` exactly (a cheap guard on
  the header names the backend re-reads).

The refactor is behavior-preserving, so the live e2e specs are coverage, not
duplication — they drive the **real** CopilotKit end-to-end (which the component
layer mocks away), per module: `e2e/tutor-chat-reply.spec.ts`, `e2e/quiz.spec.ts`,
`e2e/writing.spec.ts` (and `e2e/chat-no-replay-persistence.spec.ts`). Those that
test no specific provider run in CI against the fake LLM — see `docs/testing.md`
for the `@live` boundary.
