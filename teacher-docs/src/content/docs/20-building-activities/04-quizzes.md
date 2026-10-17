---
title: Building a quiz
description: Write a quiz file with open-ended questions and private grading guides, and set shuffling, photo answers, and the follow-up discussion.
sidebar:
  order: 4
audience: teacher
keywords: [quiz, questions, grading, evaluation, rubric, shuffle, skip question, photo answer, imageInput, discussion, fragments, quiz_files, compound quiz, final quiz, question_count, attempt length, eval, golden answers, test the grader]
related:
  - 20-building-activities/01-handling-yaml
  - 20-building-activities/02-available-llms
  - 20-building-activities/07-fragments
  - 10-yaml-for-teachers/04-cli-validation
  - 10-yaml-for-teachers/06-testing-the-grader
  - 30-sharing-activities/04-anonymous-vs-per-user
---

A quiz is an activity made of **open-ended questions**. There is deliberately no multiple choice: students answer in their own words, and the AI grades each answer against a grading guide you write. The student immediately sees a verdict (**correct**, **partial**, or **incorrect**) and written feedback, and can then open a short discussion chat about that question.

You define a quiz in one YAML file. The core is simple: an `id`, a model, and a list of questions.

## One question, two texts

Every question in a quiz file carries two pieces of text with very different audiences:

- **`question`**: the Markdown the student sees. Maths (`$…$`) and code fences render.
- **`evaluation`**: the grading guide. Only the AI sees it; it never reaches the student's browser. Because it stays private, it can openly state the expected answer and the criteria for each verdict.

## The smallest quiz that works

This complete example comes from the quiz authoring guide:

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

Field by field:

- **`id`** (required): a short machine name for the quiz.
- **`name`** (optional): a human-readable label.
- **`title`** and **`description`** (optional): what students see on the welcome screen before the first question. Write the `description` for your students.
- **`anonymous`** (optional, default `true`): by default a quiz is anonymous, so answers feed the statistics but aren't linked to a student. Set `anonymous: false` to attribute each attempt to the signed-in student. The setting is frozen onto a code when you create one; editing the file later doesn't change a live code.
- **`shuffle`** (optional, default `true`): questions appear in a random order per attempt. Set `shuffle: false` to keep your authored order.
- **`llm.model`** (required): the model that grades the answers and drives the discussion chat. You can also set an optional `llm.provider` (the provider decides where the AI runs) and an optional `llm.reasoning` level (how hard the model thinks before it grades); the create-code form can override all three per code.
- **`question_count`** (optional): how many questions one attempt asks. Leave it out to ask every question exactly once; see "How many questions one attempt asks" below.
- **`questions`** (required, unless the quiz pulls its questions from other quiz files with `quiz_files`): each question needs an `id` (unique within the quiz), a `question`, and an `evaluation`; an optional `title` labels it in the statistics and progress display.

## Writing grading guidance that works

The `evaluation` is the heart of a question. The AI maps the student's answer onto one of three verdicts, so name all three explicitly: describe what counts as `correct`, what still earns `partial`, and what is `incorrect`. Vague guidance produces vague grading.

A pattern that works well:

1. State the expected answer first, including acceptable variants.
2. List the three verdicts with concrete criteria for each.
3. Tell the AI how to write the feedback: which language to use, and whether to show a worked example or a gentle correction.

Since students never see the grading guide, you don't need to hide anything in it. Spell out the full solution, common wrong answers, and how generous to be with spelling or phrasing.

## Question order

Questions are shuffled by default: each student gets a random order per attempt. Set `shuffle: false` at the top of the file when later questions build on earlier ones, as the sorting-algorithms sample quiz does (it moves from concept to code step by step).

## Skipping a question

Every quiz lets students skip a question. Before submitting an answer, a student can select **Skip for now**, and the quiz moves on to the next question.

A skipped question comes back later in the same attempt:

- It moves to the end of the line and returns after every question the student hasn't seen yet. Several skipped questions come back in the order they were skipped.
- A student can skip a returning question again, as long as another question is still waiting. The last remaining question can't be skipped.
- Whatever the student had already typed or attached as a photo is still there when the question returns.
- The progress display doesn't move forward on a skip. It shows how many questions are waiting for later, and marks a returning question as skipped earlier.

Skipping also applies with `shuffle: false`, so a student can move a question behind later ones even when you keep your authored order. If later questions really depend on an earlier answer, say so in the question text.

