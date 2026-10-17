# Writing Tutor Files

This guide explains **tutor definitions** and **fragment libraries** — the YAML
files that describe how an AI tutor should behave — so that teachers can write
their own tutors without touching any code. This folder holds the guide and the
JSON schema; complete sample files live in [`../examples/`](../examples/).

You do not need to be a programmer. If you can edit a structured text file and
follow the examples below, you can build a tutor.

---

## 1. The idea in one minute

An AI tutor is driven by a **system prompt** — a block of instructions that tells
the model who it is, what subject it teaches, how to behave, and what it must not
do.

Instead of writing one long prompt by hand, you assemble it from small, reusable
**fragments**. Each fragment is a self-contained piece of guidance (a persona, a
set of rules, a safety policy, a topic description …). You write your tutor's
instructions as normal and drop a short **marker** wherever you want a fragment to
appear, filling in that fragment's blanks right there. The system renders the
markers in place to build the final prompt.

```
fragment library (reusable pieces)        tutor file (your text + markers)
┌───────────────────────────┐             ┌───────────────────────────────────────┐
│ persona                   │  ◀────────  │ {{fragment "lib.persona"              │
│ ground_rules              │             │            subject="arithmetic"}}     │
│ safety                    │  ◀────────  │ …your own instructions…               │
│ …                         │             │ {{fragment "lib.ground_rules" …}}     │
└───────────────────────────┘             └───────────────────────────────────────┘
                       │                                 │
                       └──────────────┬──────────────────┘
                                      ▼
              tutor_instructions rendered as one template → system prompt
```

This means policies like a Socratic teaching style or a child-safety rule are
written **once** in a fragment library and reused by many tutors.

---

## 2. The two kinds of files

| File                 | What it is                                                         | Who writes it                        |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| **Fragment library** | A collection of reusable prompt pieces (fragments).                | Usually shared/maintained centrally. |
| **Tutor file**       | Writes the instructions and drops in fragment markers with their values. | You, per subject.              |

