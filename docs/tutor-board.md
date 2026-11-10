# Tutor board (drawings in the tutor chat)

A tutor granted the built-in `board` tool draws tailor-made diagrams while it
explains — boxes, arrows, groups, message sequences, bit layouts — and changes the
**same** drawing when the student follows up ("highlight the broadcast", "and with
two servers?"). The drawing lives in a pane **beside the chat** on laptops and
**docked above the chat** on phones; no images pile up in the conversation.

```yaml
tools:
  - board
```

Teachers decide in `tutor_instructions` when and how the tutor draws (the teacher
guide's tutors chapter has the recommended paragraph and topic hints). The tool
itself stays generic.

## The approach in one paragraph

The model decides **what** to draw through a small JSON step language; Novedu owns
all geometry. The model never gives coordinates: it picks a board kind (`grid`,
`sequence`, `bits`), grid cells or drawing order, colour names and arrow styles,
and Novedu lays everything out deterministically and renders it with
[Excalidraw](https://github.com/excalidraw/excalidraw) (the npm package, used as a
renderer only — no editor, no hosted service). A board is the **replay of the
thread's successful `board` calls**, so it needs no storage of its own: it comes
back with a resumed or reopened conversation, and "Start over" empties it.

## The step language

The tool's description (`lib/tutor-tools/catalog.ts`, `BOARD_DESCRIPTION`) is the
model's only documentation. One call is `{"steps": [...]}`, each step one of:

| op | what it does |
| --- | --- |
| `board` | starts a board (`kind`: `grid` default, `sequence`, `bits`); up to 3 side by side |
| `group` | grid only: a labelled frame around boxes that join it with `"in"`; groups nest |
| `box` | a part: a grid cell (`row` 0–4, `col` 0–3, `shape`), a sequence participant, or a bits field |
| `arrow` | `from` → `to`, optional `text` and `style` (`normal`, `problem`, `dashed`, `inherits`, `has`) |
| `note` | an extra line inside a box or under an arrow's text |
| `change` | restyles a box, group, arrow or board in place (never moves it) |
| `remove` | removes parts (a box's arrows go with it; a group's members stay) |
| `highlight` | makes parts stand out while the tutor talks about them, until its next call |

The input schema is deliberately loose (`{steps: object[]}`): the board's own
checks explain a malformed step, naming the ids on the board and how to fix it.

**All or nothing** (`lib/board/model.ts`, `apply`):

- structural problems (unknown op, bad or reused id, taken cell, a group frame that
  would swallow a non-member, limits) are **errors**: nothing of the call is applied
  and the tool returns `{ok: false, errors}`; the model fixes the call and retries;
- cosmetic problems (a highlight or remove of an unknown id) are **warnings** on an
  applied call, because a retry costs a whole extra model round;
- a successful call returns `{ok: true, board: summary, warnings?}` — the summary
  lists every id on the board, so the model always knows what it can refer to.

Ids are never reused, not even after a remove. Limits (`LIMITS`): 3 boards, 5×4
grid cells, 6 sequence participants, 40 parts, 50-character texts, 70-character
titles.

## Where the pieces live

```
lib/board/                 pure, CLI-bundle-safe (inside the prompt-dump grep-guard closure)
  model.ts                 apply / summary / replay — the checks and the state
  layout.ts                state → Excalidraw element skeletons; finish() after measuring
  calls.ts                 successful board calls in stored Mastra or AG-UI messages; chat markers
  describe.ts              status line, alt text (plain text only)
lib/tutor-tools/catalog.ts the `board` entry: description, loose schemas, pure executor
app/mastra/tutor-tools.ts  the binding: supplies the executor's prior calls
lib/tutor-board-store.ts   the thread's stored board calls (raw SQL, scoped by thread + code)
lib/conversation-collapse.ts  toAguiChatMessages — the reload snapshot carries board calls
app/_tutor/board/          the client: frame, renderer, sheet rules, camera
```

### Server: a stateful executor

The catalog's executor is pure: `execute(input, deps, {priorCalls})` replays
`priorCalls` onto an empty board and applies the new call on top
(`docs/tutor-tools.md`, "Stateful tools"). The Mastra binding supplies
`priorCalls`:

- **every stored message of the thread** (`loadThreadBoardCalls`, keyed by the run's
  `threadId` and its `resourceId` = the code), not only the agent's memory window,
  which holds the last 40 messages;
- plus **this run's calls Mastra has not stored yet** (`context.agent.getMessages()`),
  deduplicated by tool-call id, minus the call being executed.

A database error fails the call rather than drawing on a board it cannot see. A
run without a thread — the eval tutor — uses only its own calls, so every eval
turn starts with an empty board (`docs/cli-eval.md`).

Known limitation: the model sees only the last 40 messages. In a very long
conversation it may no longer see its earliest board calls, but every successful
result carries the whole board's summary, so the latest one tells it what is on
the board; a reused id is rejected and the model retries.

Known limitation: two `board` calls in the **same model step** (parallel tool
calls) are each checked against the board as it was before that step, so the
second does not see the first. Both can succeed; when the board is replayed in
order and the second no longer applies (a reused id, a taken cell), `replay`
skips it, so that part of the drawing is missing. Luna draws in one call per step
in practice, so the calls are not serialised.

### Reload, resume, previous conversations

Mastra stores a tool call as a `tool-invocation` part (args and result) on the
assistant message. The tutor's `connect` snapshot (`loadThreadForChat` →
`toAguiChatMessages`) turns a reply that drew into the shape the live stream has:
an assistant message with the successful `board` calls as `toolCalls` (under the
stored id, with any text written before the first drawing), one `tool` message per
result, then the text written after it under `<id>-agui-text`. The browser rebuilds the board from that list exactly as it does
live; `HistorySnapshotRunner` already drops the in-process replay of tool calls
parented on stored messages (`docs/chat.md`). Rejected calls and other tools stay
out of the snapshot; the teacher's transcript view and the conversation export are
unchanged.

### Client: derived, never stored

`BoardFrame` (`app/_tutor/board/board-frame.tsx`) wraps the chat through
`ModuleChat`'s `frame` slot, inside the CopilotKit provider, and only for a tutor
granted `board` (`render-tutor.tsx` passes `board`). It reads the chat's messages
with `useAgent({ agentId: "tutor" })`, takes the `board` calls whose results say
`ok: true` (`boardCallsFromAgui`), and replays them through the same
`lib/board` code the server runs. It keeps no copy of the board: live runs and
restored conversations go through one path, and "Start over" (a provider
remount) empties it.

Tool calls reach the browser whole, after they finished (the route's `MastraAgent`
runs without `streamServerToolCalls`), so there is no partial "drawing" state:
while the model writes a call the student sees the chat's usual "Generating…", and
the pane appears or changes when a successful result arrives.

**The chat marker** is a CopilotKit tool-call renderer (`useRenderTool` for
`board`): a small outline pill "Drew on the board" (the reply with the thread's
first drawing) or "Changed the board". One pill per reply however many calls it
made; a rejected call renders nothing. Clicking it opens the board. No other tool
output appears in the chat.

### Rendering: PNG, never SVG

`app/_tutor/board/render.ts`: `layout` → `convertToExcalidrawElements` → `finish`
→ `exportToCanvas` → a PNG blob shown as an `<img>`.

- **Never SVG.** An Excalidraw SVG shown as an `<img>` can only use its embedded
  font, which renders text about 20% wider than Excalidraw measured, so labels
  overflow their boxes. A PNG drawn with the page's loaded fonts is correct, and no
  SVG markup reaches the page (`docs/images.md`).
- **Lazy.** `@excalidraw/excalidraw` is loaded with a dynamic import on the first
  board; a tutor that never draws never loads it.
- **Fonts.** Excalidraw loads its fonts from its default CDN — the only external
  request the board makes. Text must be measured with them loaded, so the first
  board runs a one-time warm-up export and waits for `document.fonts.ready`.
- **Scale.** One image per change at device pixel ratio × 2 (`ZOOM_MAX`, the
  largest zoom a student can pick), capped at 4× and at 16 M canvas pixels for iOS.
- **Geometry.** `exportToCanvas` places the drawing at `getCommonBounds − padding`,
  so the highlighted parts' bounds (`focus`) are in image pixels — pinned by the
  browser test that finds the marker colour inside them.

### The highlight

A highlight is plain shape properties, drawn by Excalidraw itself (`layout.ts`):

| part | highlighted | everything else |
| --- | --- | --- |
| box | marker-yellow fill `#ffe066`, outline 3 | 30% opacity |
| arrow | marker patch behind its label, line 3 | 30% opacity |
| group | marker patch behind its label, frame 2.5 (its boxes are marked too) | 30% opacity |

Parts the same call added or changed stay at full strength without the marker. The
marker yellow belongs to the drawing, not to Novedu's chrome (DESIGN.md's amber
rule governs the chrome only). The highlight is not colour-only: the rest fades
and the line gets thicker.

