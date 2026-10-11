# Cloze

Deep reference for the **cloze** activity ("Fill the gaps"): students complete the
gaps of ONE text and, after submitting the whole exercise, get a verdict per gap plus
consolidated feedback that connects their mistakes. The file kind, the module and the
eval kind are all named `cloze`. The always-on invariants are summarized in
`AGENTS.md`; this file has the full mechanics.

Read it before touching the cloze libs (`lib/cloze-*.ts`), the module
(`lib/code-modules/cloze.ts`, `app/[code]/render-cloze.tsx`, `app/[code]/_cloze/**`),
the agent (`app/mastra/cloze-agents.ts`), the cloze schema
(`activities/cloze/cloze-yaml.schema.json`, generated from `lib/cloze-schema.ts`), or
the cloze sample under `activities/examples/`.

It covers the **authoring** layer (the `cloze` file kind with its strict validator,
the gap parser, the lenient runtime parser with the public projection, the generated
JSON schema, `novedu-cli validate --kind cloze`, the `/files` editor's Cloze kind) and
the **student activity** (the `cloze` module, the two-step grading pipeline, the
result token, metering and `novedu-cli prompts --kind cloze`).

## The YAML

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/cloze/cloze-yaml.schema.json
id: future-forms-sue
name: Sue's fresh start            # label in the teacher's lists
title: Sue's fresh start           # student heading
description: |                     # the task box above the text (Markdown)
  Complete the text with suitable future forms.
llm: { provider: SCCH, model: gemma-4 }
instructions: |                    # shared preamble for grading AND feedback (fragments allowed)
  {{fragment "course.simple-english"}}
fragment_files: [ … ]
text_files: [ … ]
evaluation: |                      # SERVER-ONLY, exercise level: goal + criteria
  Goal: choose the future form that matches the speaker's intention.
  Correct: the intended form; contractions and equivalent forms count.
  Partial: the right construction with a wrong verb ending.
  Wrong: a different future form, or a form that changes the meaning.
text: |
  ## A plan for next week
  Sue has already decided on her new fitness routine. She [[is going to]]
  start it next week. … the beginners' class [[starts|start]] at nine …
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | machine-readable id (teacher tooling only) |
| `name` | no | the teacher's label |
| `title` | no | the student heading |
| `description` | no | the task above the text, Markdown |
| `llm` | yes | `model` required, `provider` (default `SCCH`) and `reasoning` optional — the same block as every module (`docs/ai-models.md`) |
| `instructions`, `fragment_files`, `text_files` | no | the shared prompt-fragment core (`docs/prompt-fragments.md`): `instructions` is the one host text, rendered once into the preamble of both the grading and the feedback prompt |
| `evaluation` | yes | **server-only** grading criteria for the whole exercise — how far an answer may deviate from the reference. There are no per-gap instructions |
| `text` | yes | the complete text (Markdown) with the gaps marked around their reference answers |

Deliberately absent (the strict schema rejects them): `anonymous` — a cloze exercise
is **always anonymous**, the code row freezes `true` exactly like coding, and
`readAnonymousFlag` answers `true` without reading the YAML — and the quiz-only
`shuffle`, `question_count`, `quiz_files`, `immediate_feedback`, `discussion` and the
image fields.

### Gap syntax

| Markup | Meaning |
| --- | --- |
| `[[answer]]` | a gap and its reference answer |
| `[[answer\|hint]]` | plus a hint rendered after the gap, e.g. "(start)" |
| `[[]]` | "nothing belongs here" (e.g. no comma) — an empty answer is correct |
| `[[\|hint]]` | an empty reference with a hint |
| `\[[` / `\]]` | a literal `[[` / `]]` |

- The reference and the hint are trimmed. Gaps are numbered **1…N in reading order**
  (the order they appear in `text`).
- A gap opens and closes on one line. It may not contain another `[[`, take a second
  `|`, or have an empty hint after `|`.
- Limits (`lib/cloze-types.ts`): at most **40** gaps (`MAX_CLOZE_GAPS`), each
  reference at most **200** characters (`MAX_CLOZE_ANSWER_LENGTH`, the answer cap a
  student's answer shares).
- The text may not contain U+E000 or U+E001 — they delimit the gap placeholders of the
  public projection.

### Where a gap may go

`text` is Markdown, rendered by the sanitized `MarkdownRenderer`. A gap must end up as
plain text: in a **paragraph, a list item, a blockquote or a table cell** (also inside
emphasis). It may **not** sit in a heading (ATX or setext), code (inline, fenced or
indented), math (`$…$`, `$$…$$`), link text or a link URL (including a bare autolink),
an image, a link definition, a raw HTML block, or a footnote. Text between inline HTML
tags is fine — the renderer drops the tags and keeps the text.

Inside code a backslash is literal, so `\[[` there is resolved to `[[` by the parser
itself; outside code the source keeps `\[[` and Markdown renders it as `[[`. An
unescaped `]]` inside code, math or raw HTML is ordinary text.

## The gap parser — `lib/cloze-gaps.ts`

`parseClozeGaps(text)` is the ONE reader of the gap markup, shared by the strict
validator and the lenient runtime parser, so the validator, the student page and the
grader agree on what the gaps are. It returns `{ ok: true, gaps, segments }` or
`{ ok: false, errors }`.

1. **Lexical scan** — every unescaped `[[ … ]]` on one line is a gap token (an odd
   number of backslashes before `[[`/`]]` escapes it); an unescaped `]]` outside a
   token is remembered for step 2.
2. **Positions** — the text is parsed with the **same Markdown pipeline the renderer
   runs** (`unified` + `remark-parse` + `remark-gfm` + `remark-math`), after every gap
   token is replaced by an inert run of letters of the same length. Offsets stay
   identical, and the probe behaves exactly like the public placeholder (neither
   contains a character Markdown could read as structure — `[`, `|`, `*`). A gap
   inside a forbidden node's range, or outside every `text` node, is a
   `CLOZE_GAP_POSITION` error; a remembered `]]` outside code, math or raw HTML is a
   `CLOZE_GAP_SYNTAX` error.
3. **Segments** — the text between the gaps (with `\[[` in code resolved) interleaved
   with the gap numbers. `renderClozeText(parsed, renderGap)` rebuilds the text,
   writing each gap however the caller needs it (a placeholder for the student, the
   reference for a prompt).

Every located problem carries its 1-based `line`/`column` **within `text`** and a
message starting `Text line L, column C:`; the errors come in reading order, followed
by the count errors.

| Code | When |
| --- | --- |
| `CLOZE_SCHEMA_ERROR` | the document does not match `ClozeYamlSchema` |
| `CLOZE_GAP_SYNTAX` | an unclosed `[[`, a gap spanning lines or containing `[[`, a second `\|`, an empty hint, a stray `]]`, a reserved character |
| `CLOZE_GAP_POSITION` | a gap in a forbidden position |
| `CLOZE_GAP_TOO_LONG` | a reference over 200 characters |
| `CLOZE_NO_GAPS` | no gap at all |
| `CLOZE_TOO_MANY_GAPS` | more than 40 gaps |

`formatGapInventory(gaps)` renders the one-line **gap inventory**:
`10 gaps · 1 "is going to" · 2 "is going to" · 3 "starts" (start) · 4 (empty) · …`.

## The strict validator — `lib/cloze-validate.ts`

`loadAndCheckCloze(url, fetcher, opts)` is the authoring gate: the shared scheme-gated
YAML load, `ClozeYamlSchema` (`lib/cloze-schema.ts`, `z.strictObject` throughout), the
gap parser, then the fragment block's authoring gate over `instructions` (every
referenced library fetched and checked thoroughly, an assembly dry-run). On success
it reports `clozeId`, `model`, `provider`, `title`, `gapCount`, `gaps` (number,
reference, hint) and `inventory`. `checkClozeValue(parsed, url)` is the pure,
fetch-free part (schema + gaps).

It backs three surfaces:

- the **validator seam** (`lib/file-validators.ts`, `fileValidators.cloze`): the app's
  provider-availability gate on top, `anonymous` frozen `true`, and the inventory as
  the result's `summary` — which the `/files` create and edit forms show beside
  "Validation passed" and "Saved" (`docs/files.md`);
- **`novedu-cli validate --kind cloze`**, which prints the summary and the inventory,
  one gap per line;
- the generated editor schema `activities/cloze/cloze-yaml.schema.json`
  (`npm run generate:schemas`, `lib/schema-gen`).

The validator, its schema, the gap parser and `lib/cloze-types.ts` are bundled into
`@novedu/cli` and sit inside the CLI's grep-guarded import closure
(`lib/prompt-dump.unit.test.ts`): no `app/**`, no DB, no `lib/llm/model.ts`, no
`"use server"`. Changing them warrants a CLI release (`docs/cli-publish.md`).

## The runtime parser and the public projection — `lib/cloze-yaml.ts`

`parseCloze(content)` is the lenient student-path read: the essentials (`llm.model`, a
valid provider and reasoning level, `evaluation`, `text`) with a friendly message when
one is missing, unknown keys ignored, scalars coerced. Its gaps come from the same
`parseClozeGaps`: a text whose gaps cannot be shown or graded fails the load with
"The gaps of this exercise could not be read" instead of rendering a broken exercise.
The parsed `Cloze` carries the server-only reference answers, `evaluation`,
`instructions` and the fragment block.

**Invariant:** the reference answers are server-only, exactly like `evaluation`. The
browser only ever receives `toPublicCloze(cloze)` — a `ClozePublic`
(`lib/cloze-types.ts`) built from a whitelist: `title`, `description`, `text` with
every gap replaced by its placeholder, and `gaps` (number + hint). The projection guard
in `lib/cloze-yaml.unit.test.ts` pins that no reference, `evaluation`, `instructions`,
rendered preamble or `llm` value reaches it.

The placeholder for gap N is `clozeGapPlaceholder(N)`: N between the Private Use Area
characters U+E000 and U+E001. Markdown treats them like letters, so the placeholder
never changes the text's structure, and the client splits a rendered text run on them
with `splitOnClozeGaps(text)` (strings and gap numbers, in order). `lib/cloze-types.ts`
is pure and client-safe.

The loader `loadCloze(url)` (`lib/cloze-fetch.ts`, the app-hosted/DB seam) and its
app-free twin `loadClozeFrom(url, fetcher)` (`lib/cloze-resolve.ts`, used by the prompt
dump) share `resolveCloze`, which renders `instructions` ONCE into the server-only
`instructionsPreamble` through `assembleFragmentPrompt` (`validateLibraries: false`; a
fragment failure fails the load closed). Every page load and every submission reloads
the YAML uncached, so a fix applies at once.

## The module — `lib/code-modules/cloze.ts`

`cloze` is a `CodeModule` (badge "Cloze", count column "Submissions", tone `rose`)
with **no `runtime`**, exactly like coding: the CopilotKit route 404s every agent id
for a cloze code, and `/info` lists none. The code row freezes `anonymous: true`.

- **Student page.** `app/[code]/page.tsx` runs `checkCode()`, records the recent code
  and delegates to `render-cloze.tsx`, which loads the exercise and hands only
  `toPublicCloze(cloze)` to the client `ClozeRunner` (`app/[code]/_cloze/`). No thread
  and no thread token are minted. A load failure shows a notice.
- **Teacher detail.** `renderDetail` is `ClozeDetail` (`app/[code]/_cloze/cloze-detail.tsx`):
  the file link, the window, the effective model and the current gap inventory.
- **Registry.** `codes sync` mints cloze codes from the activity registry's `cloze`
  group (`docs/registry.md`).

## The student runner — `app/[code]/_cloze/`

`ClozeRunner` (`cloze-runner.tsx`, client) receives `{ code, cloze: ClozePublic }` and
nothing else. Answers live in page state only: a reload starts over.

- **The text.** `ClozeText` (`cloze-text.tsx`) renders `cloze.text` through the
  sanitized `MarkdownRenderer`, extended by a small rehype plugin that splits every
  rendered text node on the placeholders (`splitOnClozeGaps`; `code`/`pre` are left
  alone) and leaves a `<cloze-gap data-gap="N">` element in each one's place. That
  element renders through ONE stable component that asks the caller's
  `renderGap(N)` (passed via context) what to show — an input while answering, a
  verdict chip on the results screen. The parsed Markdown is memoized on the text, so
  typing re-renders only the gaps and an input never loses its focus. Gaps work
  wherever the validator allows them (paragraphs, list items, blockquotes, table
  cells).
- **Answering.** Each gap is a pill-shaped `<input>` labelled "Gap N" (the superscript
  number before it is decorative), its hint "(start)" after it as the input's
  description; the DOM order is the reading order, so Tab moves from gap to gap. Each
  answer is capped at `MAX_CLOZE_ANSWER_LENGTH`. The footer counts "x / N gaps filled"
  (whitespace is not an answer); **Submit exercise** is always enabled — with empty
  gaps it first asks "N gaps are empty — submit anyway?" (Keep editing / Submit
  anyway). The attempt uuid is minted when the page loads.
- **Results.** As soon as `gradeCloze` returns, the text shows a chip per gap — the
  answer coloured AND shaped by its verdict (✓ correct, – partly correct, ✕ wrong; an
  empty wrong answer reads "Not answered") — and the "Your feedback" card shows the
  counts ("5 correct · 2 partial · 3 wrong") with a loading line while `explainCloze`
  runs. Its result fills in the pattern columns (title, explanation, "See your
  answers" gap buttons that select a gap and scroll its chip into view, "Next time:")
  and the per-gap notes. When no pattern survived the grounding filter but two or more
  gaps are non-correct, the card reads "Your mistakes don't share a common cause — see
  each gap below." When every gap is correct the client makes no feedback call and
  shows "All N gaps correct.". Below the text, the selected gap's panel (initially the
  first non-correct gap) shows "Your answer", "A possible answer" (`(leave empty)` for
  an empty reference) and its note. Pattern and note text from the model is rendered
  as plain text, never Markdown.
- **Try again** clears every gap, mints a new attempt id and switches to
  `round: "retry"`; the header shows "Practice round" from then on. A feedback that
  arrives after Try again is dropped.
- **Errors.** A failed `gradeCloze` keeps the answers and shows its message under the
  Submit button (submitting again retries). A failed `explainCloze` keeps the verdicts
  and offers **Retry**, which re-calls only `explainCloze` with the same token.

## Submitting — two server actions (`lib/cloze-actions.ts`)

Both actions verify through `lib/cloze-verify.ts`, which — like `lib/quiz-verify.ts` —
carries **no `"use server"`** (its `verifyAndLoadCloze` returns the exercise,
references and `evaluation` included; guard-tested). Order: cheap shape checks (uuid
attempt id, answers an array of strings ≤ 200 characters) before any I/O → session →
`checkCode()` → `module === "cloze"` → (explain only: the result token) → the YAML
reload → one answer per gap (a mismatch means the teacher changed the gaps since the
page loaded: "reload the page"). Every rejection is a fixed message.

1. **`gradeCloze({ code, attemptId, round, answers })`** →
   `{ ok: true, verdicts, references, resultToken }` (index-aligned with the gaps;
   `references[i]` is "a possible answer", `""` = leave empty) or `{ ok: false, message }`.
   It runs the pre-pass, then — only if gaps are left — one grading call; on success
   `recordClozeSubmission` bumps `cloze_submissions` off the response path (every
   successful grading, practice rounds included) and a content-free `cloze.graded`
   event carries `code`, `round`, `gaps`, `modelGaps`, `latencyMs`. `round`
   (`"first"` | `"retry"`) is client-claimed.
2. **`explainCloze({ code, attemptId, answers, verdicts, resultToken })`** →
   `{ ok: true, patterns, gapNotes }` or `{ ok: false, message }`. It refuses any token
   that does not match the session user, the code, the attempt, the answers and the
   verdicts, so the feedback writer only ever works from verdicts the server produced
   and the action is no general-purpose LLM endpoint. All-correct verdicts return
   empty feedback without a model call. Event: `cloze.explained` (counts, latency).

The **result token** (`lib/cloze-result-token.ts`) is the thread-token family: a
stateless HMAC-SHA256 over `JSON.stringify([code, userId, attemptId, answers, verdicts])`
with its own key, `HMAC(AUTH_SECRET, "novedu:cloze-result:v1")`. Nothing is persisted.

## The grading pipeline

**Pre-pass** (`lib/cloze-prepass.ts`, pure). Answers and references are compared after
NFC, trimming, collapsing whitespace and unifying typographic apostrophes/quotes —
case-sensitive.

| Reference | Answer | Verdict |
| --- | --- | --- |
| `""` (`[[]]`) | empty | `correct` |
| non-empty | empty | `incorrect` ("not answered") |
| any | equal after normalization | `correct` |
| otherwise | | the model decides |

**Agent.** `clozeEvaluator` (`app/mastra/cloze-agents.ts`, registered in
`app/mastra/index.ts`) is memory-less and configured per request from the
RequestContext (`cloze-eval-instructions` / `-model` / `-provider` / `-reasoning`) plus
the usage keys (`usageModule = "cloze"`), so the exporter attributes both calls' tokens.
The model is `effectiveLlm(entry, cloze)` (the code's override applies), gated by
`providerUnavailableReason` on the effective provider. Both calls use
`structuredOutput` with the schemas in `lib/cloze-output-schemas.ts` and the quiz's
truncation retry (`withTruncationRetry`, `lib/quiz-truncation-retry.ts`; events
`cloze.grading.truncated` / `cloze.feedback.truncated`).

**Grading call** (`buildClozeGradingPrompt`, `lib/cloze-grading-prompt.ts`). System
prompt = preamble → frame → `evaluation` → the full text with every gap written as
`⟦3 · reference "starts" · hint "start"⟧` (`formatGapMarker`; JSON-quoted). The user
message is `CLOZE_GRADING_MESSAGE_TEMPLATE` around a JSON list
`[{ "gap": 2, "answer": "…" }]` of the undecided gaps, framed as data, never
instructions. Output `{ gaps: [{ gap, result, reason }] }`; `reason` is never shown to
a student. The output must name every undecided gap exactly once and no other — a
mismatch is retried once (`cloze.grading.mismatch`), then the action fails.

**Feedback call** (`buildClozeFeedbackPrompt`, `lib/cloze-feedback-prompt.ts`). System
prompt = preamble → frame → `evaluation` → the text with references. The user message
`CLOZE_FEEDBACK_MESSAGE_TEMPLATE` carries `[{ gap, answer, verdict }]` for every gap as
fixed facts. Output `{ patterns: [{ title, explanation, gaps, next_time }],
gap_notes: [{ gap, note }] }`. The grading call's `reason`s are not passed on (the
client never holds them).

**Grounding filter** (`lib/cloze-grounding.ts`, pure). Drops a pattern citing an
unknown, duplicate or correct gap or fewer than two gaps, keeps at most three
(`MAX_CLOZE_PATTERNS`); drops a note on an unknown or correct gap, a second note per
gap and an empty note. It reports what it dropped and why (for the eval report); the
student gets `{ title, explanation, gaps (ascending), nextTime }` and `{ gap, note }`.

## Security

- **Server-only content.** The reference answers, `evaluation`, `instructions`, the
  rendered preamble and `llm` never reach the browser before a grading:
  `render-cloze.tsx` ships only `toPublicCloze` (guard-tested). After a grading the
  references come back on purpose, as "a possible answer".
- **The code gates every touch.** `checkCode()` runs on the page load and again in each
  action, and each action reloads the YAML; there is no thread and no thread token.
- **`clozeEvaluator` is never web-reachable** (beside `quizEvaluator`, `evalJudge`,
  `evalTutor`): no module names it as its `runtime.agentId`, so the CopilotKit route
  404s it and `/info` never lists it. Its callers are `gradeCloze` and `explainCloze`
  — the prompts are built server-side; the client sends only answers.
- **`explainCloze` trusts only token-signed verdicts.** The result token binds the
  session user, the code, the attempt, the answers and the verdicts, so a client cannot
  hand the feedback writer verdicts of its own or use it as a free LLM endpoint.
- **`lib/cloze-verify.ts` carries no `"use server"`** (guard-tested): it returns the
  loaded exercise, and as a server action it would leak the references and
  `evaluation`. `lib/cloze-actions.ts` re-exports nothing.
- **Anonymous.** No user↔answer link is stored; telemetry carries ids, counts and
  durations only — never an answer, a reference or feedback text.
- **Accepted trust gaps:** `round` is client-claimed, and there is no rate limit
  beyond `checkCode`.

## Metering

`cloze_submissions` is an `int` counter in both `novedu_usage_by_code` and
`novedu_usage_by_user` (`docs/usage-metering.md`). It is part of the activity-hour
predicates of the start pages (`lib/student-facts-store.ts`,
`lib/teacher-facts-store.ts`), a fifth activity kind for the "Full Stack" (student) and
"Full Toolkit" (teacher) badges, and the `/usage` KPI "Cloze submissions graded".

## Prompt dump

`novedu-cli prompts --kind cloze` (`lib/prompt-dump.ts`) prints a `ClozePromptDump`:
`gapCount`, and for `grading` and `feedback` each the `system` prompt, the
`userMessageTemplate` and the `responseSchema` (JSON Schema) — all from the production
builders (grep-guarded in `lib/prompt-dump.unit.test.ts`).

## Fake LLM

`fake-llm/markers.mjs` answers both calls by schema (`gaps` → grading, `patterns` →
feedback), parsing the JSON list of the user message: an answer containing
`[grade:correct|partial|incorrect]` gets that verdict, `[grade:omit]` is left out (so
the grading fails after its retry), anything else is `incorrect`; feedback is one
"Fake LLM pattern" over the non-correct gaps (when there are at least two) plus one
note each, and an answer containing `[explain:fail]` makes the feedback call fail
(`docs/testing.md`).

## Tests

- `lib/cloze-gaps.unit.test.ts` — syntax, escapes, every forbidden and allowed
  position, limits, numbering, line/column, the inventory.
- `lib/cloze-validate.unit.test.ts` — the strict schema (unknown and quiz-only keys,
  missing fields), gap errors through the validator, the fragment gate, the metadata.
- `lib/cloze-yaml.unit.test.ts` — the lenient parser and the projection guard.
- `lib/file-validators.unit.test.ts`, `lib/files-actions.unit.test.ts` — the seam
  mapping (`anonymous: true`, the inventory as `summary`, the provider gate).
- `cli/src/commands/validate.unit.test.ts`, `cli/test/validate.integration.test.ts` —
  `--kind cloze` over `test-fixtures/activities/cloze/`.
- `e2e/files.spec.ts` — the `/files/new` Validate button with a valid and a misplaced
  gap.
- `lib/cloze-prepass.unit.test.ts`, `lib/cloze-grounding.unit.test.ts` — the pre-pass
  table and every grounding rule.
- `lib/cloze-result-token.unit.test.ts` — the real HMAC: each payload field binds, the
  key domain differs from the thread token's.
- `lib/cloze-prompts.unit.test.ts` — both builders, the user-message wrappers, and the
  dump byte-identical to them.
- `lib/cloze-actions.unit.test.ts` — check order, `checkCode` on every call, the
  pre-pass skipping the model, the coverage retry, the token, metering, content-free
  telemetry, and `lib/cloze-verify.ts` without `"use server"`.
- `lib/code-modules/cloze.unit.test.ts`, `app/[code]/render-cloze.unit.test.tsx` (the
  projection is all the runner receives), `app/[code]/page.unit.test.tsx`, the runtime
  route's `clozeEvaluator` 404s (`app/api/copilotkit/[[...slug]]/route.unit.test.ts`),
  `fake-llm/markers.unit.test.ts`, `cli/src/commands/prompts.unit.test.ts`.
- `tests/component/cloze-runner.browser.test.tsx` — the runner with mocked actions:
  labelled inputs in tab order, the counter, the empty-gap confirmation, chips before
  the feedback, the all-correct and no-pattern lines, both failure states with their
  retry, Try again → "Practice round" with `round: "retry"` and a fresh attempt id.
- `e2e/cloze.spec.ts` (`@live-db`, fake LLM) — `/<code>` and `/codes/<code>` open
  without errors; fill → submit → verdicts → pattern → gap panel → Try again → all
  correct. Its `@live-llm` test proves a real model honours both structured outputs
  (`test-fixtures/activities/cloze/live-cloze.yaml`).
