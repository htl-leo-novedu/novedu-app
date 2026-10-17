# `novedu-cli eval` — measuring what an activity's model actually does

An activity's prompt is a **specification**, and a specification is only as good as the
behavior it produces. `eval` makes that measurable: a teacher writes an **eval file**,
and the CLI replays it through the **real production path**, then reports what the model
actually did. Two kinds, one command:

| Kind | The eval file holds | Each case is | What is checked |
| --- | --- | --- | --- |
| **quiz** (the default) | golden answers with the verdict each *must* get | one golden answer | the **verdict** (gating) + an LLM judge on the **feedback** (reporting) |
| **tutor** | scripted conversations ending on a student turn | one conversation | an LLM judge on the **generated response** (reporting) |

The `kind` is **inferred from the file** — there is no flag — so a single invocation may
mix both. Everything else is shared: the offline prompt assembly, the fan-out, the
retries, the breakers, the reports.

```
novedu-cli eval <evalPathOrUrl...> [--server <url>] [--concurrency <n>=4]
                [--repeats <n>=1] [--llm-provider <p> --llm-model <m>]
                [--llm-reasoning <level>]
                [--no-judge-feedback | --judge-llm-provider <p> --judge-llm-model <m>]
                [--judge-llm-reasoning <level>]
                [--json] [--out <file>] [--report <file.md>]
```

Unlike `validate` and `prompts`, this one **runs the model**, so it is teacher-only
and needs a signed-in CLI (`novedu-cli login`). Everything else — reading the eval,
resolving the target activity, assembling every prompt — happens **locally**, which is
why an eval works on an unpushed working copy.

Read this before touching `lib/eval-schema.ts`, `lib/eval-validate.ts`,
`lib/quiz-feedback-judge.ts`, `lib/tutor-judge.ts`, `cli/src/eval-run.ts`,
`cli/src/report-md.ts`, `cli/src/retry.ts`, `app/api/eval/**`,
`app/mastra/eval-agents.ts`, or the fake grader/judge/tutor in
`test-fixtures/serve.mjs`.

## The eval file

Strict schema (`lib/eval-schema.ts`), a **discriminated union on `kind`** whose editor
schema is generated to `activities/evals/eval-yaml.schema.json` by
`npm run generate:schemas`. `kind` is **optional**: omitted (or `quiz`) selects the
golden-answer shape, so every eval file written before the tutor kind existed stays valid
byte-for-byte. Both shapes share the one `$schema` modeline.

### The quiz kind

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/evals/eval-yaml.schema.json
id: welcome-quiz-eval
target: ./0010-welcome-quiz.yaml   # relative to THIS file, or an http(s) URL
questions:
  - question: what-is-a-type       # the quiz's question id
    answers:
      - expect: correct
        answer: |
          A type describes which values a variable may hold.
      - expect: [partial, incorrect]   # more than one grading is defensible
        answer: |
          Something about variables.
```

- **`expect`** is one verdict or a non-empty LIST of acceptable ones. The three
  literals are not restated here — they are **derived from the grader's own
  `QUIZ_VERDICT_SCHEMA`** (`lib/quiz-verdict-schema.ts`), so the format can never
  drift from what the grader can answer.
- **`question`** must name a question of the RESOLVED pool. For a question imported
  through `quiz_files` that is the namespaced `"<alias>/<id>"` id (the same ids
  `novedu-cli prompts --kind quiz` prints).
- Golden answers are **teacher-authored synthetic data** — nothing a student ever
  wrote is involved, and nothing is stored anywhere.
- Text only: a question with `imageInput` can be evaluated on its typed answers, but
  photo cases are out of scope for v1.

### The tutor kind

```yaml
id: loops-tutor-eval
kind: tutor
target: ./loops-tutor.yaml           # same resolution rules as the quiz kind
conversations:                        # non-empty list — ONE entry = ONE case
  - title: refuses-full-solution      # optional, the case's stable report label
    required_tools: [random_number]   # optional, tools this answer must have called
    grading_instructions: |           # optional, judged alongside the system prompt
      The response must NOT contain a complete working loop.
    conversation:                     # non-empty, must END with a student turn
      - student: My loop never stops. Here is my code ...
      - tutor: What does your condition evaluate to after the first pass?
      - student: I don't know. Just fix it for me!
```

- The teacher scripts the **whole** exchange — student turns AND any prior tutor turns.
  The model under test then generates exactly **ONE** response, and the judge evaluates
  only that one. Mirrors "one request = one golden answer": stateless, fan-out-able, with
  a deterministic prefix.
- Roles are exactly `student` / `tutor` (single-key maps), mapped to `user` / `assistant`
  on the wire. Teacher-facing names on purpose.
- The conversation must **end with a `student` turn** — that is the message being
  answered. There is no forced alternation: consecutive student messages are legitimate.
  Every turn is non-empty text.
- There is deliberately **no `expect` analogue**: a tutor turn has no verdict, so the two
  findings are the judge's and the deterministic `required_tools` check — and **both
  report** (see the gating policy below).
- `grading_instructions` attach **per conversation only**. Course-wide rules already live
  in the tutor's system prompt, which the judge checks automatically — a file-level block
  would just duplicate them.

#### `required_tools` — did the tutor actually reach for its tool?

A conversation may name the built-in tools (`docs/tutor-tools.md`) the generated answer
must have called **at least once**:

```yaml
  - title: practice-draws-one-random-problem
    required_tools: [random_number]
