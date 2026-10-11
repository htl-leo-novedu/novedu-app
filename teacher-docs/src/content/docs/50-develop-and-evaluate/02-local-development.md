---
title: Local development
description: Set up a Novedu development environment from the source code without a school account or AI keys, and run every test that works without them.
sidebar:
  order: 2
audience: developer
keywords: [develop, contribute, source code, clone, npm, Node.js, Docker, Postgres, demo login, fake model, tests, e2e, Playwright, .env.local]
related:
  - 50-develop-and-evaluate/01-trying-novedu-locally
  - 20-building-activities/02-available-llms
---

You can work on Novedu's source code without a Microsoft school account and without any AI key. Your development setup uses the **demo login** instead of the Microsoft sign-in (four demo people, one click each) and a **fake AI model** instead of a real one. Docker runs the database and the fake model; the Novedu app itself runs from your copy of the source code.

The commands in this chapter are written for a macOS or Linux terminal. On Windows, use them in WSL (the Windows Subsystem for Linux) or Git Bash.

## What you need

- **Git**, to get the source code.
- **Node.js 24** or newer, to run the app and the tests.
- **Docker** with Docker Compose, for the database and the fake model. On Windows and macOS, install [Docker Desktop](https://docs.docker.com/desktop/).
- A code editor, for example Visual Studio Code.

## Get the source code

1. Clone the repository and change into it:

   ```bash
   git clone https://github.com/htl-leo-novedu/novedu-app.git
   cd novedu-app
   ```

2. Install the dependencies:

   ```bash
   npm ci
   ```

3. Install the Chromium browser that the browser-based tests use. On Linux, add `--with-deps` to install the system libraries it needs as well:

   ```bash
   npx playwright install chromium
   ```

## Start the database and the fake model

The repository's `compose.yaml` describes a complete local Novedu. For development you start only two of its parts, the Postgres database and the fake AI model, because the app runs from your source code:

```bash
docker compose up -d --wait postgres fake-llm
```

Start these two before the app: the app asks the fake model for its list of models once, when it starts.

If you also run the complete local Novedu from the chapter on trying Novedu locally, stop it first with `docker compose down` in its folder. Both setups use the same Docker names, so they share one database, and the complete local Novedu's app occupies port 3000.

The database belongs to the demo login. A Novedu with the Microsoft sign-in refuses to use it, and a demo Novedu refuses a database that a Microsoft sign-in has used, so each sign-in mode needs its own database.

## Configure the app

The app reads its settings from a file named `.env.local` in the repository folder. The file is never committed.

1. Create a secret for signing sessions:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

2. Create a folder for uploaded images outside the repository and prepare it. Replace the path with your own:

   ```bash
   npm run images:init-root -- /home/you/novedu-images
   ```

3. Create `.env.local` with this content, using your secret and your image folder:

   ```text
   NOVEDU_AUTH_MODE=demo
   AZURE_CLIENT_ID=
   AZURE_CLIENT_SECRET=
   AZURE_TENANT_ID=
   TEACHER_GROUP_ID=
   AUTH_SECRET=your-secret
   DATABASE_URL=postgresql://novedu:novedu-demo-not-a-secret@localhost:5432/novedu
   SCCH_BASE_URL=http://127.0.0.1:4010/v1
   SCCH_API_KEY=fake-llm
   IMAGE_STORAGE_ROOT=/home/you/novedu-images
   ```

What the settings do:

- `NOVEDU_AUTH_MODE=demo` turns on the demo login. The four empty Microsoft sign-in settings must stay empty: a demo Novedu refuses to start if any of them has a value.
- `DATABASE_URL` points at the database from Docker. Its password is public on purpose; it protects nothing but sample data.
- `SCCH_BASE_URL` and `SCCH_API_KEY` send every request for the school's hosting partner SCCH to the fake model instead.
- `IMAGE_STORAGE_ROOT` is where uploaded images go.

## Run the app

1. Start the development server:

   ```bash
   npm run dev
   ```

2. Open [http://localhost:3000](http://localhost:3000) and select one of the demo people, for example **Anna Berger · Teacher**.

Every chat reply now comes from the fake model and says so: "This reply comes from Novedu's fake LLM, not a real model", followed by what you wrote. The fake model grades every quiz answer as correct.

The sign-in mode is fixed when the development server starts. After changing `NOVEDU_AUTH_MODE` or another setting, stop `npm run dev` and start it again.

To try real models as well, add an OpenRouter key to `.env.local` as `OPENROUTER_API_KEY=…` and restart the development server. The chapter on trying Novedu locally describes how to get a key with a small budget. Activities that name no provider keep using the fake model.

## Run the tests

All tests in this section run without a Microsoft school account and without AI keys. Stop `npm run dev` before the end-to-end tests, because they start their own server on port 3000.

### Checks and unit tests

These need nothing but the installed dependencies:

```bash
npm run check       # code style and lint rules
npm run typecheck   # TypeScript, for the app, the CLI and the docs site
npm run test        # unit and browser component tests
npm run test:cli    # the Novedu CLI
```

`npm run qa` runs all four, plus a production build of the app and of the docs site, in one go.

### End-to-end tests with the Microsoft sign-in build

Most end-to-end tests run against the normal Novedu, the one with the Microsoft sign-in. They don't sign in through Microsoft: they create their sessions directly in the database, so placeholder values for the sign-in settings are enough. They start their own fake model, too.

The normal Novedu needs a database of its own, because the demo database is refused. Create a second database in the same Postgres once:

```bash
docker compose exec postgres createdb -U novedu novedu_test
```

Then run the tests. The settings on the command line take precedence over your `.env.local`:

```bash
NOVEDU_AUTH_MODE=entra \
AZURE_CLIENT_ID=placeholder AZURE_CLIENT_SECRET=placeholder \
AZURE_TENANT_ID=placeholder TEACHER_GROUP_ID=placeholder \
DATABASE_URL=postgresql://novedu:novedu-demo-not-a-secret@localhost:5432/novedu_test \
npm run test:e2e:ci
```

A full run takes a few minutes.

### End-to-end tests of the demo login

The demo login has its own small set of end-to-end tests. They run against a production build of the demo Novedu and use the demo database, so with the `.env.local` above, one command is enough:

```bash
npm run test:e2e:ci
```

The production build takes a few minutes before the first test starts.

### When a test fails

Under the load of a full run, a single browser test now and then misses its time limit on a slower computer. Run the failed test file on its own, with the same settings as before, to check whether the failure is real:

```bash
npm run test:e2e:ci -- e2e/permissions.spec.ts
```

### Tests that need real services

A few test groups need real services and don't run in this setup: the tests against real AI models (`npm run test:e2e:live-llm`), the test against a mounted file share, and the test against the Azure telemetry service. `npm run test:e2e:ci` leaves them out. The project's automated checks on GitHub run the same tests as this section, so a change that passes here usually passes there too.

## Reset the database

To start over with an empty database, delete the Docker data and start the two parts again:

```bash
docker compose down -v
docker compose up -d --wait postgres fake-llm
```

Create the test database again afterwards if you run the end-to-end tests.
