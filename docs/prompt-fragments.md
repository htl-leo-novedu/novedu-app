# Prompt fragments

Deep reference for the **shared prompt-fragment core**: the one home of Handlebars
handling and the load / fetch / placement-check / render pipeline that turns an
activity's **host text** (with inline `{{fragment}}` and `{{file}}` markers) plus its
declared fragment **libraries** and plain-**text files** into a finished prompt string. It is not an activity module —
it is the infrastructure **every** activity kind (tutor, quiz, writing, coding, cloze)
build on, so a persona / safety / rules fragment written once in a fragment library is
reusable by every kind. The teacher-facing authoring guides live in
`activities/tutors/README.md` (the full fragment format) and
`activities/fragments/README.md` (the library editor schema); this file is the code
reference. Read it before touching `lib/prompt-fragments/**`, or when wiring a new
consumer of the block.

## Inline placement — the model

An activity does **not** list which fragments it uses in a document-level `fragments:`
array (there is no such list, and no `priority`). Instead the activity's own host text
is a Handlebars template, and the author places each fragment exactly where they want
it with an inline marker:

```yaml
fragment_files:
  - id: shared
    url: ./general-fragments.yaml
tutor_instructions: |
  {{fragment "shared.persona" level="beginner" topics=(array "loops" "arrays")}}

  You are helping students with...

  {{fragment "shared.hint-style" tone="strict"}}
```

- The reference is a **quoted string literal** `"alias.id"`, split at the **first** dot:
  the alias (which cannot contain a dot) before, the fragment id (which may) after.
- Inline hash args are the only variable source: strings and booleans as native hash
  args, string arrays via the registered `array` subexpression helper — `items=(array
  "a" "b")`. Per placement, effective variables = the fragment's `input_schema`
  defaults overridden by the inline args.
- The **same fragment may be placed multiple times** with different args. Fragments
  appear **only where placed** — order is textual position, nothing else.

### Embedding plain-text files — `{{file "alias"}}`

Alongside fragment libraries an activity may declare **`text_files:`** and splice an
arbitrary fetched file (markdown course material, a sample-solution source file) into
its host text with an inline `{{file "alias"}}` marker:

```yaml
text_files:
  - id: course
    url: https://example.com/material/loops.md
tutor_instructions: |
  Base your explanations on this course material:
  {{file "course"}}

  Only this excerpt matters today:
  {{file "course" from=120 to=180}}
```

- The reference is a **bare alias** — a quoted string literal with **no dot** (there is
  nothing to select inside a plain file), unlike a `{{fragment}}` `"alias.id"` ref.
- File content is spliced **verbatim** — it is **never compiled as Handlebars**, so a
  literal `{{` in the fetched material is inert by construction. There are no args.
- Optional **`from=` / `to=`** hash args are 1-based, **inclusive** line numbers (real
  Handlebars integer literals ≥ 1). Either may appear alone: `from=120` means "line 120
  to end of file", `to=40` means "line 1 to 40"; when both are given, `from <= to`. A
  no-range `{{file}}` splices the body byte-for-byte, trailing newline and all.
- **Out-of-range `to`**: authoring validators error (`TEXT_FILE_RANGE_OUT_OF_BOUNDS`);
  at **runtime `to` clamps to end-of-file**, so a source file shortened after validation
  degrades gracefully. A **`from` beyond EOF is ALWAYS an error** (an empty splice would
  silently drop material). The same file may be placed multiple times with different ranges.
- **One alias namespace:** an `id` may not collide across `text_files` and
  `fragment_files`, so every marker alias resolves unambiguously.

## The module — `lib/prompt-fragments/`

The single owner of Handlebars: fragment-content rendering, the isolated host-template
engine, placement checking, fragment schemas, and the load pipeline. Extracted out of
`lib/tutors/` so no kind owns it. The public surface is the
`lib/prompt-fragments/index.ts` barrel; consumers import from `@/lib/prompt-fragments`
and never re-implement any of it.

