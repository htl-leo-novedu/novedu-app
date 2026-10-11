---
title: Exporting a code's conversations
description: Download every conversation students had under one of your codes as a single file, for example to hand it to an AI assistant.
sidebar:
  order: 10
audience: teacher
keywords: [export, download, conversations, transcripts, JSONL, codes export, CLI, novedu-cli, analyse, AI assistant]
related:
  - 40-ai-llms/03-learning-from-conversations
  - 30-sharing-activities/02-viewing-usage
  - 30-sharing-activities/04-anonymous-vs-per-user
  - 40-ai-llms/01-novedu-cli
---

On a code's page you can read the conversations students had one at a time. When you want all of them together, for example to ask an AI assistant what your class struggled with, export them. The Novedu CLI, the command-line companion for the app, writes every conversation under one code into a single file.

## Who can export a code's conversations

Only the teacher who created a code can export its conversations. Other teachers can still read those conversations on the code's page, but the export refuses them. To see which codes are yours, run `npx @novedu/cli@latest codes list`: it lists only your own codes by default.

## What the export contains

The export holds every conversation in which a student wrote at least one message. That covers tutor chats, quiz discussions, and the feedback chats of a writing activity. For a tutor or a quiz, these are the same conversations the code's page lists.

For each conversation you get every message from the student and from the AI, in order, with the time it was sent. When a tutor used one of its tools (for example to draw a random number), the export shows which tool it used and what came back.

A very long conversation keeps only its last 500 messages and is marked as shortened. School conversations are almost never that long.

## What the export never contains

The export never names a student, not even for a per-user code. The file carries no name, no student number, and no nickname for any conversation. What students typed is exported as they wrote it, though, so a message can still give a student away, for example when someone wrote their own name into the chat.

Photos stay out as well. Where a student sent a photo, the export only notes that a photo of a certain type and size was there.

The texts students saved in a writing activity are not exported as texts of their own; only the writing activity's feedback chats are. A feedback chat can still contain parts of a student's draft, because the AI reads the draft while it gives feedback and sometimes quotes it. A coding activity has no conversations to export, because conversations in a student's own coding tool are never stored, so its export is empty. The same holds for a cloze exercise: it has no chat, and students' answers are never stored.

## Exporting with the CLI

Sign in once with `npx @novedu/cli@latest login`, then export a code by its name. The easiest way is to let the CLI write the file:

```bash
npx @novedu/cli@latest codes export k7f3qz --out k7f3qz.jsonl
```

When it's done, the CLI prints a short summary with the number of conversations and messages it wrote:

```json
{ "code": "k7f3qz", "file": "k7f3qz.jsonl", "conversations": 42, "messages": 517 }
```

Without `--out`, the CLI prints the export straight to the terminal instead. That is handy when you pass it on to another tool, or redirect it into a file yourself:

```bash
npx @novedu/cli@latest codes export k7f3qz > k7f3qz.jsonl
```

## What the export file looks like

The file is in a format called JSON Lines: one complete record per line. The first line describes the code (its activity, its note, and when you exported it). Every further line is one conversation. You rarely need to read it yourself: AI assistants and many data tools open the format directly.

If you work with `jq`, a small tool for JSON data, this prints the text of every student message, one per line:

```bash
npx @novedu/cli@latest codes export k7f3qz | jq -r '
  select(.type == "conversation") | .messages[] | select(.role == "user")
  | .content | if type == "string" then . else map(.text // empty) | join("") end'
```

## When an export fails

If an export can't finish, for example because the code isn't yours or the connection drops, the CLI prints an error message and stops. With `--out`, it also removes the unfinished file, so you never end up with half an export. When you redirect the output into a file yourself, that file may hold the first part of the export: delete it and run the command again.
