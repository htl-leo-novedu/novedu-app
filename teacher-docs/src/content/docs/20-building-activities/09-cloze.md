---
title: Building a cloze exercise
description: Write a gap text with reference answers and grading criteria, see what students get back, read the results per gap, and test the grading with an eval.
sidebar:
  order: 9
audience: teacher
keywords: [cloze, fill the gaps, gap text, gap-fill, gaps, reference answer, evaluation, hint, try again, practice round, possible answer, feedback patterns, results per gap, first submissions, saved results, eval, expect_patterns]
related:
  - 20-building-activities/01-handling-yaml
  - 20-building-activities/02-available-llms
  - 20-building-activities/07-fragments
  - 10-yaml-for-teachers/04-cli-validation
  - 10-yaml-for-teachers/06-testing-the-grader
  - 30-sharing-activities/04-anonymous-vs-per-user
---

A cloze exercise is a **gap text**: you write one complete text, mark the words students should fill in, and students complete every gap. When they submit the whole exercise, each gap gets a verdict (**correct**, **partly correct**, or **wrong**), and the AI writes feedback that connects related mistakes, for example "In three places you used *will* for a plan that was already decided".

Students see the heading **Fill the gaps** in the app. A cloze exercise suits any task where students should produce a form in context: tenses in a story, missing commas in a passage, the technical terms in a biology explanation, or the steps of a curve analysis.

## The idea: one text, your answers inside it

You write the text exactly as it should read when every gap is filled in correctly, then put double square brackets around each part students must supply. The words inside the brackets are your **reference answer** for that gap. Students never see your reference answers while they work; they see a numbered empty field.

Your reference answer is one good answer, not the only one. A separate field, `evaluation`, tells the AI how far an answer may differ from yours and still count as correct or partly correct. That keeps the grading consistent: the AI compares every student's answer with the same reference, instead of solving the exercise anew each time.

## A complete example

This example comes from the sample exercise `activities/examples/future-forms/sue-fresh-start.yaml`, an English exercise on future forms (shortened here):

```yaml
id: future-forms-sue
name: "Cloze: Future forms — Sue's fresh start"

title: "Sue's fresh start"
description: |
  Complete the text with suitable **future forms**. Use the verb in brackets
  where one is given. Contractions are welcome.

llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic

evaluation: |
  Goal: the student chooses the future form that matches the speaker's intention
  in context:
  - a plan decided before the moment of speaking → be going to
  - a timetable or schedule → present simple
  - a fixed arrangement with another person → present continuous
  ...
  Correct: the intended form. Contractions ("'ll", "'m going to") and equivalent
  forms that keep the meaning count as correct.
  Partly correct: the intended construction with a wrong verb ending or a missing
  auxiliary (e.g. "am meet", "will have complete").
  Wrong: a different future form, or a form that changes the meaning.

text: |
  ## A plan for next week

  Sue has already decided on her new fitness routine. She [[is going to]] start it
  next week. ...

  It is Saturday, and her first workout is tomorrow. According to the published
  timetable, the beginners' class [[starts|start]] at nine on Sunday. Her coach has
  confirmed an appointment in his calendar. "I [[am meeting|meet]] him at reception
  at 8:45," Sue tells her mum.
```

Field by field:

- **`id`** (required): a short machine name for the exercise.
- **`name`** (optional): your own label in the teacher lists.
- **`title`** (optional): the heading students see above the text.
- **`description`** (optional): the task, shown in a box above the text. Write it for your students. Markdown works here.
- **`llm`** (required): the AI model in `llm.model`, plus an optional `llm.provider` and `llm.reasoning` level, the same block every activity uses. A per-code model override applies to the whole exercise.
- **`evaluation`** (required): the grading criteria for the whole exercise. Only the AI sees them; they never reach the student's browser.
- **`text`** (required): the complete text in Markdown, with the gaps marked.
- **`instructions`** (optional): extra guidance for grading and feedback alike, for example a language rule. It can place shared fragments; see "Reusing fragments in a cloze exercise" below.

A cloze exercise has no `anonymous` field, because it is always anonymous: no submission is ever linked to a student. It also has none of the quiz settings (no shuffling, no photo answers, no discussion chat, no live hint while typing). Validation rejects a file that contains them.

## Marking gaps

Gaps go inside the `text` field:

| You write | Students see |
| --- | --- |
| `She [[is going to]] start.` | She ¹▢ start. |
| `The class [[starts\|start]] at nine.` | The class ²▢ (start) at nine. |
| `Yes[[]] she said.` | Yes³▢ she said. The correct answer is to leave the gap empty, for example where no comma belongs. |
| `\[[` or `\]]` | A literal `[[` or `]]`, not a gap. |

