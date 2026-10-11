---
title: Building a tutor
description: The fields that make a tutor YAML file, what students see on the empty chat, and when reusable fragments are worth the effort.
sidebar:
  order: 3
audience: teacher
keywords: [tutor, tutor_instructions, instructions, fragments, fragment library, starter questions, exampleQuestions, greeting, tools, random_number, built-in tools, YAML]
related:
  - 00-introduction/03-tutors-overview
  - 20-building-activities/02-available-llms
  - 20-building-activities/07-fragments
  - 20-building-activities/01-handling-yaml
  - 10-yaml-for-teachers/04-cli-validation
---

A tutor is one YAML file. At its core it needs three things: an id, an AI model, and your instructions, the free-text guidance that makes the tutor behave the way you want. Everything else is optional polish. This chapter walks through the fields using the sorting-algorithms sample tutor, a real, validated file you can copy from.

## The required fields

Five fields are required: `id`, `name`, `description`, an `llm` block with a `model`, and `prompt.tutor_instructions`. Here they are with the values from the sample tutor:

```yaml
id: ts-sorting-algorithms
name: "Tutor für Sortieralgorithmen (Bubble & Selection Sort)"
description: |
  Ich helfe dir, Bubble Sort und Selection Sort in TypeScript zu verstehen ...

llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic

prompt:
  tutor_instructions: |
    You are a tutor for 16-year-old students at a vocational college. ...
```

- **`id`** is a short machine name, such as `fractions-de`. Students never see it.
- **`name`** is the human-readable title of the tutor.
- **`description`** appears to students on the empty chat, below the greeting. Write it for them: say what the tutor helps with, in the language your class speaks.
- **`llm.model`** names the AI model. An optional `provider` chooses where it runs, and an optional `reasoning` level says how hard the model thinks before it answers. When you create a code for the tutor you can override all three without touching the file. The chapter on choosing an AI model covers the details.
- **`tutor_instructions`** is where your own guidance goes: free text that tells the tutor how to behave.

## Your instructions

The `tutor_instructions` field is free text in your own words: who the tutor is, what it teaches, how it should respond, and what it must not do. It's the tutor's whole prompt. When you reuse fragments, you place them with markers inside this same text, so your own wording and any shared pieces read in the order you arrange them.

For a one-off tutor, it's fine to put the whole prompt here and skip fragments entirely. The sample tutor uses its instructions for the class-specific parts: what the students already know (basic TypeScript, no classes or arrow functions yet), the learning goals of the unit, and didactic hints such as preferring tiny concrete arrays over abstract talk.

## What students notice on the empty chat

Two optional fields shape the screen students see before their first message:

- **`title`** replaces the default "How can I help you today?" greeting. Leave it out to keep the default.
- **`exampleQuestions`** adds clickable starter questions below the description. Each entry has a short `title` (the clickable label) and the full `question` text. Clicking a label puts the question into the chat input, and students can still edit it before sending.

```yaml
exampleQuestions:
  - title: "Wie funktioniert Bubble Sort?"
    question: "Kannst du mir Schritt für Schritt erklären, wie Bubble Sort ein Array sortiert?"
  - title: "Bubble vs. Selection Sort"
    question: "Was ist der Unterschied zwischen Bubble Sort und Selection Sort? Wann ist welcher besser?"
```

You can define any number of starter questions, but students see at most five. With more than five, a random selection of five appears on each page load, kept in the order you wrote them, so order them deliberately, for example from easy to hard.

## Built-in tools

A tutor can give its AI model access to built-in tools: small helpers that run on the Novedu server while the tutor chats. The model decides when to call a tool, the server runs it, and the model uses the result in its answer. Students only see the finished reply.

You opt in with a top-level `tools:` list. Without it, a tutor has no tools.

```yaml
tools:
  - random_number
```

The complete list of available tools:

| Tool            | What it does                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `random_number` | Returns a random whole number between `min` and `max` (both included), with true server-side randomness. |

