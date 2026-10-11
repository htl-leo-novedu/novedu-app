---
title: Choosing an AI model for your activity
description: Set the model, the provider, and the thinking effort in an activity's llm block, and override the whole block per code without editing the YAML.
sidebar:
  order: 2
audience: teacher
keywords: [AI model, LLM, provider, SCCH, Azure Foundry, OpenRouter, llm block, model override, reasoning, thinking effort, cost]
related:
  - 30-sharing-activities/01-creating-codes
  - 30-sharing-activities/02-viewing-usage
  - 10-yaml-for-teachers/04-cli-validation
---

Every activity tells Novedu which AI model should run it. You set that in the `llm:` block of the activity's YAML file. The block has three fields: a required `model`, an optional `provider`, and an optional `reasoning` level.

```yaml
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
```

That's the whole block in most activities, taken from the sorting-algorithms sample tutor. The same block works in tutors, quizzes, writing activities, coding activities, and cloze exercises.

## The three providers

The provider decides where the AI runs. There are three choices:

- **SCCH**, the school's Austrian LLM hosting partner: the default. If you leave out `provider`, your activity runs there. On SCCH, `model` is a raw model id, like the one in the sample above.
- **Azure Foundry**: runs the activity on an Azure deployment your school has set up. With this provider, `model` names the Azure deployment, not a raw model id.
- **OpenRouter**: a gateway that reaches models from many different vendors through a single account, so one provider opens a broad catalogue. With this provider, `model` is OpenRouter's own id for the model, always a vendor name and a model name with a slash between them, for example `z-ai/glm-5.3-flash`, `openai/gpt-5-mini`, or `anthropic/claude-sonnet-4.5`.

An activity that runs on Azure looks like this:

```yaml
llm:
  model: gpt-5.4-mini
  provider: Azure Foundry
```

And one that runs through OpenRouter looks like this:

```yaml
llm:
  model: z-ai/glm-5.3-flash
  provider: OpenRouter
```

Write the provider name exactly as it appears here, capital letters included. `SCCH`, `Azure Foundry`, and `OpenRouter` are the three names Novedu accepts; anything else is rejected when you save.

Azure Foundry and OpenRouter are both optional, and each school decides whether to set them up. If yours hasn't, all activities simply run at SCCH, the school's Austrian LLM hosting partner, and Novedu tells you in plain words that the provider isn't configured on this server when you try to save an activity or a code that asks for it.

## What each provider costs

**Azure Foundry and OpenRouter should be used with care, because they are billed per use**: what runs on Azure Foundry is charged to your school's Azure account, and what runs through OpenRouter is charged to your school's OpenRouter account. SCCH, the school's Austrian LLM hosting partner, is covered by a partnership agreement and costs nothing per use.

That is why SCCH is the default, and why it's the right home for everyday classroom work: a class of 30 students chatting there for a full lesson doesn't add anything to a bill.

On a paid provider, every student message, every answer the model writes, and every bit of thinking it does on the way there is charged. A single busy lesson can cost real money, and a model set to think hard can cost several times what the same lesson costs at a lower effort.

So treat the paid providers as the exception rather than the habit:

- Run everyday activities at the school's hosting partner.
- Reach for Azure Foundry or OpenRouter when an activity genuinely needs it, for example a subject where the partner's models keep getting things wrong.
- On a paid provider, set the thinking effort deliberately and start low. Watch what an activity actually uses on the code's usage page before you hand it to a big class.

## How hard the model thinks

Some models can spend extra effort working an answer out before they write it. The optional `reasoning` field says how much of that effort you want:

```yaml
llm:
  model: gpt-5.6-terra
  provider: Azure Foundry
  reasoning: low
```

The levels, in rising order of effort, are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. They mean the same thing on all three providers. More effort means the model writes more thinking before its answer, which makes students wait longer, counts towards the activity's usage, and costs more on a paid provider. A low level is a good starting point for a classroom activity, and a higher one is worth trying when the AI keeps getting a tricky subject wrong.

When a model writes its thinking out, you see that thinking appear in the chat while the answer is being prepared. Students never see it, on any provider, and it isn't kept in the conversation afterwards: it is a live view for teachers only.

