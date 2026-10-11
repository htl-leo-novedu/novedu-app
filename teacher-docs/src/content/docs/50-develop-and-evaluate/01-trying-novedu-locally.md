---
title: Trying Novedu locally
description: Run your own Novedu on your computer with Docker, with no school account and no AI provider, and add a low-budget OpenRouter key to try real models.
sidebar:
  order: 1
audience: evaluator
keywords: [try Novedu, Docker, Docker Compose, local, demo, evaluate, fake model, OpenRouter, API key, compose.yaml]
related:
  - 50-develop-and-evaluate/02-local-development
  - 20-building-activities/02-available-llms
  - 30-sharing-activities/01-creating-codes
---

You can run a complete Novedu on your own computer to look around before your school sets it up, or to try an idea without touching a real class. Your local Novedu needs no school account and no AI provider. One file and one command start it.

Your local Novedu is a **demo installation**: instead of the Microsoft sign-in, the sign-in page offers four demo people, two teachers and two students, one click each. Anyone who can open the page can sign in as any of them, so a local Novedu is for trying things out with sample data, never for real students.

## What you need

- **Docker** with Docker Compose. On Windows and macOS, install [Docker Desktop](https://docs.docker.com/desktop/). On Linux, install Docker Engine with the Compose plugin.
- About 2 GB of free disk space and an internet connection for the first start.

To check your Docker installation, open a terminal and run:

```bash
docker compose version
```

If the command prints a version, you're ready.

## Start your local Novedu

Novedu's Docker setup is a single file called `compose.yaml`. It describes four parts that start together: the Novedu app, a database, a stand-in for an AI model, and a one-time step that prepares the folder for uploaded images.

1. Create an empty folder, for example `novedu-local`, and open a terminal in it.
2. Download `compose.yaml` into the folder. On macOS and Linux:

   ```bash
   curl -fsSLO https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/main/compose.yaml
   ```

   On Windows, in PowerShell:

   ```powershell
   curl.exe -fsSLO https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/main/compose.yaml
   ```

3. Start Novedu:

   ```bash
   docker compose up -d --wait
   ```

   The first start downloads the Novedu images, which takes a few minutes. The command returns when everything is running.
4. Open [http://localhost:3000](http://localhost:3000) in your browser and select **Sign in** at the top right.
5. Select **Anna Berger · Teacher** to sign in as a demo teacher.

The demo people are Anna Berger and Lukas Huber (teachers) and Mia Gruber and Noah Wagner (students). Each one keeps their own codes, files, and conversations, so you can see how two teachers or two students experience Novedu.

On a Mac with an Apple chip, the Novedu app runs in emulation. Your local Novedu starts more slowly there but otherwise works the same.

## The fake AI model

Your local Novedu doesn't talk to a real AI model. A fake model stands in for one, so every activity works without any AI provider and without cost. The fake model says openly what it is: every chat reply starts with "This reply comes from Novedu's fake LLM, not a real model" and then repeats what you wrote.

- Tutors, writing feedback, and coding activities all get the fake reply.
- The fake model grades every quiz answer as correct.
- Any model name in an activity works. The fake model answers all of them, and lists itself as `novedu-fake`.

The fake model is enough to try out how codes, activities, statistics, and reports work. To see real answers, add an OpenRouter key (see "Try real AI models with an OpenRouter key" below).

## Try a first activity

The quickest way to a running activity is an example from the Novedu repository on GitHub. Your local Novedu loads it straight from GitHub.

1. Sign in as **Anna Berger · Teacher**.
2. Open the menu, select **Codes**, and then select **New code**.
3. Paste this address into **Activity YAML URL**:

   ```text
   https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/main/activities/examples/sorting-algorithms/sorting-tutor.yaml
   ```

4. Select **Create code** and copy the share link.
5. Open a private browser window and paste the share link there. Novedu asks you to sign in first: select **Mia Gruber · Student**, and the tutor opens.
6. Write a message to the tutor. The fake model answers.

Back in Anna's window, select **Codes** in the menu and then the new code to open its statistics page, which lists Mia's conversation. To write your own activity, select **YAML Files** in the menu and create a file there; the chapters on building activities explain the fields.

## Try real AI models with an OpenRouter key

OpenRouter is a paid service that gives you access to AI models from many vendors with one account. With an OpenRouter key, your local Novedu can run activities on real models, while everything else keeps using the fake model. You pay OpenRouter per use, so set a small budget first.

1. Create an account at [openrouter.ai](https://openrouter.ai).
2. Buy a small amount of credit, for example 5 or 10 US dollars. A short trial of a few chats with an inexpensive model costs a few cents.
3. Create an API key. Give the key a **credit limit**, for example 2 US dollars, so the key stops working once it has spent that much.
4. In your `novedu-local` folder, create a text file named `.env` with one line, your key in place of the placeholder:

   ```text
   OPENROUTER_API_KEY=sk-or-your-key
   ```

5. Restart Novedu so that it picks up the key:

   ```bash
   docker compose up -d --wait
   ```

6. Sign in as a teacher and open **Health** in the menu. The **OpenRouter models** line shows **OK** and the number of models available.

Now choose a real model for a code: on the create-code form, select the preset **OpenRouter · GLM 5.3 Flash**, or type `OpenRouter` as the provider and an OpenRouter model id as the model. In an activity file, the same choice is `provider: OpenRouter` and the model id in the `llm:` block. OpenRouter lists every model with its id and its price on its website.

Some OpenRouter models also come as a free version, marked by `:free` at the end of the model id. Free versions need no credit but allow only a limited number of requests per day, and which models have one changes over time.

Keep the key private: anyone with it can spend your credit. When you're done trying, delete the key on the OpenRouter website.

## Stop, update, and reset

All commands run in the folder that holds `compose.yaml`.

- **Stop** your local Novedu: `docker compose stop`. Your data stays, and `docker compose up -d --wait` starts it again.
- **Update** to the newest Novedu: `docker compose pull`, then `docker compose up -d --wait`. Your data stays.
- **Reset** everything, including all codes, files, images, and conversations: `docker compose down -v`.

## Change the ports

Your local Novedu uses the ports 3000 (the app), 5432 (the database), and 4010 (the fake model) on your computer. If another program already uses one of them, choose a different port in a text file named `.env` next to `compose.yaml`, for example:

```text
NOVEDU_PORT=3100
NOVEDU_PG_PORT=5433
NOVEDU_FAKE_LLM_PORT=4011
```

Start Novedu again with `docker compose up -d --wait` and open the new address, for example `http://localhost:3100`.

## Keep your local Novedu private

Your local Novedu is reachable only from your own computer, on purpose: because anyone who can open it can sign in as anyone, it must never be reachable from a network. Use sample data only, never real student names or work. For a Novedu your school uses with real classes, see the Novedu environments chapter and talk to your Novedu administrator.

## Use the Novedu CLI with your local Novedu

The Novedu CLI, the command-line tool for checking and publishing activities, works with your local Novedu too. Sign in with the address of your local Novedu:

```bash
npx @novedu/cli@latest login --server http://localhost:3000
```

The CLI prints a link and a short code and opens the link in your browser. Sign in there as a demo teacher, for example **Anna Berger · Teacher**, check that the code matches, and select **Approve**. After that, every CLI command works with your local Novedu as long as you add `--server http://localhost:3000` to it.

Grading tests (the CLI's `eval` command) run against your local Novedu as well. With the fake model they only show that the test file and the steps work: the fake model grades every answer as correct, so a test that expects an incorrect answer fails. To test how a quiz really grades, add an OpenRouter key (see "Try real AI models with an OpenRouter key") and run the test on a real model:

```bash
npx @novedu/cli@latest eval my-quiz.eval.yaml --server http://localhost:3000 \
  --llm-provider OpenRouter --llm-model z-ai/glm-5.3-flash
```