- **`assembleFragmentPrompts(block, baseUrl, fetchImpl, opts, hostTexts)`** (`load.ts`) —
  **THE orchestrator** and the sole owner of the fetch → validate → check → render
  pipeline, taking one or more **host texts** of the SAME document (fetched/checked
  once, each host rendered on its own; errors collected across hosts fail the whole
  call, `prompts` index-aligned with `hostTexts`).
  **`assembleFragmentPrompt(block, baseUrl, fetchImpl, opts, hostText)`** is its
  single-host wrapper — what most kinds call. Given a document-level
  `{ fragment_files, text_files }` block, a base URL, a `Fetcher`, `LoadOptions`, and
  the host text(s), it:
  1. **Template-semantics opt-in:** if the block declares **neither `fragment_files`
     NOR `text_files`**, it returns every host text **byte-verbatim** — never compiled,
     no fetch. This protects plain activities and the authoring tutors whose prose contains
     sample markers as teaching content.
  2. Otherwise fetches every declared library **and every declared text file in
     parallel** (one combined `Promise.all`; relative refs resolved against `baseUrl` via
     `resolveFragmentUrl`, through the same `Fetcher` + `schemeGate`). Libraries are YAML-
     parsed + schema-validated; text files are kept as the **raw string** (no YAML parse),
     with the 200 KB (UTF-8 bytes) cap enforced immediately after fetch (`TEXT_FILE_TOO_LARGE`).
     Every failing file is collected and surfaced at once (fail closed). Optionally runs
     the thorough whole-library check (`validateLibraries`).
  3. `parseHostPlacements(hostText)` per host, then ONE `checkPlacements(...)` over the
     union of all hosts' placements (the placement checker receives both the fragment
     side and the text-file side + the strictness flag; a library placed in any host
     counts as used).
  4. Renders each host template under strict Handlebars — the `fragment` resolver
     renders each fragment, the `file` resolver splices each prefetched body (verbatim,
     or `sliceLines` with `to` clamped to EOF); any throw is the fail-closed
     `ASSEMBLY_ERROR` backstop.
  Returns `{ ok: true, prompts, warnings }` or `{ ok: false, errors, warnings }` (the
  wrapper: `prompt`). Every kind funnels through this ONE pipeline — the tutor passes
  `tutor_instructions`, writing/coding/cloze pass `instructions`, and quiz passes its two
  optional host texts, the top-level `instructions` + `discussion.instructions`.
- **`host-template.ts`** — owns the **isolated `Handlebars.create()` instance** with
  the `fragment` + `array` + `file` helpers, so those helpers exist ONLY when rendering
  host text. Exposes `parseHostPlacements(text)` (a `Handlebars.parse()` AST walk
  producing the placement list `{ kind, ref, args, from?, to?, line, column }` plus
  findings) and `renderHostTemplate(text, resolver, fileResolver)` (compile + run under
  `{ strict: true, noEscape: true }`; `fileResolver` defaults to a thrower so a `{{file}}`
  rendered without one fails closed). Host-template **parse errors** carry no structured
  position, so the line is regexed out of the message (`/line (\d+)/`) —
  `HOST_TEMPLATE_PARSE_ERROR`; a fragment marker whose reference is not a quoted literal
  is `FRAGMENT_REF_NOT_LITERAL`. **`{{file}}` marker structure** — first positional a
  quoted literal, exactly one positional, hash keys restricted to integer `from` / `to`
  (≥ 1, `from <= to`), no block `{{#file}}`, no `(file …)` subexpression — is checked in
  `extractFileMarker` / `visitExpression` / `collectPlacements` symmetrically with the
  fragment handling; every `{{file}}` structural violation is the SAME
  `TEXT_FILE_MARKER_INVALID` code (deliberately no separate not-literal variant).
- **`assemble.ts`** — `renderFragmentContent(content, variables)`: renders ONE
  fragment's `content` with `COMPILE_OPTIONS = { strict: true, noEscape: true }` on the
  **default** Handlebars instance (which has no `fragment` helper — so a fragment that
  tries to call `{{fragment}}` itself fails closed under strict mode; nesting is out of
  scope by design).