The rules for gaps:

- Gaps are numbered in reading order: 1, 2, 3, and so on. The numbers are how you, your students and the results page refer to a gap.
- The part after `|` is a **hint**, shown in brackets after the gap, for example the verb students should use. A gap takes at most one `|`, and the hint can't be empty.
- A gap opens and closes on the same line.
- An exercise has at most 40 gaps, and each reference answer is at most 200 characters long. Students' answers have the same limit.
- Gaps belong in paragraphs, list items, quotes and table cells. They are not allowed in headings, code, maths formulas, links or images.

When a gap breaks a rule, validation names the line and column inside `text`, for example `Text line 3, column 12: gap 2 is in a heading`.

## Writing grading criteria that work

The `evaluation` field applies to every gap at once. There are no separate instructions per gap, so describe the exercise as a whole:

1. State the goal: what students should show, for example "choose the future form that matches the speaker's intention".
2. Name what counts as **correct**, including the variants you accept: contractions, synonyms, equivalent forms.
3. Name what still counts as **partly correct**, for example the right construction with a wrong ending.
4. Name what is **wrong**.

Because students never see `evaluation`, you can spell out common mistakes and how strict to be with spelling. The sample exercise lists the rule behind each future form, which helps the AI both to grade and to explain.

## Reusing fragments in a cloze exercise

A cloze exercise can place shared prompt fragments, the same reusable pieces other activities use (a language rule, a safety policy). Declare the library under a top-level `fragment_files:` and place each fragment with a marker in a top-level `instructions:` field. The sample exercise does exactly that:

```yaml
fragment_files:
  - id: general_fragments
    url: "../shared/general-fragments.yaml"

instructions: |
  {{fragment "general_fragments.language_policy" natural_language="English — simple and clear, suitable for A2–B1 learners" code_language="English"}}

  {{fragment "general_fragments.teenager_safety"}}
```

The `instructions` text applies both to how the gaps are graded and to the feedback students read. Plain-text files work too, with `text_files:` and `{{file …}}` markers. The `evaluation` and `text` fields stay plain: markers don't work there. The chapter on reusable fragments covers writing a library.

## What students experience

A student opens the code's link, signs in, and sees your title, the task box, and your text with an empty field in place of every gap:

- The **Tab** key moves from gap to gap in reading order. A counter shows how many gaps are filled.
- Students submit the whole exercise at once with **Submit exercise**. If some gaps are still empty, a short question asks whether to submit anyway.
- Answers live only in the open page. Reloading the page starts the exercise over.

After submitting, each answer turns into a marked chip: a tick for correct, a dash for partly correct, a cross for wrong. An empty gap shows as **Not answered**. Above the text, the **Your feedback** card counts the verdicts, for example "5 correct · 2 partial · 3 wrong". A moment later the feedback itself appears:

- Up to three **patterns**, each one connecting several gaps that share a cause. Every pattern names its gaps ("See your answers: Gap 1, Gap 2, Gap 10") and ends with a **Next time** tip.
- A panel for the selected gap, with the student's answer, **A possible answer** (your reference answer), and a short note when the answer was not correct. Selecting a gap or a gap button in a pattern switches the panel.

When every gap is correct, the card simply says so. When several mistakes don't have a common cause, the card says that too and points students to the note on each gap instead.

A cloze exercise has no discussion chat and no **Report** button, so students can't flag a verdict from the page.

## How answers are marked

Some answers are decided without the AI, so the obvious cases are always marked the same way:

- An answer that matches your reference answer is correct. Extra spaces and the difference between curly and straight apostrophes or quotes don't matter.
- An empty gap is wrong, shown as **Not answered**. For a gap marked `[[]]`, an empty answer is correct.

Every other answer goes to the AI, which decides by your `evaluation` criteria. That includes an answer that differs from your reference only in capital letters: it isn't marked wrong automatically, the AI decides whether the difference matters.

## Feedback built on the student's own answers

The feedback is the reason to use AI here, so Novedu makes sure it fits what the student actually wrote. A pattern is shown only if at least two of the student's gaps that were not correct back it up. A pattern that names a correct gap, or only one gap, is dropped before the student sees it. If no pattern is left although two or more gaps were not correct, the student reads that the mistakes don't share a common cause, plus the note on each gap.

What Novedu cannot check this way is whether an explanation is true of the answers it names. That is what the eval's feedback check is for; see "Testing grading and feedback" below.

## Try again is a practice round

After submitting, students can select **Try again**. The gaps are cleared and the page shows **Practice round**. Because the first submission already revealed the possible answers, a practice round is partly a memory exercise. Practice rounds are graded and get feedback like the first round, but they never appear on your results page and can never be saved as a result.

