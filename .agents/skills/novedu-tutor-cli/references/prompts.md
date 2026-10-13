# `prompts`: what the model actually receives

```
prompts <pathOrUrl> [--kind tutor|quiz|writing|coding] [--json]
```

`prompts` prints the EXACT system prompts an activity YAML produces, built by
the app's own prompt builders and runtime loaders — never a re-derivation. Use
it whenever the question is about BEHAVIOUR rather than validity ("why does the
grader accept this?", "does my safety fragment reach the tutor?", "show me the
grading prompt for question 3"), and when preparing prompt evals.

Reads files exactly like [validate.md](validate.md) (local and external files offline; uploaded files with the stored sign-in). `--kind` is caller-declared exactly as in
[validate.md](validate.md), minus `fragment` — a library has no prompt of its
own; its fragments show up rendered inside the activity that places them.

## The argument and what "offline" means

The argument is a path or a public `http(s)` URL, same as `validate`'s. Relative
`fragment_files` / `quiz_files` / `text_files` resolve against the activity's
own location — sibling file, or sibling URL. "Offline" here means no server, no
DB and no LLM call; it does not mean "no network", since a URL argument or a
remote fragment file still gets fetched.

## What you get back

Every kind returns the envelope `{ kind, id, llm: { provider, model, reasoning? } }`
(`reasoning` only when the file sets a level). The
`llm` block is the FILE's own — a code's per-code LLM override is **not**
applied, so a prompt dump never reflects what a specific shared link is running;
an override may add, change or drop the reasoning level too.

- **quiz** adds `grading` and `discussion`.
  - `grading.questions[].system` — the full grading prompt per question — plus
    `imageInput`, the `userMessageTemplate` / `userMessagePhotosOnly` wrappers,
    and `responseSchema`, the grader's JSON Schema.
  - `discussion` — `system`, the three `seedMessages` templates, and
    `verdictLabels`.
  - For a **compound quiz** the questions are the RESOLVED pool: namespaced
    `"<alias>/<id>"` ids, each carrying its source quiz's preamble. Use those
    ids when writing an eval for a compound quiz.
  - The live hint a student sees while typing (`immediate_feedback`) is **not**
    in the dump: it is a classifier request, not a prompt, and it is graded by
    nothing — `grading` remains the only judgment `prompts` shows.
- **tutor** and **writing** give `system`.
- **coding** gives `system` plus `upstreamSystemMessage` — what the proxy puts
  on the wire, appended to the calling agent's last system message so the
  teacher has the final word.

## Failures

`prompts` runs the RUNTIME load path, so failures surface as a single
`ACTIVITY_LOAD_FAILED` JSON error on stderr, exit 1 — deliberately coarse. For
structured authoring errors run `validate` instead; it is the command that
names the offending field.

## Examples

```bash
# Human summary: id, model, chars per prompt
npx @novedu/cli prompts ./my-tutor.yaml

# A tutor's assembled system prompt
npm run cli --silent -- prompts activities/examples/sorting-algorithms/sorting-tutor.yaml --json | jq -r .system

# One question's grading prompt
npm run cli --silent -- prompts ./my-quiz.yaml --kind quiz --json | jq -r '.grading.questions[0].system'

# A published activity
npx @novedu/cli prompts https://raw.githubusercontent.com/…/my-tutor.yaml
```
