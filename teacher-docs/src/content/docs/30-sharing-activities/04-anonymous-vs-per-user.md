---
title: "Anonymous or per-user: what an activity records"
description: What you can see in each mode, the default for each activity kind, and why the choice is fixed when a code is created.
sidebar:
  order: 4
audience: teacher
keywords: [anonymous, per-user, attribution, privacy, who did what, student names, anonymous flag, saved quiz results, medals, previous conversations, reopen conversation]
related:
  - 30-sharing-activities/01-creating-codes
  - 30-sharing-activities/02-viewing-usage
  - 30-sharing-activities/06-coding-special-case
  - 00-introduction/05-writing-overview
---

Every activity runs in one of two modes: anonymous, where the app never links work to a student, or per-user, where it records who did what. The mode decides what you can see afterwards, so it's worth choosing deliberately, especially for graded work.

Students sign in with their school account either way. The mode isn't about who can open the activity; it's about whether their work is linked to their name.

## Anonymous: you see what, not who

In an anonymous activity the app stores no link between a student and their work. On the statistics page for a code you see how much the activity was used, and you can still open and read every conversation, but nothing tells you which student it belongs to. Anonymity hides *who*, never *what*.

Anonymous is a good fit for practice and exploration: students can ask basic questions or make mistakes without worrying that it lands next to their name.

For a tutor this cuts both ways: because nothing links a conversation to a student, students can't return to an earlier conversation. A reload in the same tab keeps the current one going for up to an hour after the last message; once they start over or close the tab, it's gone for them, though you can still read it.

## Per-user: you see who did what

In a per-user activity the app records the author. The statistics page for a code shows how many different students took part and names the student behind each conversation or quiz attempt, and for a writing activity you can open each student's saved text together with their coach conversations. Choose per-user when you need to review or grade individual work.

In a per-user tutor, students can reopen their earlier conversations with that tutor and continue them. They only ever see their own conversations, and only those for that one tutor.

Tell your class when an activity records who did what, so nobody assumes they are practising anonymously.

## The defaults by kind

Each kind of activity has its own default:

| Kind | Default | Why |
| --- | --- | --- |
| Tutor | Anonymous | Chatting with a tutor is practice; students should feel free to ask anything. Students can't reopen earlier conversations; choose per-user if they should. |
| Quiz | Anonymous | Answers feed the aggregate statistics without naming anyone. |
| Writing | Per-user | Reviewing a saved text needs an author, so writing records one by default. |
| Cloze | Always anonymous | A submission is never linked to a student; the results page shows counts per gap only. There is no setting to change. |
| Coding | Always anonymous | Requests from a coding tool carry no student identity; there is no setting to change. Picking up the connection key is the one exception, always recorded with the student's name. |

## Where you set it

The mode comes from the `anonymous` field in the activity's YAML file. Omit it to keep the kind's default, or set it explicitly. This example from a writing activity spells out the default rather than relying on it:

```yaml
# Writing defaults to attributed (anonymous: false): the teacher reviews and
# grades the saved letters, so they must know whose text it is.
anonymous: false
```

For a tutor or a quiz, `anonymous: false` switches the activity from its anonymous default to per-user. A coding activity and a cloze exercise have no `anonymous` field at all; adding one is rejected as an error. Coding keeps its own fixed exception regardless: a student's coding conversations stay anonymous, but picking up the connection key their tool needs is always recorded with their name, covered in the chapter on connecting a coding activity.

## The choice is frozen when you create a code

When you create a code, the activity's current mode is fixed onto that code and stays with it for its whole life. Editing the activity file later does not change codes that already exist; the edit only affects codes you create afterwards. If you change your mind, create a new code from the updated file and share that one instead.

## Anonymous writing turns off saving

A writing activity set to `anonymous: true` has no author to save a text under, so saving is disabled: students see no **Save** button and their draft is gone when they leave the page. The coach chat and the formatted preview still work, so the activity remains useful as a pure practice space. Keep writing per-user whenever you plan to review or grade the texts.

## What students may save for themselves

At the end of a quiz, or after the first round of a cloze exercise, a student can choose to save the result to their personal statistics: the number of correct, partly correct and wrong answers, never the answers themselves. They answer **No**, **This time** or **Always**, and can change that choice later under **Settings** in their user menu. A saved result is stored with the student's account even in an anonymous quiz or a cloze exercise, because it belongs to them: it turns into medals, retake reminders and badges on their own start page.

Only the student sees their saved results. You cannot see them, not even as an aggregate, and they do not change what an anonymous quiz or a cloze exercise shows you. Students can delete their saved results under **Settings** at any time, and deleting a code removes every result saved for it.