- **`consistency.ts`** — `checkPlacements(placements, filesByAlias, fileRefs,
  textFilesByAlias, textFileRefs, strict)` dispatches on `placement.kind`. **Fragment**
  placements resolve each `alias.id` and validate their args (required / type / undeclared
  / defaults); warns on a declared library no marker uses (`UNUSED_FRAGMENT_FILE`). The
  shared **`resolveAndMerge(ref, args, filesByAlias)`** is used by BOTH `checkPlacements`
  (validation) and the `fragment` helper (render), so the two cannot drift on which
  fragment, which defaults, which types. **File** placements resolve the bare alias
  against the fetched-body map and bounds-check the range: `DUPLICATE_TEXT_FILE_ALIAS`
  for an alias declared twice OR colliding with any `fragment_files` id (ONE shared
  namespace); `UNKNOWN_TEXT_FILE_ALIAS` for an undeclared alias; `from` beyond the line
  count is `TEXT_FILE_RANGE_OUT_OF_BOUNDS` **always** (an empty splice would silently drop
  material), `to` beyond it only under the **`strict`** (authoring) flag — runtime clamps;
  `UNUSED_TEXT_FILE` warns on a declared text file no marker places. `resolveAndMerge`
  is untouched. Fragment placements skip the file logic and vice versa.
- **`text-files.ts`** — a small **Handlebars-free** pure module, the SINGLE source of
  truth for line semantics used by BOTH `checkPlacements` (bounds) and the render
  `fileResolver` (slice), so a range can never validate differently than it renders.
  `countLines(body)` and `sliceLines(body, from?, to?)`: `body.split("\n")` with one
  trailing empty element dropped for a newline-terminated file (so `"a\n"` is one line);
  an empty body is zero lines; `from`/`to` are 1-based inclusive; `from` alone = to EOF,
  `to` alone = from line 1; **`to` clamps to EOF** (native `Array.slice`) — callers
  enforce the `from` lower bound. Because it only slices strings it is **not** one of the
  three legal `handlebars` importers.
- **`loadYaml` / `LoadOptions`** — the shared front of every load: enforce the URL
  scheme allow-list (SSRF guard: http(s) on the server; the CLI adds `file:`), fetch,
  parse YAML. `LoadOptions` carries `allowedSchemes` and `validateLibraries`.
- **`loadAndCheckFragmentFile`** — the standalone fragment-library validator (a real
  validator with **no** module; the `fragment` FileKind in `docs/codes.md`).
- **`resolveFragmentUrl`, the fragment schemas** (`FragmentFileRefSchema`,
  `FragmentFileSchema`, `FragmentSchema`, …), the **error model**
  (`ValidationError` / `ValidationWarning`, `error`/`warning`), `Fetcher` /
  `defaultFetcher`, `getFragmentInputSchema`, `checkFragmentFileValue`.

## The isolation invariant

`handlebars` is imported by **exactly three** files, all under
`lib/prompt-fragments/`: `assemble.ts` (fragment-content render), `fragment.ts`
(standalone whole-library check), and `host-template.ts` (the isolated host-template
instance). `COMPILE_OPTIONS` is referenced only within the module. A grep-guard unit
test (`lib/prompt-fragments/isolation.unit.test.ts`) enforces both: it fails the build
if `handlebars` is imported — or `COMPILE_OPTIONS` referenced — outside the directory
(and asserts the three real importers are present, so the guard can't silently pass on
a rename). No consumer touches Handlebars; they all go through
`assembleFragmentPrompt`.

Adding `{{file}}` did **not** touch the invariant: text-file content is spliced
**verbatim and never compiled**, so `text-files.ts` does pure string slicing and stays
out of the three-importer set. The `file` helper lives on the same isolated instance
`host-template.ts` already owns — no new Handlebars importer, no change to
`isolation.unit.test.ts`.

## The document-level fragment block

Every activity kind embeds the same block shape: **`fragment_files:`** (fragment
libraries) and **`text_files:`** (plain-text files) — each entry an `id` alias (which
**cannot contain a dot**) + an http(s)-or-relative `url`. `TextFileRefSchema` mirrors
`FragmentFileRefSchema` exactly (same no-dot alias regex, same `FragmentUrlRef`). The
two lists share **ONE alias namespace** — an `id` may not collide across them, so every
`{{fragment}}` / `{{file}}` marker alias resolves unambiguously. The tutor keeps the
block **nested under `prompt:`** (the `FragmentBlock` IS `tutor.prompt`); quiz / writing
/ coding embed it **flattened to the document root**. `readFragmentBlock` (`block.ts`,
Handlebars-free) is the **lenient** reader the runtime `*-yaml.ts` parsers call to lift
both lists out of a document root without imposing a strict schema (`EMPTY_FRAGMENT_BLOCK`
carries `text_files: []` too).

### Variables, defaults, and severity

