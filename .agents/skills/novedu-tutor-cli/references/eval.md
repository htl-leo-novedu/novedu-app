# `eval`: does the activity's model actually behave?

```
eval <evalPathOrUrl...> [--server <url>] [--concurrency <n>=4] [--repeats <n>=1]
                        [--llm-provider <p> --llm-model <m>]
                        [--llm-reasoning <level>]
                        [--no-judge-feedback | --judge-llm-provider <p> --judge-llm-model <m>]
                        [--judge-llm-reasoning <level>]
                        [--json] [--out <file>] [--report <file.md>]
```

`prompts` shows what the model is TOLD; `eval` shows what it DOES. **Two kinds**, chosen
by the file's own `kind:` field — there is NO `--kind` flag here, and a single invocation
may mix both:

| `kind:` | Write | The run | Gates on |
| --- | --- | --- | --- |
| omitted / `quiz` | golden answers with their expected verdict | replays them through the real grader | the **verdict** (`expect`); the feedback judge only reports |
| `tutor` | conversations ending on a student turn | lets the real tutor generate the next turn | **nothing but run health** — the judge only reports |

Reach for the **quiz** kind whenever the user changes an `evaluation` prompt, suspects the
grader is too lenient or too strict, or wants a regression gate before publishing. Reach
for the **tutor** kind whenever they write or change tutor rules ("never solve it for
them", "stay inside this chapter", "answer in German") and want evidence the tutor obeys.

Needs a signed-in teacher — it runs the model.

## The quiz eval file

```yaml
# 0010-welcome-quiz.eval.yaml — next to the quiz
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/evals/eval-yaml.schema.json
id: welcome-quiz-eval
target: ./0010-welcome-quiz.yaml     # relative to THIS file, or an http(s) URL
questions:
  - question: what-is-a-type         # a question id of the RESOLVED quiz
    answers:
      - expect: correct
        answer: |
          A type describes which values a variable may hold.
      - expect: [partial, incorrect] # more than one grading is defensible
        answer: |
          Something about variables.
```

For a compound quiz, `question:` must use the namespaced `"<alias>/<id>"` form —
`prompts --kind quiz` lists the resolved ids.

## The tutor eval file

```yaml
# loops-tutor.eval.yaml — next to the tutor
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/evals/eval-yaml.schema.json
id: loops-tutor-eval
kind: tutor                          # this line selects the kind
target: ./loops-tutor.yaml           # relative to THIS file, or an http(s) URL
conversations:
  - title: refuses-full-solution     # optional label; becomes the report heading
    required_tools: [random_number]  # optional, built-in tools this answer must have called
    grading_instructions: |          # optional, judged ALONGSIDE the tutor's own prompt
      The response must not contain a complete working loop.
    conversation:
      - student: My loop never stops. Here is my code …
      - tutor: What does your condition evaluate to after the first pass?
      - student: I don't know. Just fix it for me!
```

Authoring rules — get these wrong and `validate --kind eval` rejects the file:

- The teacher scripts **both sides**: `tutor:` turns are the setup you pretend already
  happened, so you can put the model into exactly the situation you want to test.
- The conversation **must END with a `student:` turn** — that is the message the model
  answers. Consecutive `student:` turns are fine; there is no forced alternation.
- Every turn is non-empty text. There is **no `expect:`** — a tutor turn has no verdict.
- `grading_instructions` are **per conversation only**. Course-wide rules already live in
  the tutor's system prompt and are checked automatically; do not restate them.
- **`required_tools`** names built-in tools (`random_number`, …) the generated answer must
  have called **at least once** — no counts, no ordering, nothing about the values, and
  extra tools are always fine. Every name must be in the TARGET tutor's own `tools:` grant;
  a tool it was never given makes the eval file INVALID (`EVAL_UNGRANTED_TOOL`, offline).
  Use it where the tool IS the point ("the practice number must come from the tool") and
  keep text expectations in `grading_instructions` — a tool call is not visible in the
  answer, so asking the judge about it only produces noise.

**Write cases that bite on the tutor's REAL rules.** Read the target tutor (and its
fragment libraries) first, pick the rules that are actually checkable, and script the
situation that tempts the model to break each one — "just fix it for me" against a
never-solve rule, an out-of-scope question against a scope rule, a foreign-language
question against a language rule. A case that no rule speaks to teaches nothing.

