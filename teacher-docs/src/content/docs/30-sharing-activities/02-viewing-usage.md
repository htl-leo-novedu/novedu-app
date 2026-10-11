---
title: Seeing how a code is used
description: Check a code's own statistics page and the overall usage view to see how much students and the AI have been working.
sidebar:
  order: 2
audience: teacher
keywords: [usage, statistics, stats, conversations, dashboard, tokens, who saved]
related:
  - 30-sharing-activities/01-creating-codes
  - 30-sharing-activities/04-anonymous-vs-per-user
  - 30-sharing-activities/05-deleting-codes
  - 30-sharing-activities/09-your-start-page
  - 20-building-activities/09-cloze
---

Novedu gives you two views on how your activities are being used: each code has its own statistics page, and a separate usage view sums up all AI use across the school. Both are visible to teachers only. For a quick look at your own codes, your [start page](/30-sharing-activities/09-your-start-page/) sums them up.

## What counts as a use

A use is counted when a student actually writes something: sends a chat message, submits a quiz answer, works on a text, or submits a cloze exercise. A student who merely opens the page and leaves without typing doesn't count. So the numbers tell you who worked, not who clicked.

## A code's statistics page

The **Codes** list shows a quick interaction count next to every code. Select the stats icon on a row to open that code's own page. What it shows depends on the module:

- **Tutor and quiz codes** show the number of conversations (for a quiz, discussions), and a table of each one with its first and last message time and how many messages the student wrote. Each row opens the full conversation as a read-only transcript.
- **Writing codes** show who saved a text: each student's name, when they last saved, and how many feedback conversations they had. Opening a student takes you to their saved text and their conversations, with previous and next buttons to read through the whole class.
- **Coding codes** show your instructions, the pinned model, a button that gets you your own connection details, and a list of everyone who has picked up a personal key for the code, with the time they did so; there are no in-app conversations to list.
- **Cloze codes** show how many first submissions were graded and, for every gap, how many answers were correct, partly correct, or wrong, next to your reference answer. There are no conversations and no student answers to read; the chapter on building a cloze exercise describes the page.

For a per-user code you also see how many distinct students took part, and each conversation carries the student's name.

An anonymous code shows the same counts and the same conversations, but no student identities: no names, no per-student view. Anonymity hides *who* wrote something, never *what* was written, so you can still read the transcripts.

## The overall usage view

Select **Usage** in the menu to see how much AI the whole installation has used. A time filter (**Last 24 hours**, **7 days**, **30 days**, or **365 days**) applies to everything on the page:

- **Token usage over time**: a bar chart of how much the AI models processed per hour, day, or month, with the same numbers in a table below it.
- **Four breakdowns**: tokens by category (tutor, quiz, writing, coding, cloze), by code (labelled with the note you gave each code), by model, and by provider.
- **Three totals**: **Chats** (conversations where a student wrote at least one message), **Quiz answers graded**, and **Cloze submissions graded** (practice rounds included).

All times on the usage view are UTC, so during the school year the labels sit one or two hours behind Austrian clock time.

The usage view never shows student names or message content; it is about volume, not people. To read what was said under a specific code, use that code's own statistics page.