A fragment's `input_schema` is a constrained mini JSON-schema: properties typed
`string` / `boolean` / `array`-of-strings, a `required` list, and an optional typed
**`default`** per property. `resolveAndMerge` injects a default when the placement
omits an optional variable (a supplied value always wins); a `default` on a *required*
property can never apply and draws the `REQUIRED_PROPERTY_HAS_DEFAULT` warning. The
severity split: missing required variable, type mismatch, unknown alias/fragment,
duplicate alias, and duplicate id-in-file are **errors**; supplying an *undeclared*
variable and declaring a library no marker uses are **warnings**. The whole-library
check (`checkFragmentTemplates`) strict-renders against typed *placeholders* and
deliberately ignores real defaults — it only proves every declared variable renders.

### Accepted-but-inert fields

The fragment library's per-fragment **`version`** (now **optional**, consumed by
nothing) and the optional **`classification`** block (`type` + `override_allowed`)
validate but drive nothing. Don't assume versioning or override semantics exist — none
do today. (`priority`, the document-level `fragments:` list, and its `bind` / `required`
/ `variables` are **gone** — replaced by inline placement.)

## Error model

| Code | Severity | Meaning |
|------|----------|---------|
| `HOST_TEMPLATE_PARSE_ERROR` | error | The host text did not parse — a malformed marker or an unescaped literal `{{`. Carries the `line`. |
| `FRAGMENT_REF_NOT_LITERAL` | error | A `{{fragment}}` marker whose reference is not a quoted `"alias.id"` string literal. |
| `FRAGMENT_MARKER_INVALID` | error | A structurally wrong marker that would render differently than it validates: a block `{{#fragment}}…{{/fragment}}`, a `(fragment …)` subexpression, extra positional args, or a hash arg that is not a string / boolean / `(array "…" …)`. |
| `UNKNOWN_FRAGMENT_FILE_ALIAS` | error | A marker's alias is not a declared `fragment_files` id. |
| `FRAGMENT_NOT_FOUND` | error | The fragment id does not exist in the aliased library. |
| `MISSING_REQUIRED_VARIABLE` / `VARIABLE_TYPE_MISMATCH` | error | Placement args fail the fragment's `input_schema`. |
| `DUPLICATE_FRAGMENT_FILE_ALIAS` / `DUPLICATE_FRAGMENT_ID_IN_FILE` | error | An alias / a fragment id is declared twice. |
| `TEXT_FILE_MARKER_INVALID` | error | A structurally wrong `{{file}}` marker: a block `{{#file}}…{{/file}}`, a `(file …)` subexpression, an extra positional, an alias that is not a quoted literal, a hash key other than `from` / `to`, a non-integer or `< 1` `from`/`to`, or `from > to`. ONE code for every `{{file}}` violation (no separate not-literal variant). |
| `UNKNOWN_TEXT_FILE_ALIAS` | error | A `{{file}}` marker's alias is not a declared `text_files` id. |
| `DUPLICATE_TEXT_FILE_ALIAS` | error | A text-file alias declared twice — including a collision with a `fragment_files` id (one shared namespace). |
| `TEXT_FILE_RANGE_OUT_OF_BOUNDS` | error | `from` beyond EOF (**always**); `to` beyond EOF (**authoring validators only** — runtime clamps `to` to EOF). |
| `TEXT_FILE_TOO_LARGE` | error | A fetched text-file body exceeds the 200 KB cap (fail closed; carries the alias + URL). |
| `UNUSED_FRAGMENT_FILE` | warning | A declared library that no marker draws from. |
| `UNUSED_TEXT_FILE` | warning | A declared text file that no `{{file}}` marker embeds. |
| `UNDECLARED_VARIABLE` / `REQUIRED_PROPERTY_HAS_DEFAULT` | warning | Extra arg / a required prop with a futile default. |
| `ASSEMBLY_ERROR` | error | The strict host-template render threw (the fail-closed backstop). |

Runtime loaders stay fail-closed (`{ ok: false }` on any error); authoring validators
keep `validateLibraries: true`.

## Who consumes it, and how

Every kind resolves one document-level block + their host text through the shared
`assembleFragmentPrompt`; the runtime seam of each is documented in its own doc.

- **Tutor** (`lib/tutors/`) — `loadAndBuildTutorPrompt` passes `tutor_instructions` as
  the host text and gets the complete prompt back. `lib/tutors/` holds only
  tutor-specific code (`TutorSchema`, the wrapper, `sample.ts`).