## Layout and behaviour

**Laptop and up (≥ `md`):** no board yet → the chat as always. The first drawing
opens the pane on the right (chat : board ≈ 1 : 1.35): "Board", a one-line status
("Drawn just now", "Highlighted 1 part", "Added 2 parts, highlighted 3 parts"), a
full-screen button (⤢), a hide button, and the drawing fit onto a white sheet over
the slate canvas (never above 1.1×), with the zoom controls. Hidden,
it is a 44px rail with a vertical "Board" label; an ink dot means it changed while
hidden. A change crossfades the new image over the old one (about 300 ms); the
fixed layout keeps unchanged parts where they were.

**Phone (< `md`):** a sheet under the toolbar, above the chat. The rules are pure
functions in `app/_tutor/board/sheet.ts`:

| state | shows |
| --- | --- |
| hidden | nothing (no board yet) |
| peek | a 60px bar: thumbnail, "Board", status, ink dot, Show |
| half | about 46% of the height; the default once there is a board |
| full | covers the app, the drawing at 90–100%, with the zoom controls; pinch zooms the page |

- The first board opens *half*. If the student collapsed it to *peek*, later
  changes keep it there (status and dot update); otherwise a change returns *half*.
- Tapping into the message field tucks *half* to *peek* (the keyboard takes half
  the screen); leaving the field or sending brings it back. Only a focus that
  follows the student's tap counts — the chat refocuses its field after a send.
