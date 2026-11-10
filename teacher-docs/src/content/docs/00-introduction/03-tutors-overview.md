---
title: "Tutors: a chat that teaches your way"
description: What a tutor is, what students see in the chat, and how your written instructions shape the help it gives.
sidebar:
  order: 3
audience: teacher
keywords: [tutor, chat, AI tutor, starter questions, instructions, prompt, fragments, whiteboard, drawing]
related:
  - 20-building-activities/03-tutors
  - 00-introduction/04-quizzes-overview
  - 30-sharing-activities/04-anonymous-vs-per-user
---

A tutor is the simplest kind of activity in Novedu: a chat with an AI that follows your instructions, on a topic you choose. You decide what it teaches, how it talks to students, and where it draws the line. A well-written tutor explains ideas, asks guiding questions, and nudges students forward instead of doing the work for them.

You don't train an AI model to get this behaviour. You write a prompt, a set of plain-language instructions, and the tutor follows it. If the tutor answers in a way you don't like, you change the instructions and try again.

## What students experience

Students open a tutor and see a chat. Before the first message, the empty screen greets them: you can replace the default greeting with your own, and add a short description that tells students what this tutor helps with.

You can also offer clickable starter questions on the empty screen. A student picks one, the question lands in the chat input ready to edit, and the conversation begins. Starter questions are a gentle way to show students what the tutor is good at, especially for a class that has never talked to an AI tutor before.

From there it's a normal back-and-forth conversation. Students ask in their own words, the tutor answers within your rules, and they can dig deeper for as long as they need. Nobody is graded, and there is no fixed path through the material.

A tutor can also draw. If you give it the whiteboard tool, it sketches diagrams on a board next to the chat while it explains (above the chat on a phone), and changes the same drawing when a student asks a follow-up, for example to highlight one step. Students only look at the drawing; the tutor does the drawing.

Students can also start a tutor conversation over. A button above the chat clears what they've discussed and begins a fresh conversation, and it asks them to confirm first. In an anonymous tutor that earlier conversation is gone for the student; in a per-user tutor they can reopen it later and continue. It helps when a conversation has drifted off topic, or when a student wants to approach a question again from the beginning. The tutor won't remember anything from the earlier conversation, but you still see that conversation under the code, and a student who chats both before and after starting over counts as two conversations in your statistics.

Reloading the page doesn't lose the conversation: as long as the student stays in the same browser tab, a reload brings back the current conversation if the last message was less than an hour ago. In a per-user tutor, students can also reopen any of their earlier conversations with that tutor and pick up where they left off.

## How you shape a tutor

Everything the tutor does comes from instructions you write. Typical instructions cover:

- **Who it is and what it teaches.** For example, a friendly tutor for sorting algorithms, aimed at 16-year-olds who know basic TypeScript.
- **How it teaches.** For example, ask guiding questions, give hints before solutions, and have students predict the next step before revealing it.
- **What it must not do.** For example, never hand over the finished solution, stay on the allowed topics, and avoid concepts the class hasn't learned yet.

You write these instructions in your own words. For rules you want to apply across many tutors, such as a teaching style or a safety policy, you can also pull in a fragment, a named piece of prompt written once and reused. That way a whole team of teachers shares one carefully worded safety policy instead of each rewriting it.

By default, tutor chats are anonymous: the app doesn't record which student had which conversation. The trade-off: since nothing links a conversation to a student, students can't go back to an earlier conversation either.

## When a tutor is the right choice

Pick a tutor when students need open-ended help: preparing for a test, practising a skill, getting unstuck on homework, or exploring a topic at their own pace. It shines where a conversation beats a worksheet.

A tutor doesn't assess anything. When you want students to answer set questions and receive graded feedback, build a quiz instead. When students should produce a text of their own with an AI coach beside them, build a writing activity.