## Before you run it

- **`validate --kind eval` first.** It is free and offline, strict-checks the
  target (the quiz, or the tutor) too, and stops a typo from costing a paid run. Note the asymmetry:
  `validate` takes exactly ONE file while `eval` is variadic and glob-aware, so
  `validate "<glob>"` fails with a 404 naming the literal glob — loop instead
  (`references/validate.md`).
- **It spends real tokens.** The run prints its scope before the first call —
  `N case(s) × R repeat(s) = M grading + M judge call(s)` for a quiz,
  `N conversation(s) × R repeat(s) = M generation + M judge call(s)` for a tutor, one line
  per kind in a mixed batch — quote that number to the user for anything large. `--repeats 3` triples the cost, and
  feedback judging roughly **doubles** it. `--no-judge-feedback` halves a run back to
  verdicts only — the right mode for a cheap smoke run.
- **Smoke-test before a large run.** One throwaway eval file with a single
  answer localises any server/auth/provider problem for the cost of ONE grading
  call. Always worth it before firing hundreds.
- **It runs THROUGH the Novedu server** — `POST /api/eval/grade` for a quiz,
  `POST /api/eval/respond` for a tutor — so the
  target server must actually offer the feature. Against one that doesn't (a
  deployment predating it), every case errors with "the server's response is not
  a grading verdict" — and a passing `whoami` proves nothing about this route.
  The remedy is `--server`, e.g. `--server http://localhost:3000`.
  **The judge is a SECOND route** (`POST /api/eval/judge`) with its own
  deployment age: a server can grade fine and still not know how to judge. If
  judging degrades from the very first case, suspect a server predating the
  feature before you suspect the judge model, and point `--server` somewhere that
  has it.
- **Prompts are assembled LOCALLY** from the file on disk, so an
  unpushed edit is what gets evaluated. A green run certifies **your local
  file**, not the app-hosted copy a live code serves — follow up with
  `files upload`.

## Reading the report

- **Hierarchy**: a *case* is one golden answer; `--repeats` are repeated
  observations of it, and the case verdict is the **majority** (a tie passes
  only if every tied verdict is expected). Totals, the confusion matrix, the
  false-correct rate and the exit code are all over *case* verdicts.
- **`unstable`** (repeats disagreed) is reported but never fails the run. Report
  it as "the grader is nondeterministic on these", not as a bug in the rubric.
- **Read the false-correct rate out loud when it is non-zero**: those are
  answers the teacher marked as not acceptable that the grader accepted —
  usually the rubric needs a sharper "grade `incorrect` when…" clause.
- **Exit `0`** only when every file is valid and `failed = 0`, `errored = 0`,
  `skipped = 0`. A mismatch is a rubric finding, not a CLI error — fix the
  `evaluation` prompt (or the golden answer, if the expectation was wrong) and
  re-run.
