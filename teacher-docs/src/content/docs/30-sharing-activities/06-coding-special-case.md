---
title: "Connecting a coding activity to an outside tool"
description: How a student picks up a personal API key for a coding code, the attribution notice that comes with it, and what you see as the teacher.
sidebar:
  order: 6
audience: teacher
keywords: [coding, code, API key, personal key, connection, base URL, little-coder, models.json, attribution, issued keys]
related:
  - 30-sharing-activities/01-creating-codes
  - 30-sharing-activities/04-anonymous-vs-per-user
  - 30-sharing-activities/02-viewing-usage
  - 20-building-activities/06-coding
  - 00-introduction/06-coding-overview
---

You share a coding activity exactly like any other: create the code and hand its link to your class. What is different is what happens after a student opens that link. There is no chat inside Novedu to greet them; instead, they sign in and pick up a personal key for their own coding tool.

## Sharing works like any other activity

Creating a coding code follows the same steps as any other code: pick the activity file, add a note, set an availability window if you want one, and select **Create code**. The code's page then shows the same share link every other kind of activity gets. Send it to your class however you'd share any other link: your learning platform, the projector, or the board. Students can also type the code on the Novedu start page.

## What a student sees

Opening the link asks a student to sign in with their school account, the same as any other activity. Because a coding activity has no chat page, the page then shows connection details instead of a conversation:

- the server address (base URL),
- a personal API key, theirs alone,
- a model name,
- for [little-coder](https://github.com/itayinbarr/little-coder), a ready-to-paste configuration file (`models.json`) and a run command.

Each detail has a copy button, so setting up the coding tool is copy, save, run. The key stays the same every time the student comes back, from any device, so they only need to set their tool up once.

The page also carries a notice a student cannot miss: requesting this activity's API key is recorded with their name for you, and that their coding conversations are never stored. Opening the page and signing in is what asks for the key, so make sure your class knows that in advance, the same way they know that reporting a conversation is not anonymous.

## What you see as the teacher

A coding code's own page (reached from the **Codes** list) shows your instructions and the pinned model, plus two things about connections:

- **Your own connection details.** You can get a personal key for yourself, the same kind a student gets, so you can test the endpoint end to end before handing out the code. It is not handed to you automatically: the page offers a **Get my API key** button, and only pressing it creates the key. Once you have one, the page shows your connection details straight away on every later visit.
- **Issued keys**, a read-only list of everyone who has requested a key for this code, with the time they requested it. There is no per-student conversation to open, because coding conversations are never stored; the list only tells you who is connected, not what they asked.

Getting your own key is recorded exactly like a student's, so the button carries the same notice: your name goes into the **Issued keys** list below it. That is why the key is behind a button rather than automatic. Simply opening a coding code's page records nothing, so you can review your activities without appearing in your own class list.

## Access control is the window, not the key

There is no button to take a single key away. Access to a coding activity works the same way as any other code:

- **The availability window.** The moment a code's window closes, every key issued for it stops working immediately, for every student, even ones who set their tool up days earlier. This makes a coding code a good fit for bounding AI help to your lesson time, or shutting it off for an exam. Reopen or extend the window and the same keys work again; nobody needs to reconnect their tool.
- **Deleting the code.** Deleting a coding code deletes every key issued for it along with everything else recorded under it. There is nothing left to revoke one student at a time; deleting the code turns every one of its keys off at once.

## The activity code itself opens nothing on its own

The code string you share is not, by itself, an API key. A student who only has the code and has not signed in gets nowhere: pasting a bare code into a coding tool does not work, only a personal key does. This means a leaked code grants nothing on its own, someone would still need to sign in with a school account to turn it into a working key.
