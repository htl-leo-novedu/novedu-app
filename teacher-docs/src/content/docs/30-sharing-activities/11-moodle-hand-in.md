---
title: Handing in quiz results to Moodle
description: Let students hand in a Novedu quiz result to your Moodle course, where it lands in the gradebook like any other activity.
sidebar:
  order: 11
audience: teacher
keywords: [Moodle, hand in, gradebook, grade, LTI, Select content, Inhalt auswählen, Moodle activity, link account, quiz result, deadline, moodle]
related:
  - 50-develop-and-evaluate/04-connecting-moodle
  - 30-sharing-activities/01-creating-codes
  - 30-sharing-activities/03-time-limitation
  - 30-sharing-activities/04-anonymous-vs-per-user
  - 30-sharing-activities/05-deleting-codes
  - 20-building-activities/04-quizzes
---

If you organise your course in Moodle, a Novedu quiz can count there too. You add the quiz to your Moodle course as an activity, students open it from Moodle, and at the end of an attempt they can hand the result in with one click. The result lands in Moodle's gradebook, in the column of that activity, like any other Moodle grade.

## What a Moodle hand-in is

Handing in is always the student's choice, attempt by attempt. Nothing reaches Moodle unless the student selects **Hand in** on the quiz's Finish page. Students can take the quiz as often as they like and hand in again; a later hand-in replaces the earlier one in the gradebook.

What arrives in Moodle for a hand-in:

- **A score.** A correct answer counts one point, a partly correct answer half a point, and a wrong or unanswered question nothing. The maximum is the number of questions in the attempt. Moodle scales the score to the activity's maximum points, so with the usual maximum of 100 the gradebook shows the percentage.
- **A comment** that Moodle shows as feedback, for example: "Novedu quiz: 10 questions — 6 correct, 2 partly correct, 1 wrong, 1 not answered."

Novedu sends no school grade and no pass or fail. Turning the score into a grade stays your decision in Moodle.

Moodle hand-in exists for quizzes only. Tutors, writing activities, and coding activities can't be handed in to Moodle.

## Before you start: is your Novedu connected to Moodle?

Your school's Moodle administrator registers Novedu in Moodle once, and the person who runs your school's Novedu enters the values Moodle shows. The chapter on connecting Novedu to Moodle describes both steps.

To check whether that has happened, open **Settings** from your user menu in Novedu and look at the **Moodle connection** section:

- "Connected to …" followed by your Moodle's address means you're ready.
- "Not connected yet" means Novedu is registered on the Novedu side but the values from Moodle are still missing on the server.
- "Moodle hand-in is not set up on this Novedu" means nobody has started the setup.

Until the connection exists, the Moodle option doesn't appear on the code form at all.

## Set up a quiz for Moodle in three steps

### 1. Tick the Moodle option on the quiz code

Create a code for your quiz as usual, and tick **Students can hand in results to Moodle** on the create form. The option appears only for a quiz and only while Novedu is connected to Moodle. For an existing quiz code, open the code's edit page, tick the option, and save.

If you create codes from the command line, add `--moodle` to `novedu-cli codes create`; in an activity registry, add `moodle: true` to the quiz's entry.

### 2. Add the Novedu activity in your Moodle course

1. In your Moodle course, switch on editing and add an activity. Choose **Novedu** from the activity chooser. (Your administrator may have given the tool a different name.)
2. Select **Select content** (**Inhalt auswählen** in a German Moodle). Moodle opens a small Novedu page inside its dialog.
3. Paste your quiz's code or its full link into the field and select **Use this quiz**.
4. Back in the Moodle form, the activity is named "Novedu:" followed by your code's note (or the code itself if it has no note), with a maximum grade of 100. You can change both.
5. Save the activity.

You don't need to be signed in to Novedu for this. The picker only checks the code, and it tells you if something is off:

- "No quiz found for this code." The code is mistyped or was deleted.
- "This code is not a quiz. Only quizzes can be handed in to Moodle."
- "This code is not set up for Moodle." Tick **Students can hand in results to Moodle** on the code's edit page and try again.

### 3. Check the gradebook

Saving the activity creates a grade column for it in your course's gradebook. That column is where your students' hand-ins appear.

## What students see

**Opening the activity in Moodle.** Novedu opens in a new browser window. Students sign in to Novedu with their school account as always, if they aren't signed in already.

**Linking the two accounts, once.** The first time a student comes from Moodle, Novedu asks "Link your Moodle account?" and shows both accounts side by side: their Novedu name and email, and their Moodle name and username. With **Yes, these are both me**, Novedu remembers that the two accounts belong together and opens the quiz. With **That's not me**, nothing is stored and Novedu explains how to sign out of the wrong account. Every later visit from Moodle goes straight to the quiz.

