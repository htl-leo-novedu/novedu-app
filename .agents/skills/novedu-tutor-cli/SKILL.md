---
name: novedu-tutor-cli
description: >-
  Use `novedu-cli`, the Novedu chat app's command-line companion, for anything
  touching Novedu activity YAML or the Novedu server — it is the source of
  truth for what the app accepts, so run it instead of reading YAML by eye or
  re-deriving validation rules. Trigger it whenever the user wants to validate,
  lint, or debug any activity file (tutor, fragment library, quiz, writing,
  coding, cloze, or eval); dump the exact prompts the LLM receives; run evals or
  regression-test a grading rubric or a tutor's behaviour; sign in to Novedu or
  check who is signed in; mint or share activity codes; upload app-hosted YAML
  or images; sync a course repo's activity registry and lock file; triage
  student reports; or export a code's student conversations to analyse them and
  improve the activity. Reach for it even when the user never names the CLI. Do NOT
  use it for teacher-docs chapters — that is the novedu-teacher-docs skill.
---

# Working with `novedu-cli`

`novedu-cli` validates activity YAML with the **same pipeline the app uses** and
manages the app (codes, hosted files, images, student reports) over its
authenticated API. An activity that passes `validate` is one the app will
accept, so treat the CLI as authoritative — don't re-derive validation rules
yourself. It is built to grow: run `<command> --help` whenever a task sounds
like a newer flag or command might already cover it.

For up-to-date teacher-facing documentation on any Novedu feature (activity
YAML fields, codes, quizzes, providers, …), fetch the machine-readable teacher
guide: <https://docs.novedu.at/llms.txt> is the index, `llms-full.txt` beside
it the full corpus, and every chapter has a `.md` twin at its own URL. Prefer
it over guessing — it is generated from the same corpus the guide's HTML pages
at docs.novedu.at come from.

## Pick the invocation

- **Inside the app repo** (root `package.json` is named `chat-prototype`):
  `npm run cli -- <command…>` — nothing to install, works offline in the repo.
  Add `--silent` (`npm run cli --silent -- …`) whenever you pipe stdout: npm's
  own banner otherwise corrupts the JSON going into `jq`.
  **Pass file arguments as ABSOLUTE paths.** npm runs the script with the app
  repo as cwd, so a `./my-quiz.eval.yaml` copied from the examples resolves
  against `chat-prototype`, not your shell's directory — and the error names a
  path you never typed (`Failed to fetch file:///…/chat-prototype/my-quiz.eval.yaml`).
  This bites whenever the activity files live in their own repo, which is the
  normal case.
- **Anywhere else**: `npx @novedu/cli <command…>` — npm fetches it on demand.
  Add `@latest` if a stale cached version misbehaves; if `npx` can't reach the
  package that's a network/registry problem, not a missing publish.

## Command map

Read the reference file for the command you're about to run — each carries the
failure modes and the cost/safety notes that decide whether a run is correct.

| Command | Answers | Auth | Details |
| --- | --- | --- | --- |
| `validate <pathOrUrl> [--kind …] [--json]` | Is this file valid? | none | [references/validate.md](references/validate.md) |
| `prompts <pathOrUrl> [--kind …] [--json]` | What does the model actually receive? | none | [references/prompts.md](references/prompts.md) |
| `eval <evalPathOrUrl…>` | Does the rubric grade — or the tutor behave — as intended? | teacher | [references/eval.md](references/eval.md) |
| `login` / `logout` / `whoami` | Who am I signed in as? | — | below |
| `codes create` / `codes list` | Share one activity with students | teacher | [references/teacher-api.md](references/teacher-api.md) |
| `codes sync <registry-file>` | Mint codes for a whole repo of material | teacher | [references/registry-sync.md](references/registry-sync.md) |
| `files upload` / `files list` | Host activity YAML in the app | teacher | [references/teacher-api.md](references/teacher-api.md) |
| `images upload` / `images list` | Host an image a quiz can show | teacher | [references/teacher-api.md](references/teacher-api.md) |
| `reports list` / `show` / `resolve` | What did students flag? | teacher | [references/teacher-api.md](references/teacher-api.md) |
| `codes export <code> [--out <file>]` | What did students actually talk about? | teacher (the code's creator) | [references/teacher-api.md](references/teacher-api.md) |

## Contracts that hold across commands

- **The auth split**: `validate` and `prompts` run fully offline — no server, no
  DB, no LLM call. Everything else, `eval` included (it runs the model), needs a
  signed-in **teacher**. A non-teacher gets a generic 403, so check `whoami` for
  `"isTeacher": true` before blaming the command.
- **JSON I/O contract** for `codes` / `files` / `images` / `reports`: success
  objects verbatim on stdout, exit 0; every failure a JSON `{ message }` or
  `{ errors: [...] }` on stderr, exit 1. Read the stderr JSON and act on it — the
  server's structured detail names the exact problem. (`login`, `logout` and
  `whoami` follow it too; `validate`, `codes sync` and `eval` have their own
  report formats plus `--json`, and `codes export` streams JSON Lines — one header
  line, then one conversation per line — but their hard failures still follow this.)
