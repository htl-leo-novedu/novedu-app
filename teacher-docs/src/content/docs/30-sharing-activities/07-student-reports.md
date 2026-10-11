---
title: Reviewing student reports
description: Let students flag notable AI answers, then work through what comes in on the Reports page.
sidebar:
  order: 7
audience: teacher
keywords: [report, flag, feedback, reaction, good, OMG, bad, holy sh, reports page, resolve, CLI, novedu-cli, reports list, command line]
related:
  - 30-sharing-activities/04-anonymous-vs-per-user
  - 30-sharing-activities/02-viewing-usage
  - 30-sharing-activities/05-deleting-codes
  - 40-ai-llms/01-novedu-cli
  - 10-yaml-for-teachers/04-cli-validation
  - 20-building-activities/01-handling-yaml
---

Students can flag a notable AI answer to you: something brilliant, something wrong, or something that needs your attention right away. A report is one small action a student takes inside an activity, and every report lands in one place for you to review: the Reports page. Reports are a feedback channel, not only a complaint box, so it's worth telling a class they can flag great answers too.

## What students can report

A small **Report** button sits in every chat: a tutor conversation, a quiz discussion, and the feedback chat in a writing activity. It also sits next to every graded quiz answer. Coding activities have no in-app chat, so they have no Report button. Cloze exercises have no Report button either.

Filing a report takes two clicks. The student picks one of four reactions and can add a short note:

- **Good** for an answer worth praising.
- **OMG** for a surprising one.
- **Bad** for a weak or wrong one.
- **Holy sh..** for something that needs a teacher's attention now.

The note is optional. The student selects a reaction, can type a sentence about what happened, and sends it.

## Reports are never anonymous

A report always carries the reporting student's name, even on an anonymous code. The form says so before anything is sent: it warns the student that the report is not anonymous and that their name and the reported conversation or answer will be shared with you. So filing a report is the student's own choice to be named. Nobody is identified without acting.

An anonymous code stays anonymous everywhere else. A report on such a code names only the student who filed it. The rest of the class's work under that code keeps its anonymity: you still see what was written, never who wrote it, exactly as on the code's statistics page.

## The Reports page

Select **Reports** in the menu to open the list of every report across your codes. Only teachers can see it. There are no notifications and no emails: reports show up here and nowhere else, so check the page when you want to see what students have flagged.

When you open the page it shows the reports that still need attention, with the most urgent first:

- Only **open** reports, the ones you have not resolved yet.
- Only your own codes, because **Only my codes** is ticked by default. Untick it to see reports on codes created by other teachers.
- The urgent **Holy sh..** reports float to the top and carry a red stripe, so the ones that need you now are easy to spot.

You can narrow the list with the filters at the top: switch between **Open**, **Resolved**, and **All**, pick a single reaction, or type in the search box to match a description, a student, or a code.

## Opening a report

Each report opens to show you exactly what the student saw. How it opens depends on where it came from:

- A **chat** report opens the full conversation as a read-only transcript, so you can read the whole exchange around the flagged moment.
- A **quiz** report opens a detail view with the question, the student's answer, and the AI's feedback, shown just as the student saw them when the answer was graded.

A quiz report carries its own copy of the answer and the feedback. Quiz answers are not stored anywhere else, so this copy is the only record of that graded moment: keep the report if you want to keep the answer. If the student answered with a photo, the report notes that a photo was attached, but the photo itself is not kept.

Every report also has a details view that shows the reaction, the student's name, the code, and the note they wrote, whatever kind of report it is.

## Working through reports

You handle reports in bulk from the Reports page. Tick the reports you want to act on, then use the buttons above the list:

- **Mark resolved** clears the ones you've dealt with, so they drop out of the default open view. A report that is already resolved keeps the teacher who resolved it first.
- **Reopen** brings a resolved report back if you need to look again.
- **Delete Selected** removes reports you no longer need to keep.

Resolving a report does not delete it. It stays available under the **Resolved** and **All** filters, so you have a record of what was flagged and what you did about it.

## Triaging reports from the command line

If you'd rather work in a terminal, or you'd like an AI coding assistant to help, the Novedu CLI handles reports too. Sign in once with `novedu-cli login`, the same sign-in the other CLI commands use, and then three commands cover triage:

```bash
# List open reports on your own codes (add --all for every teacher's codes)
npx @novedu/cli reports list
npx @novedu/cli reports list --status resolved --reaction holysh --search "linked list"

# Show one report in full; a chat report also prints the whole conversation
npx @novedu/cli reports show <report-id>

# Mark one or more reports resolved
npx @novedu/cli reports resolve <report-id> <report-id>
```

- **`reports list`** starts from the same view as the page: open reports on your own codes. Narrow it with `--status` (`open`, `resolved`, or `all`), `--reaction` (`good`, `omg`, `bad`, or `holysh`), and `--search`, or add `--all` to include other teachers' codes.
- **`reports show`** prints one report in full. For a chat report it includes the conversation transcript, so you read the flagged exchange without opening a browser.
- **`reports resolve`** marks reports resolved, one or several at a time. The CLI records the resolve as done by you, the signed-in teacher, exactly as resolving on the page does.

The CLI prints its results as JSON. That reads a little densely for a person, but it's exactly what a script or an AI assistant needs. Reopening and deleting a report are left out of the CLI on purpose: those stay on the Reports page, so an automated helper can never delete a student's report. Reports are always filed by students inside an activity; the CLI never creates one.

This opens up a repair loop you can hand to an AI coding assistant working in a copy of your activities: it reads a report, works out what went wrong, fixes the activity file, publishes the new version, and marks the report resolved, all from the command line. Reports become the to-do list for improving your activities.

## Deleting a code deletes its reports

When you delete a code, its reports go with it. If you want to keep a flagged quiz answer or the note a student wrote, act on the report, or copy out what you need, before you delete the code. Once the code is gone, its reports are gone too.
