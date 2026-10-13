# Writing Activity Files

This guide explains **writing activity definitions** — the YAML files that
describe a split-screen writing task with an AI **writing coach** — so that
teachers can write their own activities without touching any code. This folder
holds the guide and the JSON schema; complete sample files live in
[`../examples/`](../examples/).

You do not need to be a programmer. If you can edit a structured text file and
follow the example below, you can build a writing activity.

---

## 1. The idea in one minute

A writing activity gives the student a **split screen**: they write Markdown in an
editor on the left, and an AI **writing coach** on the right gives feedback.

The coach can **read** the student's live draft (through a read-only tool), but it
is structurally incapable of **editing** it — by design it only advises, it never
rewrites. When the student is happy, they press **Save**, which stores one text per
student so a teacher can review it later.

```
┌───────────────────────────┐   ┌──────────────────────────────┐
│ student's draft (Markdown) │   │ writing coach                │
│   the student writes here  │ ──▶ reads the draft, gives       │
│                            │   │ feedback — never edits it     │
└───────────────────────────┘   └──────────────────────────────┘
            │
            ▼  press Save → one stored text per (activity, student)
```

You describe the task and how the coach should behave; everything else — the
editor, the read-only draft tool, the Save flow — is built for you.

---

## 2. Quick start — a complete example

A minimal writing activity, `my-writing.yaml`:

```yaml
id: my-essay
name: "Persuasive Essay"
title: "Write a Persuasive Essay"
description: |
  Write a short persuasive essay (about 400 words). Draft on the left; ask the
  coach on the right for feedback. Press **Save** when you are happy with it.
anonymous: false # writing defaults to false (attributed) — see Privacy below
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
instructions: |
  You are an encouraging writing coach. Help the student improve THEIR essay —
  never write it for them. Read the current draft with the `getCurrentText` tool
  before giving feedback. Point at what works and what to improve, and end with a
  concrete next step.
placeholder: "" # optional starter text; empty = blank page
```

This repository ships a complete example you can copy from:
[`../examples/review-writing/restaurant-review-letter.yaml`](../examples/review-writing/restaurant-review-letter.yaml)
— a feedback letter to a restaurant, with a formal-letter scaffold as
`placeholder` and detailed coaching criteria.

---

## 3. Editor support

This folder includes a JSON Schema for writing YAML files:
`writing-yaml.schema.json`. It is **generated from the zod schema** in
`lib/writing-schema.ts` via `npm run generate:schemas` — do not edit it by hand.

Editors that use the YAML Language Server, including VS Code with YAML support,
can pick up the schema from a modeline comment at the top of a writing file:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/writings/writing-yaml.schema.json
```

The sample files in [`../examples/`](../examples/) use this **full raw GitHub URL** so that validation,
completion, and hover help work in your editor **whether or not** the schema file
happens to sit next to the YAML you are editing. (If your file _is_ next to the
schema, the relative path `./writing-yaml.schema.json` works too.)

In VS Code, install the Red Hat YAML extension to get this schema support:
<https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml>.

The line is a comment, not a YAML field. The app ignores it, but the editor can
use it for validation, completion, and hover help. (The schema is for editor hints;
the app validates with its own checks — see [Validating your activity](#6-validating-your-activity).)

---

## 4. Writing file reference

A writing file has these fields. All of them are required unless marked optional.

```yaml
id: my-writing # short machine name, e.g. my-essay
name: "My Writing Activity" # optional: human-readable label
title: "Welcome!" # optional: greeting students see on the welcome screen
description: "What to write." # optional: shown below the greeting (Markdown)
anonymous: false # optional: omit for default FALSE (attributed); true disables saving
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic # which model drives the coach
instructions: | # the coach's system prompt (server-only)
  ...