A skipped question counts as unanswered until the student answers it. If a student finishes early, the summary names how many skipped questions were never answered. Skips aren't stored anywhere and don't show up in your statistics.

## How many questions one attempt asks

By default one attempt walks through every question exactly once. Set a top-level `question_count` to change that:

```yaml
question_count: 30
```

The number combines with `shuffle` in a predictable way:

- **Fewer than the quiz has**: with `shuffle: true` each attempt asks a random selection of that size, so two students (or two attempts) get different questions. With `shuffle: false` every attempt asks the first `question_count` questions in your authored order.
- **More than the quiz has**: questions repeat, which turns the quiz into a practice drill. The whole pool is covered before anything repeats, and with `shuffle: true` the same question never appears twice in a row.

Students see the chosen length in the progress display ("Question 3 of 30"). Two things to keep in mind:

- `question_count` shapes one attempt in the student's browser; it is not an exam lock. Reloading the page starts a fresh attempt, and answers are not stored.
- Skipping never changes the length of an attempt: a skipped question returns later instead of being replaced by a new one.
- A repeated question is simply graded again, independently of the earlier answer.

## Photo answers

Students can attach photos of their work, for example a handwritten calculation, when you turn photo answers on:

```yaml
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
  imageInput: true
```

Photo answers are **off by default**. A few things to know:

- The model must be **vision-capable** (able to look at images). That also applies to any per-code model override on such a quiz.
- Students can attach up to three photos per answer. An answer may even be photo-only, with no typed text.
- Novedu prepares each photo in the student's browser before the model sees it. Photos that a phone stored sideways are straightened, and very large photos are made smaller. Students can simply use their phone camera: an ordinary phone photo is fine, even though the original file is far bigger than what gets sent.
- Some phone photo formats, HEIC above all, cannot be opened by every browser. A student whose photo cannot be read gets a message naming the format and what to change on the phone, together with details they can copy and send to you.
- If a photo still does not work, ask the student to open the photo check page at `/image-check` on the device that took it, and to send you the text shown there. The photo is examined on their own device and is never uploaded.
- The quiz-level flag is the default for all questions; an `imageInput` on a single question overrides it in either direction.

## The follow-up discussion