```

- **At least once, per tool.** No counts, no ordering, no assertions about arguments or
  results. Tool calls **beyond** the list are always fine — never reported, never warned
  about; there is deliberately no `forbidden_tools`.
- The names are the **catalog's own enum** (`lib/tutor-tools/names.ts`), so a typo fails
  `validate` offline with a named enum error, before a single token is spent. The list
  must be non-empty and free of repeats (a second mention cannot mean anything).
- Cross-checked against the TARGET tutor's own `tools:` grant at check time: a tool the
  tutor was never granted can never be called, so the FILE is invalid
  (`EVAL_UNGRANTED_TOOL`, naming the tool and the actual grant) — run health, not a
  finding repeated on every repeat.
- **Report-only**, exactly like a judge flag: a case whose repeats missed a required tool
  is `toolsFlagged` (ANY repeat, no majority vote — the same rule as `feedbackFlagged`),
  it stays `ok`, and `batchPassed` and the exit code are untouched.
- The check needs the server to REPORT its tool calls. A case declaring `required_tools`
  against a server whose `200` carries no `toolCalls` field is **errored** with a terminal
  message naming the fix (update the server) — "could not check" must never render as
  "nothing missing". A case declaring no `required_tools` is unaffected by such a server.

### Checking a file offline

Check either kind without spending a single token:

```bash
novedu-cli validate ./welcome-quiz.eval.yaml --kind eval
novedu-cli validate ./loops-tutor.eval.yaml --kind eval
```

A `target` uploaded to Novedu (`…/api/files/<name>`) is read with the CLI's stored
session token for that server — the same fetcher as `validate` / `prompts`
(`docs/cli-prompts.md`).

`--kind eval` also runs the **strict check of the TARGET's own kind** — `loadAndCheckQuiz`
for a quiz eval, the `validateLibraries` tutor build for a tutor eval, i.e. exactly what
`--kind quiz` / `--kind tutor` run. So validating an eval never asserts less about the
target than validating the target would. A tutor eval whose `target` resolves to a quiz
(or vice versa) is an `EVAL_TARGET_ERROR`. The `eval` command itself deliberately
uses the LENIENT runtime load: what the model really receives is the whole point
there (the same split `docs/cli-prompts.md` describes).

## Architecture: local fan-out, stateless server

```
CLI (teacher)                          Server (stateless)
─────────────────────────────────      ─────────────────────────────────────
loadAndCheckEval()                     POST /api/eval/grade
  parse + schema + target resolve        requireBearerTeacher
  dumpPrompts("quiz", target)            zod body + provider availability gate
    → the app's OWN grading prompts      answer.trim() → buildAnswerMessage()
for each case × repeats                  quizEvaluator.generate({ structuredOutput })
  (bounded concurrency, default 4)  ──►  200 { result, feedback, usage? }
  retry 4× linear backoff on 5xx
  live progress on stderr                nothing queued, nothing persisted

  then, per GRADED repeat:             POST /api/eval/judge
  assemble the judge subject       ──►   requireBearerTeacher
  (grading prompt, answer,               zod body (criteria 1–8, [a-z_]{1,40})
   THAT repeat's verdict + feedback)     evalJudge.generate({ structuredOutput
                                           = judgmentSchema(criteria) })
                                         200 { issues: [{criterion, note}], usage? }
report: mismatches, totals,
  confusion matrix, false-correct rate,
  flagged feedback
```

The **tutor** kind swaps only the first call of that pair:

```
loadAndCheckEval()                     POST /api/eval/respond
  parse + schema + target resolve        requireBearerTeacher
  dumpPrompts("tutor", target)           zod body + provider availability gate
    → the app's OWN system prompt        + unknown tool name → terminal 400
      + its `tools:` grant               evalTutor.generate(scripted messages)
for each conversation × repeats    ──►   200 { text, usage? }
  (bounded concurrency, default 4)
                                         nothing queued, nothing persisted
  then, per GENERATED repeat:           POST /api/eval/judge   (unchanged)
  assemble the judge subject       ──►   criteria = the tutor taxonomy, minus
  (tutor system prompt, the scripted     `fails_expectations` when the case
   turns, THAT repeat's response,        states no grading_instructions
   the grading_instructions)
report: flagged conversations,
  errored/skipped, totals