placeholder: "" # optional: starter text prefilled into the editor
```

### `id`

Required. A short machine-readable identifier for the activity.

### `title` and `description`

Both optional. Students see them on the welcome screen before they start writing:
`title` replaces the default greeting (omit it to keep the default), and
`description` appears below it as Markdown. Write the `description` for your
students — this is where you set the actual writing task.

### `anonymous`

Optional, **default `false`** — this is the writing **divergence** from tutors and
quizzes. Writing defaults to **attributed** because the teacher review and the Save
feature need to know whose text it is.

Set `anonymous: true` only for ephemeral, unattributed writing — and note that
**this disables saving**: there is nothing to review. The flag is **frozen** onto
the writing code when the code is created, and the Save action re-checks it live.

### `llm.model`

Required. The model that drives the **feedback chat**. Same id space as a tutor's
or quiz's `llm.model`. SERVER-ONLY.

### `llm.provider`

Optional, one of `SCCH` (the default — the school's Austrian LLM hosting
partner), `Azure Foundry` or `OpenRouter`. With `provider: Azure Foundry` the
feedback chat runs on an Azure OpenAI deployment and `llm.model` is the
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
answers — `none`, `minimal`, `low`, `medium`, `high` or `xhigh`. Omitted, the
model decides for
itself. Not every level works on every model, and the models disagree in
both directions. SCCH's Qwen 3.8 takes `none`, `low`, `medium` and `xhigh` (its
default) and answers `minimal` or `high` with an error; the levels really do
change how long it thinks. SCCH's Gemma 4 accepts every level but acts on `none`
alone — `low` and `xhigh` give it the identical answer, so the choice buys
nothing there. Azure Foundry's gpt-5.x deployments have a real ladder too, but
which names they take varies per deployment. A model that does not know the
level you picked fails when a student uses the activity, just like a wrong model
name does. `none` turns thinking OFF, which is not the same as leaving the field
out: left out, the model keeps its own default.

### `instructions`

Required. The writing coach's **system prompt**. SERVER-ONLY — never sent to the
browser — so it may freely describe the assessment criteria and the coaching
strategy.

This is where you shape the coach. A good `instructions` block tells it to read
the draft with the `getCurrentText` tool before commenting, to advise rather than
rewrite, what to prioritise in feedback, and how to talk to the student. See
[`../examples/review-writing/restaurant-review-letter.yaml`](../examples/review-writing/restaurant-review-letter.yaml)
for a thorough example.

> The coach has **no** tool to change the text — it can only read the draft. So
> even if `instructions` asked it to rewrite, it physically cannot. Lean into that:
> tell it to give directions and guiding questions, not finished sentences.

### `fragment_files`, `text_files` and reusable prompt pieces

Optional. A writing activity may pull in **prompt fragments** — the same reusable,
parameterized pieces tutors use (a persona, a safety policy, a set of ground rules) —
and embed **plain-text files** verbatim. Declare the libraries under a **top-level
`fragment_files:`** and any text files under a **top-level `text_files:`**, then place
the fragments with inline `{{fragment "alias.id" …}}` markers and the files with
`{{file "alias"}}` markers directly in your `instructions`:

```yaml
fragment_files:
  - id: general # the alias (no dots) you use in markers
    url: "../shared/general-fragments.yaml" # relative to this writing file, or a full http(s) URL

instructions: |
  {{fragment "general.teenager_safety"}}

  You are an encouraging writing coach. Read the current draft with the
  `getCurrentText` tool before giving feedback, and advise rather than rewrite.

  {{fragment "general.language_policy"
    natural_language="English — simple and clear, suitable for B1–B2 learners"
    code_language="English"}}