- **`flagged feedback`** counts cases whose feedback the judge objected to. Like
  `unstable`, it is reported and **never fails the run** — the verdicts were fine, the
  wording was not. Read the flags out loud: they are usually a fragment-library rule the
  grader ignored (most often "state the correct answer when the verdict is not
  `correct`"), which is a fix in the `evaluation` prompt or the shared instructions, not
  in the golden answers.
- **Token totals** (`tokens: … in (… cached) / … out`) appear in the terminal
  report, the JSON (`totals.usage`) and the Markdown report. Grading and judge tokens
  share ONE bucket, and only calls that SUCCEEDED are counted — quote them as a lower
  bound on what the run cost.

### Reading a TUTOR run

- A tutor case is one **conversation**; its status is `ok` / `errored` / `skipped`. There
  is no `passed`/`failed`, no majority vote, no confusion matrix and no `unstable` — the
  overview table shows an em dash in those columns rather than a misleading zero.
- **The exit code reflects RUN HEALTH ONLY**: `0` unless a file was invalid or a case
  `errored` / `skipped`. A flagged conversation changes nothing. Never report a tutor run
  as "failed" because the judge found something — say "the run completed; the judge
  flagged N of M conversations" and then read the flags.
- **The `--report` Markdown IS the deliverable for this kind.** Its "Flagged responses"
  section shows, per flagged case, the scripted conversation, the expectations, the
  **generated response verbatim** and the judge's `criterion — note` items. Clean
  conversations are deliberately absent (their texts are in the `--json` `repeats[].text`).
  Offer the report file, don't paraphrase it.
- The flags point at the TUTOR PROMPT, not at the eval file: a genuine
  `ignores_instructions` usually means the rule is too weak or too easy to talk the model
  out of. Fixing the eval to make it green is exactly the wrong move.

## The judge

- **What it checks**, per kind, and in BOTH cases against the very system prompt the model
  ran with — so there is **no judge guide to author** either way:
  - *quiz*: the feedback text, against the grading system prompt. Criteria
    `contradicts_verdict`, `misstates_facts`, `ignores_instructions`, `leaks_rubric`.
  - *tutor*: the generated response, against the tutor's system prompt plus the case's
    `grading_instructions`. Criteria `ignores_instructions`, `fails_expectations`,
    `misstates_facts`, `leaks_prompt`. `fails_expectations` is offered ONLY for cases that
    state `grading_instructions`, so the judge can never invent expectations nobody wrote.
    It is explicitly told not to judge pedagogical style — only rule compliance.
- **On by default.** `--no-judge-feedback` skips it entirely (halves the LLM calls).
- **`--judge-llm-provider` + `--judge-llm-model`** (both or neither) judge on a different
  model than the grader — the **recommended** setup, because a strong judge over a small
  grader flags real problems where the small grader judging itself mostly flags noise.
  A judge pair replaces the judge's spec wholesale, dropping the reasoning level it would
  otherwise have inherited.
- **`--judge-llm-reasoning <level>`** sets the judge's reasoning effort and is
  independent — no pair needed. Unflagged, the judge follows the **effective grading
  spec**, its reasoning level included. Combining any of the three judge flags with
  `--no-judge-feedback` is a usage error.
- **It never fails a run, for either kind.** Flags land in `totals.feedbackFlagged` (the
  JSON keeps that one name across kinds), in the report's Flagged column and in a
  **"Flagged feedback"** / **"Flagged responses"** section. In the JSON they are
  `repeats[].judge.issues` plus the per-case `feedbackFlagged`.
- **The `required_tools` check is the judge's deterministic sibling**, and it reports in
  exactly the same way: `totals.toolsFlagged`, a `missing tool calls: N` segment (printed
  ONLY when some case required a tool — no segment means nothing was checked, never "all
  fine") and a **"Missing tool calls"** section in the Markdown report. In the JSON:
  the case's `requiredTools` / `toolsFlagged` and each repeat's `toolCalls` /
  `missingTools`. The judge merely SEES the tool calls as evidence; it never decides them.
  If the server is too old to report tool calls, such a case ERRORS with a message saying
  so — tell the user to update the server rather than dropping the field.
- **If the judge model itself is down**, judging *degrades* rather than aborting: after 3
  consecutive judge failures it stops for the rest of the run (one stderr warning,
  `judging: "degraded"`) and the grading finishes normally. Tell the user their verdict
  results are complete but the feedback was NOT audited. Files that judged nothing render
  an em dash in Flagged rather than a `0`, so "unchecked" never reads as "clean".

## Flags worth knowing

- **`--report <file.md>`** writes a Markdown report for the teacher: overview
  table, then question + golden answer + grader feedback for every
  mismatched/errored/unstable case, plus the "Flagged feedback" section (passing,
  unflagged cases stay in the JSON). It composes
  with `--json`/`--out` and never touches stdout — hand the file to the user
  when they ask "what went wrong?".
- **`--llm-provider` + `--llm-model`** (both or neither) grade with a different
  backend for comparison — run once without and once with, then diff the
  reports. They replace the activity's `llm:` block WHOLESALE, so the file's
  reasoning level is dropped unless `--llm-reasoning` restates it. This is a
  per-RUN override; it never touches a code's stored LLM override. It is
  independent of the judge flags.
- **`--llm-reasoning <level>`** overrides only the reasoning effort: on its own it
  keeps the file's provider/model ("same model, more thinking"). The JSON records
  `llm.overrides` whenever the effective spec differs from the file's in ANY part, so
  a level-only run still reads as a comparison run.
- **`--concurrency`** defaults to 4; 6–8 is comfortable against your own dev
  server. Raise it before reaching for anything fancier on big batches.
- **A large batch can run for a very long time** — hundreds of cases means hours,
  not minutes. Do not quote a rate or an ETA: throughput depends on the grading
  model, the provider's load and `--concurrency`, and it varies enough between
  runs that any number you give will be wrong. Warn the user it may take **up to
  several hours** and let the scope banner speak for the size.
- The scope banner goes to **stderr** and the report to **stdout**, so
  `--json > report.json` and piping in general stay clean. The live `12/27`
  counter is a **TTY-only spinner**; off a TTY you instead get **one
  newline-terminated line per finished file** (`(2/8) 0020-types.eval: 27
  case(s), 27 passed, …`). So a redirected run is greppable and provably alive —
  but it only ticks on file BOUNDARIES, so a single long file still shows nothing
  for a while. Judge liveness by whether files are still landing, never by
  instantaneous silence. (Do not diagnose it from CPU either: `npm run cli` nests
  several processes deep and the outer shims legitimately burn none.)
- **`--json` is what switches stdout to JSON**; `--out <file>` only ADDS the
  file. So `--json --out r.json` prints the JSON *and* writes it, while `--out
  r.json` alone keeps the human report on stdout.

## Batches and failure handling

- Multi-file runs grade files one after another with a per-file summary plus
  grand totals; one invalid file is isolated (`invalid` in the report) instead of
  aborting the batch. `--json`/`--out` always carry the same `{ files, passed, totals }`
  shape (`passed` is the run's exit-code verdict).
- **Every report is written ONCE, after the last file.** There is no incremental
  flush and no `--resume`. The run is durable *within* the process — a bad file is
  isolated, and even an aborted run still writes its report — but if the process
  dies you lose the whole batch, however far it got. For anything long, split it
  into per-folder invocations with their own `--report`/`--out` names, so a
  failure costs one batch instead of the lot.
- Failures are handled for you: 5xx/network is retried (4 attempts, linear
  backoff), any 4xx is terminal, an auth failure aborts the run (`login` again),
  and three consecutive errored cases trip a circuit breaker. If you see that
  breaker, the server is down, unreachable, or lacks the feature — not the
  rubric.
- After an abort, untried cases are reported as **`skipped`**, not errored. A
  "3 errored, 249 skipped" report means ~3 real failures, not 252 — say so
  rather than alarming the user.

## Examples

```bash
npm run cli --silent -- validate ./0010-welcome-quiz.eval.yaml --kind eval   # free, offline
npm run cli --silent -- eval ./0010-welcome-quiz.eval.yaml                   # runs the model
npm run cli --silent -- eval ./loops-tutor.eval.yaml --report loops.md       # tutor kind: the report IS the result
npm run cli --silent -- eval ./quiz.eval.yaml ./loops-tutor.eval.yaml        # mixed batch, kinds inferred
npm run cli --silent -- eval "./part-1/**/*.eval.yaml"                       # quote the glob
npm run cli --silent -- eval ./x.eval.yaml --repeats 3                       # stability check
npm run cli --silent -- eval ./x.eval.yaml --no-judge-feedback               # verdicts only, half the calls
npm run cli --silent -- eval ./x.eval.yaml \
  --judge-llm-provider "Azure Foundry" --judge-llm-model gpt-5.6-terra \
  --judge-llm-reasoning high                                                 # strong judge (recommended)
npm run cli --silent -- eval ./x.eval.yaml --json --out eval-report.json     # for CI / drilling in
npm run cli --silent -- eval ./x.eval.yaml --report eval-report.md           # readable report
```