Leave `reasoning` out and the model decides for itself. There is no level Novedu fills in behind your back: the setting is simply not sent, and the model uses its own default.

`none` is the one level that isn't just "think less". It switches thinking off completely, so the model answers straight away. Leaving the field out and setting `none` are two different things: left out, a thinking model keeps thinking at its own default; set to `none`, it stops. If a model feels slow for a simple task, `none` is what makes it quick.

## The same level means different things to different models

What a reasoning level actually does depends on the model you picked, and there are three behaviours you'll meet.

**Some models have a real range.** Qwen 3.8, one of the models at the school's Austrian LLM hosting partner SCCH, thinks steadily longer as you go from `low` to `medium` to `xhigh`, and at `xhigh` it writes roughly two and a half times the thinking it writes at `low`. The gpt-5.x deployments on Azure work the same way. On these models the level is a genuine dial, and on a paid provider it's also a cost dial.

**Some models only have an on/off switch.** Gemma 4 at the school's hosting partner accepts every level, but only `none` changes anything. Asking it for `high` instead of `low` gives you the identical answer, so the useful choice there is thinking on or thinking off, nothing in between.

**Some models refuse a level outright.** Qwen 3.8 accepts only `none`, `low`, `medium`, and `xhigh`, and answers with an error if you ask for `minimal` or `high`. On Azure it varies per deployment: one gpt deployment refuses `minimal` while another is happy with it. Through OpenRouter it varies per model, because each vendor in the catalogue sets its own rules. A refused level doesn't show up when you save the file. It fails when a student starts working, in the same way a wrong model name does.

You can't tell from the app which of the three groups a model belongs to, so try the activity once yourself after you set a level. Send a question that needs real thought, check that an answer comes back at all, and see whether a higher level makes the answers better before you leave it there.

At the school's hosting partner some models come as two separate entries instead, one with reasoning on and one with it off. There you pick the behaviour by choosing the model name, and you can leave `reasoning` out entirely.

## Which model names can I use?

There is no fixed list to print here: the available models are set up by your school and change over time. Two reliable places to look:

- **The sample activities** your school shares (for example the ones under `activities/examples/` in the Novedu repository). They always name a model that works.
- **The preset buttons on the create-code form.** When you create a code, the form offers one-click presets that fill in a known-good provider and model, and a level for the presets that name a reasoning model. There is a preset per provider, including **OpenRouter · GLM 5.3 Flash**, which is a quick way to see the shape of an OpenRouter model id.

For OpenRouter there is a third place: OpenRouter publishes its whole catalogue on its own website, and the id shown there is exactly what goes into `model`.

The `model` field is free text, so a typo isn't caught when you save the file. A wrong name only fails when a student starts chatting, so copy a model name from a working sample rather than typing it from memory.

If you validate your YAML with the Novedu CLI, keep the CLI current: an older copy doesn't know the newer provider names and rejects a file that uses one. Running it as `npx @novedu/cli@latest` fetches the current version instead of an old one from your computer's cache.

## Override the model per code, without editing the YAML

The `llm:` block is only the activity's default. When you create or edit a code (the short link you hand to a class), the form lets you override it for that one code. The YAML file stays untouched, so the same activity can run once at the school's hosting partner and once on Azure, just by creating two codes.

A few things to know about the override:

- **Provider and model are both or nothing.** You set the two together, or neither. A half-filled pair is rejected when you save.
- **The reasoning level rides on top of them.** You can add a level to the pair, but you cannot set a level on its own; without a provider and a model, there is nothing for it to apply to.
- **The override replaces the whole block.** It doesn't merge with the activity file. If the file sets `reasoning: high` and your override leaves the level on "Provider default", the code runs without any level at all. Repeat the level in the override whenever you want to keep it.
- **Presets fill it in one click.** The form offers buttons for common combinations, and each button fills the whole override: a preset for a reasoning model also sets its level, a preset for a plain model clears the level again. **Clear** removes the override and returns the code to the activity's own `llm:` settings.
- **You can change it later.** Unlike the activity file, the override isn't frozen; edit the code any time to switch models or effort.
- **Only the AI settings change.** Everything else, such as the instructions and the anonymity setting, still comes from the YAML file. If your tutor lets students upload images, pick an override model that can read them.