```

Each fragment or file renders exactly where its marker sits inside `instructions` —
there is no separate prepend step and no ordering knob. A writing file with **neither**
`fragment_files` nor `text_files` keeps its `instructions` exactly as written (any
`{{…}}` in it stays literal). Omit both when the activity uses no shared prompt.

The full mechanics — fragment libraries, `input_schema`, defaults, the `{{fragment …}}`
marker syntax, and `text_files` + the `{{file "alias" from= to=}}` marker (whole file or
a 1-based inclusive line range, spliced verbatim; aliases are shared with
`fragment_files`) — are documented in the tutor guide,
[`../tutors/README.md`](../tutors/README.md). The shared library
[`../examples/shared/general-fragments.yaml`](../examples/shared/general-fragments.yaml)
is reused across activity kinds.

### `placeholder`

Optional. Starter text prefilled into the editor. Leave it empty (`""`) for a blank
page, or set a scaffold (headings, a first line) to give more structure.

---

## 5. Hosting your activity

The server fetches your activity over the internet, so it must be at a **public
`http(s)` URL**.

The easiest option is GitHub:

1. Put your `.yaml` file in a public repository.
2. Use the **raw** URL of the file, for example:
   `https://raw.githubusercontent.com/<org>/<repo>/refs/heads/main/activities/writings/my-writing.yaml`
3. **Commit and push** before validating or creating a code — the server reads the
   published version, not your local copy.

Alternatively, **host the activity in the app itself** — no GitHub needed. On the
**YAML Files** page (`/files`) a teacher can create, edit and version a writing
file (kind **Writing**); it is served at `https://<origin>/api/files/<name>` and
drops straight into a code. Students cannot read an uploaded file. The file is
**validated when you save it**.

An activity is shared like any other: mint a **code** pointing at the writing URL
and hand the `/<code>` link to students.

---

## 6. Validating your activity

Validation runs the same structural checks the app enforces, so a broken activity
is caught **before** a student opens it — an invalid file cannot be saved or turned
into a code.

In the app, open **YAML Files** (`/files`), create or edit your activity (kind
**Writing**), and press:

- **Validate** — checks the YAML **without** saving, or
- **Validate & save** — checks again and stores a new version; an invalid save is
  rejected with the specific errors.

From the terminal or CI, use the CLI:

```bash
novedu-cli validate ./writings/my-writing.yaml --kind writing
```

The validator checks, in order:

1. The file is valid YAML.
2. The activity has the correct structure — no missing or misspelled fields, an
   `llm.model`, and a non-empty `instructions` block.

### See the exact prompt

To check what the writing coach is really told — especially when your
`instructions` pull in shared fragments — dump the prompt:

```bash
novedu-cli prompts ./writings/my-writing.yaml --kind writing
novedu-cli prompts ./writings/my-writing.yaml --kind writing --json   # the full text
```

You get the **complete system prompt the coach receives**: your `instructions`
with every `{{fragment …}}` and `{{file …}}` marker replaced by the text it stands
for. That is what the coach is told before it ever sees the student's draft, so it
is the place to look when a rule of yours seems to be ignored. Nothing is uploaded
and no sign-in is needed; the command only reads your file. Like the file itself,
the output is written for teachers, not students.

### Common problems and how to fix them

| Reported problem       | What it means                                                  | How to fix                                    |
| ---------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| `YAML_PARSE_ERROR`     | The file isn't valid YAML.                                     | Check indentation and quotes.                 |
| `WRITING_SCHEMA_ERROR` | A field is missing, has the wrong type, or is misspelled (the detail lines name the field). | Compare against this guide; fix the named field. A missing `instructions` or `llm.model` is the usual cause. |
| `FETCH_FAILED`         | The URL couldn't be loaded.                                    | Check the URL is public and pushed.           |

---

## 7. Checklist before you publish

- [ ] The activity has an `id`, an `llm.model`, and a non-empty `instructions`.
- [ ] `instructions` tells the coach to **read** the draft with `getCurrentText`
      and to **advise, not rewrite**.
- [ ] `anonymous` is set the way you want — default `false` (attributed); `true`
      **disables saving**.
- [ ] The `description` states the writing task for the student.
- [ ] The file is **public** and **pushed** (if hosted on GitHub).
- [ ] You validated the activity and it passes.
