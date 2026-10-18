---
title: Creating a shared code
description: Turn an activity into a short link for your class, with a note, an availability window, and an optional model override.
sidebar:
  order: 1
audience: teacher
keywords: [code, share link, create code, note, availability window, model override, activity model, reasoning, codes create, owner]
related:
  - 30-sharing-activities/03-time-limitation
  - 30-sharing-activities/04-anonymous-vs-per-user
  - 30-sharing-activities/06-coding-special-case
  - 20-building-activities/02-available-llms
  - 40-ai-llms/01-novedu-cli
---

Once an activity is ready, you hand it to a class as a code: a short link that opens the activity for anyone who has it. Creating one takes a minute, and you can create as many codes for the same activity as you like, for example one per class.

## What you need first

The activity's YAML file must be reachable at a public web address. There are two ways to get one:

- **Host the file yourself**, for example in a public GitHub repository, and use the raw file address.
- **Upload it to Novedu's file store.** Every stored file gets a public address, and the file list offers a **Create code** shortcut that opens the create form with the kind and the address already filled in.

## Create the code

Novedu checks the activity file before storing anything. If the file has errors, the form lists them and no code is created; fix the file and submit again.

1. Open **Codes** and select **New code**.
2. Under **Activity**, pick the kind of activity: tutor, quiz, writing, or coding.
3. Paste the file's address into **Activity YAML URL**.
4. Add a **Note** for yourself, for example "3AHIF linked lists exercise". Only teachers see it; it labels the code in your list.
5. Set **Available from** and **Available until** if the code should only work during a certain time. Both fields use your local time, and either may stay blank to leave that side open. The **Now**, **+1h**, **+1d**, and **+1w** buttons fill common values.
6. Fill in the **LLM override** only if this one code should run on different AI settings than the activity file names.
7. Select **Create code**.

## The LLM override section

Above the override fields, the create and edit forms show the AI settings the activity file itself names in the read-only field **Activity's LLM (from the YAML)**: its provider, model, and reasoning level, or **provider default** when the file sets no level. The field fills in when the form opens with an address and again whenever you change **Activity YAML URL** and move on to another field, so you can see whether a code needs an override without opening the file. If Novedu can't read the file, the field says so instead; for a new code, selecting **Create code** checks the file and lists what's wrong.

The override section has three fields, with a quick-pick dropdown and two buttons below them:

- **LLM provider override** and **LLM model override**, two free-text fields. They always go together: fill in both, or leave both blank. The provider is one of `SCCH`, `Azure Foundry`, or `OpenRouter`, written exactly like that.
- **Reasoning (optional)**, a dropdown that starts on **Provider default** and offers the thinking-effort levels `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. A level only works alongside a provider and a model; on its own it is rejected. Not every model accepts every level, and some ignore the difference between them, so the chapter on choosing an AI model is worth reading before you set one.
- **Quick picks**, a dropdown of common combinations of a provider and a model. A pick only works if your school's server has that provider set up and accepts that model. Choosing one changes nothing yet: select **Apply** to fill the whole override with it. **OpenRouter · GPT-6 Luna (medium)**, for example, fills in the provider `OpenRouter`, the model `openai/gpt-6-luna`, and the level `medium`. A pick without a level puts the dropdown back on **Provider default**. The fields stay editable after **Apply**, and **Clear** empties all three, so the code uses the activity's own settings again.

The override replaces the activity file's whole `llm:` block for this code. If the activity file sets a reasoning level and you leave the dropdown on **Provider default**, the code runs without one. Repeat the level in the override whenever you want to keep it. The chapter on choosing an AI model explains the settings themselves.

One thing to keep in mind when you override: SCCH, the school's Austrian LLM hosting partner, doesn't bill per use, but Azure Foundry and OpenRouter are both paid per use, and a high thinking effort multiplies what a lesson costs on them. Pointing a code at either one is a spending decision as well as a quality one.

## What you get

Novedu generates the code text for you, a short random string; you can't choose your own. After creating it you land on the code's page, which shows the full link with a copy button. Share it however you reach your class: paste it into your learning platform, show it on the projector, or write it on the board. Students can also type just the code on the Novedu start page.

For a coding activity, opening that same link is how a student picks up the personal key their coding tool needs; the chapter on connecting a coding activity covers that step.

## What you can change later, and what's fixed

You can reopen any code from the list and edit three things at any time:

- the note,
- the availability window,
- the model override.

Three things are fixed when the code is created and never change: the kind of activity, the activity file's address, and whether the activity records who did what (anonymous or per-user, taken from the activity file at creation time). To share a different file, create a new code.

The code points at your file, not at a copy of it. If you edit the activity file itself, students get the new version the next time they open the link.

## Finding a code in the list

The Codes page holds every teacher's codes, and it opens on your own: the **Owner** box starts on your name. Pick **All owners** to see the whole staff room's codes, pick a colleague to see only theirs, or select **Clear** to come back to your own. You can also filter by note or code text and by kind of activity, and sort by any column header.

A code's owner is the teacher who created it, and that never changes. Every teacher can still open, edit, and delete any code, so ownership is a way to find your own work quickly, not a lock.

## Creating codes from the command line

If you're comfortable with a terminal, the Novedu CLI creates codes too, with the same checks as the web form. Sign in first with `novedu-cli login`, then:

```bash
npx @novedu/cli codes create --module quiz \
  --file https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/examples/sorting-algorithms/sorting-quiz.yaml \
  --note "3AHIF sorting quiz" \
  --start 2026-07-07T08:00:00Z --end 2026-07-07T10:00:00Z
```

`--start` and `--end` take ISO 8601 times with an explicit offset (the `Z` above means UTC) and may be left out for an open-ended code. `--llm-provider` and `--llm-model` set the model override, always together, and `--llm-reasoning` adds a thinking-effort level (`none`, `minimal`, `low`, `medium`, `high`, or `xhigh`) on top of that pair; without the pair it is rejected, and left out it drops whatever level the activity file sets. `novedu-cli codes list` shows your codes.