**The Finish page.** Below the usual question about personal statistics, a box **Hand in to Moodle** shows what Moodle will receive, for example "10 questions — 6 correct, 2 partly correct, 1 wrong, 1 not answered (70 %)", and reminds the student that you'll see the result in Moodle under their name. One click on **Hand in** sends it. The box then confirms the date and time of the hand-in.

**Handing in again.** On a later attempt, the box says when the student last handed in and that handing in again replaces it.

Once a student has come to this quiz from Moodle and linked their accounts, the box appears every time they finish it, also when they open the quiz later from the code field or **Recently used** in Novedu instead of from Moodle. It doesn't appear for an attempt with no answered question, and it never appears for a student who hasn't opened the quiz from Moodle yet.

## The hand-in deadline is the code's end date

Students can hand in for as long as the quiz code is valid. To set a deadline, set the code's end date (the chapter on time-limiting a code explains the availability window). Once the code expires, the quiz no longer opens and a student who is still on the Finish page sees "This quiz has ended, so the result can't be handed in." If you want students to keep practising after the deadline, create a second code without the Moodle option and share that one.

## What Novedu stores and what Moodle learns

For a linked student, Novedu keeps three things:

- the student's Moodle user id, an internal number from Moodle (not their name or username),
- where in Moodle a result of this quiz goes, that is, the grade column of the activity the student last came from,
- the time of their last hand-in.

Novedu doesn't keep the student's Moodle name, their username, or any score they handed in. The names appear only once, on the linking page.

Moodle sees each hand-in under the student's name, like any other grade. In Novedu itself, a Moodle-enabled quiz can still be anonymous: your statistics in Novedu don't name anyone, and you won't see in Novedu who handed in. The gradebook in Moodle is the only place for that.

Students can undo the link at any time in **Settings** under **Moodle account** with **Unlink my Moodle account**. That deletes the link and every hand-in destination Novedu kept for them. Results already in Moodle stay there.

## Switching it off, deleting the code, copying the course

**Switching the Moodle option off** on the code's edit page removes the hand-in box from the Finish page, and opening the activity from Moodle just opens the quiz. Grades already in Moodle stay. When you switch the option on again, students who had come from Moodle get their hand-in box back without linking again.

**Deleting the code** in Novedu ends the activity: the Moodle activity then leads to an "unknown code" page. Grades already in Moodle stay.

**Copying your Moodle course** (for example, restoring a backup as next year's course) keeps the Novedu activity and its code. Hand-ins from students who open the activity in the copy go to the copy's gradebook. If the new class should get a fresh code, create one and pick it in the copied activity with **Select content**.

**The same code in two Moodle activities** is possible. A student's hand-in goes to the activity they most recently opened.

## When something doesn't work

- **The Moodle option isn't on the code form.** The code isn't a quiz, or your Novedu isn't connected to Moodle yet. Check **Settings**, then ask the person who runs your Novedu.
- **"This code is not set up for Moodle."** Tick **Students can hand in results to Moodle** on the code's edit page.
- **"This quiz has ended, so the result can't be handed in."** The code's end date has passed. Extend it on the code's edit page if you want to allow more hand-ins.
- **"Hand-in to Moodle is switched off for this quiz."** The option was switched off while the student was taking the quiz.
- **"This activity no longer exists in Moodle. Ask your teacher."** The Moodle activity the student came from was deleted. The student opens the quiz again from the current activity in Moodle.
- **"Moodle could not be reached right now. Please try again."** A short connection problem; **Try again** usually helps.
- **"This Moodle account can't be used here."** The student's Moodle account is already linked to a different Novedu account, or their Novedu account to a different Moodle account. The owner of the link can undo it under **Settings** → **Moodle account**. Until then the student can take the quiz but can't hand in.
- **"Your Moodle doesn't share your name with Novedu."** Moodle is set up not to share names with Novedu, so accounts can't be linked. Ask your Moodle administrator to change that setting.
- **"This link from Moodle has expired."** The student waited too long between opening the activity and signing in. Opening the activity from Moodle again fixes it.
- **Novedu opens inside the Moodle page instead of a new window**, and signing in doesn't work there. The Novedu tool must open in a new window; ask your Moodle administrator to check the tool's launch container setting.
- **Opening the activity as a teacher** in Moodle just shows the quiz, without the linking page and without a hand-in box. Hand-ins are for the students enrolled in the course.
