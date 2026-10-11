# `novedu-cli prompts` — dumping an activity's exact LLM prompts

The `prompts` command prints the **exact system prompts** an activity YAML
produces — the strings the app really sends to the model. Teachers use it to see
what their file turns into; the eval harness (`novedu-cli eval`, `docs/cli-eval.md`)
uses it to grade prompts without re-implementing (and slowly drifting from) our
assembly rules.

Like `validate`, it is **offline and sign-in-free**: a local path or a `file:` /
`http(s)` URL, no server, no database, no LLM call.

```
novedu-cli prompts <pathOrUrl> [--kind tutor|quiz|writing|coding] [--json]
```

`--kind` is caller-declared (default `tutor`), exactly like `validate`. There is
no `fragment` kind: a library produces no prompt of its own — its fragments show
up **rendered in place** inside whichever activity places them.

## The invariant: one implementation, never a copy

> **External tools must never re-implement prompt assembly.** Every dumper calls
> the same builders and loaders production runs.

| Kind | What the dump runs |
| --- | --- |
| `tutor` | `loadAndBuildTutorPrompt` (`lib/tutors`) — the same call the tutor agent makes per request |
| `quiz` | `loadQuizFrom` (`lib/quiz-resolve.ts`) → `buildGradingPrompt` (`lib/quiz-grading-prompt.ts`) per question + `buildDiscussionInstructions` (`lib/quiz-discussion-prompt.ts`) |
| `writing` | `loadWritingFrom` (`lib/writing-resolve.ts`) |
| `coding` | `loadCodingFrom` (`lib/coding-resolve.ts`) + `buildUpstreamChatBody` (`lib/coding-proxy.ts`) |

Two guards keep it that way, both in `lib/prompt-dump.unit.test.ts`:

- a **purity guard** — the dump seam and the pure modules it reaches for
  import nothing from `app/**`, the DB, or `lib/llm/model.ts`, and carry no
  `"use server"` directive. Enforced twice over: a per-file grep of the documented
  seam modules, plus a walk of the **entire transitive import closure** of
  `lib/prompt-dump.ts` (every specifier form — relative paths, side-effect
  imports, `export … from`, dynamic `import()`), so a server-only import N levels
  deep fails too. This is load-bearing: `app/mastra/scch.ts` performs a
  **top-level `await` network call at import time** and is pulled in transitively
  through `lib/llm/model.ts`, so a single `app/` import would break the CLI. The
  walk runs on the shared `tests/import-graph.ts` (`walkClosure`), which the CLI
  telemetry guard uses as well.
- a **no-second-implementation guard** — `lib/quiz-actions.ts` and
  `lib/code-modules/quiz.ts` must IMPORT the extracted builders (the prompt text
  itself must not appear in either file).

Plus golden tests (`lib/quiz-grading-prompt.unit.test.ts`,
`lib/quiz-discussion-prompt.unit.test.ts`) that pin the assembled strings
character by character.

## Architecture: a Layer-2 seam next to the validators

`lib/prompt-dump.ts` is the read-only sibling of `lib/file-validators.ts` — the
validator seam of the codes architecture (`docs/codes.md`). Both are keyed by
**`FileKind`** and both derive from the **FILE alone**, never from a code entry:

```
FileKind ──┬─► fileValidators[kind].validate(url, fetcher)   "is it valid + metadata"
           └─► promptDumpers[kind].dump(url, fetcher, opts)  "which prompts does it produce"
```

`PromptKind = Exclude<FileKind, "fragment" | "cloze">` — a fragment library produces no
prompt of its own, and cloze has no prompt builder to dump. The CLI command
(`cli/src/commands/prompts.ts`) stays generic over kinds: it picks a kind,
calls `dumpPrompts`, and renders — the human summary walks the kind-agnostic
`promptSections(dump)` list, so a new kind needs no renderer change.

Adding a prompt-producing kind = one dumper entry + its loader, nothing else.

## Runtime path, not the authoring gate

`prompts` runs the **lenient runtime loaders** — the same ones the app uses when
a student opens the activity — because that is what makes the output faithful.
So a load failure is reported as one structured
`ACTIVITY_LOAD_FAILED` error carrying the loader's friendly message. For the
strict, structured authoring check (schema errors, duplicate ids, thorough
whole-library fragment validation) use **`validate`**; the two are complementary.

Each runtime loader is split in two:

| Pure, fetcher-injected | App-hosted / DB seam |
| --- | --- |
| `lib/quiz-resolve.ts` (`resolveQuiz`, `loadQuizFrom`) | `lib/quiz-fetch.ts` (`loadQuiz`) |
| `lib/writing-resolve.ts` | `lib/writing-fetch.ts` |
| `lib/coding-resolve.ts` | `lib/coding-fetch.ts` |

The `*-fetch.ts` modules keep owning `loadAppHostedYaml` + `appHostedFetcher`
(the loopback-avoiding app-hosted resolution — `docs/files.md`); the `*-resolve.ts`
modules own the resolution itself and are what the CLI imports, with
`allowedSchemes` extended by `file:` so on-disk activities resolve their siblings.

## Output

Human-readable by default (kind, id, provider/model, one line per prompt with its
character count); `--json` prints the full dump on stdout. Errors are JSON on
stderr with exit 1, per the CLI's conventions.

Common envelope:

```json
{ "kind": "quiz", "id": "sorting-quiz", "llm": { "provider": "SCCH", "model": "…" } }
```

The **activity's own** `llm` block is reported. A code's per-code LLM override
pair (`effectiveLlm`, `docs/ai-models.md`) is deliberately **out of scope** — a
dump describes a file, and a file has no code.

### Per kind

- **tutor** → `system`: the assembled `tutor_instructions`, fragments placed
  inline; plus `tools`: the opted-in built-in tool names (top-level `tools:`,
  `[]` by default) — their definitions ship to the model alongside the prompt
  (`docs/tutor-tools.md`). The human summary lists them when non-empty.
- **writing** → `system`: the coach's whole system prompt. Writing has exactly
  **one** host text (`instructions`); `placeholder` is editor starter text, not a
  prompt, and the agent's only tool (`getCurrentText`) carries no teacher text.
- **coding** → `system` (the assembled `instructions`) plus
  `upstreamSystemMessage`: what the proxy really puts on the wire, built by the
  proxy's own `buildUpstreamChatBody` over an empty client body. When the calling
  agent sends no system message the proxy prepends one carrying exactly this text;
  when it does, the same text is **appended to the client's last system message**
  so the teacher keeps the final word (`docs/coding.md`).
- **quiz** → the biggest dump, and the one an eval harness wants:

```json
{
  "grading": {
    "userMessageTemplate": "The student's answer:\n\n{answer}",
    "userMessagePhotosOnly": "The student answered with the attached photo(s) only.",
    "responseSchema": { "…": "QUIZ_VERDICT_SCHEMA as plain JSON Schema" },
    "questions": [{ "id": "…", "title": "…", "system": "…", "imageInput": false }]
  },
  "discussion": {
    "system": "…",
    "seedMessages": {
      "question": "Answer the following question: {question}",
      "answer": "{answer}",
      "verdict": "Your answer is {verdictLabel}. {feedback}"
    },
    "verdictLabels": { "correct": "correct", "partial": "partly correct", "incorrect": "wrong" }
  }
}
```

- `questions` is the **RESOLVED** pool: for a compound quiz every `quiz_files`
  include is fetched and each imported question's grading prompt carries its
  SOURCE quiz's preamble (`sourcePreamble`), exactly as in production. Question
  ids are the namespaced `"<alias>/<id>"` ones.
- `imageInput` is the EFFECTIVE flag (per-question override → quiz default).
- `responseSchema` is `QUIZ_VERDICT_SCHEMA` (`lib/quiz-verdict-schema.ts`)
  converted with zod 4's native `z.toJSONSchema` — the same mechanism
  `lib/schema-gen` uses for the authoring schemas.
- The three `seedMessages` are the messages `startDiscussion` writes into a
  thread's memory; `question` and `verdict` are templates (their variable parts
  are per-attempt), `answer` marks where the student's own answer is seeded
  verbatim. The discussion prompt itself uses only the compound file's own
  instructions — see `lib/quiz-discussion-prompt.ts` for why.

## Tests

| Layer | File |
| --- | --- |
| Golden prompt strings | `lib/quiz-grading-prompt.unit.test.ts`, `lib/quiz-discussion-prompt.unit.test.ts` |
| Purity + no-second-implementation guards, verdict JSON Schema | `lib/prompt-dump.unit.test.ts` |
| The command core over the fixtures | `cli/src/commands/prompts.unit.test.ts` |
| The built binary (local-only, offline) | `cli/test/prompts.integration.test.ts` |

All of them are hermetic — no LLM, no DB, no network (the integration test's
served-URL case uses `test-fixtures/serve.mjs`). See `docs/testing.md`.
