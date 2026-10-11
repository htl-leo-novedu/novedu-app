# `codes sync`: the publish loop for repo-based material

```
codes sync <registry-file> [--lock <path>] [--dry-run] [--json]
```

Material that lives in a git repo — a course, a book, a worksheet set — should
NOT accumulate hand-pasted codes. Keep one hand-written **registry** file next
to it and let `codes sync` do the minting. Keep `codes create` (see
[teacher-api.md](teacher-api.md)) for genuine one-offs.

Needs a signed-in teacher.

## The registry file

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/registry/registry-yaml.schema.json
# ddp-activities.yaml — hand-written, committed
base-url: "https://raw.githubusercontent.com/acme/course/refs/heads/main/"
activities:          # groups: quizzes | tutors | writing | coding | cloze
  quizzes:
    welcome:         # the KEY the material references; unique across all groups
      file: 0010-introduction/0010-welcome-quiz.yaml
      note: "Course: Welcome (0010)"
    exam:
      file: 0030-conditions/exam-quiz.yaml
      start: 2026-09-01T00:00:00+02:00     # offset or Z, whole seconds
      end: 2027-01-31T23:59:59+01:00
```

## The workflow

Write + `validate` the YAML → push → add ONE registry entry → `codes sync` →
commit registry **and** lock file → reference the key from the material. Never
paste a code by hand again.

```bash
npx @novedu/cli codes sync ddp-activities.yaml --dry-run   # what would happen
npx @novedu/cli codes sync ddp-activities.yaml             # writes the lock file
# → per-entry report; writes ddp-activities.lock.yaml (activity-codes: key → code)
# → commit ddp-activities.yaml AND ddp-activities.lock.yaml
```

## What an agent must know before running it

- **Re-running is the normal case, not a risk.** An entry that matches an
  existing code of yours — same URL, module, window and LLM override (provider,
  model and reasoning level); `note` is
  NOT part of matching — reuses it. Run `--dry-run` first when unsure; it mints
  and writes nothing.
- **Changing a window or an LLM override mints a NEW code.** The old one is
  never modified or deleted (the API has no update endpoint); it is reported as
  superseded and keeps working. Say this to the user *before* changing those
  fields — links already handed to students will not follow.
- **The lock file is generated: commit it, never edit it.** Keys sorted, one
  `activity-codes` map. Removing a registry entry drops the key from the lock;
  the server code stays and is reported as orphaned.
- **Exit 1 with a `failed` entry** means the server rejected that activity —
  usually the YAML at the URL. The other entries still synced, and the lock kept
  that entry's previous code. Fix the YAML, push, re-run.
- **Registry errors abort before ANY minting**, reported as JSON on stderr with
  the exact YAML path. Common ones: a group name other than the five above; a
  key that is not lowercase-kebab; a duplicate key across groups; `file:` without
  a `base-url` ending in `/`; a naive datetime; a window bound with milliseconds
  (the server stores whole seconds); and an entry with no fields at all — the
  shape a mis-indented entry takes, which is why it is an error rather than an
  ignored annotation.
- `--json` gives `{ entries: [{ key, module, fileUrl, action, code?, url?,
  error? }], warnings }` for scripting.
