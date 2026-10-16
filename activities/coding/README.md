# Coding Activity Files

This guide explains **coding activity definitions** — the YAML files that describe
an **OpenAI-compatible coding endpoint**. A student points an external coding agent
(such as [little-coder](https://github.com/itayinbarr/little-coder)) at the app, and
codes against the school's model with behaviour you control. Teachers can write
their own activities without touching any code. This folder holds the guide and
the JSON schema; complete sample files live in [`../examples/`](../examples/).

If you can edit a structured text file and follow the example below, you can build a
coding activity.

---

## 1. The idea in one minute

You write a short YAML that says **which model** to use and **how the assistant
should behave** (its system prompt). The app turns that into a time-limited **code**.
A student configures a coding agent with three things — **base URL**, **key**,
**model** — and starts coding. The **code is the API key**.

```
coding agent (little-coder)        the app                     the pinned model
  ─── request + your key ──▶  check code + window                 (e.g. gemma)
                              append your system prompt    ──▶
                              pin the model
  ◀────────── answer streamed straight back ──────────────────────
  runs its own tools (edit files, run code) on the student's machine
```

Unlike the tutor, quiz, and writing activities, there is **no in-app chat** — the
student works in their own terminal/editor through the coding agent. The endpoint is
a thin, gatekept relay: it adds your instructions and forwards to the model. Coding
activities are **always anonymous** — the requests carry no student identity, so
nothing is tracked or stored per student.

---

## 2. Quick start — a complete example

A minimal coding activity, `my-coding.yaml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/coding/coding-yaml.schema.json
id: my-coding
name: "Beginner TypeScript Coding Buddy"
title: "TypeScript Coding Buddy (Beginners)"
llm:
  model: openai/gpt-6-luna
  provider: OpenRouter
  reasoning: medium
instructions: |
  You are a friendly TypeScript coding buddy for a BEGINNER. Keep every explanation
  and every line of code within what the student has learned:
  - only the primitive types number, string, boolean (arrays are fine); no classes
    or interfaces (no OOP)
  - only if / else if / else and basic while / for loops; no map/filter/reduce
    one-liners
  - no arrow functions — declare functions with the `function` keyword
  - always add explicit type annotations to every variable, parameter and return;
    never use `any`
  Teach in small steps and explain WHY.
```

The first line is the editor schema hint — see [Editor support](#3-editor-support).

This repository ships a complete example you can copy from:
[`../examples/sorting-algorithms/sorting-visualizer.yaml`](../examples/sorting-algorithms/sorting-visualizer.yaml)
— a sorting-visualizer project buddy that states the class's prior knowledge,
limits the TypeScript constructs, and keeps the algorithm itself for the student
to write.

---

## 3. Editor support

This folder includes a JSON Schema for coding YAML files: `coding-yaml.schema.json`.
It is **generated from the zod schema** in `lib/coding-schema.ts` via
`npm run generate:schemas` — do not edit it by hand.

Editors that use the YAML Language Server, including VS Code with YAML support, can
pick up the schema from a modeline comment at the top of a coding file:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/coding/coding-yaml.schema.json
```

The sample files in [`../examples/`](../examples/) use this **full raw GitHub URL** so that validation,
completion, and hover help work in your editor **whether or not** the schema file
happens to sit next to the YAML you are editing. (If your file _is_ next to the
schema, the relative path `./coding-yaml.schema.json` works too.)

In VS Code, install the Red Hat YAML extension to get this schema support:
<https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml>.

The line is a comment, not a YAML field. The app ignores it, but the editor can use
it for validation and completion. (The schema is for editor hints; the app validates
with its own checks — see [Validating your activity](#7-validating-your-activity).)

---

## 4. Coding file reference

A coding file has these fields. All are required unless marked optional.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/coding/coding-yaml.schema.json
id: my-coding # short machine name
name: "My Coding Buddy" # optional: human-readable label
title: "Coding Buddy" # optional: label shown to the student on the /<code> page
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic # which model answers (server-only)
instructions: | # the assistant's system prompt (server-only)
  ...
```

### `id`

Required. A short machine-readable identifier for the activity.

### `name` and `title`

Both optional. `name` is a human-readable label; `title` is shown to the student on
the connection page (`/<code>`). Neither is required for the endpoint to work.

### `llm.model`

Required. The model that answers. Same id space as a tutor's, quiz's, or
writing's `llm.model`. **SERVER-ONLY** and **pinned**: the proxy always uses this
model and **ignores** whatever model the coding agent sends, so the student never
needs to know it.

### `llm.provider`

Optional, one of `SCCH` (the default — the school's Austrian LLM hosting
partner), `Azure Foundry` or `OpenRouter`. With `provider: Azure Foundry` the
answers come from an Azure OpenAI deployment and `llm.model` is the **deployment
name** (e.g. `gpt-5.4-mini`); with `provider: OpenRouter` they come through
OpenRouter and `llm.model` is its namespaced routing key (e.g.
`openai/gpt-6-luna`). Both are only usable if the server is configured for them
— otherwise the activity is rejected with a readable reason.
A server may also accept only some OpenRouter models: any other one fails when a
student uses the activity, just like a wrong model name. Like the
model, the provider never reaches the student.

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
out: left out, the model keeps its own default. Like the model and the provider, it is **pinned**: it overrides whatever
reasoning effort the coding agent asks for.

### `instructions`

Required. The assistant's **system prompt**. **SERVER-ONLY** — never sent to the
browser or the coding agent — and **appended after** the coding tool's own prompt
(so your rules are the final word). This is where you constrain the assistant to what
your class has learned (a
language, a subset of features, a teaching style). See
[`../examples/sorting-algorithms/sorting-visualizer.yaml`](../examples/sorting-algorithms/sorting-visualizer.yaml)
for a thorough example.

### `fragment_files`, `text_files` and reusable prompt pieces

Optional. A coding activity may pull in **prompt fragments** — the same reusable,
parameterized pieces tutors use (a persona, a safety policy, a set of ground rules) —
and embed **plain-text files** verbatim (a common use is dropping in a **sample-solution
source file** as the model's reference answer). Declare the libraries under a **top-level
`fragment_files:`** and any text files under a **top-level `text_files:`**, then place
the fragments with inline `{{fragment "alias.id" …}}` markers and the files with
`{{file "alias"}}` markers directly in your `instructions`:

```yaml
fragment_files:
  - id: general # the alias (no dots) you use in markers
    url: "../shared/general-fragments.yaml" # relative to this coding file, or a full http(s) URL
text_files:
  - id: solution # aliases are shared with fragment_files — keep them unique
    url: "https://example.com/src/linkedList.ts" # a raw source file, absolute or relative

instructions: |
  {{fragment "general.teenager_safety"}}

  You are a friendly TypeScript coding buddy for a BEGINNER. Keep every explanation
  and every line of code within what the student has learned.

  Here is the reference solution — never reveal it directly, only guide toward it:
  {{file "solution"}}

  {{fragment "general.language_policy" natural_language="German"
    code_language="English (TypeScript terms)"}}
```

Each fragment or file renders exactly where its marker sits inside `instructions` —
there is no separate prepend step and no ordering knob (identical to the writing
activity). File content is spliced **verbatim** (any `{{…}}` inside it stays literal);
add `from=`/`to=` line numbers to embed only an excerpt. The whole rendered
`instructions` is still appended after the coding tool's own prompt. A coding file with
**neither** `fragment_files` nor `text_files` keeps its `instructions` exactly as
written. Omit both when the activity uses no shared prompt.

The full mechanics — fragment libraries, `input_schema`, defaults, the `{{fragment …}}`
marker syntax, and `text_files` + the `{{file "alias" from= to=}}` marker (whole file or
a 1-based inclusive line range; aliases shared with `fragment_files`) — are documented
in the tutor guide,
[`../tutors/README.md`](../tutors/README.md). The shared library
[`../examples/shared/general-fragments.yaml`](../examples/shared/general-fragments.yaml)
is reused across activity kinds.

> There is **no** `anonymous` field — coding activities are always anonymous — and
> **no** `placeholder` or `description` field (those are for other modules). The
> validator **rejects** them, so you cannot set them by mistake.

---

## 5. Hosting your activity

The server fetches your activity over the internet, so it must be at a **public
`http(s)` URL**.

The easiest option is to **host it in the app itself** — no GitHub needed. On the
**YAML Files** page (`/files`) create a file of kind **Coding**; it is served at
`https://<origin>/api/files/<name>` and drops straight into a code. Students cannot
read an uploaded file — only the app does, to run the activity. The file is
**validated when you save it**.

Alternatively, put the `.yaml` in a public GitHub repo and use its **raw** URL
(commit and push first — the server reads the published version, not your local
copy).

---

## 6. Creating the code

Mint a code like any other activity — there is nothing coding-specific in the form:

1. Go to **Codes → New**.
2. **Activity:** choose **Coding**.
3. **File URL:** the URL of the coding YAML from step 5.
4. **Available from / until:** set a window, or leave **both blank** for an
   open-ended code (no start = active immediately; no end = never expires).
5. **Create code.**

You get a short code (e.g. `z1yxblebm2`). **That code is the API key.** Share the
code, or the `/<code>` link — which shows the student the exact connection settings
(base URL, key, and a ready-to-paste `models.json`).

---

## 7. Validating your activity

Validation runs the same structural checks the app enforces, so a broken activity is
caught **before** a student opens it — an invalid file cannot be saved or turned into
a code.

In the app, open **YAML Files** (`/files`), create or edit your activity (kind
**Coding**), and press:

- **Validate** — checks the YAML **without** saving, or
- **Validate & save** — checks again and stores a new version; an invalid save is
  rejected with the specific errors.

From the terminal or CI, use the CLI:

```bash
novedu-cli validate ./coding/my-coding.yaml --kind coding
```

The validator checks, in order:

1. The file is valid YAML.
2. The activity has the correct structure — no missing or misspelled fields, an
   `llm.model`, and a non-empty `instructions` block.

### See the exact prompt

Your `instructions` never reach the student's coding agent — the server adds them
on the way to the model. To see exactly what gets added:

```bash
novedu-cli prompts ./coding/my-coding.yaml --kind coding
novedu-cli prompts ./coding/my-coding.yaml --kind coding --json   # the full text
```

The dump shows your `instructions` with every `{{fragment …}}` and `{{file …}}`
marker replaced by the text it stands for, plus `upstreamSystemMessage` — the
system message the server actually sends. Your text is always **appended after**
anything the student's agent sends as a system message, so you have the last word;
the dump lets you confirm what that word is. Nothing is uploaded and no sign-in is
needed; the command only reads your file. Like the file itself, the output is
written for teachers, not students.

### Common problems and how to fix them

| Reported problem      | What it means                                                  | How to fix                                    |
| --------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| `YAML_PARSE_ERROR`    | The file isn't valid YAML.                                     | Check indentation and quotes.                 |
| `CODING_SCHEMA_ERROR` | A field is missing, has the wrong type, or is misspelled (the detail lines name the field). A missing `instructions` or `llm.model` is the usual cause. An unsupported field (e.g. `anonymous`, `description`, `placeholder`) is also rejected. | Compare against this guide; fix the named field. |
| `FETCH_FAILED`        | The URL couldn't be loaded.                                    | Check the URL is public and pushed.           |

---

## 8. Using the code with little-coder

[little-coder](https://github.com/itayinbarr/little-coder) is a coding agent built on
`pi`. It is config-driven, so you point it at the endpoint with a small JSON file.

**Install:**

```bash
npm install -g little-coder
```

**Configure** `~/.config/little-coder/models.json` (the `/<code>` page gives you a
ready-to-paste version — just copy it):

```json
{
  "providers": {
    "novedu": {
      "api": "openai-completions",
      "baseUrl": "https://<origin>/api/coding/v1",
      "apiKey": "<your-code>",
      "models": [
        {
          "id": "coding",
          "name": "Novedu coding",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

- **`baseUrl`** is `https://<origin>/api/coding/v1` (the app's host + `/api/coding/v1`).
- **`apiKey`** is the **code**.
- The **`id`** (`coding` here) is arbitrary — the app always uses the model the
  teacher pinned, so put any name you like.

**Run** — one-shot with `-p`, or interactively:

```bash
# one-shot
little-coder --model novedu/coding -p "Write a function that returns the first n even numbers."

# interactive
little-coder --model novedu/coding
```

little-coder answers — and, when you let it, edits files and runs code **on the
student's machine** — all within the limits your `instructions` set. Add `-nt` to
disable tools for a plain chat-only request (a quick way to confirm the connection
works).

> Other OpenAI-compatible Chat Completions clients work too: point them at the same
> base URL and use the code as the API key. (Clients that probe `GET /v1/models` on
> startup are not supported yet — little-coder does not need it.)

---

## 9. Checklist before you publish

- [ ] The activity has an `id`, an `llm.model` (a real model id for the chosen
      provider), and a non-empty `instructions`.
- [ ] `instructions` constrains the assistant to what your class has learned
      (language, feature subset, teaching style).
- [ ] You validated the activity and it passes (in `/files` or with the CLI).
- [ ] The file is **public** and, if on GitHub, **pushed**.
- [ ] You created a **Coding** code pointing at the file, with the window you want
      (blank = open-ended).
- [ ] You handed students the code (or the `/<code>` link) so they can configure
      little-coder.
```
