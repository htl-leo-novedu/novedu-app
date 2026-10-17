---
title: Azure AI models with a hard budget
description: Give your school's Novedu GPT models from your own Azure subscription through OpenRouter, with a model allowlist and a budget that really stops requests.
sidebar:
  order: 3
audience: operator
keywords: [Azure, Azure OpenAI, OpenRouter, BYOK, bring your own key, budget, spending limit, hard limit, guardrail, allowlist, workspace, API key, OPENROUTER_API_KEY, GPT, school IT, operator]
related:
  - 20-building-activities/02-available-llms
  - 00-introduction/07-environments
  - 50-develop-and-evaluate/01-trying-novedu-locally
---

If your school wants its Novedu to run activities on GPT models from its own Azure subscription, and needs a spending limit that really stops requests, this chapter is for you. It's written for the person who runs the school's Novedu, usually someone in the school's IT team.

Azure hosts OpenAI's GPT models, but Azure doesn't offer a hard stop: an Azure budget sends a warning, while requests keep running and the bill keeps growing. A class that chats for a whole week on a model set to think hard can cost far more than anyone planned.

The setup in this chapter adds the hard stop. OpenRouter sits between Novedu and your Azure resource, and OpenRouter refuses every request once your budget is used up. Your Azure resource still does all the work and still bills your school's Azure subscription.

## How the Azure and OpenRouter setup fits together

The setup has three parts:

- **An Azure OpenAI resource** in your school's Azure subscription, with one deployment per GPT model. Azure answers every request and bills it to your subscription.
- **An OpenRouter workspace.** OpenRouter is a gateway that reaches AI models from many vendors through one account. A workspace is a separate area inside an OpenRouter account with its own keys, settings, and budget. The workspace holds your Azure key as a **BYOK** key ("bring your own key": OpenRouter forwards requests to your Azure resource instead of its own capacity), a list of allowed models, and the budget.
- **Your Novedu server**, which talks only to OpenRouter, with an OpenRouter API key from that workspace. Novedu never sees the Azure key.

When a student writes to a tutor that runs on one of these models, Novedu sends the request to OpenRouter. OpenRouter checks the key, the allowed models, and the budget, then forwards the request to your Azure resource, and the answer travels back the same way.

What the setup gives you:

- **A hard budget.** Once the workspace has spent its budget for the current period, OpenRouter refuses every further request until the next period starts.
- **Only the models you chose.** A teacher who names any other OpenRouter model gets an error instead of an answer.
- **One key per Novedu server.** You can revoke the key of one server without touching any other.
- **Azure stays your provider.** Every request runs on your own Azure resource, never on OpenRouter's capacity at another vendor.

Novedu can also connect to Azure directly, as the Azure Foundry provider. That direct route has no spending limit of its own, and Azure doesn't stop either, which is why this chapter routes Azure through OpenRouter.

## What you need for the Azure and OpenRouter setup

- An **Azure subscription** in which you may create an Azure OpenAI resource and deploy models.
- An **OpenRouter account** in which you can create a workspace, with a little credit in it. OpenRouter charges a small fee on BYOK requests (a percentage of its own list price, above a monthly free allowance) and takes it from that credit. OpenRouter's BYOK page lists the current terms.
- Access to your **Novedu server's settings**, to add one secret setting and restart the server.

OpenRouter's website changes from time to time, so a label in this chapter's steps may read slightly differently. OpenRouter's guides on [bring your own key](https://openrouter.ai/docs/guides/overview/auth/byok) and [guardrails](https://openrouter.ai/docs/guides/features/guardrails) describe the current screens.

## Step 1: Deploy the GPT models in Azure

1. In the Azure portal, create an **Azure OpenAI** resource in the region you want.
2. Deploy each model you want to offer. Name each deployment exactly like the model, for example `gpt-6-luna`.
3. Choose each deployment's type together with your school's data protection officer. A **Global Standard** deployment may process a request in any Azure region worldwide; a **Data Zone Standard** deployment of a resource in the EU keeps processing inside the EU. Not every model is available with every type.
4. Open the resource's **Keys and Endpoint** page and note the resource name. Keep the page open: in step 2 you copy one of its two keys straight into OpenRouter. Never save the key in a file or send it by email.

Each deployment has a quota of tokens per minute. The quota is the only brake Azure applies by itself, and it limits speed, not cost.

Anyone who holds the Azure key can use your Azure resource directly, outside the OpenRouter budget. Keep the key only in OpenRouter, and rotate it if it ever leaks (see "Rotate the keys of the Azure and OpenRouter setup").

## Step 2: Create the OpenRouter workspace and add the Azure key

1. In OpenRouter, create a new workspace for Novedu, so that its keys and budget stay separate from anything else your account does.
2. In the workspace's BYOK settings, add a key for the provider **Azure**: the resource name from step 1, one of the resource's keys, and the resource type **Azure OpenAI**.
3. Set the shared capacity fallback for Azure to **Never use shared capacity for any model on this provider**.

The shared capacity setting matters. Without it, OpenRouter may answer a request from its own capacity, paid from your OpenRouter credit and not running in your Azure resource, whenever your resource is busy or fails.

## Step 3: Allow only your GPT models

The workspace's **default guardrail** holds the rules that apply to every key in the workspace. A guardrail is a set of limits OpenRouter checks on every request. Open the workspace's guardrails and edit the default guardrail:

- **Allowed models:** the OpenRouter ids of the models you deployed in step 1, for example `openai/gpt-6-luna` and `openai/gpt-6.1-sol`. OpenRouter's id is the vendor, a slash, and the model name.
- **Allowed providers:** Azure only.

From now on, a request for any other model is refused, whichever key in the workspace sends it.

## Step 4: Set the budget of the OpenRouter workspace

1. Set the workspace budget: an amount in US dollars and a reset period (daily, weekly, or monthly). A weekly budget suits a school well, because a busy week can't use up the whole month.
2. Turn on **Include BYOK spend** for the budget.

**Include BYOK spend** is the switch that makes the budget work. By default, OpenRouter counts only what it charges to your OpenRouter credit, and BYOK requests are billed by Azure, so without the switch your budget would never stop anything.

OpenRouter counts each BYOK request at its own recorded price for that model, which can differ from what Azure actually invoices. Treat the budget as a close estimate: during the first weeks, compare it with the cost view of your Azure subscription and adjust the amount. Novedu's **Usage** page shows a third figure, **OpenRouter spend (estimate)**: that one server's tokens at OpenRouter's list prices, without OpenRouter's fee.

The workspace budget is one shared pool for every key in the workspace. If several Novedu servers share the workspace, each one can use up the budget for the others (see "Step 5: Create one OpenRouter key per Novedu server").

## Step 5: Create one OpenRouter key per Novedu server

1. In the workspace, create one API key for each Novedu server, for example one for a test server and one for the production server. Name each key after its server.
2. Copy the key straight into your Novedu server's secret settings as `OPENROUTER_API_KEY`, the same way your installation keeps its other secrets. Don't save the key anywhere else.
3. Restart the Novedu server so that it picks up the key.

Separate keys let you revoke one server's access without touching the other. All keys still draw on the same workspace budget, so heavy use of a test server can use up the budget the production server needs. To protect production, assign the test server's key its own guardrail with a smaller budget and **Include BYOK spend** turned on. A key's own guardrail adds to the workspace's default guardrail, so the allowed models still apply to it.

## Step 6: Check the Azure and OpenRouter setup

1. Sign in to Novedu as a teacher and open **Health** in the menu. The **OpenRouter models** line shows **OK**, which proves that OpenRouter accepts the key. It doesn't prove that only your models are allowed or that Azure answers.
2. Create a code for any tutor with an LLM override: on the create-code form, choose **OpenRouter · GPT-6 Luna (medium)** in the quick picks and select **Apply**, or type `OpenRouter` as the provider and one of your model ids as the model. Open the code and send a message. An answer comes back.
3. In OpenRouter, open the workspace's activity. The request is listed with Azure as the provider.
4. Edit the code and change the override's model to one that isn't on your list, for example `z-ai/glm-5.3-flash`. Send another message. No answer comes back, because OpenRouter refuses the model.
5. Delete the test code.

## Tell your teachers about the GPT models

Teachers need three things from you:

- **The model ids your server accepts**, and that they go with the provider `OpenRouter`, in an activity's `llm:` block or in a code's override.
- **The quick picks on the create-code form** name two OpenAI GPT models through OpenRouter. They work only if your allowed models include them; for any other model, teachers type the id themselves.
- **What happens when the budget is used up**: every activity on these models fails until the next budget period starts. Activities on other providers keep working, so a free provider stays the better choice for everyday work.

## When requests to the GPT models fail

When OpenRouter refuses a request, the activity gets no answer. The clearest error messages come from the Novedu CLI's grading tests (its `eval` command): each one names OpenRouter and the reason, and asks teachers to contact the operator, which is you.

- **"OpenRouter answered 404 for model"**: the model isn't on the workspace's list of allowed models, or the name is wrong. Compare the teacher's model id with your list.
- **"OpenRouter refused the request (upstream 403)"**: the budget is used up, or another guardrail rule refused the request. OpenRouter refuses every request until the next budget period starts. Raise the budget in the workspace, or wait.
- **"OpenRouter refused the server's credentials (upstream 401)"**: OpenRouter doesn't accept the server's key, for example because it was deleted. **Health** shows the same problem as **API key rejected**. Put a valid key into the server's settings and restart.
- **A model that worked yesterday is refused today**: OpenRouter's list of allowed models holds each model at a specific dated version. When OpenRouter moves a model id to a newer version, it may refuse requests until you add the new version to the list, and your Azure deployment may need an upgrade to the same version.
- **Every request fails after an Azure key change**: OpenRouter still holds the old Azure key. Update the BYOK key in the workspace.

## Rotate the keys of the Azure and OpenRouter setup

**An OpenRouter key:** create a new key in the workspace, put it into the server's settings as `OPENROUTER_API_KEY`, restart the server, check **Health**, and then delete the old key.

**The Azure key:** an Azure OpenAI resource has two keys so that you can switch without an interruption. Put the second key into the workspace's BYOK settings, check that a chat still answers, and then regenerate the first key in Azure.

## Data protection with Azure and OpenRouter

- Every request passes through OpenRouter on its way to Azure, so OpenRouter sees what students and teachers write. In OpenRouter's privacy settings, keep the logging of prompts and answers switched off. A guardrail can also enforce zero data retention for a group of models.
- Where Azure processes a request depends on the deployment type you chose in step 1.
- Decide both together with your school's data protection officer before students use the models.
