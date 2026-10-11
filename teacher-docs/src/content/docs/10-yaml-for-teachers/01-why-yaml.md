---
title: The idea behind YAML
description: Why every Novedu activity is one plain-text YAML file you can read, copy, and adapt, with no programming needed.
sidebar:
  order: 1
audience: teacher
keywords: [YAML, plain text, text editor, activity file, examples, copy, GitHub, validation]
related:
  - 10-yaml-for-teachers/02-yaml-101
  - 10-yaml-for-teachers/03-json-schemas-vscode
  - 10-yaml-for-teachers/04-cli-validation
---

Every activity you build in Novedu, whether a tutor, a quiz, a writing task, a coding activity, or a cloze exercise, is a single plain-text file written in YAML. You can open and edit it in any text editor. There is no special software to install and no programming to learn: you fill in named fields, and most of what you write is ordinary teaching language, the instructions you want the AI to follow.

## One file you can actually read

An activity file reads top to bottom like a structured worksheet. Each line starts with a field name, followed by what you put there. Here is the start of a real writing activity, exactly as a teacher wrote it:

```yaml
id: restaurant-review-letter
name: "Feedback Letter — Birthday Party at a Restaurant"

title: "Write a Feedback Letter to the Restaurant"
description: |
  Last Saturday you celebrated your **birthday party** with eight friends at
  the restaurant *Bella Vista*. Some things were great: the pizza was
  delicious and the staff sang for you. Some things were not: you had booked
  a table for 7 p.m. but waited 30 minutes, and the drinks were expensive
  and arrived slowly.
```

You can guess what each field does just by reading it. The rest of the file continues the same way: a few short settings, then the prompt, the written instructions that shape how the AI behaves. Nothing is hidden in a database or behind a form; the file is the whole activity.

## Why plain text is a good fit for teaching

A plain-text file behaves like any other document you already work with, and that brings real advantages:

- **You can copy and adapt.** Take a working activity, save it under a new name, and change the subject, the questions, or the tone. Ten minutes of editing often turns one activity into another.
- **You can share it.** Send the file to a colleague by email or chat, or keep a shared folder for your department. Whoever receives it sees everything the activity does.
- **It versions well.** Because it is text, the file fits normal file workflows, including GitHub if your school uses it. You can keep older versions, compare what changed between two versions, and roll back an edit that did not work in class.
- **Nothing gets stale in a hidden place.** When you want to know exactly what an activity tells the AI, you read the file. What you see is what runs.

## Start from an example, not a blank page

The recommended way to author is not to write a file from scratch. Novedu comes with a set of complete, validated example activities covering all five kinds. Pick the example closest to what you want, copy it, and change the parts that are yours: the topic, the instructions, the questions. The overall shape of the file stays the same, so you rarely need to invent structure.

## Small mistakes matter, and they get caught

One honest caveat: YAML is strict about indentation. The spaces at the start of a line tell Novedu how the pieces of your file belong together, so a missing or extra space can change the meaning or make the file invalid. That sounds fragile, but in practice two safety nets catch these mistakes long before a student sees them:

- Your editor can check the file as you type and underline problems, much like a spelling checker.
- Novedu validates every activity file with the same rules before it goes live, and you can run that exact check yourself from the command line while you write.

So the working rhythm is simple: copy an example, edit it, let the checks confirm the file is valid, and only then hand it to your class.