- **Zoom to the highlight:** with a highlight, *half* frames the highlighted parts
  at a readable scale (≤ 1.1, never below the whole-board fit) with an animated
  camera (`focusCamera`); a "Whole board" / "Zoom to highlight" pill switches.
  Without a highlight it shows the whole board; tapping it opens *full*.

**Zoom and full screen.** The laptop pane and the full-screen view (laptop: ⤢ in
the pane; phone: ⤢ or a tap on the half sheet) show the drawing in a scroll area
with − / percentage / + controls in the bottom-right corner. The steps
(`ZOOM_STEPS` in `sheet.ts`) run from 25% to 200%; zooming out stops at the
whole drawing, and the percentage button returns to the fitted view. A zoom keeps
the point in the middle of the view in place; from the fitted view it moves to the
highlight. A chosen zoom survives the tutor's changes, and a new highlight that is
not fully in view scrolls into the middle. Full screen covers the app; ✕ or Escape
closes it and returns focus to ⤢. The phone's half sheet keeps its camera instead.

**Accessibility.** The image's alt text is built from the board model (titles,
parts, arrows, what is highlighted); a polite live region announces each change.
Model text only ever lands in Excalidraw text, the alt attribute or the live
region — plain text, never HTML. Reduced motion drops the crossfade and the
camera animation.

## Invariants

- No new table or column: the board is the replay of stored tool calls.
- A student never sees a board error: a rejected call changes nothing visible, a
  failed render keeps the last good image.
- No SVG markup on the page; no external request from the student's browser except
  Excalidraw's font CDN.
- `lib/board/` stays pure (no `app/**`, DB or Excalidraw import) — the catalog
  imports it, so it is in the CLI bundle's grep-guarded closure.
- The platform never mentions the tool in the prompt; authors do, in
  `tutor_instructions`.
- The step language (`BOARD_DESCRIPTION`) was tuned against GPT-6 Luna; the board is
  verified on Luna only. Change the description only with a live re-check.

## Tests

- `lib/board/model.unit.test.ts` — every board kind, errors vs warnings, limits,
  the marker properties, layout stability (adding a part moves nothing), the call
  extraction from stored and AG-UI messages, the chat-marker rule, status and alt
  text.
- `lib/tutor-tools/catalog.unit.test.ts` — the executor on prior calls.
- `app/mastra/tutor-tools.unit.test.ts` — prior calls from storage + the run,
  deduplicated, without a thread for evals.
- `lib/conversation-collapse.unit.test.ts` — the snapshot's board-call shape.
- `app/_tutor/board/sheet.unit.test.ts` — the sheet rules, the camera and the zoom
  steps.
- `tests/component/tutor-board.browser.test.tsx` — the pane at both breakpoints
  with the real renderer (zoom steps and limits, full screen with ✕ and Escape),
  and the geometry pin.
- `e2e/tutor-board.spec.ts` — laptop and phone against the fake LLM's
  `[tool:board {…}]` marker; `e2e/tutor-reload-roundtrip.spec.ts` — the board
  comes back after a reload, once.
