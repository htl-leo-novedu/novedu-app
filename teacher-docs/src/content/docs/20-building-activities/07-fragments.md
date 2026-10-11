---
title: Reusable fragments
description: Write a fragment library once and reuse it across activities, and embed plain-text files such as course material or a sample solution.
sidebar:
  order: 7
audience: teacher
keywords: [fragment, fragment library, fragments, fragment_files, marker, input_schema, default, reuse, prompt, text file, text_files, course material, sample solution, line range]
related:
  - 20-building-activities/03-tutors
  - 20-building-activities/04-quizzes
  - 20-building-activities/05-writing
  - 20-building-activities/06-coding
  - 20-building-activities/09-cloze
  - 20-building-activities/01-handling-yaml
  - 10-yaml-for-teachers/04-cli-validation
---

A fragment is a named piece of prompt (a teaching style, a safety policy, a language rule) that lives in a fragment library, a YAML file of its own. Write the rule once, place it in as many activities as you like, and fix it in one place when it needs a change. The chapter on building a tutor shows how to *use* fragments; this chapter shows how to *write* a library of your own, and how the same library serves every kind of activity. It also covers the simpler sibling of a fragment library: embedding a plain-text file (course material, a sample solution) straight into your instructions with a text-file marker.

## One library, every kind of activity

Fragments aren't a tutor feature. A tutor, a quiz, a writing activity, a coding activity, and a cloze exercise can all draw fragments from the same library, so a school-wide safety policy written once really does cover everything you build. Using fragments takes two steps in the activity file:

1. **List the libraries** you want to draw from under `fragment_files:`, each with a short `id` (an alias) and the library's `url`.
2. **Place each fragment** by writing a marker directly in the activity's own instructions, wherever you want that piece to appear.

Where `fragment_files:` goes depends on the kind. A tutor declares it inside its `prompt:` section. A quiz, a writing or coding activity, and a cloze exercise declare it at the top level of the file, next to `id` and `name`.

The instructions text that holds the markers also depends on the kind: a tutor's `tutor_instructions`, a writing or coding activity's `instructions`, and for a quiz two fields, its top-level `instructions` and its `discussion.instructions`. A quiz's `instructions` field is special: that text applies both to how answers are graded and to the follow-up discussion chat, so a persona or safety rule you place there shapes grading and conversation alike. `discussion.instructions` steers only the discussion chat and takes the same markers; the per-question `evaluation` texts stay plain. A cloze exercise's `instructions` field works the same way for grading and for the feedback students read, while its `evaluation` and `text` stay plain.

## Placing a fragment with a marker

You place a fragment by writing a marker in the instructions text:

```text
{{fragment "general_fragments.socratic_tutor"}}
```

The part in quotes is split at the first dot: `general_fragments` is the alias you gave the library under `fragment_files:`, and `socratic_tutor` is the fragment's `id` inside that library. The fragment's text drops in exactly where the marker sits, so the order of your prompt is simply the order you write the markers. There is no separate list of fragments and no ordering number to manage.

Here is a tutor placing three fragments from the shared example library, with its own wording in between:

```yaml
prompt:
  fragment_files:
    - id: general_fragments
      url: "../shared/general-fragments.yaml"
  tutor_instructions: |
    {{fragment "general_fragments.socratic_tutor"}}

    You are helping students with Bubble Sort and Selection Sort.

    {{fragment "general_fragments.teenager_safety"}}
```

A fragment that expects values takes them as arguments on the marker, right where you place it:

```text
{{fragment "general_fragments.language_policy" natural_language="German" code_language="English"}}
```

You can place the same fragment more than once with different values, and a marker on its own line keeps the prompt readable. This quiz places two fragments in its top-level `instructions`, so both the grading and the discussion chat get the language policy and the safety net:

```yaml
fragment_files:
  - id: general_fragments
    url: "../shared/general-fragments.yaml"

instructions: |
  {{fragment "general_fragments.language_policy" natural_language="German" code_language="English (TypeScript and p5.js terms)"}}

  {{fragment "general_fragments.teenager_safety"}}
```

## What a library file looks like

A fragment library is a YAML file with an `id` and a list of fragments. Here's a small, complete library with two fragments:

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
        greeting:
          type: string
          default: "Hi there!"
    content: |
      {{greeting}}

      You are a friendly, encouraging tutor for {{subject}}.

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

Each fragment carries a few fields:

- **`id`** names the fragment; it must be unique within the library, and it's what a marker refers to.
- **`input_schema`** declares the values the fragment expects. Leave it out for a fragment that takes no values.
- **`content`** is the prompt text itself, written as a template.
- **`version`** is optional. It's a number you raise when you change the fragment meaningfully, for you and your colleagues to track changes; it doesn't change how the fragment behaves today.

A fragment may also carry a `classification` label, for example to mark a safety piece. It's a note for readers of the library; it doesn't change validation or behaviour today.

A larger, real library is `activities/examples/shared/general-fragments.yaml`: a Socratic teaching style, a topic limiter, a language policy, and a safety net for teenage students, reused across the sample activities of every kind.

## Writing the content

The `content` field is a template (the Handlebars format, if you want to look it up). You only need three constructs:

**Insert a value** with `{{name}}`:

```yaml
content: |
  You are a tutor for {{subject}}.
```

**Loop over a list** with `{{#each}}`, using `{{this}}` for the current item:

```yaml
content: |
  Follow these ground rules:
  {{#each rules}}
  - {{this}}
  {{/each}}
```

**Show text only when a flag is off** with `{{#unless}}`:

```yaml
content: |
  {{#unless allow_solution}}
  Do not give away the full solution.
  {{/unless}}
```

