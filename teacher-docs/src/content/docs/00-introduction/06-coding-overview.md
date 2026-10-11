---
title: "Coding: an AI assistant inside the student's editor"
description: What a coding activity is, how students connect their own coding tool to it, and how your rules and model choice shape the help they get.
sidebar:
  order: 6
audience: teacher
keywords: [coding, coding assistant, coding agent, little-coder, programming, instructions, model, API key, personal key]
related:
  - 20-building-activities/06-coding
  - 30-sharing-activities/06-coding-special-case
  - 00-introduction/03-tutors-overview
---

A coding activity gives every student an AI coding assistant that follows your rules while they program in a real editor. The student works in their own coding environment with an external coding assistant, for example [little-coder](https://github.com/itayinbarr/little-coder), and that assistant gets its answers through Novedu. You decide how it behaves: which language it uses, which concepts it may touch, and how it teaches.

As with every other kind of activity, you don't train an AI model. You write a prompt, plain-language instructions for the assistant, and pick the model that answers.

## How coding differs from the other kinds

Tutors, quizzes, writing tasks, and cloze exercises all run as a page inside Novedu. A coding activity doesn't: there is no chat page in the app. Instead, the student's own coding tool connects to Novedu using the code, and every question the student asks goes through Novedu on its way to the AI. On that way through, Novedu adds your instructions and answers with the model you chose.

The effect: the student works in a normal programming setup, with files, a terminal, and an assistant that edits and runs code on their machine, yet the help always stays within the limits you set. Students never see your instructions or which model answers; they simply notice that the assistant teaches the way you asked it to.

## What students experience

Students set up their coding tool once. Opening the code's link asks them to sign in with their school account, then shows them the exact connection settings, ready to copy into their tool, built around a personal key that is theirs alone. From then on they work as programmers do: they ask the assistant for help, let it explain, scaffold, or debug, and write their own code in between.

If your instructions say so, the assistant refuses to use concepts the class hasn't learned, keeps its code inside a beginner-friendly subset, or explains a bug instead of silently fixing it.

## How you shape the assistant

You write instructions that describe your class and your limits. Typical instructions cover:

- **What the class already knows.** For example, TypeScript basics and simple p5.js drawing, but nothing beyond.
- **What the assistant may use.** For example, only plain loops and simple types; no classes, no shortcut functions the class hasn't seen.
- **What it must leave to the student.** For example, never write the sorting algorithm itself; explain the next step and let the student assemble it.
- **How it teaches.** Small steps, explain why, encourage.

A real example from the sample activities, an assistant for a sorting-visualizer project, puts it like this:

```yaml
instructions: |
  You are a friendly coding buddy for 16-year-old vocational-college students.
  ...
  ## TypeScript limits — stay inside them
  Every explanation and every line of code you produce MUST stay within these
  limits, so the code never runs ahead of the class:
  - Use only `number`, `string`, `boolean`, and simple arrays of those. No
    classes, no interfaces, no enums, no generics, ...
  ## The algorithm is the learning goal — don't write it for the student
  - The comparison-and-swap logic of Bubble Sort and Selection Sort is what
    the students must write THEMSELVES. Never generate a complete, working
    sorting function on request.
```

You also pick the model that answers, and where it runs (the school's Austrian LLM hosting partner, Azure, or the OpenRouter gateway, a provider choice you can adjust per code).

Coding activities keep what a student asks the assistant anonymous: you see overall usage of a code, never an individual conversation. Picking up the connection key itself is the one thing recorded with a student's name, so you know who is connected.

## When coding is the right choice

Pick a coding activity when students should practise programming in a real editor with real files, and you want the AI at their side to act like a patient teaching assistant rather than an all-knowing autocomplete. It works well for guided projects where the core algorithm is the learning goal, for keeping generated code inside what the class has learned, and for coding workshops where every student gets the same carefully constrained helper.

When students need explanations and conversation rather than a programming session, a tutor is the better fit. When you want graded answers to set questions, build a quiz.
