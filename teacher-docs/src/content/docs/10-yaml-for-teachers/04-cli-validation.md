---
title: Check your activity with the CLI
description: Run the Novedu CLI's validate command on an activity file, pick the right kind, and read a pass or fail result before students see it.
sidebar:
  order: 4
audience: teacher
keywords: [validate, CLI, novedu-cli, check YAML, kind, error, quiz, tutor, cloze, eval]
related:
  - 40-ai-llms/01-novedu-cli
  - 10-yaml-for-teachers/03-json-schemas-vscode
  - 10-yaml-for-teachers/06-testing-the-grader
  - 20-building-activities/01-handling-yaml
  - 20-building-activities/02-available-llms
---

Before you hand an activity to a class, you can check it with the Novedu CLI, a small command-line tool. Its `validate` command runs the same checks the app itself runs when it loads your file, so any problem shows up on your screen instead of in front of your students. If the CLI says your file is valid, the app will accept it.

You don't need to install anything permanently: `npx` fetches and runs the CLI on demand. The introduction chapter on the Novedu CLI and its AI skill covers what you need on your machine and everything else the CLI can do.

## Run the validate command

Point the command at your YAML file:

```bash
npx @novedu/cli validate ./activities/examples/sorting-algorithms/sorting-tutor.yaml
```

You can also validate a published file by giving its web address instead of a file path:

```bash
npx @novedu/cli validate https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/examples/sorting-algorithms/sorting-tutor.yaml
```

Validating a web address checks the file that is published there, not the copy on your disk. If your file lives on GitHub, commit and push your latest changes first, otherwise you are checking an old version.

## Tell the CLI what kind of file it is

The CLI does not guess what your file is. It assumes a tutor unless you say otherwise with `--kind`:

```bash
npx @novedu/cli validate ./activities/examples/shared/general-fragments.yaml --kind fragment
npx @novedu/cli validate ./activities/examples/sorting-algorithms/sorting-quiz.yaml --kind quiz
npx @novedu/cli validate ./activities/examples/review-writing/restaurant-review-letter.yaml --kind writing
npx @novedu/cli validate ./activities/examples/sorting-algorithms/sorting-visualizer.yaml --kind coding
npx @novedu/cli validate ./activities/examples/future-forms/sue-fresh-start.yaml --kind cloze
```

`--kind` accepts `tutor` (the default), `fragment`, `quiz`, `writing`, `coding`, `cloze`, or `eval`. Getting it right matters: if you validate a quiz without `--kind quiz`, the CLI checks it against the rules for a tutor and reports errors that have nothing to do with your quiz. When a perfectly good file seems to fail, check the `--kind` first.

The `eval` kind checks a golden-answer file, a small test file for a quiz's grading, together with the quiz it points at. The chapter on testing how a quiz grades explains what those files are and how to run them.

Two more things worth knowing:

- Validating a tutor also fully checks every fragment library it references, so one command covers the whole set.
- A tutor's relative fragment file paths resolve next to the tutor itself, so validate the tutor where its fragment files actually sit.

## Read the result

A valid file gets a short confirmation, for example:

```
✔ Valid quiz — ./sorting-quiz.yaml
```

An invalid file gets a list of errors, each naming the specific problem: a field that is missing or misspelled, a fragment the tutor references but the library doesn't contain, a variable a fragment needs but never receives, or plain YAML syntax such as wrong indentation. Fix what the message names, run the command again, and repeat until it passes.

The report separates errors from warnings. Errors mean the app would reject the file; warnings mean it still works, but something deserves a look.

## Let an AI assistant do it for you

With the Novedu skill installed in your AI coding assistant, you never have to type the validate command yourself. Ask "is my quiz valid?" or "why won't this tutor load?", and the assistant runs the validation, reads the error messages, and explains in plain language what to change. The introduction chapter on the Novedu CLI and its AI skill shows how to install that skill.