## Your results page

Open the code from the **Codes** list to see its results. The page shows only counts per gap: never what a student wrote, and never who submitted.

- **First submissions**: how many first rounds were graded. Your own test runs count too; practice rounds don't.
- **Answer key with results**: your text, read-only, with every gap showing its number, your reference answer, its hint, and a small bar of correct, partly correct and wrong answers.
- **Results per gap**: a table with one row per gap: the reference answer, the number and share of correct, partly correct and wrong answers, and the total.

The **Codes** list shows the same number of first submissions next to the code.

The usage dashboard and your start page count differently: there, every graded submission counts as an interaction, practice rounds included.

## Changing an exercise after you share it

Novedu reads the file again every time a student opens the exercise and every time they submit, so a fix to `description`, `evaluation` or `instructions` applies at once, without a new code.

Changing the gaps themselves has a side effect on your results page. A gap's statistics are tied to its number and its reference answer:

- A gap you leave unchanged keeps its counts.
- A gap whose reference answer changed, or that moved to another number because you added or removed a gap before it, starts again from zero. The page then notes that some statistics start from zero.

A student who is in the middle of the exercise while you change the number of gaps is asked to reload the page. So settle the gaps before you hand out a code, and create a new code for a new class or a new term if you want separate results.

## Saved results

After the first round, a student can choose to save the result to their personal statistics, exactly as at the end of a quiz: they answer **No**, **This time** or **Always**. A saved result holds only the counts (one per gap: correct, partly correct, wrong or not answered), never the answers. It turns into medals, retake reminders and badges on the student's own start page, together with their quiz results.

The choice appears only after a first round in which the student answered at least one gap, never after a practice round. Only the student sees their saved results; you cannot see them. Deleting the code removes every result saved for it.

## Before you share a cloze exercise

Validate the file before you hand out a link. In the app, the Files page validates on every save, and a valid cloze file shows its **gap inventory**: the number of gaps and every gap's reference answer and hint in one line. From the terminal:

```bash
npx @novedu/cli validate ./sue-fresh-start.yaml --kind cloze
```

```
✔ Valid cloze exercise — ./sue-fresh-start.yaml
  id: future-forms-sue
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
  anonymous: true (always — no submission is linked to a student)
  gaps: 10
     1  "is going to"
     2  "is going to"
     3  "starts"  (start)
     4  "am meeting"  (meet)
  ...
```

Read the inventory once: it is the quickest way to spot a gap you marked by mistake or a hint in the wrong place.

A valid file becomes a code like any other activity: on the **New code** form, pick **Cloze** under **Activity**.

To read what the AI is told, run `npx @novedu/cli prompts ./sue-fresh-start.yaml --kind cloze`. A cloze exercise has two prompts: one for grading the gaps and one for writing the feedback.

## Testing grading and feedback

The CLI's `eval` command can run sample submissions through the real grading and feedback before students meet the exercise. Write an eval file next to the exercise; the sample one is `activities/examples/future-forms/sue-fresh-start.eval.yaml`:

```yaml
kind: cloze
id: sue-fresh-start-eval
target: ./sue-fresh-start.yaml
submissions:
  - id: will-for-every-plan
    answers:            # by gap number; a gap you leave out was left empty
      1: will
      2: will
      4: am meet
      10: will
    expect:             # optional: the verdict a gap must get
      1: incorrect
      4: [partial, incorrect]
    expect_patterns:    # optional: gaps the feedback should connect
      - [1, 2, 10]
```

- `kind: cloze` is what makes it a cloze eval.
- Each submission is what one student might type. `answers` lists gaps by number; the validation output above tells you the numbers.
- `expect` sets the verdict a gap must get, one verdict or a list of acceptable ones. A gap graded otherwise fails the run.
- `expect_patterns` lists gaps that one pattern of the feedback should connect. The report says whether it did; this never fails the run.

Run it while signed in as a teacher, and ask for a readable report:

```bash
npx @novedu/cli eval ./sue-fresh-start.eval.yaml --report report.md
```

The report has a section for every submission: each gap's answer, the possible answer, what you expected and what it got, then the patterns and notes a student would see, and the ones Novedu dropped because the answers didn't back them up. A second AI, the judge, also reads the feedback and flags problems, above all a pattern that doesn't fit the answers it names. Its findings are notes, never a failure.

Nothing from an eval run is stored in Novedu. If the exercise is hosted in the app, upload the improved file after the run, or your code keeps serving the old version. The chapter on testing how a quiz grades explains the shared options, such as `--repeats` and the judge settings.
