# Cloze Exercise Files ("Fill the gaps")

This guide explains **cloze exercise definitions** — the YAML files that describe a
**gap text**: you write one complete text and mark the words students must fill in.
After submitting the whole exercise, a student gets a verdict per gap (correct,
partly correct, wrong) and feedback that connects their mistakes. This folder holds
the guide and the JSON schema; a complete sample lives in
[`../examples/future-forms/`](../examples/future-forms/).

---

## 1. Quick start — a complete example

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/cloze/cloze-yaml.schema.json
id: future-forms-sue
name: "Cloze: Future forms"
title: "Sue's fresh start"
description: |
  Complete the text with suitable **future forms**. Use the verb in brackets
  where one is given.
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
evaluation: |
  Goal: the future form that matches the speaker's intention.
  Correct: the intended form; contractions count.
  Partly correct: the right construction with a wrong verb ending.
  Wrong: a different future form, or a form that changes the meaning.
text: |
  ## A plan for next week

  Sue has already decided on her new fitness routine. She [[is going to]] start
  it next week. The beginners' class [[starts|start]] at nine on Sunday.
```

Validate it before you upload it:

```bash
npx @novedu/cli validate ./my-cloze.yaml --kind cloze
```

A valid file prints its **gap inventory** — every gap's number, answer and hint — so
you can check at a glance that the gaps are the ones you meant. The `/files` editor
shows the same inventory after **Validate**.

---

## 2. The fields

| Field | Required | What it does |
| --- | --- | --- |
| `id` | yes | A short machine-readable id, e.g. `future-forms-sue`. |
| `name` | no | Your own label in the teacher lists. |
| `title` | no | The heading students see. |
| `description` | no | The task in a box above the text (Markdown). |
| `llm` | yes | `model` (required), `provider` (`SCCH` when omitted, `Azure Foundry` or `OpenRouter`) and an optional `reasoning` level — see [`../README.md`](../README.md). |
| `instructions` | no | A preamble for grading and feedback alike, e.g. a language policy. May place shared fragments (`fragment_files`, `text_files`) — see [`../tutors/README.md`](../tutors/README.md). |
| `evaluation` | yes | **Never shown to students.** The goal of the exercise and how far an answer may deviate from your reference answer and still count as correct or partly correct. It applies to every gap — there are no per-gap rules. |
| `text` | yes | The complete text (Markdown) with the gaps marked. |

There is no `anonymous` field: a cloze exercise is **always anonymous** — no
submission is linked to a student.

---

## 3. Marking gaps

Write the **whole** text and put each gap around its **reference answer** — the answer
you would give. Students never see it; they see a numbered empty field.

| You write | Students see |
| --- | --- |
| `She [[is going to]] start.` | She ¹▢ start. |
| `The class [[starts\|start]] at nine.` | The class ²▢ (start) at nine. |
| `Yes[[]] she said.` | Yes³▢ she said. — the correct answer is to leave it empty (e.g. no comma) |
| `\[[` or `\]]` | a literal `[[` or `]]` |

- Gaps are numbered **in reading order**, 1, 2, 3, …
- The part after `|` is a **hint** shown after the gap (e.g. the verb to use). One `|`
  per gap at most, and the hint may not be empty.
- A gap opens and closes **on the same line**.
- At most **40 gaps** per exercise, each answer at most **200 characters**.
- Gaps belong in **paragraphs, list items, quotes and table cells**. They are not
  allowed in headings, code, math formulas, links or images.

The validator names every problem with its **line and column inside `text`**, e.g.
`Text line 3, column 12: gap 2 is in a heading`.

The reference answer is one good answer, not the only one: `evaluation` decides which
other answers count (contractions, synonyms, equivalent forms).

---

## 4. See the exact prompt

A cloze exercise sends two prompts to the AI: one grades the gaps, the other writes the
feedback the student reads. Both contain your whole text with every reference answer,
`evaluation`, and the rendered `instructions`. Print them offline, no sign-in needed:

```bash
npx @novedu/cli prompts ./my-cloze.yaml --kind cloze          # summary
npx @novedu/cli prompts ./my-cloze.yaml --kind cloze --json   # full text + output schemas
```

---

## 5. After you share it

- Every page load and every submission re-reads the file, so a fix to `description`,
  `evaluation` or `instructions` applies at once.
- The results page counts verdicts per gap, keyed by the gap's number and reference
  answer: change a reference, or add or remove a gap before others, and those gaps'
  statistics start from zero. Settle the gaps before you hand out a code.
- Only a student's **first** submission is counted. **Try again** starts a practice
  round, which is never counted and can never be saved as a result.