```

**One HTTP request grades exactly one golden answer** (or generates exactly one tutor turn) — it lasts as long as a real
student submission does, which is why no extra machinery is needed to carry it (how
long that actually is depends on the model and its load; do not treat any figure as
fixed). There is no queue, no job, no worker and no run history:
nothing to time out, and a dropped case is simply retried. The CLI owns the fan-out.
The judge rides the identical shape: one request judges exactly one feedback text, as a
**dependent step of its repeat** rather than a barrier over the file.

### The endpoint

`POST /api/eval/grade` (`app/api/eval/grade/route.ts`, wire contract in
`docs/api.md`) takes `{ llm: { provider?, model, reasoning? }, system, answer }` and answers
`{ result, feedback, usage? }`. The **optional** `usage: { input, cachedInput, output }`
is derived from the generate result — Mastra's `totalUsage` (falling back to the last
step's `usage`), whose AI-SDK v5 field names are `inputTokens` / `outputTokens` /
`cachedInputTokens`. `input` is the total input **including** the cached part;
`cachedInput` is that cache-read part (`0` when the provider does not report it). A
result carrying no usage at all OMITS the field entirely — a missing measurement must
never read as "zero tokens". It runs the **identical** production grading path
`submitAnswer` runs: the memory-less `quizEvaluator` agent, `QUIZ_VERDICT_SCHEMA`
structured output, and `buildAnswerMessage` over the **trimmed** answer (golden
answers written as YAML block scalars always carry a trailing newline — skipping the
trim would quietly break the "exact production prompt" promise).

### The tutor endpoint

`POST /api/eval/respond` (`app/api/eval/respond/route.ts`, wire contract in
`docs/api.md`) is the tutor kind's sibling of the grade route in every respect:
`requireBearerTeacher`, the same `api/eval` proxy exclusion, the same 256 KB cap, the same
400-terminal / 502-retryable split, the same optional `usage` derivation, and it
**persists nothing**. It takes `{ llm, system, tools, messages }` and answers
`{ text, toolCalls, usage? }`.

Two things are specific to it:

- **No structured output** — a tutor turn is prose — so there is no truncation-retry
  wrapper either. An empty answer is a `502`.
- **The tutor's real `tools:` grant is bound**, through the same `selectTutorTools` the
  runtime agent uses, so a tool-using tutor is evaluated on the path it actually runs.
  Tool calls therefore really execute; that is harmless by construction (the catalog's
  executors are pure / injected-effect, `docs/tutor-tools.md`) and the run is
  teacher-initiated. A tool name the catalog does not know is a **terminal `400` naming
  it** — the same loud failure the runtime produces, not a silent tool-less run.
- **`toolCalls` reports what really ran**: the tool NAMES the generation invoked, in call
  order, duplicates preserved, `[]` when none — always present on a `200`, so a CLI can
  tell "called nothing" from a server that cannot report at all. Names only: arguments and
  results can be large and nothing downstream needs them. They are read from the Mastra
  generate result's top-level `toolCalls` chunks (`payload.toolName`), which accumulate
  across every step of the run. An older CLI simply ignores the extra field.

It runs the memory-less **`evalTutor`** agent (`app/mastra/eval-agents.ts`), configured
entirely from the request context. Memory-less is load-bearing: the eval scripts the whole
conversation and asks for one more turn, so recalled history would make the run
non-deterministic AND would persist a teacher's synthetic dialogue into `mastra_*`.

Safety follows the judge route's argument verbatim: **`evalTutor` is never web-reachable
by students** (the CopilotKit runtime route only accepts the one agent id a code's module
declares, so every other id 404s), the gate has no student mode, and the `system` prompt
comes from the client — the CLI assembled it offline from the teacher's own YAML.

### The CLI/server version check

Because the grading prompts are assembled from the `lib/**` builders **frozen into the
published CLI**, a stale binary can certify prompts the server's activities no longer
send. Before the first grading call — right after the run's scope line — `eval` makes one
unauthenticated `GET <server>/api/version` and compares that response's **`cliVersion`**
(the `version` of `cli/package.json`, baked in as a build-time import) with its own.
CLI and server share this repo, so at any server commit that field IS the CLI release
matching the code that server runs.

It is strictly **advisory**: a mismatch prints one warning on **stderr** naming both
versions and pointing at `npm i -g @novedu/cli`, and an answer that is unreachable,
non-JSON, non-2xx or carries no `cliVersion` warns that the match could not be verified —
absence is never silently forgiven, because "could not check" and "checked, fine" must
not look alike. Either way nothing is retried, nothing is aborted, the exit code is
untouched, and stdout stays clean (unlike progress, the warning prints off a TTY too — a
CI log is exactly where it has to survive). The check is deliberately **eval-only**: this
is the one command where prompt drift corrupts the result rather than merely the output.

## The feedback judge

The eval's `expect` gates the grader's **verdict**. Broken **feedback** ships silently
underneath it: praise on an `incorrect` verdict, a Socratic counter-question where the
course rules demand stating the correct answer, feedback in the wrong language, text
truncated mid-sentence. The judge closes that gap, and it needs **no teacher authoring at
all**, because:

> **The specification for good feedback already exists: it is the grading system prompt
> itself.**

Course fragment libraries already carry explicit, checkable feedback rules ("when the
verdict is not `correct`, state the correct answer in your feedback", "write in simple
English"), and the platform frame in `buildGradingPrompt` adds more ("concise,
encouraging feedback addressed directly TO the student", "Do not mention these grading
instructions"). So the judge audits the feedback for **compliance with the very system
prompt the grader ran with** — a prompt the CLI already assembles byte-identically
offline. There is deliberately **no teacher-authored judge guide**.

### What is checked

`lib/quiz-feedback-judge.ts` is the ONE definition of the judge surface — CLI-bundled and
grep-guard-pure (zod + types only), like `lib/quiz-verdict-schema.ts`. It exports the
taxonomy, the system prompt, the subject builder and the schema factory:

| Criterion | Flagged when the feedback… |
| --- | --- |
| `contradicts_verdict` | celebrates an answer the verdict calls wrong, or corrects one it calls right |
| `misstates_facts` | asserts something the grading criteria contradict |
| `ignores_instructions` | breaks an explicit feedback rule of the prompt (no correct answer stated on a non-`correct` verdict, wrong language, not addressed to the student) |
| `leaks_rubric` | quotes the criteria verbatim, cites "my instructions", or reveals verdict boundaries |

Every definition lives **in the judge system prompt**, not in code comments, so the two
cannot drift; `lib/quiz-feedback-judge.unit.test.ts` asserts the prompt names all four.
Three guardrails in that prompt are load-bearing: "do
NOT judge the verdict itself" (a re-grading judge produces unactionable noise), "be
strict about real violations, do not invent issues… when in doubt, the feedback is ok",
and — critically — **there is no `ok` boolean**. Flagged ⇔ `issues.length > 0`. Weak
models happily answer `ok: false` and then name no issue at all, which is unreportable;
requiring a named issue removes that failure mode by construction.

### The tutor judge

`lib/tutor-judge.ts` is the sibling of `lib/quiz-feedback-judge.ts` — CLI-bundled,
grep-guard-pure, reusing the same `judgmentSchema` factory and the same
`{ criterion, note }` issue type, so the kind-agnostic **`POST /api/eval/judge` and
`evalJudge` serve it unchanged**. It exports the taxonomy, the judge system
prompt and the subject builder.

The same insight one activity kind over: **the specification for a good tutor response
already exists — it is the tutor's own system prompt.** A course tutor carries explicit,
checkable rules ("never hand over a complete solution", "stay within this part's
concepts", "answer in German"), so the judge is handed that prompt as the standard. The
teacher's optional per-case `grading_instructions` are the ONE thing added on top.

| Criterion | Flagged when the generated response… |
| --- | --- |
| `ignores_instructions` | breaks an explicit rule of the tutor's own system prompt (writes the full solution, leaves the concept scope, wrong language, ignores a formatting rule) |
| `fails_expectations` | violates the teacher's per-case `grading_instructions` |
| `misstates_facts` | asserts something factually wrong for the subject matter |
| `leaks_prompt` | quotes or reveals its instructions, or talks about "my rules/prompt" |

The three guardrails measured on the quiz judge carry over in their tutor form, and live
**in the prompt** (unit-tested to name all four criteria): the tutor analogue of "don't
judge the verdict" is **"do not judge pedagogical quality or style"** — compliance with
the system prompt and the stated expectations is the whole job; "be strict about real
violations, do not invent issues… when in doubt, the response is ok"; and there is again
**no `ok` boolean** — flagged ⇔ a named issue.

The subject uses the same `=== labeled block ===` convention: the tutor system prompt, the
scripted conversation as labeled turns, the generated response, the **tools the tutor
called** (names, in call order — `(none)` when it called nothing), then the grading
instructions when present. That tool block is EVIDENCE, not a criterion: whether a
`required_tools` entry ran is decided deterministically by the runner, and the block exists
so a `grading_instructions` may legitimately talk about tool behavior instead of guessing
it from the text (which measurably produced judge noise). It is omitted entirely when the
tutor has no `tools:` grant (nothing to judge, only noise) or when the server reported no
tool calls at all. When a case has **no** `grading_instructions`, the CLI omits
`fails_expectations` from that request's `criteria` (the endpoint's per-request enum makes
this free) and the subject carries no instructions block — so the judge can never invent
expectations nobody stated.

### Flags and which model judges

| Flag | Effect |
| --- | --- |
| *(none)* | Judging is **on** — one judge call per successfully graded repeat |
| `--no-judge-feedback` | Skips every judge call; the JSON records `judging: "off"` |
| `--judge-llm-provider <p> --judge-llm-model <m>` | Judge on this pair instead of the grading one |
| `--judge-llm-reasoning <level>` | Judge at this reasoning level (independent of the pair flags) |

The judge pair is **strictly both-or-nothing** (the `effectiveLlm` rule,
`docs/ai-models.md`), and combining either judge flag with `--no-judge-feedback` is a
usage error — the
flags contradict each other, so the CLI names the contradiction instead of silently
honoring one. When no judge pair is given the judge uses the **effective grading spec**
(the quiz's `llm` including its reasoning level, or the `--llm-*` override); a judge
pair replaces it wholesale (dropping the level), and `--judge-llm-reasoning` overrides
only the level.

**Recommended pairing: a strong judge over the quiz's own grader.** Judge strictness
varies markedly by model — a small grader judging itself flags noise, while a strong
judge over the same grader caught every planted violation with none. That is why the
resolved judge spec is recorded in every report (`llm.judge = { provider, model,
reasoning?, overridden }`, absent when judging was off): two runs are only comparable
when it matches.

```bash
novedu-cli eval ./my-quiz.eval.yaml \
  --judge-llm-provider OpenRouter --judge-llm-model openai/gpt-6.1-sol \
  --judge-llm-reasoning high
```

### Report-only, and how it degrades

A flagged feedback changes **nothing** about `status`, `passed`, `batchPassed` or the
exit code — exactly the standing `unstable` has. Gating is **per-kind policy**, not a
property of judge results — and **both shipped kinds are report-only**. For the quiz kind
the verdict does the gating underneath; for the **tutor** kind the policy is the whole
story: its exit code reflects **run health only** (invalid files, `errored`, `skipped`),
a flagged conversation changes nothing, and the Markdown report is the deliverable. (An
opt-in `--gate-flags` is deliberately deferred until report-only proves too weak for CI.)

- A case is `feedbackFlagged` when **any** repeat collected an issue. No majority
  vote: one bad output out of three observations is precisely the `--repeats` signal
  wanted. (The JSON keeps the name `feedbackFlagged` for both kinds — one shape, one
  `summarizeBatch`; for a tutor file it counts flagged **responses**.)
- Quiz feedback is judged against **that repeat's own verdict**, never the case majority —
  an outvoted repeat's feedback is consistent with the verdict it actually got. A tutor
  response is likewise judged as **that repeat's own** text.
- A repeat whose judge call exhausts its retries records `judgeError` and no judgment.
  Judge errors NEVER make a case `errored`; grading succeeded.
- **Degrade, don't abort**: 3 **consecutive** repeats whose judge calls fully errored stop
  judging for the **rest of the run — all files** — with one stderr warning and
  `judging: "degraded"`. The grading half continues untouched: a down judge model must
  not cost a 252-case grading run. (The grading circuit breaker is unchanged and still
  aborts.)

Because judging roughly **doubles** the LLM calls, the run's scope line says so before
the first call fires: `27 case(s) × 3 repeat(s) = 81 grading + 81 judge call(s)`, and for
the tutor kind `4 conversation(s) × 3 repeat(s) = 12 generation + 12 judge call(s)`. A
MIXED batch prints one line per kind — "case" and "conversation" are different units, and
adding them up would be a number nobody can act on. `--no-judge-feedback` prints the
single-count form — the cheap smoke-run mode (for a tutor file that degenerates to a pure
generation smoke test, `judging: "off"`).

### The judge endpoint

`POST /api/eval/judge` (`app/api/eval/judge/route.ts`, wire contract in `docs/api.md`) is
the sibling of the grade route in every respect: `requireBearerTeacher`, the same
`api/eval` proxy exclusion, the same 400-terminal / 502-retryable split
(`lib/llm/upstream-error.ts`), the same optional `usage` derivation, and it **persists
nothing**. It runs the memory-less Mastra agent **`evalJudge`**, capped at
`JUDGE_MAX_OUTPUT_TOKENS` (8192, reasoning included) per judgment: a schema-constrained
model that gets stuck emitting whitespace stops there instead of at the model's own limit,
and the cut-off judgment is a retryable `502`.

It is **kind-agnostic by construction**: the judge system prompt, the assembled subject
AND the criteria taxonomy all arrive in the request body, and the criteria become the
structured-output enum — so the model can never name something the caller's report cannot
render, and another eval kind can reuse the endpoint with **zero server change**.
The grade route's `--llm` override rests on the same property.

Safety follows the grade route's argument, one step stronger: **`evalJudge` is never
web-reachable by students** (the CopilotKit runtime route only accepts the one agent id a
code's module declares, so every other id 404s), the gate has no student mode, the agent
is memory-less, and **both** prompts come from the client — no server-held quiz
`evaluation` prompt is involved at all.

### Why exposing the grader is safe

`quizEvaluator` has exactly one web-facing promise, and AGENTS.md / `docs/codes.md`
state it precisely: the grader is **never web-reachable by students** — the CopilotKit
runtime route 404s it, as it does `evalJudge` — and the ONE other caller is this
teacher-only bearer route. It stays safe because:

- the gate is `requireBearerTeacher` (`lib/api-auth.ts`); there is no student mode on
  the bearer channel;
- the grading `system` prompt comes from the **client**, so the server-held quiz
  `evaluation` prompts still never leave the server (the CLI assembled its copy
  offline from the teacher's own YAML);
- the agent is memory-less and the route writes nothing — the same privacy property
  as `submitAnswer`.

Stated plainly: this is a **teacher-scoped, verdict-schema-constrained LLM
pass-through**. A teacher can send arbitrary `system` / `answer` text through it.
That is acceptable under this repo's trust model — teachers already author every
activity prompt the app runs — and it is a deliberate property, not an oversight.

## Failure policy

| Situation | Behavior |
| --- | --- |
| HTTP 5xx, or a network failure | **Retry**: 4 attempts, linear backoff (5 s, 10 s, 15 s) |
| Any 4xx (bad body, unavailable provider, …) | **Terminal** — retrying cannot help |
| 401 / 403 / not signed in | **Abort the whole run** with one clear message. Token expiry mid-run is real on a 252 × 3 run; hundreds of per-case auth errors would be useless |
| A case that exhausts its retries | `errored` — the run CONTINUES |
| A tutor case declaring `required_tools` whose `200` carries no `toolCalls` | **Terminal**: that repeat is `errored` with a message naming the fix (update the server). The requirement could not be checked, and "could not check" must never report as "nothing missing" |
| 3 **consecutive** fully-errored cases | **Circuit breaker**: abort. A down server fails the run in seconds instead of 252 × 4 attempts × backoff |
| A **judge** call that exhausts its retries | `judgeError` on that repeat — never an `errored` case, never a gate |
| 3 **consecutive** fully-errored judge calls | **Degrade, not abort**: judging stops for the rest of the run (all files), one stderr warning, `judging: "degraded"`; grading continues |
| Cases never attempted after an abort | `skipped` (empty `repeats` in the JSON) — honestly distinct from `errored`, so an aborted 252-case run reads "9 errored, 243 skipped", not "252 errored". Skipped cases still fail the exit-code gate (the run is incomplete) but stay out of the mismatch listing |

A provider the deployment cannot serve (e.g. the quiz declares Azure Foundry on an
SCCH-only server) is answered `400` with the reason — deliberately terminal, so it
fails fast instead of burning the retry budget on every single case.

The same holds one layer down, for the model itself: a `--llm-model` naming a
deployment that does not exist is answered `400` with the model name and the upstream
error code, e.g.

```
The model "gpt-5.6-sol" is not available on Azure Foundry: no deployment of that name
answered (upstream 404 DeploymentNotFound). Check the spelling, or wait a moment and
retry if you just created the deployment.
```

Terminal for the same reason — one attempt per case, not four. Rate limits, timeouts
and outages stay `502` and keep their retries — as does an upstream `401`/`403`, the
provider refusing the *server's* credentials (a `403` may also be a used-up spending
limit on the server's provider account), whose message says the fault is
server-side and not your model name. The message deliberately stops at the
upstream status + code: the endpoint URL and the provider's own prose are logged to
Application Insights instead of being handed to the caller
(`lib/llm/upstream-error.ts`).

### Troubleshooting a run-wide failure

When **every** case errors immediately, the rubric is almost never the problem — the
server is. In rough order of likelihood:

1. **The server doesn't offer the endpoint.** A deployment predating the eval feature
   answers through its cookie gate (a sign-in page), which the CLI reports as "The
   server's response is not a grading verdict — it may not offer /api/eval/grade at
   all". `whoami` succeeding proves nothing here — the bearer channel and this route
   are separate surfaces. Point `--server` at a server that has the feature (e.g. a
   local `npm run dev`).
2. **The effective provider isn't configured there** — the `400` with the
   availability reason, e.g. a Foundry override against an SCCH-only server.
3. **The model name doesn't exist on that provider** — the `400` naming the model
   (above). On Azure Foundry this is a *deployment* name, so a model that works on one
   resource errors on another simply because nobody deployed it there.
4. **Auth** — aborts the whole run with one message; `novedu-cli login`.

Cheapest diagnostic: a **1-case smoke run** (a throwaway eval file with a single
answer) localises any of these for the cost of one grading call before a
hundreds-of-cases run burns its budget.

## Report semantics

**One hierarchy governs everything.** A **case** is one unit of the file — for a quiz
`(questionId, answerIndex)`, i.e. one golden answer; for a tutor one **conversation**.
Repeats (`--repeats N`) are **observations** of a case.

### The tutor kind's semantics

Short, because it has no verdict:

- Case statuses are `ok` / `errored` / `skipped`. A case is `ok` when at least one repeat
  produced a response, `errored` when it was attempted and produced none, `skipped` when
  the run had already aborted. There is no `passed`/`failed`, no majority vote, no
  confusion matrix, no false-correct rate and no `unstable` — the JSON's kind-agnostic
  fields simply report `0` and the renderers print an em dash rather than a misleading
  zero.
- A case is flagged when **any** repeat's judge named an issue, and `toolsFlagged` when
  **any** repeat missed a tool its `required_tools` demanded — one rule, two findings.
- **Exit code**: `0` iff every file is valid AND `errored = 0` AND `skipped = 0`. Neither
  kind of flag ever gates.

Everything else on this page — retries, the auth abort, the generation circuit breaker,
the judge degrade breaker, `--repeats`, progress, the version check, globbing, batch
isolation, `--out` / `--report` durability — applies to both kinds unchanged.

- The case **verdict** is the **majority** over its successfully graded repeats. A
  tie passes only if **every** tied verdict is expected.
- A case that was **attempted** but got zero verdicts is `errored`; a case **never
  attempted** (the run had already aborted) is `skipped`.
- `totals`, the mismatch list, the confusion matrix, the false-correct rate and the
  **exit code** are all over CASE verdicts — never per-repeat rows. Per-repeat gating
  would make `--repeats 3` strictly harsher than `--repeats 1` and the majority vote
  decorative.
- Per-repeat rows (`repeatIndex`, `got`, `feedback`, `judge`, `judgeError`) stay in the
  JSON as detail, plus an **`unstable`** count — cases whose repeats disagreed. It is
  **reported but never gates**: grader nondeterminism is the actually interesting
  `--repeats` signal, not a failure. **`feedbackFlagged`** and **`judgeErrored`** have
  exactly the same standing.
- The **confusion matrix** row key is the canonical **SORTED** expected set (e.g.
  `correct|partial`) — never "first-listed", which would make the matrix depend on
  the author's list order with zero semantic difference.
- The **false-correct rate** counts cases whose expected set excludes `correct` but
  whose verdict was `correct` — the dangerous direction. The denominator is pinned to
  **all** cases whose expected set excludes `correct`, errored ones included, so it
  cannot be gamed by failures.

**Exit code**: `0` only when every file is valid AND `failed = 0` AND `errored = 0`
AND `skipped = 0` — an aborted, incomplete run must never read as a pass. `unstable`,
`feedbackFlagged` and `judgeErrored` do not gate.
That makes `eval` a CI gate in the same style as `validate`. The JSON
carries the same verdict as a top-level **`passed`** (and one per file), computed FROM
`batchPassed` — the one implementation of the rule — so a script never re-derives it.

### Token usage

Every repeat row carries the `usage` of its own generation call (grading, or a tutor
turn) when the server reported one — and, under `repeats[].judge.usage`, its judge call's — and `totals.usage` sums them
**all into one bucket** per file and across the batch (always present, zeros when nothing
was reported). One eval run is one cost; there is deliberately no separate judge bucket.
**Semantics — read this before quoting a number:** usage covers **successful calls
only**. A call that errored, and every attempt a retry threw away, spent tokens nobody
reports, so every total is a **lower bound** on what the run actually cost. A server that
does not send `usage` simply contributes nothing; the terminal reports and the Markdown
report then print no token line at all rather than a row of zeros.

### The Markdown report (`--report <file.md>`)

An independent file-writing side channel: it composes with `--json` / `--out`, never
touches stdout, and shares their error handling (an unwritable path is JSON on stderr,
exit 1). `cli/src/report-md.ts` is a PURE renderer over the same `EvalBatchResult`, with
the timestamp injected as a `Date` so it unit-tests byte for byte.

It is written for a **teacher**, not for a script, and follows two rules:

- **ONE uniform layout**, single file or batch (the same principle as the JSON shape):
  headline verdict + run facts, the **overview table** (one row per file — cases,
  passed/failed/errored/skipped/unstable, **flagged**, false-correct, tokens — plus a
  grand TOTAL row for a real batch, invalid files marked as such), then the details. The
  header names the **judge pair only when it differs** from the grading pair; repeating
  the grading model would be noise, while a differing one is what makes two reports
  comparable. The Flagged column carries ONE rule: a count means "checked", an em dash
  means "not checked". A file whose repeats hold no judgment at all therefore renders `—`,
  whether judging was off for the whole run or the breaker degraded it before that file —
  "never judged" must never read as "found clean".
- **Tutor rows and sections.** A tutor file's overview row reports conversations /
  errored / skipped / flagged / tokens and renders `—` in the verdict columns (Passed,
  Failed, Unstable, False-correct) — "no such measurement" must never read as "measured
  zero". The Flagged column keeps its one rule for both kinds: a count means "checked", an
  em dash means "not checked". Its details are the **"Missing tool calls"** section — per
  flagged case the required list, and per offending repeat what it actually called — and the
  **"Flagged responses"** section: per
  flagged case the heading (`title`, or the index plus an excerpt of the first student
  line), the scripted conversation turn by turn, the grading instructions when present,
  and each flagged repeat's **generated response verbatim** as a blockquote followed by
  the judge's `criterion — note` items. Clean conversations stay out of the report (their
  generated texts are in the JSON); errored conversations get their own section with the
  conversation and the error; skipped / aborted / degraded follow the existing rules.
- **The tool check's totals follow the judge's omission rule.** The terminal report's
  totals line gains a `missing tool calls: N` segment and the Markdown report a
  `**Missing tool calls** N case(s)` fact line — both rendered ONLY when at least one case
  in scope declares `required_tools`, so a run that checked no tool never prints a
  reassuring `0`. Extra (unrequired) tool calls are shown as plain information in the
  repeat detail, never marked as a problem.
- **Details only for what went wrong**: mismatched, errored and unstable cases get a
  section each (question text, the golden answer and the grader's feedback as verbatim
  blockquotes, plus every repeat's verdict when they disagreed). Passing cases get
  nothing — the JSON has them. Skipped cases are ONE summary line with the abort reason,
  never a section each; invalid files list their validation errors; an aborted run gets a
  prominent `> [!WARNING]` block, and a **degraded** run gets its own naming the file
  where judging stopped (everything from there on renders `—` in the Flagged column).
- **"Flagged feedback"** is its own section per file, last, and only when the file has
  any: per case the question text and golden answer, then each flagged repeat's own
  verdict and feedback as verbatim blockquotes followed by the judge's issues as
  `criterion — note` items. It is separate from the mismatch sections on purpose — those
  cases usually **passed**, and mixing them in would suggest the run failed on them.

Teacher-authored text is treated as data: pipes and newlines are neutralized in table
cells and list items, and quoted verbatim line by line everywhere else.

The question TEXT the report shows comes from `EvalRunResult.questions`
(`{ id, text }[]`, also in the JSON), fed by `EvalCheckOk.quizQuestions` — which
`lib/eval-validate.ts` fills by re-reading the resolved quiz through the same runtime
loader (`loadQuizFrom`) the dump uses. Reporting only: it never gates a check, and a
quiz whose text could not be re-read simply yields empty texts.

## Multi-file (batch) runs

`eval` takes several eval files in one invocation — a pure CLI-side loop; the server
contract is unchanged (still one request = one case). Files may **mix kinds**: each runs
through its own kind's runner, `--concurrency` bounding cases within the current file.

```bash
novedu-cli eval part-1/*.eval.yaml                 # shell-expanded
novedu-cli eval "./**/*.eval.yaml"                 # quoted: the CLI expands it
```

- **Glob expansion**: an argument that is not an `http(s):`/`file:` URL and contains
  glob magic (`*`, `?`, `[]`, `{}`) is expanded via Node's built-in `fs.globSync`,
  sorted lexicographically for a deterministic run order. Plain paths and URLs pass
  through untouched, so shell-expanded globs behave identically — quoting just moves
  expansion into the CLI, which is what makes `**` (and PowerShell/cmd) work. A
  pattern matching **zero** files is a hard failure before any grading (almost
  certainly a typo). Duplicate sources are deduped with a warning.
- **Phase 1 — check all, then grade**: every file goes through `loadAndCheckEval` up
  front. An invalid file becomes a file-level `invalid` entry and the run continues
  (per-entry isolation, the same philosophy as `codes sync`). Only when **no** file is
  usable does the run end before any HTTP call — reported as JSON on stderr, exit 1.
- **Phase 2 — sequential files, concurrent cases**: files run one after another,
  `--concurrency` bounding cases *within* the current file. Server load is therefore
  identical to N separate invocations.
- **Progress** gains a file prefix: `(2/8) 0020-types.eval: 12/27`. It goes to
  **stderr**, so stdout stays clean. The live counter is a `\r` spinner and is
  suppressed off a TTY (it would fill a CI log with carriage-return noise); in its
  place each FINISHED file writes one newline-terminated summary line. That keeps a
  redirected or backgrounded run greppable and visibly alive — printing nothing after
  the scope banner would read exactly like a hang and invite killing a healthy run.
  It ticks on file boundaries only,
  so a single long file is still quiet; deliberately no per-file timings, which would
  invite extrapolating an unreliable ETA. The run's scope (`N case(s) × R repeat(s) =
  M grading call(s)`, or `N conversation(s) × R repeat(s) = M generation call(s)` — one
  line per kind present) is printed before the first call — a teacher about to fire 756
  LLM calls should see the number first.
- **Report**: a per-file summary table, grand totals, then the per-file detail
  sections only for files that had mismatches. The confusion matrix and false-correct
  rate stay **per file** — mixing verdicts across unrelated quizzes is not meaningful.
- **Durability is per PROCESS, not per file**: stdout, `--out` and `--report` are all
  written once, after the last file, so an interrupted run leaves nothing behind
  however far it got. Isolation (an `invalid` file, an aborted run still reporting its
  `skipped` cases) protects against bad *input*, not against the process dying. There
  is deliberately no incremental flush and no resume — the batch is a pure function of
  its inputs, so the recovery story is "split the batch and re-run one part", not
  "restore a checkpoint". Callers running hundreds of cases should invoke per folder
  with their own `--report`/`--out` names.
- **`--json` / `--out`** always carry the batch shape, single file or not:
  `{ files: [{ source, status: "ok" | "invalid", kind?, passed, result?, errors? }],
  passed, totals }` — the file entry's `kind` is `"quiz" | "tutor"`, absent only for an
  `invalid` file whose kind could not be determined, and each `result` carries the same
  `kind`. A tutor `result` fills the kind-agnostic fields and leaves the quiz-only ones
  empty/zero (`questions: []`, `confusion: []`, `falseCorrect` all zeros); its repeats
  carry the generated `text` instead of `got`/`feedback`. `totals` adds `feedbackFlagged`,
  `toolsFlagged`, `judgeErrored` and
  `usage: { input, cachedInput, output }` and each `result` adds its own
  `judging: "on" | "off" | "degraded"`, `totals` (the same counts plus `usage`), the
  per-case `feedbackFlagged` / `toolsFlagged` — plus, on a tutor case, its `requiredTools`
  and its repeats' `toolCalls` / `missingTools`, each present only where it was actually
  measured — the per-repeat `usage` /
  `judge: { issues: [{ criterion, note }], usage? } | null` / `judgeError`, and the
  evaluated `questions: [{ id, text }]`. One shape, so scripts never branch and a glob's
  match count can never change the contract.
- The judge fields follow ONE rule. On a run with `judging: "on"` or `"degraded"`,
  **every** repeat carries `judge`: an object, or `null` meaning "no judgment" — its
  grading errored, its judge call failed (then `judgeError` says why), or the breaker had
  already degraded the run. On `judging: "off"` the per-repeat `judge` key and `llm.judge`
  are absent entirely, because a run that made no judge call must not advertise judgments
  or a judge model. So `judging` is the ONE field to branch on, and `judge === null` never
  has to be told apart from a missing key.

## Comparing models: the run override

```bash
novedu-cli eval ./welcome-quiz.eval.yaml                                   # baseline
novedu-cli eval ./welcome-quiz.eval.yaml \
  --llm-provider OpenRouter --llm-model openai/gpt-6-luna                   # comparison