- **The server validates, not the CLI.** Don't pre-validate before
  `codes create` / `files upload` — the server runs the identical pipeline as the
  web forms. `validate` is for offline checks, not a gate on upload.
- **`--server <url>`** is accepted by `login`, `logout`, `whoami`, `codes`,
  `files`, `images`, `reports` and `eval`. It beats the `NOVEDU_SERVER` env var,
  which beats the production default `https://app.novedu.at`. Use
  `--server https://dev.novedu.at` for the dev stage (new features, activity
  experiments) and `--server http://localhost:3000` against a local dev server.
  Sessions are stored per server, so each one needs its own `login`.
- **`--all` / `--search`**: every `list` (including `reports list`) defaults to
  **only your own** rows; `--all` widens to every teacher's, `--search` is a
  contains-filter.
- **`--kind` is caller-declared, never auto-detected**, for both `validate` and
  `prompts`. The tell-tales that identify each kind are in
  [references/validate.md](references/validate.md).
- **Exit `0` / `1`** throughout, so any of these commands works as a pre-commit
  or CI gate.

## Signing in: the human must finish `login`

`login` prints a verification link and a short code (and tries to open the link
in the system browser as a convenience) and **blocks until the human approves it
there** while signed in to Novedu — a 30-minute window. So run it in the
background or keep reading its output, and relay the printed link to the user if
a browser didn't open for them.

`{"status": "signed-in", "name": …}` on stdout means done; everything afterwards
is non-interactive (the session token is stored in `~/.novedu/sessions.json`,
mode 0600, keyed by server — one entry per server you sign in to). Re-running
while signed in prints `{"status": "already-signed-in", …}` and exits 0, so
running it defensively is safe. A command failing with
`Not signed in — run "novedu-cli login".` means exactly that. `whoami` verifies
the whole chain (stored token → server) and prints
`{ name, userId, isTeacher, server }`; `logout` revokes the session server-side
(best effort) and always removes the local token.

`NOVEDU_TOKEN` overrides the stored session with a bearer token from the
environment — useful in CI or an agent sandbox with no browser to approve a
device code, but not a substitute for `login`: the server still validates the
token on every request.

## Where to start, by what the user is asking

- *"Is this valid? why won't it load?"* → `validate`, and re-run with `--json`
  when a schema error reads vague. → [validate.md](references/validate.md)
- *"Why does the tutor/grader behave like that?"* → `prompts`. Validity and
  behaviour are different questions, and a confusing prompt usually wants both
  commands. → [prompts.md](references/prompts.md)
- *"Is the grading too lenient? did my rubric change break anything?"* → golden
  answers (`kind` omitted), then `validate --kind eval`, then `eval`.
- *"Does the tutor still follow its rules?"* → a `kind: tutor` eval file of
  scripted conversations, then the same two commands — the kind is inferred from
  the file, and its verdict is the Markdown report, not the exit code. A case may
  add `required_tools:` to demand that the answer really called a built-in tool.
  Both spend real tokens, so read [eval.md](references/eval.md) before running them.
- *"Get this in front of students."* → one-off: `files upload` + `codes create`
  ([teacher-api.md](references/teacher-api.md)). Material that lives in a repo:
  a registry file + `codes sync`, never hand-pasted codes
  ([registry-sync.md](references/registry-sync.md)).
- *"What did students say?"* → `reports list` → `show` → fix the YAML →
  `validate` → `files upload` → `reports resolve`.
  → [teacher-api.md](references/teacher-api.md)
- *"Improve an activity from real conversations."* → `codes export <code> --out
  <file>` (only the code's creator may) → analyse the JSONL (recurring
  misconceptions, where the tutor drifted, questions the activity doesn't cover)
  → fix the YAML → `validate` → `files upload` (and `eval` when the rubric or tutor
  rules changed). → [teacher-api.md](references/teacher-api.md)

## Scope — what the CLI does NOT do

It cannot edit or delete codes (which is why `codes sync` mints a new code
instead of changing an existing one), delete files or images, overwrite an
image, browse stats or other teachers' conversations (`codes export` covers only
the caller's OWN codes; a reported chat's transcript is visible via `reports
show`), file/reopen/delete reports, or deploy. Those
stay in the web app on purpose — an agent should never destroy a student's
report, and deletion is deliberately bulk-only in the web UI.

## Related material

`cli/README.md` is the human-facing counterpart to this skill; keep the two from
drifting when the CLI changes. The `novedu-teacher-docs` skill covers the teacher
guide's prose, and `novedu-publish` covers releasing the app and the CLI itself.
Note the boundary: this CLI checks whether a file is valid and what it produces —
it does not tell you what makes a good quiz question. Authoring guidance lives
with the course material.