- **Quiz** (`docs/codes.md`) — resolved **once** at load (`loadQuiz`,
  `lib/quiz-fetch.ts`): the quiz's TWO host texts render in one
  `assembleFragmentPrompts` pass — the optional top-level **`instructions`** into the
  server-only **`Quiz.instructionsPreamble`** (prepended to BOTH the grader prompt and
  the discussion chat's system prompt) and the optional **`discussion.instructions`**
  into the rendered `Quiz.discussionInstructions` (discussion-only). `toPublicQuiz`
  copies neither. (No markers in per-question `evaluation`.) Note that the quiz's
  **`quiz_files`** live includes are NOT a fragment mechanism: questions are
  structured data, not prompt text — the quiz loader merely calls the existing
  `assembleFragmentPrompt` seam once more per included quiz (with the SOURCE's own
  block, relative to the SOURCE url) to render that source's `instructions` into the
  imported questions' `sourcePreamble`. The Handlebars importer set is unchanged.
- **Writing** (`docs/writing.md`) — `loadWriting` (`lib/writing-fetch.ts`) renders the
  `instructions` host text and stores the result back as `instructions`.
- **Coding** (`docs/coding.md`) — `loadCoding` (`lib/coding-fetch.ts`) does the same for
  its `instructions`. Rendering stays in the load/parse layer, **never** in
  `lib/llm/endpoint.ts` (which stays provider-blind and side-effect-free).
- **Cloze** (`docs/cloze.md`) — `loadCloze` (`lib/cloze-fetch.ts`) renders the optional
  `instructions` **once** into the server-only `Cloze.instructionsPreamble`, prepended
  to BOTH the grading and the feedback prompt. `toPublicCloze` never copies it.

## Literal-text safety & whitespace

- In a fragment-using activity a literal `{{` must be escaped as `\{{` (it renders back
  to `{{`). A forgotten escape fails at save time (authoring validators) with
  Handlebars' `line:col` message, and fails closed at runtime — never silent text loss.
- Whitespace house policy: put a marker on its own line; surrounding blank lines are
  preserved. The `~` trim variant works but is deliberately undocumented (it eats
  adjacent blank lines aggressively).

## Runtime vs. authoring — `validateLibraries`

`validateLibraries` (a `LoadOptions` flag, default `false`) opts a build INTO the
thorough whole-library check: **every** fragment in every referenced file is
strict-rendered against its own `input_schema`, not just the fragments the activity
places, catching a template bug anywhere in a referenced library. The same flag is
passed to `checkPlacements` as its `strict` argument, so authoring builds also flag a
`{{file}}` `to=` beyond end-of-file (`TEXT_FILE_RANGE_OUT_OF_BOUNDS`) that the runtime
would silently clamp.

- **Runtime loaders** (`loadQuiz` / `loadWriting` / `loadCoding`, and the tutor's own
  runtime path) pass `validateLibraries: false` — the hot path (chat start, quiz
  grading, the per-request coding proxy) needs only the finished prompt. A fetch /
  placement / render failure at runtime is a hard `{ ok: false }` (**fail closed**).
- **Authoring validators** (`loadAndCheckQuiz` / `loadAndCheckWriting` /
  `loadAndCheckCoding`, `loadAndBuildTutorPrompt` at share/validate time, and the CLI)
  default `validateLibraries: true` — so a broken fragment in a referenced library is
  caught at save / share time, not when the first student opens.

Fragment fetches go through the existing loopback-avoiding `appHostedFetcher` via an
optional async post-parse `resolve` hook on `loadAppHostedYaml`
(`lib/app-hosted-yaml.ts`): an app-hosted fragment ref resolves from the database,
never a loopback fetch — preserving the `docs/files.md` invariant.

## Security posture

Rendering is server-side inside the load path; the finished prompt, the grading
prompts, the writing instructions, and the coding system prompt never reach the
browser. The scheme gate (http(s) on the server; `file:` added only by the CLI)
applies to **both** fragment and text-file fetches — same SSRF guard as the activity
YAML itself — and the 200 KB cap bounds an embedded file.

Text-file content is **strictly less powerful** than a fragment: it is spliced
**verbatim and never compiled**, so fetched material can never execute template logic —
a literal `{{` in course material is inert. The change only narrows the surface.
