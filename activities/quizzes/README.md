# Writing Quiz Files

This guide explains **quiz definitions** — the YAML files that describe an
LLM-graded, open-ended quiz — so that teachers can write their own quizzes
without touching any code. This folder holds the guide and the JSON schema;
complete sample files live in [`../examples/`](../examples/).

You do not need to be a programmer. If you can edit a structured text file and
follow the examples below, you can build a quiz.

---

## 1. The idea in one minute

A quiz is a list of **open-ended questions**. There are deliberately no
multiple-choice options: the student answers in their own words, and the **LLM
grades each answer** against a private grading prompt you write.

For every question you write two things the student never sees together:

- a **question** — the Markdown shown to the student, and
- an **evaluation** — a server-only grading prompt that embeds the expected
  answer and the rubric.

The model returns a structured verdict — **correct**, **partial**, or
**incorrect** — plus written feedback the student sees immediately. After seeing
the feedback the student can open a short **discussion chat** about that question.

```
quiz file (your questions)
┌─────────────────────────────────────────────┐
│ question  → shown to the student            │
│ evaluation → SERVER-ONLY grading prompt     │  ──▶  LLM grades the answer
│              (expected answer + rubric)     │       → correct | partial | incorrect
└─────────────────────────────────────────────┘       → feedback (+ optional discussion)
```

Because grading is just another prompt, a question can ask for reasoning, an
explanation, or a short calculation — anything the model can judge from your
rubric.

---

## 2. Quick start — a complete minimal example

A tiny quiz, `my-quiz.yaml`:

```yaml
id: capitals-basics
name: "Capital Cities — Basics"
title: "Capitals Quiz"
description: "A short quiz on capital cities. Answer in your own words."
anonymous: false # record which student each attempt belongs to
shuffle: true # random question order per attempt
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
questions:
  - id: capital-australia
    title: "Capital of Australia"
    question: |
      What is the **capital city of Australia**?
    evaluation: |
      The correct answer is **Canberra**.

      Grade as:
      - `correct`   — names Canberra (any reasonable spelling).
      - `partial`   — mentions Canberra among other guesses, or describes it.
      - `incorrect` — names Sydney, Melbourne, or any other city.
```

This repository ships complete examples you can copy from:

- [`../examples/sorting-algorithms/sorting-quiz.yaml`](../examples/sorting-algorithms/sorting-quiz.yaml)
  — a seven-question quiz about sorting algorithms with code-reading questions,
  a discussion prompt, and `shuffle: false` (the questions build on each other).
- [`../examples/review-writing/review-writing-quiz.yaml`](../examples/review-writing/review-writing-quiz.yaml)
  — an anonymous English-class quiz about writing reviews and feedback letters.

---

## 3. Editor support

This folder includes a JSON Schema for quiz YAML files: `quiz-yaml.schema.json`.
It is **generated from the zod schema** in `lib/quiz-schema.ts` via
`npm run generate:schemas` — do not edit it by hand.

Editors that use the YAML Language Server, including VS Code with YAML support,
can pick up the schema from a modeline comment at the top of a quiz file:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/quizzes/quiz-yaml.schema.json
```

The sample files in [`../examples/`](../examples/) use this **full raw GitHub URL** so that validation,
completion, and hover help work in your editor **whether or not** the schema file
happens to sit next to the YAML you are editing. (If your file _is_ next to the
schema, the relative path `./quiz-yaml.schema.json` works too.)

In VS Code, install the Red Hat YAML extension to get this schema support:
<https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml>.

The line is a comment, not a YAML field. The app ignores it, but the editor can
use it for validation, completion, and hover help. (The schema is for editor hints;
the app validates with its own checks — see [Validating your quiz](#8-validating-your-quiz).)

---

## 4. Quiz file reference

A quiz file has these fields. All of them are required unless marked optional.

```yaml
id: my-quiz # short machine name, e.g. capitals-basics
name: "My Quiz" # optional: human-readable label
title: "Welcome!" # optional: greeting students see on the welcome screen
description: "What this quiz covers." # optional: shown below the greeting
anonymous: false # optional: omit for default true; false attributes each attempt
shuffle: true # optional: omit for default true; false keeps the authored order
immediate_feedback: false # optional: omit for default true; false hides the live hint while typing
question_count: 30 # optional: questions per attempt (omit: every question once)
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic # which model grades + discusses
  imageInput: true # optional: omit for default false; students may attach photos
