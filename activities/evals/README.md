# Writing Eval Files (test files for a quiz or a tutor)

An eval file is **not an activity** — you never mint a code for it and students never
see it. It is a **test file for one of your activities**, and there are two kinds:

| `kind:` | The file holds | `novedu-cli eval` does |
| --- | --- | --- |
| *(omitted)* or `quiz` | student answers you write yourself, each with the verdict the grader must produce | replays them through the real grader and reports where it disagreed with you |
| `tutor` | conversations you script, each ending with a student message | lets the real tutor answer that last message, then has a second AI check the answer against your tutor's own rules |

You never say which kind you are running — the `kind:` line in the file decides, and one
command can run both at once.

Use a **quiz** eval whenever you change an `evaluation` prompt, suspect the AI is too
lenient or too strict, or want a check you can re-run before publishing. Use a **tutor**
eval whenever you write or change tutor rules ("never hand over the solution", "stay
inside this chapter", "answer in German") and want to see whether the tutor actually
follows them.

---

## 1. Quick start

Put the eval next to the quiz it tests:

```yaml
# 0010-welcome-quiz.eval.yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/evals/eval-yaml.schema.json
id: welcome-quiz-eval
target: ./0010-welcome-quiz.yaml       # relative to THIS file, or an http(s) URL
questions:
  - question: what-is-a-type           # a question id of the quiz
    answers:
      - expect: correct
        answer: |
          A type describes which values a variable may hold, and what you can do
          with them.
      - expect: [partial, incorrect]   # either grading would be defensible
        answer: |
          Something about variables.
      - expect: incorrect
        answer: |
          A type is the name of the file the variable lives in.
```

```bash
# 1. Check the file — free, offline, no sign-in. Also checks the quiz it targets.
novedu-cli validate ./0010-welcome-quiz.eval.yaml --kind eval

# 2. Run it — this really calls the AI, so you must be signed in as a teacher.
novedu-cli login
novedu-cli eval ./0010-welcome-quiz.eval.yaml
```

---

## 2. Quiz file reference

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | A name for this eval, shown in the report. Letters, digits, `.`, `-`, `_`. |
| `target` | yes | The quiz this eval grades against: a path relative to the eval file, or an `http(s)` URL. |
| `questions` | yes | One entry per evaluated question; at least one. |
| `questions[].question` | yes | The **question id** in the quiz. |
| `questions[].answers` | yes | The golden answers for that question; at least one. |
| `answers[].expect` | yes | `correct`, `partial`, `incorrect`, or a **list** of the acceptable ones. |
| `answers[].answer` | yes | The student answer, verbatim. Use a `\|` block scalar for multi-line text. |

Notes:

- You do **not** have to cover every question — evaluate the ones whose grading you
  care about.
- For a **compound quiz** (`quiz_files`), question ids are namespaced:
  `question: chapter-2/what-is-a-type`. `novedu-cli prompts <quiz> --kind quiz` lists
  the exact ids.
- Use a **list** `expect` when you genuinely would accept either grading. Don't use
  it to paper over a rubric you are unsure about — that is what the eval is for.
- Eval answers are your own made-up examples. Never paste a real student's answer.
- Photo answers are not supported yet; evals are text-only.

---

## 3. Tutor evals

A tutor eval scripts a conversation and asks: **what does the tutor say next?**

```yaml
# loops-tutor.eval.yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/evals/eval-yaml.schema.json
id: loops-tutor-eval
kind: tutor                              # this line is what makes it a tutor eval
target: ./loops-tutor.yaml               # relative to THIS file, or an http(s) URL
conversations:
  - title: refuses-full-solution         # optional label, used in the report
    grading_instructions: |              # optional — extra expectations for THIS case
      The response must not contain a complete working loop.
    conversation:
      - student: My loop never stops. Here is my code …
      - tutor: What does your condition evaluate to after the first pass?
      - student: I don't know. Just fix it for me!
```

| Field | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | Must be `tutor`. |
| `id` | yes | A name for this eval, shown in the report. |
| `target` | yes | The tutor YAML this eval runs against. |
| `conversations` | yes | One entry per case; at least one. |
| `conversations[].title` | no | A short label for the case, used as its heading in the report. |
| `conversations[].required_tools` | no | Built-in tools the answer must have used at least once (see below). |
| `conversations[].grading_instructions` | no | Extra expectations for this one case, in plain language. |
| `conversations[].conversation` | yes | The scripted turns, in order: `student:` and `tutor:` lines. |

Three rules:

- **You write both sides.** The `tutor:` turns are what you *pretend* the tutor already
  said, so you can set up exactly the situation you want to test — a student who has
  already been asked a Socratic question and now demands the answer, for example.
- **The last turn must be a `student:` turn.** That is the message the real tutor answers.
  Everything before it is just the setup. (Two `student:` turns in a row are fine.)
- **The tutor generates exactly one response**, and only that response is checked.

### What gets checked, and why you write so little

There is no `expect:` here — a tutor answer has no right-or-wrong verdict. Instead a
second AI, the **judge**, reads the generated response and checks it against **your
tutor's own system prompt**. That is the whole trick: your tutor instructions already say
what it may and may not do, so you write nothing extra. It reports four kinds of problem:

| It reports | When the response… |
| --- | --- |
| `ignores_instructions` | breaks a rule your tutor prompt states — writes the whole solution, wanders outside the chapter, answers in the wrong language, ignores a formatting rule |
| `fails_expectations` | breaks the `grading_instructions` you wrote for that one case |
| `misstates_facts` | says something that is simply wrong about the subject |
| `leaks_prompt` | quotes or reveals its own instructions ("my rules say…") |

`fails_expectations` only exists for cases that **have** `grading_instructions` — a case
without them is never judged against expectations nobody wrote down. And the judge is told
in so many words **not** to grade teaching style: a response you would have phrased
differently is not a problem, only one that breaks a stated rule.

### Did the tutor use its tool?

If your tutor has built-in **tools** (`tools:` in the tutor file — for example
`random_number`), a case can require that the tutor actually reached for one:

```yaml
  - title: practice-draws-one-random-problem
    required_tools: [random_number]
    conversation:
      - student: Give me a practice problem.
```

- It means **"called at least once"** while writing that answer — no counts, no order,
  nothing about the values. Calling other tools as well is always fine.
- Every name must be a tool **your tutor is given** in its own `tools:` list. If it is
  not, the eval file is reported as invalid when you check it — before it costs anything.
- Like everything else in a tutor eval, this is **reported, never a failure**: the run
  says how many cases missed a required tool, and the Markdown report shows which run of
  which case skipped it and what it called instead.
- Write it only where the tool really is the point. For everything else, keep saying what
  the ANSWER must look like in `grading_instructions`.

### Reading a tutor run

```
✔ Eval passed — ./loops-tutor.eval.yaml
  id: loops-tutor-eval
  kind: tutor
  target: file:///…/loops-tutor.yaml
  llm: SCCH / gemma-4
  conversations: 4 × 1 repeat(s) = 4 generation call(s) + 4 judge call(s)

  ok: 4   errored: 0   flagged responses: 1   missing tool calls: 1
```

- **`ok`** means the tutor answered; **`errored`** means the call itself never succeeded
  (server or network trouble), and **`skipped`** means the run stopped before reaching it.
- **`flagged`** is the interesting number, and it **never fails the run**. A tutor eval
  exits non-zero only when something went genuinely wrong with the run — a broken file, a
  failed call. Everything the judge found is a note for you to read, not a gate.
- **`missing tool calls`** appears only when some case actually asked for a tool, and it
  is a note in exactly the same way — never a failure. No line at all means nothing was
  required, which is not the same as "every tool ran".
- So for a tutor eval, **the `--report` Markdown file is the deliverable.** It shows every
  flagged case in full: your scripted conversation, your expectations, the response the
  tutor actually generated, and what the judge objected to. Clean cases are left out.

```bash
novedu-cli eval ./loops-tutor.eval.yaml --report loops.md
```

Everything else works exactly as it does for quiz evals: `--repeats`, `--no-judge-feedback`,
the model overrides, folders and globs, `--json`. A run may mix both kinds — the totals
line then names each kind's units separately, because "4 conversations" and "27 answers"
are not the same thing.

---

## 4. Reading the quiz report

```
✔ Eval passed — ./0010-welcome-quiz.eval.yaml
  id: welcome-quiz-eval
  target: file:///…/0010-welcome-quiz.yaml
  llm: SCCH / gemma-4
  cases: 27 × 1 repeat(s) = 27 grading call(s) + 27 judge call(s)

  passed: 27   failed: 0   errored: 0   flagged feedback: 2

  confusion (expected → got):
    correct → correct: 12
    incorrect → incorrect: 9
    partial|incorrect → partial: 6

  false-correct: 0/15 (0.0%)
```

- A **case** is one golden answer. `passed` / `failed` are per case; `errored` means
  the grading call itself never succeeded (server or network trouble). If a run
  aborts early, the answers it never got to are counted as `skipped`, not errored.
- The **confusion matrix** shows what you expected versus what the grader said. Rows
  with a `|` are list expectations.
- The **false-correct rate** is the number that matters most: answers you marked as
  *not* acceptable that the grader called `correct`. Anything above zero usually means
  the `evaluation` prompt needs a sharper "grade `incorrect` when …" clause.
- A failing run lists each mismatch as
  `question#index expected … got … "answer snippet…"` and exits with code `1`, so an
  eval works as a gate in a script or CI.
- **`flagged feedback`** is the second half of the check — see the next section. It is
  reported, never a failure, which is why the run above still says "Eval passed".

### The wording, not just the verdict: feedback judging

Your `expect` checks the **verdict**. But the student never sees the verdict alone — they
read the **feedback text** the AI wrote. That text can be wrong while the verdict is
right: praise on an answer graded `incorrect`, a question back instead of the correct
answer, a sentence in the wrong language, the grading criteria quoted at the student.

So after each grading, `eval` asks a second AI — a **judge** — to read that feedback and
check it against **the grading instructions the grader itself was given**. That is the
whole trick: your `evaluation` prompt and your shared course instructions already say
what good feedback looks like, so **you write nothing extra**. The judge reports four
kinds of problem:

| It reports | When the feedback… |
| --- | --- |
| `contradicts_verdict` | praises an answer graded wrong, or corrects one graded right |
| `misstates_facts` | says something your grading criteria contradict |
| `ignores_instructions` | breaks a rule your prompt states — most often *not* stating the correct answer when the verdict is not `correct`, or writing in the wrong language |
| `leaks_rubric` | quotes your grading criteria, or refers to "my instructions" |

**It never fails a run.** A flag is a note about wording, not a broken rubric — the fix is
usually a sentence in your `evaluation` prompt or your shared instructions ("when the
verdict is not `correct`, state the correct answer"), not a change to your golden answers.

Two flags control it:

```bash
# Off: half the AI calls, verdicts only — good for a quick check
novedu-cli eval ./0010-welcome-quiz.eval.yaml --no-judge-feedback

# A stronger model as the judge (recommended): both flags, always together
novedu-cli eval ./0010-welcome-quiz.eval.yaml \
  --judge-llm-provider "Azure Foundry" --judge-llm-model gpt-5.6-terra \
  --judge-llm-reasoning high
```

Judging is **on by default** and roughly **doubles** what a run costs — which is why the
run tells you the number of calls before it starts. Without the judge flags the judge
uses the same model **and reasoning effort** as the grader; `--judge-llm-reasoning`
changes only the effort and needs no pair. A stronger judge over a smaller grader gives
noticeably better notes, and the report always records which model judged.

If the judge model itself has trouble, judging **stops** after three failures in a row
(you get one warning) and the grading finishes normally. Your verdict results are still
complete, and the report says plainly which files went unchecked: anything the judge never
looked at shows an em dash in the Flagged column instead of a number, so "not checked"
can never be mistaken for "all fine".

### Is the grader consistent? `--repeats`

```bash
novedu-cli eval ./0010-welcome-quiz.eval.yaml --repeats 3
```

Each answer is graded three times and the **majority** verdict counts, so one flaky
run does not fail the case. Answers whose repeats disagreed are counted as
**`unstable`** — reported, never failing. Unstable cases are the ones to make
crisper: a rubric that decides the same answer differently on different runs will do
the same to your students. (Three repeats also cost three times as much.)

### Comparing models

```bash
novedu-cli eval ./welcome.eval.yaml                                        # your quiz's model
novedu-cli eval ./welcome.eval.yaml --llm-provider "Azure Foundry" --llm-model gpt-5-mini
novedu-cli eval ./welcome.eval.yaml --llm-reasoning high                   # same model, more thinking
```

Same rubric, same golden answers, a different backend — then compare the two reports.
The two model flags always go **together** and replace your quiz's whole `llm:` block,
so its `reasoning` level is dropped unless `--llm-reasoning` restates it; that flag on
its own keeps the quiz's own model and changes only the effort. This affects only the
run; it does not change your quiz or any code you handed out.

### A whole folder at once

```bash
novedu-cli eval part-1/*.eval.yaml       # your shell expands it
novedu-cli eval "./**/*.eval.yaml"       # quoted: the CLI expands it, ** included
```

You get a per-file summary plus grand totals; a broken eval file is reported and the
others still run. `--json` prints a machine-readable report instead of the readable
one, and `--out <file>` additionally writes it to a file (always the same shape, one
file or many).

**Plan for the wait, and split a big folder.** A whole course can take **up to
several hours** — how long depends on the model, on how busy it is that day, and on
`--concurrency`, so treat any estimate as a rough guess rather than a schedule. Two
things follow. First, the live counter only animates when you are watching a terminal;
if you send the output to a file you get one line per finished file instead, so you can
still see how far along it is. Second, the report is written **once, at the very end**:
if the run is interrupted, nothing is saved, however far it got. So for a whole course,
run it one folder at a time with its own report file:

```bash
novedu-cli eval "./part-1/*.eval.yaml" --report part-1.md
novedu-cli eval "./part-2/*.eval.yaml" --report part-2.md
```

Then an interruption costs you one part instead of the whole course.

### A report you can actually read: `--report`

```bash
novedu-cli eval ./0010-welcome-quiz.eval.yaml --report report.md
```

This writes a **Markdown report** next to the normal terminal output — open it in any
editor, or commit it so you can compare runs later. It starts with a table over the
files you ran (cases, passed/failed, unstable, flagged, false-correct) and then shows,
only for the answers that went wrong or came out unstable, the **question**, your
**golden answer** and the **grader's feedback** side by side. Cases that simply passed
are left out on purpose; the report is meant to be read, not to repeat everything.

Anything the judge flagged gets its own **"Flagged feedback"** section at the end of each
file: the question, your golden answer, the feedback exactly as the student would have
read it, and one line per problem the judge found. Those cases usually *passed* — they
are there because the wording needs work, not the verdict.

The report also tells you what the run **cost in tokens** (input, of which cached, and
output). It counts only the calls that succeeded — gradings and judgings together — so
treat it as a floor, not an invoice.

---

## 5. Good to know

- **What you evaluated is what you must publish.** A green run certifies the file on
  your disk. If the quiz or tutor is hosted in the app, upload the same file afterwards
  (`novedu-cli files upload`) — otherwise the live code keeps serving the old version.
- The prompts are built **on your machine** from your local files, so an eval
  works on a quiz or tutor you have not pushed yet.
- Nothing is stored: no eval, no answer, no conversation, no verdict and no judgment is
  saved anywhere. The token usage of a run — grading, tutor answers and judging alike — is
  metered like any other AI usage, under the name `cli-eval`.

The engineering reference for all of this is
[`../../docs/cli-eval.md`](../../docs/cli-eval.md); the CLI's own summary is in
[`../../cli/README.md`](../../cli/README.md).