Both are plain YAML. A fragment library is referenced by a tutor file through a
public URL (see [Hosting](#9-hosting-your-files)).

---

## 3. Quick start — a complete minimal example

A tiny fragment library, `simple-fragments.yaml`:

```yaml
id: simple-fragments
fragments:
  - id: persona
    input_schema:
      type: object
      required:
        - subject
      properties:
        subject:
          type: string
        greeting: # optional — a default is used when the marker omits it
          type: string
          default: "Hi there!"
    content: |
      {{greeting}}

      You are a friendly, encouraging tutor for {{subject}}.

      Explain ideas simply and check the student's understanding with short questions.

  - id: ground_rules
    input_schema:
      type: object
      required:
        - rules
      properties:
        rules:
          type: array
          items:
            type: string
    content: |
      Follow these ground rules:
      {{#each rules}}
      - {{this}}
      {{/each}}
```

A tutor file, `simple-tutor.yaml`, that uses it — the fragments are placed by
**markers** inside `tutor_instructions`:

```yaml
id: simple-math-tutor
name: "Simple Math Tutor"
description: "A minimal, valid example tutor."
llm:
  model: openai/gpt-6-luna
  provider: OpenRouter
  reasoning: medium
prompt:
  fragment_files:
    - id: simple # the alias (no dots) you use in markers
      url: "simple-fragments.yaml" # relative — sits next to this tutor file

  tutor_instructions: |
    {{fragment "simple.persona" subject="basic arithmetic"}}

    {{fragment "simple.ground_rules" rules=(array
      "Never give the final answer immediately."
      "Encourage the student to try each step themselves."
      "Keep explanations short and friendly.")}}

    Always stay positive and patient. If the student is stuck, give a small hint
    rather than the full solution.
```

Each `{{fragment "simple.persona" …}}` marker names the library **alias** and the
fragment **id** joined by a dot (`simple.persona`), and supplies that fragment's
values as arguments right there. `greeting` is left out on purpose, so its default
(`"Hi there!"`) is used.

The assembled system prompt becomes:

```text
Hi there!

You are a friendly, encouraging tutor for basic arithmetic.

Explain ideas simply and check the student's understanding with short questions.

Follow these ground rules:
- Never give the final answer immediately.
- Encourage the student to try each step themselves.
- Keep explanations short and friendly.

Always stay positive and patient. If the student is stuck, give a small hint
rather than the full solution.
```

Complete, working tutors built exactly this way live in
[`../examples/`](../examples/) — for instance
[`../examples/sorting-algorithms/sorting-tutor.yaml`](../examples/sorting-algorithms/sorting-tutor.yaml),
which pulls its fragments from the shared library
[`../examples/shared/general-fragments.yaml`](../examples/shared/general-fragments.yaml).

---

## 4. Editor support

This folder includes a JSON Schema for tutor YAML files: `tutor-yaml.schema.json`.
It is **generated from the zod schema** in `lib/tutors/schemas.ts` via
`npm run generate:schemas` — do not edit it by hand.

Editors that use the YAML Language Server, including VS Code with YAML support,
can pick up the schema from a modeline comment at the top of a YAML file:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/tutors/tutor-yaml.schema.json
```

Fragment-**library** files use a **separate** schema — see
[`../fragments/README.md`](../fragments/README.md). The sample files in
[`../examples/`](../examples/) use the **full raw GitHub URL** so that validation,
completion, and hover help work in your editor **whether or not** the schema file
happens to sit next to the YAML you are editing. (If your file _is_ next to the
schema, the relative path `./tutor-yaml.schema.json` works too.)

In VS Code, install the Red Hat YAML extension to get this schema support:
<https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml>.

The line is a comment, not a YAML field. The tutor app ignores it, but the editor
can use it for validation, completion, and hover help.

---

## 5. Tutor file reference

A tutor file has these fields. All of them are required unless marked optional.

```yaml
id: my-tutor # short machine name, e.g. "fractions-de"
name: "My Tutor" # human-readable title
title: "Welcome!" # optional: greeting students see on the empty chat
description: "What this tutor does." # shown to students below the greeting
exampleQuestions: # optional: clickable starter questions on the empty chat
  - title: "Short label"
    question: "The full question text."
anonymous: false # optional: omit for default true; false records which student each chat belongs to
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic # which model serves this tutor
  provider: SCCH # optional: omit for default SCCH; "Azure Foundry" (a deployment name) or "OpenRouter"
  imageInput: false # optional: omit for default true; set false to disable image uploads
tools: # optional: omit for default [] (no tools); built-in tools the model may call
  - random_number
prompt:
  fragment_files: [...] # optional: the libraries you pull fragments from
  text_files: [...] # optional: plain-text files you embed with {{file ...}}
  tutor_instructions: | # your instructions, with inline {{fragment ...}} / {{file ...}} markers
    ...
```

### `title` and `description`

Students see both on the empty chat, before the first message: `title` replaces
the default "How can I help you today?" greeting (omit it to keep the default),
and `description` appears below it in smaller text. Write the `description` for
your students — tell them what the tutor helps with.

### `exampleQuestions`

Optional. A list of starter questions shown below the `description` on the empty
chat. Each entry has a short `title` (the clickable label) and the full
`question` text. Hovering a title shows the question as a tooltip; clicking it
puts the question into the chat input — students can still edit it before
sending.

You may define any number of questions, but students see **at most 5**: with
more than 5, a random selection of 5 is shown on each page load (in the order
you defined them — so order them deliberately, e.g. easy to hard).

```yaml
exampleQuestions:
  - title: "Was ist eine verkettete Liste?"
    question: "Kannst du mir erklären, was eine verkettete Liste ist und wie sie sich von einem Array unterscheidet?"
  - title: "Knoten löschen"
    question: "Wie entferne ich einen bestimmten Knoten aus einer einfach verketteten Liste?"
```

### `anonymous`

Optional, default `true`. By default chats are **anonymous**: the app stores no
link between the signed-in student and their chat, so chat transcripts cannot be
attributed to a person. Set `anonymous: false` to record which student each chat
belongs to (e.g. for graded assignments). Tell your students when a tutor
records attribution.

```yaml
anonymous: false
```

### `llm.provider`

Optional, one of `SCCH` (the default — the school's Austrian LLM hosting
partner), `Azure Foundry` or `OpenRouter`. With `provider: Azure Foundry` the
tutor is served from an Azure OpenAI deployment and `llm.model` is the
**deployment name** (e.g. `gpt-5.4-mini`) rather than an SCCH model id; with
`provider: OpenRouter` it is served through OpenRouter and `llm.model` is its
namespaced routing key (e.g. `openai/gpt-6-luna`). Both are only usable if the
server is configured for them — otherwise the activity is rejected with a
readable reason.
A server may also accept only some OpenRouter models: any other one fails when a
student uses the activity, just like a wrong model name.

The `llm:` values are the **default**: when a teacher mints a code for this
activity, the code's create/edit form can **override the whole `llm:` block per
code** (provider + model always together, plus an optional reasoning level) — the
YAML file itself stays unchanged.

```yaml
llm:
  model: openai/gpt-6-luna
  provider: OpenRouter
```

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

```yaml
llm:
  model: openai/gpt-6-luna
  provider: OpenRouter
  reasoning: medium
```

### `tools`

Optional, default `[]` (no tools). A list of **built-in tools** the tutor's
model may call while chatting. Tools run on the Novedu server; the model decides
when to call one, receives the result, and continues its answer. An unknown tool
name fails validation, so typos cannot slip through.

Available tools (this list is exhaustive):

| Tool            | What it does                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `random_number` | Returns a uniformly random integer between `min` and `max` (both inclusive), using true server-side randomness. |

Use `random_number` when the tutor generates practice problems: language models
are poor at inventing random values on their own — they repeat the same "random"
numbers across sessions, so students end up with the same exercises.

The platform never tells the model about its tools in the system prompt —
**mention enabled tools in your `tutor_instructions`** so the model actually
uses them:

```yaml
tools:
  - random_number

prompt:
  tutor_instructions: |
    ...
    When the student asks for a practice problem, use the random_number tool
    to pick the values — do not invent the numbers yourself.
```

`novedu-cli prompts` lists a tutor's enabled tools alongside its assembled
system prompt.

### `prompt.fragment_files`

Optional. Declares which fragment libraries this tutor uses and gives each one a
short local **alias** you refer to later.

Omit this field when the tutor does not use fragments and all instructions live
directly in `prompt.tutor_instructions`.

```yaml
fragment_files:
  - id: simple # the alias (you choose this)
    url: "simple-fragments.yaml" # the library file (relative to this tutor)
```

- `id` — the alias your markers use (`{{fragment "simple.<id>" …}}`). Pick
  something readable. An alias **must not contain a dot** — the marker splits the
  reference at the first dot, so the alias is everything before it and the fragment
  id everything after.
- `url` — where the library file lives. Two forms are allowed:
  - **Absolute** — a full `http(s)://…` link (e.g. a "raw" GitHub URL). Use this
    when the library lives somewhere else than your tutor file.
  - **Relative** — just a path, like `simple-fragments.yaml` or
    `../shared/general-fragments.yaml`. It is resolved **next to your tutor file**:
    the system takes your tutor's own URL, drops its filename, and appends the path.
    So if your tutor is published at
    `https://.../activities/tutors/my-tutor.yaml`, then `simple-fragments.yaml` is loaded from
    `https://.../activities/tutors/simple-fragments.yaml`. This is the easiest option when the
    tutor and its libraries sit in the same folder (as the examples here do).

  Either way the file must be reachable by the server (see
  [Hosting](#9-hosting-your-files)). Only `http(s)` is allowed — an absolute URL
  with any other scheme (e.g. `ftp:`) is rejected.

### `prompt.text_files`

Optional. Declares **plain-text files** — markdown course material, a sample-solution
source file, anything — that you want to drop into your instructions **verbatim**.
Unlike a fragment library there is no schema and nothing to select inside: the whole
file (or a line range) is spliced in exactly as fetched, and any `{{…}}` inside it stays
literal (it is **never** treated as a template).

```yaml
text_files:
  - id: course # the alias (you choose this)
    url: "https://example.com/material/loops.md" # the file (absolute or relative)
```

- `id` — the alias your `{{file "course"}}` markers use. Like a fragment alias it **must
  not contain a dot**. Aliases are **shared** with `fragment_files`: an `id` may not be
  used by both a library and a text file.
- `url` — same two forms as `fragment_files` (absolute `http(s)://…`, or a relative path
  resolved next to your tutor file). Each file is capped at **200 KB**.

### Embedding a text file with `{{file}}`

Write a `{{file "alias"}}` marker at the exact spot where the file's content should
appear. To embed only part of a file, add 1-based, **inclusive** line numbers:

```yaml
text_files:
  - id: solution
    url: "https://example.com/src/linkedList.ts"
tutor_instructions: |
  Here is the full reference solution:
  {{file "solution"}}

  Focus today on the delete method only:
  {{file "solution" from=42 to=68}}
```

- `{{file "alias"}}` — the whole file, byte-for-byte (trailing newline and all).
- `from=` / `to=` — optional line numbers. `from=42 to=68` keeps lines 42–68 inclusive;
  `from=42` alone means "line 42 to the end"; `to=68` alone means "line 1 to 68". They
  must be whole numbers ≥ 1 and `from` may not be greater than `to`.
- You may place the **same file more than once** with different ranges.
- **Line numbers vs. the live file:** at validation time a `from` or `to` past the end of
  the file is an error. If the source file is later shortened, a too-large `to` is quietly
  clamped to the last line at runtime, but a `from` past the end still fails (an empty
  splice would silently drop material — fix the range or re-check the file).

### Placing fragments with markers

You do not list fragments in a separate field. Instead you write a **marker**
directly in `tutor_instructions` at the exact spot where the fragment's text
should appear:

```
{{fragment "<alias>.<fragment-id>" key="text" flag=true items=(array "a" "b")}}
```

- **`"<alias>.<fragment-id>"`** — a **quoted** reference: the library alias (from
  `fragment_files`), a dot, then the fragment's `id` inside that library. It is
  split at the **first** dot, so the alias can't contain a dot but a fragment id
  may. The reference must be a plain quoted string (`FRAGMENT_REF_NOT_LITERAL` if
  you leave it out or write it unquoted).
- **The rest are the fragment's values** — one argument per input:
  - a single line of text as `key="text"`,
  - a `true`/`false` flag as `flag=true`,
  - a list of text items as `items=(array "first" "second")`.
- Any input you omit falls back to its `default` from the fragment's
  `input_schema` (see [Inputs and variables](#7-inputs-and-variables)).

You may place the **same fragment more than once** with different arguments — each
marker is independent. Put a marker on its own line; the blank lines around it are
kept as written.

```yaml
tutor_instructions: |
  {{fragment "simple.persona" subject="basic arithmetic"}}

  Always stay positive and patient.

  {{fragment "simple.ground_rules" rules=(array
    "Never give the final answer immediately."
    "Keep explanations short and friendly.")}}
```

If you need the literal characters `{{` in your text (not a marker), escape them as
`\{{`.

### `prompt.tutor_instructions`

Your instructions in your own words, **with the `{{fragment …}}` markers placed
wherever you want each fragment**. There is no separate list and no ordering knob:
a fragment appears exactly where its marker sits, in reading order.

For a one-off tutor that uses no fragments and no text files, just write plain
instructions and omit both `fragment_files` and `text_files` — a tutor with **neither**
is never treated as a template, so any `{{…}}` in it is kept verbatim (handy when your
instructions mention Handlebars as example text).

---

## 6. Fragment library reference

A fragment library has an `id` and a list of `fragments`:

```yaml
id: simple-fragments
fragments:
  - id: persona # unique within this library
    version: 1 # optional: a number you bump when you change it
    input_schema: { ... } # optional: the inputs this fragment expects
    classification: { ... } # optional: metadata, e.g. for safety pieces
    content: | # the prompt text (a Handlebars template)
      ...
```

Field by field:

- `id` — unique name within the library; this is what a marker refers to.
- `version` — _(optional)_ a number; increase it when you change the fragment
  meaningfully. It is accepted but not used by anything today.
- `input_schema` — _(optional)_ declares the variables the fragment needs. Omit
  it for fragments that take no inputs.
- `classification` — _(optional)_ metadata. For example a safety fragment may use
  `type: safety` with `override_allowed: false`.
- `content` — the actual text, written as a [Handlebars template](#writing-content).

---

## 7. Inputs and variables

A fragment declares what it needs with `input_schema`, and a **marker** supplies
those values as arguments. They must agree.

### Declaring inputs (`input_schema`)

```yaml
input_schema:
  type: object
  required:
    - subject # these inputs MUST be supplied
    - rules
  properties:
    subject:
      type: string # a single line of text
    rules:
      type: array # a list…
      items:
        type: string # …of text items
```

The supported value types, and how you pass each as a marker argument:

| `type`                | Meaning              | Marker argument             |
| --------------------- | -------------------- | --------------------------- |
| `string`              | A piece of text      | `subject="fractions"`       |
| `boolean`             | `true` or `false`    | `allow_solution=false`      |
| `array` (of `string`) | A list of text items | `rules=(array "…" "…")`     |

### Optional inputs with a `default`

An input that is **not** in `required` is optional. If its `content` references it, a
marker must still supply it — unless the property declares a `default`, which is used
whenever the marker omits the value:

```yaml
input_schema:
  type: object
  required:
    - subject # must be supplied
  properties:
    subject:
      type: string
    greeting:
      type: string
      default: "Hello!" # optional — used when the tutor doesn't set `greeting`
    allow_solution:
      type: boolean
      default: false # lets `{{#unless allow_solution}}` work without supplying it
```

- A `default` must match its property's `type` (a text default on a `boolean` property
  is rejected).
- A value supplied on the marker always wins over the default.
- Putting a `default` on a `required` input is pointless — the value must be supplied
  anyway, so the default can never apply. The validator flags this with a warning.

### Supplying values (marker arguments)

You pass values as arguments on the marker, right where you place the fragment:

```yaml
tutor_instructions: |
  {{fragment "simple.persona" subject="basic arithmetic"}}

  {{fragment "simple.ground_rules" rules=(array
    "Never give the final answer immediately."
    "Keep explanations short and friendly.")}}
```

The **effective** values for a placement are the fragment's `input_schema` defaults
overridden by that marker's arguments. Rules the validator enforces **per marker**:

- Every input listed under `required` must be supplied by the marker (or have a
  `default`).
- Each argument's type must match what `input_schema` declares.
- Supplying an argument the fragment doesn't declare is allowed but produces a
  **warning** (it usually means a typo).

---

## Writing content

A fragment's `content` is a [Handlebars](https://handlebarsjs.com/) template. You
only need three constructs:

**1. Insert a value** with `{{name}}`:

```yaml
content: |
  You are a tutor for {{subject}}.
```

**2. Loop over a list** with `{{#each}}` … `{{/each}}`, using `{{this}}` for the
current item:

```yaml
content: |
  Follow these ground rules:
  {{#each rules}}
  - {{this}}
  {{/each}}
```

**3. Show text only when a flag is off** with `{{#unless}}`:

```yaml
content: |
  {{#unless allow_solution}}
  Do not give away the full solution.
  {{/unless}}
```

Notes:

- Text is inserted **verbatim** — special characters like `<`, `>` and `&` are
  preserved, so ASCII diagrams (e.g. `[A] -> [B]`) survive unchanged.
- If a template uses `{{something}}` that you never declared or supplied, the
  build fails — declare every variable you reference.

---

## 8. How the prompt is assembled

1. If the tutor declares **neither** `fragment_files` nor `text_files`,
   `tutor_instructions` is used **exactly as written** — no template processing at all —
   and that is the whole system prompt.
2. Otherwise `tutor_instructions` is treated as a template: each `{{fragment …}}`
   marker is replaced, **in place**, by that fragment's `content` rendered with the
   placement's effective values (the fragment's defaults overridden by the marker's
   arguments); each `{{file …}}` marker is replaced, **in place**, by the fetched file's
   content (whole, or the requested line range) spliced in **verbatim** — never rendered
   as a template, so any `{{…}}` inside the file stays literal.
3. Everything else — your own text and the blank lines around the markers — is kept
   as written. The result is the final system prompt.

There is **no ordering knob** and no priority: a fragment appears exactly where you
place its marker, in reading order. Place the same fragment twice and it renders
twice.

---

## 9. Hosting your files

The server fetches your files over the internet, so they must be at a **public
`http(s)` URL**.

The easiest option is GitHub:

1. Put your `.yaml` files in a public repository.
2. Use the **raw** URL of each file, for example:
   `https://raw.githubusercontent.com/<org>/<repo>/refs/heads/main/activities/tutors/your-fragments.yaml`
3. If your tutor uses fragment libraries, reference each library from your tutor's
   `fragment_files[].url`. If the library sits **in the same folder** as the tutor
   file (as the examples in this repo do), you can use just the filename — e.g.
   `your-fragments.yaml` — and it is resolved next to the tutor's own URL. Use a
   full raw URL when the library lives somewhere else.

Remember to **commit and push** changes before validating — the server reads the
published version, not your local copy. (A relative reference is resolved against the
tutor's published URL, so the library must be pushed too.)

Alternatively, **host your files in the app itself** — no GitHub or external storage
needed. On the **YAML Files** page (`/files`) a teacher can create, edit and version a
tutor or fragment file; each is served at `https://<origin>/api/files/<name>`, a URL
that drops straight into a tutor code and that students cannot read. The file is validated when you save it, sibling
hosted files can be referenced by relative name (`./<other-name>`), and editing always
serves the latest version. This is the easiest option when the app is deployed for you.

---

## 10. Validating your tutor

Open the **Validate** page in the app, leave the selector on **Tutor**, paste your
tutor file's public URL, and click **Validate**. You'll get either:

- the **assembled system prompt** (as markdown source), or
- a **list of problems** to fix.

The validator checks, in order:

1. The file is valid YAML.
2. The tutor file has the correct structure (no missing or misspelled fields).
3. Every referenced fragment library loads and has the correct structure.
4. Every `{{fragment …}}` marker parses, resolves to a real fragment, and supplies
   every required input with the right type. Every `{{file …}}` marker resolves to a
   declared `text_files` alias, and its `from`/`to` line range fits the file.
5. **Every fragment in every referenced library renders** — its `content` template
   is checked against its own declared inputs, even fragments this tutor doesn't
   use. A template bug anywhere in a library you reference fails validation.
6. The prompt assembles cleanly.

> The same thorough validation runs when you **share a tutor code** — a broken
> tutor (or a broken fragment in a library it references) is caught at create time,
> not when the first student opens the code. Opening a chat does **not** re-run the
> whole-library check.

### Validating a fragment library on its own

If you maintain a fragment library, validate it directly: switch the selector to
**Fragment library** and paste the library's URL (or, in the CLI,
`novedu-cli validate <file> --kind fragment`). This checks the file's structure,
that fragment ids are unique, and that **every** fragment's template renders
against its own `input_schema` — so undeclared-variable typos and Handlebars
syntax errors surface before any tutor references the library.

### See the exact prompt

The assembled prompt is also available straight from the terminal, and it is
worth a look whenever your tutor behaves oddly:

```bash
novedu-cli prompts ./tutors/my-tutor.yaml
novedu-cli prompts ./tutors/my-tutor.yaml --json    # the full text
```

You see the **complete system prompt your tutor sends to the model**: your
`tutor_instructions` with every `{{fragment …}}` and `{{file …}}` marker replaced
by the text it stands for. That is exactly what the tutor is told before it reads
a single student message — so when a rule seems to be ignored, check here first
whether it really made it into the prompt.

Nothing is uploaded and no sign-in is needed; the command only reads your file.

### Common problems and how to fix them

| Reported problem                                    | What it means                                                  | How to fix                                       |
| --------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `YAML_PARSE_ERROR`                                  | The file isn't valid YAML.                                     | Check indentation and quotes.                    |
| `TUTOR_SCHEMA_ERROR` / `FRAGMENT_FILE_SCHEMA_ERROR` | A field is missing, has the wrong type, or is misspelled.      | Compare against this guide; fix the named field. |
| `FETCH_FAILED`                                      | A URL couldn't be loaded.                                      | Check the URL is public and pushed.              |
| `HOST_TEMPLATE_PARSE_ERROR`                         | A marker is malformed, or a literal `{{` was not escaped as `\{{`. | Fix the marker (the message gives a line:column), or escape the stray `{{`. |
| `FRAGMENT_REF_NOT_LITERAL`                          | A `{{fragment}}` has no reference, or the reference isn't a quoted string. | Write it as `{{fragment "alias.id" …}}`.         |
| `UNKNOWN_FRAGMENT_FILE_ALIAS`                       | A marker's alias (before the dot) doesn't match any `fragment_files` alias. | Use the exact alias you declared.                |
| `FRAGMENT_NOT_FOUND`                                | The fragment id (after the dot) isn't in that library.         | Check the fragment's spelling/existence.         |
| `MISSING_REQUIRED_VARIABLE`                         | A required input wasn't supplied by the marker.                | Add it as a marker argument.                     |
| `VARIABLE_TYPE_MISMATCH`                            | An argument's type is wrong (e.g. text where a list is expected). | Provide the declared type.                       |
| `FRAGMENT_TEMPLATE_ERROR`                           | A fragment's `content` uses a `{{variable}}` it never declares, or has a Handlebars syntax error. | Declare the variable in `input_schema`, fix the typo, or correct the template. |
| `UNUSED_FRAGMENT_FILE` _(warning)_                  | A declared library isn't used by any marker.                   | Remove the unused `fragment_files` entry, or add a marker that uses it. |
| `TEXT_FILE_MARKER_INVALID`                          | A `{{file}}` marker is malformed: unquoted alias, an argument other than `from`/`to`, a non-integer or `<1` line number, or `from > to`. | Write it as `{{file "alias"}}` (optionally `from=`/`to=` whole numbers ≥ 1). |
| `UNKNOWN_TEXT_FILE_ALIAS`                           | A `{{file}}` alias doesn't match any `text_files` alias.       | Use the exact alias you declared.                |
| `DUPLICATE_TEXT_FILE_ALIAS`                         | An alias is declared twice — or the same alias is used by both a `text_files` entry and a `fragment_files` entry. | Give each library and text file a unique alias. |
| `TEXT_FILE_RANGE_OUT_OF_BOUNDS`                     | A `{{file}}` `from`/`to` line number is past the end of the file. | Fix the range (or re-check the file — it may have been shortened). |
| `TEXT_FILE_TOO_LARGE`                               | A fetched text file is over the 200 KB limit.                  | Trim the file or embed a smaller excerpt.        |
| `UNUSED_TEXT_FILE` _(warning)_                      | A declared text file isn't embedded by any marker.             | Remove the unused `text_files` entry, or add a `{{file}}` marker that uses it. |
| `UNDECLARED_VARIABLE` _(warning)_                   | A marker passes an argument the fragment doesn't use.          | Usually a typo — remove or correct it.           |
| `REQUIRED_PROPERTY_HAS_DEFAULT` _(warning)_         | A `required` input also declares a `default` it can never use. | Drop the `default`, or remove it from `required`. |

---

## 11. Checklist before you publish

- [ ] Each fragment has a **unique** `id` within its library.
- [ ] Every `fragment_files` / `text_files` alias is **dot-free**, **unique across both
      lists**, and used by at least one marker.
- [ ] Every `{{fragment "alias.id" …}}` marker is well-formed and supplies each
      `required` input with the **correct type**.
- [ ] Every `{{file "alias"}}` marker names a declared text file and any `from`/`to`
      range fits the file.
- [ ] Every `{{variable}}` used in a fragment's `content` is declared and either
      supplied or has a `default`.
- [ ] Any literal `{{` in your instructions is escaped as `\{{`.
- [ ] All `url`s are **public** and **pushed** (relative refs resolve against the tutor's URL).
- [ ] You validated the tutor and the prompt looks right.
