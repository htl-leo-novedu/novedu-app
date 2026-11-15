---
title: Time-limiting a code
description: Set an optional start and end time so a code only works during your lesson or until a deadline.
sidebar:
  order: 3
audience: teacher
keywords: [time window, availability, start time, end time, deadline, expired, lesson, valid from, valid until]
related:
  - 00-introduction/02-shareable-codes
  - 30-sharing-activities/01-creating-codes
  - 30-sharing-activities/05-deleting-codes
  - 30-sharing-activities/11-moodle-hand-in
---

Every code can carry a time window: a start time, an end time, or both. Outside the window the link doesn't open the activity, so you can hand out a code before the lesson and know it only works when you want it to. The window belongs to the code, not the activity, so two codes for the same activity can have different windows.

## Setting the window

You set the window on the same form you use to create or edit a code. Two fields control it:

- **Available from**: when the code starts working. Select **Now** to start immediately, or pick a date and time.
- **Available until**: when the code stops working. The **+1h**, **+1d**, and **+1w** buttons extend the end time by an hour, a day, or a week, counting from the current end time (or from the start time if you haven't set an end yet).

You enter both times in your own local time, exactly as you'd read them off your classroom clock. A typical lesson setup: set **Available from** to the start of the lesson and press **+1h**.

If you set both times, the end must be after the start; the form tells you if it isn't.

For a quiz whose results students hand in to Moodle, the end time is also the hand-in deadline; the chapter on handing in quiz results to Moodle has the details.

## Either bound is optional

Both fields can be left blank, and each blank field has a clear meaning:

- No start time: the code works as soon as you create it.
- No end time: the code never expires.
- Both blank: the code is always open.

Use the **Clear** button next to a field to remove a bound you set earlier.

## What students see outside the window

During the window, the link works normally. Outside it, the link shows a short explanation instead of the activity:

- Before the start, students see that the activity is not available yet, together with the time it becomes active.
- After the end, students see that the code has expired, when it stopped working, and a hint to ask their teacher for a new code.

Times in these messages appear in the student's local time. The window is checked on every interaction, not just when the page opens, so a chat that is still on a student's screen stops accepting new messages the moment the window closes.

## Changing the window later

You can change the window at any time after creating the code: open the code's edit page and adjust the **Available from** and **Available until** fields. The change takes effect immediately.

This also works for a code that has already expired. Extending its end time (or clearing it) makes the same link work again, so students keep any conversations they already had under that code. There's no need to create and distribute a new code for a second round.

## Expired codes stay in your list

An expired code isn't deleted for you. It stays in your list of codes, marked with an **expired** badge, and keeps all of its statistics and student conversations so you can review them after the lesson. The list also shows each code's **Valid from** and **Valid until** times in your local time. The code and its data only disappear when you delete the code yourself.
