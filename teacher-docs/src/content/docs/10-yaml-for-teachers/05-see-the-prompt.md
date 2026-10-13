---
title: See the exact prompt your activity produces
description: Print the finished prompt an activity sends to the AI, so you can debug it, reuse it in another tool, or test it systematically.
sidebar:
  order: 5
audience: teacher
keywords: [prompt, prompts, CLI, novedu-cli, debugging, fragment, grading prompt, evaluation, JSON]
related:
  - 10-yaml-for-teachers/04-cli-validation
  - 40-ai-llms/01-novedu-cli
  - 10-yaml-for-teachers/06-testing-the-grader
  - 20-building-activities/07-fragments
  - 20-building-activities/04-quizzes
---

Your activity file isn't quite what the AI reads. Novedu takes the instructions you wrote, puts every shared fragment and every text file you referenced in place, and hands the finished text to the model. The Novedu CLI's `prompts` command prints that finished text, so you can read exactly what the AI is told before a single student message arrives.

The `validate` command answers "is my file well-formed?". The `prompts` command answers "what does the AI actually read?". They're two different questions, and you'll want both.

## Run the prompts command

Point the command at your activity file:

```bash
npx @novedu/cli prompts ./activities/examples/sorting-algorithms/sorting-tutor.yaml
```

You get a short summary: what the file is, which AI model it uses, and how long each prompt turned out.

```
✔ Prompts — tutor — activities/examples/sorting-algorithms/sorting-tutor.yaml
  id: ts-sorting-algorithms
  provider: SCCH   model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
  prompts: 1
    system: 5132 chars

  Run again with --json for the full prompt text.
```

When the file also sets a thinking-effort level, the same line names it:

```
  provider: Azure Foundry   model: gpt-5.6-terra   reasoning: low
```

These are the settings of the **file** you pointed at. A code that overrides the AI settings when you share the activity is not taken into account, because the command describes a file, not a share link.

Add `--json` for the prompts themselves, in full:

```bash
npx @novedu/cli prompts ./sorting-tutor.yaml --json
```

A web address works in place of a file path, and reads the file as it's published:

```bash
npx @novedu/cli prompts https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/examples/sorting-algorithms/sorting-tutor.yaml
```

If your file lives on GitHub, commit and push before you check a web address, otherwise you're reading an older version. Nothing is uploaded either way, and for a file on your computer or on GitHub you don't need to sign in: the command only reads your file.

A file you uploaded on the Novedu Files page is only readable by teachers, so the command needs your teacher sign-in for it. Run `npx @novedu/cli login` once, then use the file's address from the Files page. If you aren't signed in, the command tells you which `login` to run.

## Tell the CLI what kind of activity it is

The `prompts` command assumes a tutor unless you say otherwise with `--kind`:

```bash
npx @novedu/cli prompts ./my-quiz.yaml --kind quiz
npx @novedu/cli prompts ./my-writing.yaml --kind writing
npx @novedu/cli prompts ./my-coding.yaml --kind coding
```

`--kind` accepts `tutor` (the default), `quiz`, `writing`, or `coding`. There's no `fragment` kind, because a fragment library has no prompt of its own: its fragments appear inside whichever activity places them, already filled in.

## What each kind of activity gives you

A tutor and a writing activity each produce one system prompt: your instructions with every `{{fragment …}}` and `{{file …}}` marker replaced by the text it stands for.

A quiz produces more, because a quiz asks the AI to do more. You get one complete grading prompt per question, plus the prompt behind the discussion chat:

```
✔ Prompts — quiz — activities/examples/sorting-algorithms/sorting-quiz.yaml
  id: sorting-algorithms-quiz
  provider: SCCH   model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
  prompts: 8
    grading: bubble-idea: 3003 chars
    grading: selection-idea: 2838 chars
    grading: bubble-trace: 2948 chars
    grading: swap-typescript: 3264 chars
    grading: find-the-bug: 3665 chars
    grading: selection-swaps: 2835 chars
    grading: early-exit: 2979 chars
    discussion: 2033 chars

  Run again with --json for the full prompt text.
```

A quiz built from other quizzes lists every imported question too, each one carrying the instructions of the quiz it came from, exactly the way it will be graded.

A coding activity gives you your own instructions and, as `upstreamSystemMessage`, the system message the server passes on to the student's coding agent, with your text appended last so you have the final word.

One thing to keep in mind: a quiz's grading prompts contain your evaluation criteria, the notes on what counts as a correct answer. Students never see them. The output of the command is teacher material, just like the file it came from.

## Find out why an activity behaves oddly

When a tutor ignores a rule you wrote, or a quiz grades an answer in a way you didn't expect, the finished prompt tells you whether your text actually arrived. Reading it usually explains the behaviour faster than changing the file and trying again.

Common things it uncovers:

- A shared fragment you meant to include, but whose marker never made it into the instructions.
- A marker still sitting in a section you thought you'd removed.
- A value that filled in differently from what you had in mind, so the finished sentence says something slightly different from your draft.

There's a boundary worth knowing: if a fragment can't be produced at all, the command reports an error instead of a prompt. That's the moment to run `validate`, which names that kind of problem field by field.

## Reuse your prompt in another AI tool

The dumped prompt is ordinary text, which makes it easy to take elsewhere. Paste it into ChatGPT or another AI tool to try your instructions outside Novedu, send it to a colleague who teaches the same subject, or keep it with your lesson material so the teaching intent stays documented next to the worksheet.

To pull out one single prompt, for example the grading prompt of one question, use the JSON output with a tool such as `jq`:

```bash
npx @novedu/cli prompts ./sorting-quiz.yaml --kind quiz --json \
  | jq -r '.grading.questions[] | select(.id=="q3") | .system'
```

## Check an activity systematically before a class uses it

In AI work, an evaluation means checking a prompt on purpose rather than by feel. Instead of trying two or three answers by hand and hoping the rest go well, you collect a set of sample student answers, run all of them through the same prompt, and look at whether the results are what you want: does the good answer pass, does the half-correct one get the feedback you'd give, does the wrong one get corrected kindly?

Novedu does this for you. The CLI's `eval` command, covered in the chapter on testing how a quiz grades, replays a file of your own sample answers through the real grader and reports where the marks differ from what you expected. The two commands are partners: `prompts` is how you read what the grader is told, `eval` is how you measure what it does. When an eval reports a surprising mark, dumping the grading prompt for that question is usually the fastest way to see why.

## Ask an AI assistant instead of typing flags

With the Novedu skill installed in your AI coding assistant, you can ask "show me the grading prompt for question 3" or "did my safety fragment reach the tutor?", and it runs the command, reads the output, and answers in plain language. The introduction chapter on the Novedu CLI and its AI skill shows how to install that skill.

That's also why this lives in a command rather than as a screen in the app: it's meant to be used by an assistant at least as much as by a person, it works on your own files without signing in, and it uploads nothing. A screen in the app can follow later if teachers ask for one.