After seeing their feedback, a student can open a short discussion chat about that question. Novedu already gives the assistant full context (the question, the expected answer, the student's answer, and the verdict), so the optional `discussion.instructions` field is only extra steering: tone, language, and didactic style. Omit it to use a sensible default.

When the quiz declares fragment libraries (see "Reusing fragments in a quiz" below), you can place `{{fragment …}}` and `{{file …}}` markers inside `discussion.instructions` too, exactly as in the top-level `instructions` field.

## Reusing fragments in a quiz

A quiz can place shared prompt fragments, the same reusable pieces tutors use (a persona, a safety policy, a language rule). Declare the library under a top-level `fragment_files:`, then place each fragment with a marker in a top-level `instructions:` field:

```yaml
fragment_files:
  - id: general_fragments
    url: "../shared/general-fragments.yaml"

instructions: |
  {{fragment "general_fragments.teenager_safety"}}
```

A quiz's `instructions` field reaches further than the instructions of other activities: it applies **both** to how answers are graded **and** to the follow-up discussion chat, so a shared safety or persona rule shapes grading and conversation alike. It is a separate field from `discussion.instructions`, which only steers the discussion and takes the same markers. Your per-question `evaluation` texts stay plain, markers don't work there. The chapter on reusable fragments covers writing a library and supplying values.

## One final quiz over several chapters

When a course is split into chapters, each with its own quiz, you can build an overall quiz at the end that asks the questions of all chapters, without copying a single question. Declare the chapter quizzes under a top-level `quiz_files:`, each with a short alias and the file's address:

```yaml
id: ddp-final
name: "Final quiz: all chapters"
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
question_count: 30
quiz_files:
  - id: intro
    url: ./0010-introduction-quiz.yaml
  - id: loops
    url: ./0020-loops-quiz.yaml
```

**All** questions of every referenced quiz are included, and they are read **live**: when you edit a chapter quiz, the final quiz asks the updated questions the next time a student opens it. There is nothing to keep in sync. A final quiz built this way needs no `questions` of its own, though it may add some. Combining `quiz_files` with `question_count`, as in the example, keeps a large final quiz to a sensible length per attempt.

How the pieces fit together:

- **The final quiz's own settings rule.** The model, the anonymity setting, `shuffle`, `question_count`, and `discussion.instructions` all come from the final quiz's file, and the same settings inside a chapter quiz are ignored here. A chapter's own `discussion.instructions` never applies in the final quiz.
- **Grading instructions add up.** The chapter quiz's top-level `instructions:` text is the one thing that travels with its questions, and it applies to grading only. An imported question is graded with the final quiz's `instructions` first and the chapter's on top, so both are in force at once. That is worth keeping in mind while you write them: a language, persona, or safety rule in the final quiz's `instructions` also governs every imported question, so avoid putting a rule there that contradicts a chapter's.
- **The follow-up discussion follows the final quiz alone.** No chapter text reaches the discussion chat, so put any guidance the discussions need into the final quiz's own `instructions` and `discussion.instructions`.
- **Aliases name the source.** Pick a short alias per file (no dot, no slash, each one unique). In the statistics an imported question shows up as `alias/question-id`, for example `intro/capital-australia`, so you can tell the chapters apart.
- **Addresses work like elsewhere.** The `url` is a web address or a relative path, resolved next to the final quiz's own file. That also works between files hosted in the app: host the chapter quizzes and the final quiz together and refer to them with `./file-name` style paths.
- **One level only.** A referenced quiz must not declare `quiz_files` itself; a quiz of quizzes of quizzes is not supported.

If a referenced file is missing or broken, students see a friendly error instead of a shortened quiz: the final quiz never silently loses a chapter. Validation catches this before sharing; see "Before you share a quiz" below.

## A real example: the sorting-algorithms quiz

The sample file `activities/examples/sorting-algorithms/sorting-quiz.yaml` is a seven-question quiz for a TypeScript class, and it shows most of the options above in action. Its header keeps the authored order and steers the discussion chat:

```yaml
id: sorting-algorithms-quiz
name: "Quiz: Bubble Sort & Selection Sort"

# The questions build up from concept to code, so keep the authored order.
shuffle: false

llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic

discussion:
  instructions: |
    You are a friendly programming tutor helping the student understand THIS
    quiz question about sorting algorithms. The student has already submitted
    an answer, so you may reveal and explain the correct answer. ...
    Respond in German, keep code and identifiers in English, and stay on the
    topic of this question.
```

One question turns photo answers on just for itself, because a handwritten trace on paper is the natural way to answer it:

```yaml
  - id: bubble-trace
    title: "Bubble Sort von Hand"
    imageInput: true
    question: |
      Gegeben ist das Array `[5, 2, 4, 1]`.

      Wie sieht das Array nach dem **ersten vollständigen Durchlauf** von
      Bubble Sort aus ...
```

Its grading guide states the full solution and even anticipates a typical wrong answer, grading it `partial` rather than `incorrect`:

```yaml
    evaluation: |
      Die korrekte Antwort ist **`[2, 4, 1, 5]`** ...

      Bewerte als:
      - `correct`   — das Ergebnis `[2, 4, 1, 5]` (mit oder ohne
                      Zwischenschritte).
      - `partial`   — ... ODER die Antwort ist das fertig sortierte Array
                      `[1, 2, 4, 5]` (zu weit gedacht: das ist das Ergebnis
                      ALLER Durchläufe, nicht des ersten).
      - `incorrect` — ein anderes Ergebnis ohne erkennbar richtiges Vorgehen.

      Gib das Feedback auf Deutsch und zeige die drei Vergleichsschritte.
```

Notice the mix of languages: the questions and feedback instructions are in German for the students, while field names and code stay in English. Write your quiz in whatever language your class works in; the grading works the same way.

## Before you share a quiz

Validate the file before you hand out a link: an invalid quiz cannot be saved in the app or turned into a code. The validator checks that the YAML parses, that the structure is right (an `llm.model` and at least one question, each with an `id`, a `question`, and an `evaluation`), and that every question `id` is unique. For a quiz with `quiz_files`, it also fetches and fully checks every referenced quiz file, so a broken chapter quiz blocks the final quiz from being saved. From the terminal:

```bash
novedu-cli validate ./quizzes/my-quiz.yaml --kind quiz
```

A valid quiz can still grade differently from how you meant it. You can test the grading itself before students meet it: write a few sample answers with the marks they should get, and the CLI's `eval` command grades them with the real grader and reports where it disagreed with you. The chapter on testing how a quiz grades walks through it.
