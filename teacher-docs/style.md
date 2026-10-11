# Style (project voice)

The full rulebook is `references/style-and-voice.md` in the `novedu-teacher-docs`
skill. This file is where project-specific overrides and preferences go as they
emerge; keep it short.

## In one line

Write for a teacher, second person, active, task-first, short, and never use an
internal name (a file, function, route, or table). Explain a technical term once,
in place, the first time it matters.

## Reviewer

The current reviewer of the docs is the app author (an engineer). Accuracy
review is therefore strong, but the **audience is still the teacher**: write for
the teacher, not the reviewer.

## Preferences (add as they come up)

- Prefer real examples from `activities/examples/` over invented YAML.
- Prefer "activity" and "code" as the two core nouns; introduce module names
  (tutor, quiz, writing, coding) as *kinds of activity*.
- The **`50-develop-and-evaluate`** section is the one exception to "never an
  internal name": its readers run Novedu themselves, so commands, settings, file
  names, and test names are its subject. Voice and the hard writing rules still
  apply.
- SCCH is the school's **Austrian LLM hosting partner**, a company the school buys
  hosting from, not hardware the school runs. Expand it that way the first time a
  chapter needs it, then use "SCCH" or "the school's hosting partner". Never write
  "the school's own server", "self-hosted", or "in-house".
