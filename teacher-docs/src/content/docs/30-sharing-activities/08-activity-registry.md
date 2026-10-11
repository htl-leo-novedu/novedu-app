---
title: "Many activities at once: the activity registry"
description: Keep every activity of a course in one registry file and let the CLI mint and refresh all its codes in a single command.
sidebar:
  order: 8
audience: teacher
keywords: [registry, codes sync, lock file, many quizzes, course material, book, activity-codes, key]
related:
  - 30-sharing-activities/01-creating-codes
  - 40-ai-llms/01-novedu-cli
  - 10-yaml-for-teachers/04-cli-validation
  - 30-sharing-activities/03-time-limitation
  - 30-sharing-activities/05-deleting-codes
  - 20-building-activities/02-available-llms
---

With one or two activities, creating a code by hand is quick and there is nothing to organise. With twenty, it stops working. Every new quiz means the same ritual: check the file, build its address, create the code, copy the code, paste it into the chapter that links to it. Nothing in your material says which code belongs to which activity file, so a year later the only way to find out is to open each code in Novedu and compare addresses.

The activity registry solves that. You write one file that lists every activity of your course under a short name you choose. One command reconciles that list with Novedu: activities that already have a code keep it, activities without one get a new code. The command writes a second file that maps your names to the codes, and your material refers to activities by name instead of by code.

The registry is a command-line feature. There is no registry page in Novedu, and the app knows nothing about your names: they live only in the two files in your repository. For a single activity, the create form in Novedu stays the simpler path.

## What you need

The registry lives next to your material, usually at the top of the git repository that holds it. To use it you need:

- The Novedu CLI, ready to run and signed in with your teacher account. The introduction chapter on the Novedu CLI and its AI skill covers what the CLI is and how to set it up. Sign-in is one browser step, and every later command runs without asking again.
- Your activity files reachable at a public web address, for example the raw addresses of a public GitHub repository, or addresses from Novedu's file store.

## Write the registry file

The registry is plain YAML. Give it any name you like, for example `ddp-activities.yaml`, and commit it with your material.

```yaml
# The address every relative file is resolved against. It must end with a slash.
base-url: "https://raw.githubusercontent.com/rstropek/ddp-ts-p5-beginner-course/refs/heads/main/"

activities:
  quizzes:
    welcome:
      file: 0010-introduction/0010-welcome-quiz.yaml
      note: "Creative Coding book: Welcome (0010)"
    number-systems:
      file: 0030-conditions/0050-number-systems-quiz.yaml
      start: 2026-09-01T00:00:00+02:00
      end: 2027-01-31T23:59:59+01:00
  tutors:
    sorting:
      url: https://app.novedu.at/api/files/sorting-tutor
```

The example is the real registry shape used by the Creative Coding book, a TypeScript course where most chapters end with a quiz.

**The groups decide the kind of activity.** There are five, and each one may be left out: `quizzes` for quizzes, `tutors` for tutors, `writing` for writing activities, `coding` for coding activities, and `cloze` for cloze exercises. A group name that is not one of these five is an error, so a typo can never silently drop half your course.

**Each entry says where the activity file is**, in one of two ways: `file` for a path relative to `base-url`, or `url` for a complete address. Use one or the other, not both. If you use `file` anywhere, `base-url` must be set and must end with a slash.

**Everything else in an entry is optional:**

- `start` and `end` set the availability window, written as a full date and time with a time zone offset, for example `2026-09-01T00:00:00+02:00`, or `Z` for UTC. These are the same window rules the create form uses.
- `note` is your own label for the code, up to 200 characters. Only teachers see it.
- `llm` sets a model override for this one code, with `provider` and `model` always given together and an optional `reasoning` level (`none`, `minimal`, `low`, `medium`, `high`, or `xhigh`) on top of them. The `provider` must be one of `SCCH`, `Azure Foundry`, or `OpenRouter`; any other name is an error, so a misspelt provider can never reach a code:

  ```yaml
  llm:
    provider: Azure Foundry
    model: gpt-5.6-terra
    reasoning: low
  ```

You can also add your own extra lines to an entry, for example a chapter number. Anything the registry does not recognise is ignored, so annotate freely.

## Choose good names

The name in front of each entry (`welcome`, `number-systems`, `sorting` in the example) is yours to pick, and it is what your material will refer to. Two rules apply:

- Lowercase letters, digits, and hyphens only, up to 64 characters.
- Unique across the whole file, not just within a group. One list of names covers all five groups.

Pick names that will still make sense next year: a chapter slug usually beats a number.

## Run the command

From the folder that holds the registry:

```bash
npx @novedu/cli codes sync ddp-activities.yaml
```

The report lists every entry with what happened to it:

```
ddp-activities.yaml: 3 entries
  reused    welcome         cu4afwoa23  https://app.novedu.at/cu4afwoa23
  minted    number-systems  hb34gpvahn  https://app.novedu.at/hb34gpvahn
  reused    sorting         nlc90ezf5z  https://app.novedu.at/nlc90ezf5z

2 reused, 1 minted, 0 failed
Lock file: ddp-activities.lock.yaml
```

- **reused** means one of your existing codes already matches that entry, so nothing was created.
- **minted** means a new code was created. Novedu checks the activity file first, exactly as the create form does.
- **failed** means Novedu rejected that one activity, usually because its file has an error or is not reachable. The other entries still sync, the command ends with an error exit code, and the failed entry keeps the code it had before, so your material does not break while you fix the file.

Add `--dry-run` to see the same report without creating anything and without writing any file. It is the safe way to try a change to the registry.

## Commit the lock file

Next to the registry, the command writes a second file with `.lock.yaml` in its name, for example `ddp-activities.lock.yaml`:

```yaml
# Generated by @novedu/cli — do not edit.
# Regenerate with: novedu-cli codes sync ddp-activities.yaml
activity-codes:
  number-systems: hb34gpvahn
  sorting: nlc90ezf5z
  welcome: cu4afwoa23
```

Commit this file together with the registry. It is generated: never edit it by hand, because every run rewrites it completely. The names are sorted, so two runs that change nothing produce exactly the same file and your version history stays quiet.

## What happens when you run it again

Running the command again is the normal workflow, not something to be careful about. Whether an entry keeps its code or gets a new one follows three rules:

- **Nothing changed, nothing happens.** An entry whose activity file, availability window, and model override still match one of your codes reuses that code. Editing the activity file itself changes nothing here: a code always points at the file's address, so students get your edits without a new code.
- **A new window, or any change to the model override, means a new code.** That includes the reasoning level on its own: the same provider and model at a different thinking effort is a different code. The command never edits or deletes an existing code, so it creates a second one and reports the old one as superseded. The old code keeps working and keeps its statistics until you delete it in Novedu, which matters because links you have already handed to students still point at it.
- **A different note changes nothing.** The note is a label for you, so it is not part of what makes a code match. Novedu keeps the note the code was created with.

Removing an entry from the registry drops its name from the lock file on the next run. The code itself is untouched and still works; the command mentions it so you can decide whether to delete it.

## Use the names in your material

The point of the lock file is that your material never contains a code. In a Quarto book, register the lock file as document metadata:

```yaml
# in _quarto.yml
metadata-files:
  - ddp-activities.lock.yaml
```

The book's quiz shortcode then takes a name and looks it up in `activity-codes`, so a chapter reads:

```markdown
{{< quiz welcome title="Welcome" >}}
```

The name says what it links to, and a reader of the source can find the matching entry in the registry. The build only reads the committed lock file, so rendering the book works offline and never depends on Novedu being reachable. If a name is missing from the lock file, the build fails with a clear message instead of publishing a dead link.

Any other publishing system works the same way, as long as it can read a small YAML file at build time.

## The everyday loop

Once the registry is in place, adding an activity is five short steps:

1. Write the activity file and check it with `novedu-cli validate`.
2. Push it, so its public address serves the new file.
3. Add one entry to the registry with a new name.
4. Run `npx @novedu/cli codes sync ddp-activities.yaml`.
5. Commit the registry and the lock file, and refer to the activity by its name.

No code is ever copied by hand again.

## Options at a glance

| Option | What it does |
| --- | --- |
| `--dry-run` | Show the report without creating codes or writing the lock file. |
| `--json` | Print the report as machine-readable data, for scripts. |
| `--lock <path>` | Write the lock file somewhere other than next to the registry. |
| `--server <url>` | Talk to another Novedu server than the default one. |