instructions: | # optional TOP-LEVEL shared prompt (may hold {{fragment ...}} / {{file ...}} markers);
  ...           # rendered once and prepended to BOTH grading and discussion
fragment_files: [...] # optional: fragment libraries the markers above draw from
text_files: [...] # optional: plain-text files embedded verbatim with {{file ...}}
discussion: # optional: guidance for the per-question follow-up chat only
  instructions: |
    ...
quiz_files: [...] # optional: other quiz files whose questions are ALL included live
questions: # at least one — unless quiz_files supplies the questions
  - id: ...
    question: |
      ...
    evaluation: |
      ...
```

### `id`

Required. A short machine-readable identifier for the quiz.

### `title` and `description`

Both optional. Students see them on the welcome screen before the first question:
`title` replaces the default greeting (omit it to keep the default), and
`description` appears below it as Markdown. Write the `description` for your
students.

### `anonymous`

Optional, **default `true`**. By default a quiz is anonymous: answers are recorded
for aggregate statistics but **not** linked to a student. Set `anonymous: false`
to attribute each attempt to the signed-in student (e.g. for graded work). The
flag is **frozen** onto the quiz code when the code is created — editing the YAML
later does not change a live code.

### `shuffle`

Optional, **default `true`**. When true, questions are presented in a random order
per attempt. Set `shuffle: false` to keep the authored order (useful when later
questions build on earlier ones).

Students can **skip** a question before answering it. A skipped question moves to
the end of the line and returns after every question not yet seen, with the
half-written answer restored; the last remaining question can't be skipped. This
holds with `shuffle: false` too. Skipping never changes the attempt length, and
skips are not stored.

### `immediate_feedback`

Optional, **default `true`**. While a student types an answer, a small pill (icon
plus label) next to "Your answer" shows where the answer currently stands: **looks correct**,
**partly there**, **not yet**, or **unsure** when the check cannot tell. It
updates after a short pause in typing, and its tooltip says plainly that this is
a live hint, not the graded verdict — the real grading still happens on
**Submit**, from your `evaluation` prompt.

The hint only appears when the school's server has the feature switched on. If
it is off there, the hint never shows and this field changes nothing.

Set `immediate_feedback: false` to switch the hint off for this quiz — for
example in an exam, where students should commit to an answer without a running
commentary.

### `question_count`

Optional. How many questions **one attempt** asks. Omit it to ask every question
exactly once (the default). The number interacts with `shuffle`:

- **Fewer than the pool**: with `shuffle: true` each attempt asks a **random
  selection** of that size; with `shuffle: false` every attempt asks the **first
  `question_count` questions** in authored order.
- **More than the pool**: questions **repeat** (drill/practice mode). The whole
  pool is covered before anything repeats, and with `shuffle: true` the same
  question never appears twice in a row.

Students see the length in the progress display ("Question 3 of 30"). The count
shapes one attempt in the browser only — it is **not** an exam lock: a reload
starts a fresh attempt, and a repeated question is simply graded again.

### `llm.model`

Required. The model that **grades** the answers and **drives** the per-question
discussion chat. Same id space as a tutor's `llm.model`.

### `llm.provider`

Optional, one of `SCCH` (the default — the school's Austrian LLM hosting
partner), `Azure Foundry` or `OpenRouter`. With `provider: Azure Foundry` the
quiz grades and discusses on an Azure OpenAI deployment and `llm.model` is the
**deployment name** (e.g. `gpt-5.4-mini`); with `provider: OpenRouter` it runs
through OpenRouter and `llm.model` is its namespaced routing key (e.g.
`z-ai/glm-5.3-flash`). Both are only usable if the server is configured for them
— otherwise the activity is rejected with a readable reason.

The `llm:` values are the **default**: when a teacher mints a code for this
activity, the code's create/edit form can **override the whole `llm:` block per
code** (provider + model always together, plus an optional reasoning level) — the
YAML file itself stays unchanged.

### `llm.reasoning`

Optional, no default. How much **thinking effort** the model spends before it
grades or answers — `none`, `minimal`, `low`, `medium`, `high` or `xhigh`.
Omitted, the model decides for itself. Not every level works on every model, and the models disagree in
both directions. SCCH's Qwen 3.8 takes `none`, `low`, `medium` and `xhigh` (its
default) and answers `minimal` or `high` with an error; the levels really do
change how long it thinks. SCCH's Gemma 4 accepts every level but acts on `none`
alone — `low` and `xhigh` give it the identical answer, so the choice buys
nothing there. Azure Foundry's gpt-5.x deployments have a real ladder too, but
which names they take varies per deployment. A model that does not know the
level you picked fails when a student uses the activity, just like a wrong model
name does. `none` turns thinking OFF, which is not the same as leaving the field
out: left out, the model keeps its own default.

### `llm.imageInput`

Optional, **default `false`**. When `true`, students can attach **photos** to
their answers — for example a picture of a handwritten calculation — and the
model grades the photo together with (or instead of) the typed text. Up to
3 photos per answer, 5 MB each; an answer may even be photo-only.

The model must be **vision-capable** (able to look at images). This also
applies to a per-code model override on such a quiz.

The quiz-level flag is the default for all questions; an `imageInput` on a
single question overrides it in either direction (see below).

### `discussion.instructions`

Optional. Guidance appended to the system prompt of the follow-up **discussion
chat** a student can open on any question after seeing their feedback. The app
already gives the assistant full context (the question, the expected answer, the
student's answer, and the verdict), so this is only extra steering. Omit it to use
a sensible default.

Like the top-level `instructions`, this is a **host text**: when the quiz declares
`fragment_files:` or `text_files:` (below), you can place `{{fragment "alias.id" …}}`
and `{{file "alias"}}` markers here too — same rules, including escaping a literal
`{{` as `\{{`. Without those declarations the text is used exactly as written.

### `instructions`, `fragment_files` and `text_files` (reusable prompt pieces)

Optional. A quiz may pull in **prompt fragments** — the same reusable, parameterized
pieces tutors use (a persona, a safety policy, a set of ground rules) — and embed
**plain-text files** verbatim. You declare the libraries under a **top-level
`fragment_files:`** and any text files under a **top-level `text_files:`**, then place
the fragments with inline `{{fragment "alias.id" …}}` markers and the files with
`{{file "alias"}}` markers inside a **top-level `instructions:`** host text:

```yaml
fragment_files:
  - id: general # the alias (no dots) you use in markers
    url: "../shared/general-fragments.yaml" # relative to this quiz file, or a full http(s) URL

instructions: |
  {{fragment "general.teenager_safety"}}

  {{fragment "general.language_policy" natural_language="German"
    code_language="English (TypeScript terms)"}}
```

This top-level `instructions` is rendered **once** and **prepended to BOTH** the
private grading prompt and the follow-up discussion chat — so a shared safety or
persona rule applies to how the model grades **and** how it discusses. It is **not**
the same field as `discussion.instructions`, which stays discussion-only (and may
carry markers too, see above). Your per-question `evaluation` blocks stay **plain
text** (markers go in the two host texts, never in `evaluation`); the rendered
`instructions` comes first, your text follows. Omit both fields when the quiz uses
no shared prompt.

The full mechanics — fragment libraries, `input_schema`, defaults, the `{{fragment …}}`
marker syntax, and `text_files` + the `{{file "alias" from= to=}}` marker (whole file or
a 1-based inclusive line range, spliced verbatim; aliases are shared with
`fragment_files`) — are documented in the tutor guide,
[`../tutors/README.md`](../tutors/README.md). The shared library
[`../examples/shared/general-fragments.yaml`](../examples/shared/general-fragments.yaml)
is reused across activity kinds.

---

## 5. Questions and grading

`questions` is a list with **at least one** entry. Each question:

| Field         | Required | What it is                                                                       |
| ------------- | -------- | -------------------------------------------------------------------------------- |
| `id`          | yes      | Stable id, **unique** within the quiz — the per-question stats key. Must not contain `/` (reserved for questions imported via `quiz_files`). |
| `title`       | no       | Short label for the stats table and progress display.                            |
| `question`    | yes      | The **Markdown** shown to the student (math via `$…$` and code fences render).    |
| `evaluation`  | yes      | The **grading prompt**. SERVER-ONLY — never sent to the browser.                  |
| `image`       | no       | An optional content image shown above the question (see below).                  |
| `imageInput`  | no       | Overrides the quiz-level `llm.imageInput` for this question only (photo answers on/off). |

The `evaluation` is the heart of a question. Because it never reaches the browser,
it can freely state the expected answer and the criteria for each verdict. Write
it as a short rubric, for example:

```yaml
evaluation: |
  The correct answer is **Canberra**.

  Grade as:
  - `correct`   — names Canberra (any reasonable spelling).
  - `partial`   — unsure but mentions Canberra, or describes it without naming it.
  - `incorrect` — names Sydney, Melbourne, or any other city.

  In the feedback, confirm or gently correct the student.
```

The model returns one of the three verdicts — **correct**, **partial**,
**incorrect** — and the feedback text the student sees. The verdicts you name in
the rubric are what the model maps an answer onto, so name all three.

### Content images

A question may carry an optional `image`, rendered above its Markdown:

```yaml
image:
  hosted: true # look the image up by NAME in the app's image store (server-side)
  src: sample-compass-rose # the hosted name (when hosted) or a URL / relative path
  alt: A compass rose showing the four cardinal directions. # accessible description
  credit: Compass rose — CC BY 4.0 # optional attribution shown below the image
```

Omit `hosted` (or set it `false`) to use an absolute `http(s)` URL or a path
relative to the quiz's own URL as `src`. The image carries no secret, so it
crosses to the browser (unlike `evaluation`).

---

## 6. Compound quizzes — one quiz from many (`quiz_files`)

When a course is split into chapters, each with its own quiz, you can build an
**overall quiz** at the end that asks the questions of all chapters — without
copying a single question. Declare the chapter quizzes under a top-level
`quiz_files:`, each with a short **alias** and the file's **URL**:

```yaml
id: ddp-final
name: "Final quiz: all chapters"
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
question_count: 30 # keep a big final quiz to a sensible length per attempt
quiz_files:
  - id: intro # alias: no dots, no slashes, unique within this file
    url: ./0010-introduction-quiz.yaml # relative to THIS file, or a full http(s) URL
  - id: loops
    url: ./0020-loops-quiz.yaml
```

How it works:

- **All questions, live.** Every question of every referenced quiz is included,
  read **fresh on each load** — editing a chapter quiz immediately updates the
  final quiz. There is nothing to keep in sync.
- **Own questions are optional.** A compound quiz may add its own `questions`, or
  declare none at all and consist purely of the included ones.
- **Ids are namespaced.** An imported question appears in the statistics as
  `alias/question-id` (e.g. `intro/capital-australia`), so chapters can't collide
  and you can tell them apart. That is why an own question id may not contain `/`.
- **The compound quiz's own settings rule.** Its `llm`, `anonymous`, `shuffle`,
  `question_count`, `title`/`description`, `instructions`, and `discussion` govern
  every question, imported ones included; the same settings inside a referenced
  file are **ignored**. The one thing that travels with an imported question is its
  source quiz's top-level `instructions:` text, and it applies to **grading only** —
  so a question is graded with the same shared guidance in its chapter quiz and in
  the final quiz. The follow-up **discussion chat** always follows the final quiz's
  own `instructions` and `discussion.instructions`; put any guidance discussions
  need there (fragments make it easy to share it with the chapters).
- **One level deep.** A referenced quiz must not declare `quiz_files` itself —
  includes do not nest.
- **Never a silently shorter exam.** If a referenced file is missing or broken,
  students see a friendly error instead of a shrunken quiz, and validation (below)
  fails the save: every included file is fetched and fully checked, so a broken
  chapter blocks the final quiz.

URLs resolve exactly like `fragment_files` refs: an absolute `http(s)` URL is used
as-is, anything else is resolved **relative to the compound quiz's own URL**. That
also works between app-hosted files — host the chapter quizzes and the final quiz
together on the **YAML Files** page and reference them as `./<file-name>`.

---

## 7. Hosting your quiz

The server fetches your quiz over the internet, so it must be at a **public
`http(s)` URL**.

The easiest option is GitHub:

1. Put your `.yaml` file in a public repository.
2. Use the **raw** URL of the file, for example:
   `https://raw.githubusercontent.com/<org>/<repo>/refs/heads/main/activities/quizzes/my-quiz.yaml`
3. **Commit and push** before validating or creating a code — the server reads the
   published version, not your local copy.

Alternatively, **host the quiz in the app itself** — no GitHub needed. On the
**YAML Files** page (`/files`) a teacher can create, edit and version a quiz file
(kind **Quiz**); it is served at `https://<origin>/api/files/<name>` and drops
straight into a quiz code. Students cannot read an uploaded file — not its
questions, not its `evaluation` prompts — so it suits an exam. The file is
**validated when you save it**.

A quiz is shared like any activity: mint a **code** pointing at the quiz URL and
hand the `/<code>` link to students.

---

## 8. Validating your quiz

Validation runs the same structural checks the app enforces, so a broken quiz is
caught **before** a student opens it — an invalid quiz cannot be saved or turned
into a code.

In the app, open **YAML Files** (`/files`), create or edit your quiz (kind
**Quiz**), and press:

- **Validate** — checks the YAML **without** saving, or
- **Validate & save** — checks again and stores a new version; an invalid save is
  rejected with the specific errors.

From the terminal or CI, use the CLI:

```bash
novedu-cli validate ./quizzes/my-quiz.yaml --kind quiz
```

The validator checks, in order:

1. The file is valid YAML.
2. The quiz has the correct structure — no missing or misspelled fields, an
   `llm.model`, and at least one question, own or included (each with an `id`, a
   `question`, and an `evaluation`).
3. Every question `id` is unique (and contains no `/`), and every `quiz_files`
   alias is unique.
4. For a compound quiz, **every referenced quiz file is fetched and fully
   checked** the same way — a broken chapter quiz blocks the final quiz.

### See the exact prompt

Validation tells you the quiz is *well-formed*. When you want to know what the AI
is actually told — why an answer was graded the way it was, or whether your
`instructions` really reach the grader — dump the prompts:

```bash
novedu-cli prompts ./quizzes/my-quiz.yaml --kind quiz          # a summary
novedu-cli prompts ./quizzes/my-quiz.yaml --kind quiz --json   # the full text
```

For **each question** you get the complete grading prompt: your quiz-level
`instructions` (with any `{{fragment …}}` markers replaced by the text they stand
for), the question as the student sees it, and your `evaluation` criteria, wrapped
in the frame that asks the model for a verdict and feedback. You also get the
**discussion** chat's prompt and the messages that discussion starts from. For a
compound quiz the list covers every imported question, each carrying its own
chapter's `instructions` — exactly the way it will be graded.

Nothing is uploaded and no sign-in is needed; the command only reads your file.

### Testing the grading itself: golden answers (`eval`)

The prompt dump shows what the AI is *told*. To find out what it actually *does*,
write a small **eval file** next to your quiz: student answers you make up, each
with the verdict it must get. `novedu-cli eval` then grades them with the real
grader and tells you where your rubric disagreed with you.

```yaml
# my-quiz.eval.yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/evals/eval-yaml.schema.json
id: my-quiz-eval
target: ./my-quiz.yaml            # relative to THIS file
questions:
  - question: q1                  # a question id of your quiz
    answers:
      - expect: correct
        answer: |
          The full, correct answer.
      - expect: [partial, incorrect]   # either grading would be fine
        answer: |
          Half of the answer.
      - expect: incorrect
        answer: |
          A confident, wrong answer.
```

```bash
novedu-cli validate ./my-quiz.eval.yaml --kind eval   # free: checks the eval AND the quiz
novedu-cli eval ./my-quiz.eval.yaml                   # runs the real grader (sign-in required)
```

A few good answers per question already catch a lot — especially the *confidently
wrong* ones, which is where a lenient `evaluation` shows up as a **false-correct**
in the report. The eval also makes rubric edits safe: re-run it after every change
and you will see immediately whether you fixed one case and broke another.

The same run also checks the **wording** your students would read, not just the verdict:
a second AI reads each piece of feedback and reports where it breaks the instructions you
already wrote — praise on a wrong answer, no correct answer given, the wrong language,
your grading criteria quoted back at the student. You author nothing extra for this, and
it never fails a run; add `--no-judge-feedback` to skip it and halve the cost.

The full guide (report semantics, `--repeats`, feedback judging, comparing models,
running a whole folder at once) is in [`../evals/README.md`](../evals/README.md).

### Common problems and how to fix them

| Reported problem            | What it means                                                  | How to fix                                    |
| --------------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| `YAML_PARSE_ERROR`          | The file isn't valid YAML.                                     | Check indentation and quotes.                 |
| `QUIZ_SCHEMA_ERROR`         | A field is missing, has the wrong type, or is misspelled (the detail lines name the field). | Compare against this guide; fix the named field. A numeric-looking `id` must be **quoted**. |
| `DUPLICATE_QUIZ_QUESTION_ID`| Two questions share an `id`.                                   | Give each question a distinct `id`.           |
| `QUIZ_QUESTION_ID_RESERVED_SLASH` | An own question `id` contains `/` (reserved for imported questions). | Remove the `/` from the id.       |
| `QUIZ_NO_QUESTIONS`         | The quiz has no own questions **and** no `quiz_files` includes. | Add at least one question or an include.      |
| `DUPLICATE_QUIZ_INCLUDE_ALIAS` | Two `quiz_files` entries share an alias.                    | Give each include a distinct alias.           |
| `QUIZ_INCLUDE_UNREADABLE`   | A referenced quiz file couldn't be fetched, or fails its own checks (the message names the alias + URL and the nested problems). | Fix or re-publish the referenced quiz file.   |
| `QUIZ_INCLUDE_NESTED`       | A referenced quiz declares `quiz_files` itself.                | Reference only plain (chapter) quizzes — includes don't nest. |
| `FETCH_FAILED`              | The URL couldn't be loaded.                                    | Check the URL is public and pushed.           |

---

## 9. Checklist before you publish

- [ ] The quiz has an `id`, an `llm.model`, and **at least one** question (own,
      or included via `quiz_files`).
- [ ] Every question has an `id`, a `question`, and an `evaluation`.
- [ ] Every question `id` is **unique** and contains no `/`.
- [ ] Numeric-looking ids are **quoted** (e.g. `id: "1"`).
- [ ] `anonymous` is set the way you want — default `true` (not attributed).
- [ ] For a compound quiz: aliases are short and unique, every referenced quiz
      file is published and valid, and `question_count` is set if the combined
      pool is large.
- [ ] The file is **public** and **pushed** (if hosted on GitHub).
- [ ] You validated the quiz and it passes.