Why `random_number` matters: AI models are surprisingly bad at being random. Ask a model to "pick a random number" and it tends to produce the same few values in every session, so your students end up practising with the same exercises. The tool draws a genuinely random number instead, which gives every student varied practice problems.

Two rules to get right:

- **Validation checks the names.** A tool name that Novedu doesn't offer fails validation, so a typo can't slip through quietly.
- **Tell the tutor to use its tools.** Novedu never mentions the tools in the prompt for you. Say it in your `tutor_instructions`, for example: "When the student asks for a practice problem, use the random_number tool to pick the values. Don't invent the numbers yourself."

## Fragments: reusable pieces of prompt

A fragment is a named piece of prompt (a teaching style, a topic list, a safety policy) that lives in a separate fragment library file and can be pulled into many tutors. Write a rule once, reuse it everywhere, and fix it in one place when it needs a change.

Using fragments takes two steps inside `prompt`:

- **`fragment_files`** declares the libraries and gives each a short alias. The `url` is either a full `https://` link or a relative path, which is resolved next to your tutor file's own published location.
- **A marker** in `tutor_instructions` places each fragment where you want it: `{{fragment "alias.id" name="value"}}`. The part in quotes is the library alias and the fragment's id, split at the first dot. A fragment declares which values it needs; required ones must be supplied with the right type, and validation tells you exactly what's missing. An optional value can carry a default set by the library's author: leave the argument out to accept it, or supply your own to override it.

A fragment lands exactly where its marker sits, so your own wording and the shared pieces read in the order you arrange them in `tutor_instructions`. There is no priority number and no separate list to keep in sync.

Two things to know before you rely on a library:

- A fragment library is hosted like the tutor file itself: at a public web address, or as a file hosted in the app. Publishing works the same way for both.
- Validating a tutor also validates every fragment in every library it references, even fragments the tutor doesn't use. A broken template anywhere in the library fails the whole check, which is good news: a shared library that validates once is safe for everyone who uses it.

**When are fragments worth it?** When several activities should share the same wording: a school-wide safety policy, a Socratic teaching style, a language rule. Fragments aren't limited to tutors, either: the same library also works in quizzes, writing activities, coding activities, and cloze exercises, and the chapter on reusable fragments shows how to write a library of your own. For a single tutor with instructions nobody else will reuse, plain `tutor_instructions` is simpler and just as good.

## The sample tutor, walked through

The sorting-algorithms tutor (`activities/examples/sorting-algorithms/sorting-tutor.yaml`) declares one shared library and places four fragments with markers at the top of its instructions, then adds its own text:

```yaml
prompt:
  fragment_files:
    - id: general_fragments
      url: "../shared/general-fragments.yaml"

  tutor_instructions: |
    {{fragment "general_fragments.socratic_tutor"}}

    {{fragment "general_fragments.topic_limits" allowed_topics=(array
      "Bubble Sort: idea, passes, comparisons, swaps"
      "Selection Sort: finding the minimum and swapping it to the front")}}

    {{fragment "general_fragments.language_policy" natural_language="German" code_language="English (TypeScript and p5.js terms)"}}

    {{fragment "general_fragments.teenager_safety"}}

    You are a tutor for 16-year-old students at a vocational college ...
```

Reading it top to bottom:

1. **One library, one alias.** The library sits in a sibling folder, so a relative `url` is enough; `general_fragments` is the alias every marker below refers to.
2. **`socratic_tutor`** needs no values: it's a fixed teaching style (hints and questions instead of ready-made solutions) placed with a bare marker.
3. **`topic_limits`** takes a list of allowed topics, written with `(array …)`, so the same fragment keeps a maths tutor on maths and this one on sorting. The full sample lists seven topics; the excerpt above shows two.
4. **`language_policy`** takes two text values: the tutor speaks German with the students but keeps code and technical terms in English.
5. **`teenager_safety`** is the shared safety net for teenage students, placed with a bare marker.

Below the markers, in the same `tutor_instructions` text, the tutor adds everything specific to this class: the students' prior knowledge, the learning goals, and how to guide them through visualising the algorithms. That split is the pattern to copy: shared behaviour in fragments, your class in the instructions.