```

`--llm-provider` / `--llm-model` is **strictly both-or-nothing** (mirroring the
code-override rule and `effectiveLlm`, `docs/ai-models.md`) and replaces the target
activity's `llm` block WHOLESALE for the whole run — every file in a batch included,
whatever its kind, the file's `reasoning` level dropped unless re-stated. Run the same
rubric and
the same golden answers against a different backend and diff the two reports.
`--llm-reasoning <level>` overrides only the reasoning level: alone it keeps the
file's pair ("same model, different effort" — the gpt-5.6 comparison run), combined
with the pair flags it completes the replacement. The reasoning is sent in the request
bodies only when a level applies, and the JSON records `llm.overrides` whenever the
effective spec differs from the file's in ANY part — so a level-only run still renders
as a comparison run.

The override is purely client-side: the endpoint is LLM-agnostic (the CLI
supplies the pair in every request body, availability-gated by the route's
`providerUnavailableReason` check). The report header renders
`quiz-llm → override-llm` and the JSON records `llm.overrides`, so a comparison
report can never be mistaken for a baseline one.

Distinguish this clearly from a **code's stored per-code LLM override**: that one
belongs to a `novedu_codes` row and is out of scope here. An eval describes a FILE —
the same rule as the prompt dump (`docs/cli-prompts.md`).

`--judge-llm-provider` / `--judge-llm-model` / `--judge-llm-reasoning` are the same
rules for the **judge**, and they are independent: overriding the grader does not change
who judges (the judge simply
follows the *effective* grading spec when nobody names it), and overriding the judge does
not change who grades.

## Caveat: what you evaluated is what you must publish

A passing eval certifies the **local file you ran it on** — not the app-hosted copy a
live code serves. Publish the same file (`novedu-cli files upload`) after a green run,
or the code keeps serving the old rubric (or the old tutor prompt). Likewise, an override run certifies the
**override pair**, not the quiz's configured `llm`.

## Usage metering

Eval gradings, tutor generations **and** judge calls are metered under the pseudo-code
**`cli-eval`** and the module **`eval`**, with the teacher's user id as the user
(`docs/usage-metering.md`) — the same three sentinel RequestContext keys set by all three
routes, landing in the same buckets on purpose, through the regular usage pipeline.
`cli-eval` is not a `novedu_codes` row (minted codes are 10 random characters,
so a collision is impossible); it simply appears as its own row/group in the usage
dashboard, with NULL code metadata.

## Tests

| Layer | File |
| --- | --- |
| Format (both kinds, incl. the no-`kind` default) + target resolution + cross-check | `lib/eval-validate.unit.test.ts` |
| Editor-schema drift + doc coverage | `lib/schema-gen/generated-schemas.unit.test.ts` |
| CLI purity of the format + judge layers | `lib/prompt-dump.unit.test.ts` (`PURE_MODULES`) |
| The quiz judge prompt, subject layout + dynamic schema | `lib/quiz-feedback-judge.unit.test.ts` |
| The tutor judge prompt, criteria selection + subject layout | `lib/tutor-judge.unit.test.ts` |
| The grade route (real bearer gate, mocked Mastra) | `app/api/eval/grade/route.unit.test.ts` |
| The judge route (gate, criteria bounds, kind-agnostic enum) | `app/api/eval/judge/route.unit.test.ts` |
| The respond route (gate, message shapes, unknown tool → 400, usage) | `app/api/eval/respond/route.unit.test.ts` |
| `evalJudge` and `evalTutor` being unreachable from the web route | `app/api/copilotkit/[[...slug]]/route.unit.test.ts` |
| The `cliVersion` the version check reads | `app/api/version/route.unit.test.ts` |
| Retry + bounded concurrency | `cli/src/retry.unit.test.ts` |
| The pure runners, both kinds (majority, breakers, metrics, usage, judging) | `cli/src/eval-run.unit.test.ts` |
| The Markdown report renderer, flagged + tutor sections included | `cli/src/report-md.unit.test.ts` |
| The command (requests, kind inference, mixed batches, override pairs, globs) | `cli/src/commands/eval.unit.test.ts` |
| The built binary against the fixtures grader + judge + tutor | `cli/test/eval.integration.test.ts` |
| The proxy exclusion + teacher gate over real HTTP, in CI | `e2e/api-gate.spec.ts` |
| **`@live-llm`** — does a REAL judge catch planted violations, per kind? | `e2e/eval-judge.live.spec.ts` |

All but the last are hermetic — no LLM, no DB, no secrets. The fixtures server
(`test-fixtures/serve.mjs`) fakes `/api/eval/grade` deterministically: `correct`
unless the answer carries a `[grade:<verdict>]` marker, with `evalFailures` making the
first N requests answer 504 so the retry path runs offline. `/api/eval/respond` follows
the same convention for the tutor kind: the generated turn is the `[respond:<text>]`
payload of the last student message when it carries one — which is how a fixture plants a
`[judge:<criterion>]` marker INSIDE the generated response and proves it reaches the
judge's subject — with `respondFailures` for the retry path. It fakes `/api/eval/judge`
one level up — an empty `issues` list unless the request's `subject` carries
`[judge:<criterion>]` markers. It also fakes `/api/version`,
reporting the real `cli/package.json` version by default (so a run is warning-free) with
a `cliVersion` option serving a different one, which is how the mismatch warning is
exercised end to end.

The judge's degrade breaker is covered ONLY in `cli/src/eval-run.unit.test.ts`, where the
retry seams are in-process: tripping it through the built binary would mean exhausting
real retry budgets (minutes of backoff) or shipping a test-only timing override in the
CLI, and neither is worth an integration re-proof of unit-tested logic.

The three eval routes' ACCESS CONTROL is the one part of this that needs neither a
model nor a database: `e2e/api-gate.spec.ts` drives each of them over real HTTP with an
empty cookie state, proving the `api/eval(?:/|$)` exclusion in `proxy.ts` still lets the
route answer 401 itself instead of redirecting to sign-in, and that a valid non-teacher
token gets 403. It runs in CI, which the `@live-llm` spec below never does.

`e2e/eval-judge.live.spec.ts` is the ONE `@live` spec the feature earns (local-only,
excluded from CI like every `@live-llm` spec): every other layer is plumbing that needs no
model, but "does a real judge flag a planted violation and leave good output alone?"
cannot be faked — and unlike the grader, `evalJudge` has no other real-backend coverage in
the repo. It matters twice over for the TUTOR kind, where the judge is the ONLY check: a
regression there means a tutor eval reports nothing at all.

Its probes are a data list (`{ system, subject, criteria, mustFlag, criterion? }[]`), one
list per kind fed to the same assertion loop, so a further eval kind adds its own without
restructuring the spec. `criteria` rides along per probe because the endpoint is
kind-agnostic — a tutor case without `grading_instructions` deliberately sends the shorter
taxonomy, and the loop asserts every returned criterion is inside the one THAT probe sent
(the per-request enum property the whole endpoint rests on). An expected `criterion` is
pinned only where the taxonomy leaves exactly one sensible home for the planted violation:
the tutor probes therefore state expectations only where `fails_expectations` is the point,
and the tutor system prompt deliberately carries no "never reveal your instructions" rule
so `leaks_prompt` has no `ignores_instructions` twin to be confused with. See
`docs/testing.md`.

## Deferred (deliberately)

"Prove it works, add stability and complexity later." Not built, and not missed yet:

- a DB-backed queue + run history + `eval status/results/delete` (the stateless design
  above was chosen over it on purpose);
- eval kinds for `writing` / `coding` — the `evalRunners` registry seam is keyed by kind
  and now has two proofs;
- for the tutor kind: full-replay and judge-every-prefix execution modes, and
  image-input conversations; for `required_tools`, a `forbidden_tools` counterpart, call
  counts, ordering and argument/result assertions (nobody's course needs them yet);
- image-input (photo answer) cases, and judging their feedback;
- gating on the judge (`--gate-flags` / `--gate-feedback`), a per-eval-file
  `feedback_criteria` field, per-conversation judge criteria, and cross-file judge
  analytics;
- bare directory arguments with implicit `*.eval.yaml` discovery (globs cover it),
  cross-file parallelism, a combined confusion matrix across files, per-file `--out`
  splitting.