Text is inserted exactly as written: characters like `<`, `>`, and `&` survive, so small ASCII diagrams such as `[A] -> [B]` come through unchanged. One rule to respect: every `{{variable}}` the content uses must be declared in the fragment's `input_schema`. A variable the fragment never declares fails validation.

## Declaring values, and defaults

The `input_schema` block declares what a fragment needs, and a marker supplies those values as arguments. Three value types are supported, each with its own way of writing the argument:

| `type` | Meaning | Marker argument |
| --- | --- | --- |
| `string` | A piece of text | `subject="fractions"` |
| `boolean` | `true` or `false` | `allow_solution=false` |
| `array` (of `string`) | A list of text items | `rules=(array "…" "…")` |

A list is written with the `array` helper, one quoted item after another: `topics=(array "Bubble Sort" "Selection Sort")`. These three shapes are the only ones a marker accepts, and the reference in quotes is always required.

Inputs listed under `required` must be supplied by every marker that places the fragment, with the right type; validation names exactly what's missing or mismatched. Supplying a value the fragment doesn't declare isn't an error, but it draws a warning, because it usually means a typo.

An optional input can carry a **`default`**, used whenever a marker leaves the value out. In the `persona` fragment above, a marker that sets no `greeting` gets "Hi there!"; a marker that supplies one gets its own text, because a supplied value always wins. Two details worth knowing:

- A default must match its declared type: a text default on a `boolean` input is rejected.
- A default on a *required* input can never apply, since the value must be supplied anyway. The validator flags that combination with a warning.

Defaults are what make a fragment pleasant to reuse: the common case needs no values at all, and the unusual class overrides just the one value it cares about.

## Embedding a plain-text file

Sometimes you don't need a parameterised fragment, you just want an existing file inside the prompt: the markdown notes for this week's unit, or the sample solution a coding assistant should steer students towards. For that, declare the file under `text_files:` and place it with a `{{file}}` marker:

```yaml
text_files:
  - id: solution
    url: https://raw.githubusercontent.com/rstropek/htl-2025-26-2nd/refs/heads/main/40-classes/LinkedListWithTests/src/linkedList.ts

instructions: |
  Here is the sample solution. Guide students towards it, never paste it back:

  {{file "solution"}}
```

`text_files:` sits in the same place as `fragment_files:` for each kind (inside `prompt:` for a tutor, at the top level for every other kind), and the entries have the same shape: a short `id` alias plus a `url`, absolute or relative to the activity file. The two lists share one set of aliases, so an id you use under `text_files:` must not also name a fragment library.

A few things make text files simpler than fragments:

- The marker is a bare quoted alias, `{{file "solution"}}`, with no dot: a plain file has nothing to select inside it.
- The file is inserted exactly as fetched. It's ordinary text, not a template, so `{{ }}` inside the material stays literal and needs no escaping; only your own surrounding prose follows the `\{{` rule.
- The only arguments are optional line numbers: `{{file "course" from=120 to=180}}` embeds lines 120 to 180 (counting from one, both ends included). Either end works alone: `from=120` means "from line 120 to the end", `to=40` means "the first 40 lines". You can place the same file several times with different ranges, for example the whole file for context and one excerpt to focus on today.

Like a fragment library, a text file is fetched fresh when a student opens the activity, so editing the hosted file updates the prompt without touching the activity. A file that can't be fetched, or is larger than 200 KB, stops the activity from starting rather than running with material missing. The linked-lists coding activity under `activities/examples/linked-lists/` is a complete, validated example of the sample-solution pattern.

## Braces that are not markers

An activity that declares neither `fragment_files:` nor `text_files:` is left exactly as you wrote it, character for character. So a plain activity, or a teaching example whose instructions show `{{ }}` as ordinary text, is safe: nothing tries to read those braces as markers.

Once an activity does declare a fragment library or a text file, its instructions are read as a template. Two things follow:

- If you want a literal `{{` in your own wording (not a marker), write it as `\{{` so it isn't mistaken for one.
- A marker only works when its library is declared. If you write `{{fragment "…"}}` but forget the matching `fragment_files:` entry, validation reports an unknown library and the activity doesn't start. Declare every library you place a marker from.

## Validating a library

You can validate a fragment library on its own, before any activity uses it: on the app's Files page, select **New file**, enter a name, set **Kind** to **Fragment**, paste the library's YAML, and select **Validate**, or run the CLI with `--kind fragment`. The check confirms the file's structure, that fragment ids are unique, and that every fragment's content renders against its own declared inputs, so a typo in a template surfaces before a colleague's activity trips over it.

Validating or sharing an *activity* runs the same thorough check over every fragment in every library the activity references, even fragments it doesn't place. A library that validates once is safe for everyone who builds on it. The activity check also fetches every declared text file and checks each placed line range against the real file, so a `from=` or `to=` past the end of the file fails validation instead of surprising a class later.

One safety property to rely on: fragments never vanish silently. If a library can't be loaded or a fragment fails when a student opens the activity, the activity refuses to start rather than running without the missing rules. A safety policy you placed is either in effect or the activity doesn't run.

## Hosting a library

A fragment library is hosted like any other activity file: at a public web address (for example a raw GitHub URL), or as a file hosted in the app itself on the **Files** page, which is the easiest route when you don't want to touch GitHub. Publishing works the same way for libraries and activities.

An activity references a library by URL, and the URL may be relative: a plain path like `../shared/general-fragments.yaml` resolves next to the activity file's own published location. Keep a library next to the activities that use it and the references stay short. When the files live on GitHub, remember to commit and push the library before validating; the server reads the published version, not your local copy.
