# Cloze

Deep reference for the **cloze** activity ("Fill the gaps"): students complete the
gaps of ONE text and, after submitting the whole exercise, get a verdict per gap plus
consolidated feedback that connects their mistakes. The file kind, the module and the
eval kind are all named `cloze`. The always-on invariants are summarized in
`AGENTS.md`; this file has the full mechanics.

Read it before touching the cloze libs (`lib/cloze-*.ts`), the cloze schema
(`activities/cloze/cloze-yaml.schema.json`, generated from `lib/cloze-schema.ts`), or
the cloze sample under `activities/examples/`.

This file covers the **authoring** layer: the `cloze` file kind with its strict
validator, the gap parser, the lenient runtime parser with the public projection, the
generated JSON schema, `novedu-cli validate --kind cloze`, and the `/files` editor's
Cloze kind. `cloze` is a file kind without a code module: no code can be created for a
cloze file (the `/files` list offers no "Create code" for it), and it has no prompt
dump (`PromptKind` excludes it).

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
