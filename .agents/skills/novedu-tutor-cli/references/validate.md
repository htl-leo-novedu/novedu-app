# `validate`: kinds, thoroughness, and error codes

```
validate <pathOrUrl> [--kind tutor|fragment|quiz|writing|coding|eval] [--json]
```

Offline for a local path or an external URL (no server, no sign-in). A file
uploaded to Novedu (`https://<server>/api/files/<name>`) is read with the stored
`login` session for that server — no other host ever gets the token; a refusal adds
an error naming the `novedu-cli login --server <origin>` that fixes it. Exit `0` = valid, `1` = errors, so it works
directly as a pre-commit or CI gate.

`validate` takes **one file per call** — only `eval` accepts globs. For many
files, loop:

```bash
for f in ./part-1/*.eval.yaml; do npm run cli --silent -- validate "$f" --kind eval; done
```

## Choosing `--kind`

`--kind` is caller-declared, never auto-detected. Tell-tales:

| Kind | Tell-tale in the YAML |
| --- | --- |
| `tutor` | a top-level `prompt` |
| `quiz` | `questions` |
| `writing` / `coding` | `instructions` |
| `fragment` (library) | `fragments`, and none of the above |
| `eval` | `target` plus `questions[].answers` |

Careful: quiz, writing and coding documents may ALSO carry a top-level
`fragments:` — that is their *document-level fragment block*, not a library. So
`fragments` alone never means "fragment library"; check that none of the other
tell-tales are present.

`--kind eval` also strict-checks the quiz the eval targets, so a green eval
validation certifies both files. See [eval.md](eval.md) for the eval format.

## What validation actually checks

- It is **thorough by design**: any kind that declares a fragment block
  (`fragment_files:` + `fragments:`) gets every fragment in every referenced
  library strict-rendered. A latent template bug anywhere in a referenced
  library therefore fails the activity, even for fragments the activity never
  places. That is intentional — the app would hit the same bug the moment the
  library changed. `--kind fragment` checks one library standalone.
- Relative `fragment_files` resolve against **the activity's own location** —
  sibling file, or sibling URL. Validate the activity where its fragment files
  actually sit; a copy moved to a scratch directory will fail with
  `FETCH_FAILED` for reasons that have nothing to do with the YAML.
- `--json` prints the raw result object, which names the exact failing
  variable / fragment / field. Reach for it whenever a schema error reads
  vague — the human-readable line is a summary, the JSON is the detail.

## Error codes — act on them, don't just relay them

| Code | Meaning |
| --- | --- |
| `YAML_PARSE_ERROR` | Not valid YAML (indentation, syntax). |
| `TUTOR_SCHEMA_ERROR` | Tutor fields wrong/missing — often a typo'd key (strict schema). |
| `FRAGMENT_FILE_SCHEMA_ERROR` | A referenced fragment file has invalid structure. |
| `QUIZ_SCHEMA_ERROR` | Quiz document wrong/missing a field, or has no questions. |
| `DUPLICATE_QUIZ_QUESTION_ID` | Two questions share an `id` (the stats key must be unique). |
| `WRITING_SCHEMA_ERROR` | Writing document wrong — usually missing `instructions` or `llm.model`. |
| `CODING_SCHEMA_ERROR` | Coding document wrong — missing field, or an unsupported one like `anonymous`. |
| `FRAGMENT_NOT_FOUND` | The activity references a fragment id the file doesn't define. |
| `MISSING_REQUIRED_VARIABLE` | A fragment needs a variable the activity didn't supply. |
| `VARIABLE_TYPE_MISMATCH` | A supplied variable has the wrong type. |
| `FRAGMENT_TEMPLATE_ERROR` | A fragment template failed to render — Handlebars syntax, or an undeclared variable; the `fragment`/`file` context points at the offender. |
| `FETCH_FAILED` | A file/URL couldn't be read (missing file, bad URL, network). |
| `EVAL_READ` / `EVAL_PARSE` | The eval file couldn't be read / isn't valid YAML. |
| `EVAL_SCHEMA` | Eval document wrong — the dotted path leads the message (e.g. `questions.0.answers.1.expect`). |
| `EVAL_TARGET_ERROR` | The eval's `target` quiz couldn't be resolved or loaded (path wrong, or the quiz itself is broken). |
| `EVAL_UNKNOWN_QUESTION` | The eval names a question id the quiz doesn't have — for an imported question use the namespaced `"<alias>/<id>"` form. |
| `EVAL_UNGRANTED_TOOL` | A tutor eval case's `required_tools` names a tool the target tutor's own `tools:` list does not grant — it could never be called. |

## Triage order

1. `validate` with the right `--kind`. A wrong `--kind` produces a confusing
   schema error, so check the tell-tales before blaming the file.
2. Vague schema error → re-run with `--json`.
3. `FETCH_FAILED` on a fragment file → you are validating the activity from the
   wrong location; validate it in place.
4. Valid, but the activity *behaves* wrong → that is a different question;
   `prompts` answers it (see [prompts.md](prompts.md)). The two commands are
   complementary and a confusing prompt usually wants both.

## Examples

```bash
# A known-good sample tutor inside the app repo (exit 0)
npm run cli -- validate activities/examples/sorting-algorithms/sorting-tutor.yaml

# A published activity by URL
npx @novedu/cli validate https://raw.githubusercontent.com/…/my-quiz.yaml --kind quiz

# Drill into a vague failure
npm run cli --silent -- validate ./my-quiz.yaml --kind quiz --json | jq .
```
