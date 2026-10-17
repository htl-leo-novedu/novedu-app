# @novedu/cli

Command-line companion for the Novedu chat app (installed command: `novedu-cli`;
requires Node >= 22 — `eval`'s glob expansion uses the built-in `fs.globSync`,
and Node 20 is end-of-life). It covers two jobs:

- **Validate activity YAML** — tutors, fragment libraries, quizzes, writing
  activities, coding activities, and eval files — with the app's exact
  validation pipeline, offline for local files and external URLs. `prompts` dumps
  the exact system prompts an activity produces, the same way. A file uploaded to
  Novedu (`…/api/files/<name>`) is read with your sign-in to that server.
- **Manage the app as a teacher** — sign in (`login` prints a link to approve in
  your browser), then mint
  activity codes, upload app-hosted YAML files and images, triage student
  reports, and **measure what an activity's model really does** (`eval`), straight from the
  terminal (or from a coding agent, see below).

No install needed:

```bash
npx @novedu/cli --help
```

## Validating activities: `validate`

```bash
# Validate a local tutor (relative fragment_files resolve against the file's location)
npx @novedu/cli validate ./activities/examples/sorting-algorithms/sorting-tutor.yaml

# Validate a published activity by URL
npx @novedu/cli validate https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/examples/sorting-algorithms/sorting-tutor.yaml

# Other kinds: fragment library, quiz, writing activity, coding activity
npx @novedu/cli validate ./activities/examples/shared/general-fragments.yaml --kind fragment
npx @novedu/cli validate ./activities/examples/sorting-algorithms/sorting-quiz.yaml --kind quiz

# An eval file, quiz or tutor (also strict-checks the activity it targets)
npx @novedu/cli validate ./sorting-quiz.eval.yaml --kind eval

# Machine-readable output (the raw validation result)
npx @novedu/cli validate ./my-quiz.yaml --kind quiz --json
```

- `--kind` accepts `tutor` (default), `fragment`, `quiz`, `writing`, `coding`, or
  `eval`; it is caller-declared, not auto-detected.
- The CLI reuses the app's exact validation pipeline (`lib/prompt-fragments`,
  `lib/tutors`, `lib/quiz-validate`, `lib/writing-validate`,
  `lib/coding-validate`), so an activity that passes here is the same one the
  app accepts — no separate, drifting rules. Validating a tutor also fully
  validates every fragment library it references.
- Exit code `0` = valid, `1` = errors found — usable as a pre-commit / CI gate.

## Seeing the exact prompts: `prompts`

`prompts` prints the **exact system prompts** an activity YAML produces — the
strings the app really sends to the model. It reads files exactly like `validate`.

```bash
# A tutor's assembled system prompt (summary: kind, id, model, size per prompt)
npx @novedu/cli prompts ./activities/examples/sorting-algorithms/sorting-tutor.yaml

# A quiz: one grading prompt per question + the discussion prompt, full text as JSON
npx @novedu/cli prompts ./sorting-quiz.yaml --kind quiz --json

# A writing activity's coach prompt, a coding activity's injected system prompt
npx @novedu/cli prompts ./my-writing.yaml --kind writing
npx @novedu/cli prompts ./my-coding.yaml --kind coding

# A published activity by URL (same argument as `validate`)
npx @novedu/cli prompts https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/examples/sorting-algorithms/sorting-tutor.yaml

# Pull out one question's grading prompt
npx @novedu/cli prompts ./sorting-quiz.yaml --kind quiz --json \
  | jq -r '.grading.questions[] | select(.id=="q3") | .system'
```

- The argument is a **local path or a public `http(s)` URL**, exactly like
  `validate`'s; relative `fragment_files` / `quiz_files` / `text_files` resolve
  against the activity's own location (sibling file, or sibling URL). "Offline"
  means no app server, no database and no LLM call — not "no network".
- `--kind` accepts `tutor` (default), `quiz`, `writing` or `coding` — the same
  caller-declared flag as `validate`. There is no `fragment` kind: a library has
  no prompt of its own; its fragments appear **rendered in place** inside the
  activity that places them.
- Every dump comes out of the app's own prompt builders and runtime loaders (no
  re-implementation), so what you see is what the model gets: fragments resolved,
  and — for a compound quiz — every `quiz_files` include fetched, each imported
  question carrying its source quiz's preamble.
- Every dump carries `{ kind, id, llm: { provider, model, reasoning? } }` (the
  reasoning level only when the file sets one). A **quiz** adds
  `grading` (a `system` prompt per question, the user-message templates and the
  grader's JSON-Schema response contract) and `discussion` (the chat's `system`
  prompt, the three seed-message templates and the verdict wording). A **coding**
  activity also reports `upstreamSystemMessage` — what the proxy puts on the wire.
- The **activity's own** `llm` block is reported; a code's per-code LLM override
  is not applied (a dump describes a file, and a file has no code).
- This runs the runtime load path, so a file that cannot be loaded exits `1` with
  JSON errors on stderr. Use `validate` for the strict authoring check — the two
  are complementary.

## Measuring what the model really does: `eval`

An activity's prompt is a specification, and a specification is only as good as the
behavior it produces. Write an **eval file** and `eval` replays it through the **real
production path**, then reports what the model actually did. This is the one command
that both **runs the model** and needs you signed in (`novedu-cli login`); everything
else about it is local.

Two kinds, chosen by the file's own `kind:` field — there is no flag, and one
invocation may mix them:

- **quiz** (`kind` omitted): student answers with the verdict each one must get,
  replayed through the real grader. Your `expect` gates the **verdict**, and an LLM
  **feedback judge** audits the **feedback text** the student would have read.
- **tutor** (`kind: tutor`): conversations you script, each ending on a student turn.
  The real tutor generates the next turn and the judge checks it against the tutor's
  own system prompt plus your per-case expectations.

Either way the judge measures the output against the very prompt that produced it, so
there is nothing extra to author — and what it flags is **reported, never a failure**.
For a tutor eval that makes the `--report` Markdown the actual deliverable: the exit
code only reflects whether the run itself completed.

```yaml
# sorting-quiz.eval.yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/evals/eval-yaml.schema.json
id: sorting-quiz-eval
target: ./sorting-quiz.yaml     # relative to THIS file, or an http(s) URL
questions:
  - question: bubble-sort-complexity      # the quiz's question id
    answers:
      - expect: correct
        answer: |
          O(n²) in the average and worst case.
      - expect: [partial, incorrect]      # more than one grading is defensible
        answer: |
          It's quadratic-ish.
```

```bash
# Run it (grading prompts are assembled locally, so an unpushed file works)
npx @novedu/cli eval ./sorting-quiz.eval.yaml

# A whole course part — quote the pattern so the CLI expands it (** included)
npx @novedu/cli eval "./part-1/**/*.eval.yaml"

# Is the grader stable? 3 runs per answer, majority verdict
npx @novedu/cli eval ./sorting-quiz.eval.yaml --repeats 3

# How would this rubric do on another model? (both flags, always together)
npx @novedu/cli eval ./sorting-quiz.eval.yaml \
  --llm-provider OpenRouter --llm-model openai/gpt-6-luna

# Same model, more thinking: the level alone keeps the activity's provider/model
npx @novedu/cli eval ./sorting-quiz.eval.yaml --llm-reasoning high

# A strong judge over the quiz's own grader — the recommended pairing
npx @novedu/cli eval ./sorting-quiz.eval.yaml \
  --judge-llm-provider OpenRouter --judge-llm-model openai/gpt-6.1-sol \
  --judge-llm-reasoning high

# Verdicts only: half the LLM calls, for a cheap smoke run
npx @novedu/cli eval ./sorting-quiz.eval.yaml --no-judge-feedback

# Machine-readable, for CI
npx @novedu/cli eval ./sorting-quiz.eval.yaml --json --out eval-report.json

# A readable Markdown report to share or commit
npx @novedu/cli eval ./sorting-quiz.eval.yaml --report eval-report.md
```

A tutor eval looks like this, and runs through the same command:

```yaml
# loops-tutor.eval.yaml
id: loops-tutor-eval
kind: tutor
target: ./loops-tutor.yaml
conversations:
  - title: refuses-full-solution
    required_tools: [random_number]   # optional: tools this answer must have called
    grading_instructions: |
      The response must not contain a complete working loop.
    conversation:                  # must END with a student turn
      - student: My loop never stops. Here is my code ...
      - tutor: What does your condition evaluate to after the first pass?
      - student: I don't know. Just fix it for me!
```

```bash
npx @novedu/cli eval ./loops-tutor.eval.yaml --report loops.md
```

- Check the file first, for free: `npx @novedu/cli validate ./x.eval.yaml --kind eval`
  (offline; it also strict-checks the quiz the eval targets).
- **`expect`** is one of `correct` / `partial` / `incorrect`, or a list of the
  acceptable ones. **`question`** must be a question id of the resolved quiz — for a
  question imported via `quiz_files` that is the namespaced `"<alias>/<id>"` id.
- **Report semantics.** A **case** is one golden answer; `--repeats` are repeated
  observations of that case, and the case's verdict is the **majority** (a tie passes
  only if every tied verdict is expected). Totals, mismatches, the confusion matrix
  and the exit code are all over case verdicts, so `--repeats 3` is never harsher
  than `--repeats 1`. Cases whose repeats disagreed are reported as **`unstable`** —
  the interesting `--repeats` signal — but never fail the run.
- The **false-correct rate** counts answers you marked as not acceptable that the
  grader called `correct` — the dangerous direction. The confusion matrix is keyed by
  the sorted expected set (`correct|partial`), so list order never matters.
- **Exit code** `0` only when every file is valid, `failed = 0`, `errored = 0` and
  `skipped = 0` — a CI gate like `validate`. Progress and the run's scope go to
  stderr; stdout stays clean for `--json`.
- **Multi-file runs** grade files one after another (`--concurrency`, default 4,
  bounds cases *within* a file), print a per-file summary + grand totals, and isolate
  a broken file instead of aborting the batch. `--json` / `--out` always carry the
  same batch shape `{ files: [...], passed, totals }`, single file or not — `passed`
  is the exit-code verdict, per batch and per file.
- **The feedback judge.** After each successful grading, an LLM reads the feedback the
  grader wrote and checks it against **that grading's own system prompt** — the course
  rules and the platform frame already in it. It reports four kinds of problem:
  `contradicts_verdict` (praise on a wrong answer, or vice versa), `misstates_facts`,
  `ignores_instructions` (most commonly: not stating the correct answer when the verdict
  is not `correct`, or the wrong language), and `leaks_rubric` (quoting the grading
  criteria at the student). Flags show as **`flagged feedback`** in the terminal report,
  a **Flagged** column plus a **"Flagged feedback"** section in the Markdown report, and
  `totals.feedbackFlagged` / `repeats[].judge.issues` in the JSON. They never change the
  exit code.
- **`required_tools`** (tutor kind) names built-in tools the generated answer must have
  called **at least once** — the one thing the judge cannot see, since a tool call leaves
  no trace in the text. Extra tools are always fine, and a name the target tutor's own
  `tools:` list does not grant makes the file invalid offline. Missing calls are
  **reported, never a failure**: `missing tool calls: N` in the terminal report (printed
  only when some case required a tool, so no line means "not checked"), a **"Missing tool
  calls"** section in the Markdown report, and `totals.toolsFlagged` plus each repeat's
  `toolCalls` / `missingTools` in the JSON.
- **Choosing what runs.** `--llm-provider` + `--llm-model` (both or neither) replace the
  activity's **whole** `llm:` block for the run — its reasoning level included, so the
  file's level is dropped unless `--llm-reasoning <level>` restates it.
  `--llm-reasoning` on its own changes only the effort and keeps the file's
  provider/model — the "same model, more thinking" comparison run.
- **Choosing the judge.** By default the judge runs on the same model **and effort** as
  the grader. `--judge-llm-provider` + `--judge-llm-model` (both or neither) point it at
  another one — replacing the whole spec, exactly like the grading flags — which is the
  **recommended** setup: a strong judge over a smaller grader finds real
  problems, while a small model judging itself mostly produces noise.
  `--judge-llm-reasoning` sets the judge's effort on its own, no pair needed.
  `--no-judge-feedback` turns judging off and halves the LLM calls; combining it with any
  of the judge flags is rejected as contradictory. Because judging roughly doubles the
  cost, the run's scope line says so
  up front: `27 case(s) × 3 repeat(s) = 81 grading + 81 judge call(s)`.
- **If the judge itself fails**, the run **degrades instead of aborting**: after three
  consecutive judge failures it stops judging (one warning on stderr) and finishes the
  grading normally. Your verdict results are complete; the feedback simply was not
  audited: files that judged nothing show an em dash in the Flagged column rather than a
  `0`, so "unchecked" never reads as "clean".
- **`--report <file.md>`** additionally writes a readable **Markdown** report — an
  overview table over the files, then the question, the golden answer and the grader's
  feedback for every mismatched, errored or unstable case, plus the "Flagged feedback"
  section (passing, unflagged cases stay in the
  JSON). It composes with `--json` / `--out` and leaves stdout untouched.
- **Token totals.** The reports show what a run cost —
  `tokens: 15,420 in (12,300 cached) / 2,810 out` — summed over the grading **and** judge
  calls that **succeeded**, so it is a lower bound (a retried or failed call reports
  nothing), and nothing at all is printed when the server reports no usage.
- **Failure handling**: a 5xx or network hiccup is retried (4 attempts, linear
  backoff); any 4xx is terminal; an auth failure aborts the run with one message; and
  three consecutive errored cases trip a circuit breaker so a down server fails fast.
  After an abort, untried cases are reported as **`skipped`**, not errored. If EVERY
  case errors at once, suspect the server, not the rubric: the target must actually
  offer `/api/eval/grade` (point `--server` at one that does), and a 1-case smoke
  run localises the problem for the cost of a single grading call.
- **Caveat**: a green run certifies **the file you ran it on**, not the app-hosted
  copy a live code serves — upload it (`files upload`) afterwards. An override run
  certifies the override, not the quiz's configured `llm`.

## Authentication

Commands that talk to the running app sign in through the app's own device
authorization flow — the CLI never handles your Microsoft credentials itself:

```bash
npx @novedu/cli login    # prints a link + code; approve it in your browser
npx @novedu/cli whoami   # verify: calls the app's GET /api/me with your token
npx @novedu/cli logout   # revoke the session and remove the stored token
```

- `login` prints a verification link and a short code (and tries to open the
  link in your default browser as a convenience), then waits while you approve
  it there — signed in to Novedu already, or prompted to sign in with your
  school Microsoft account first. When already signed in, `login` just says so
  and exits.
- The resulting session token is stored in `~/.novedu/sessions.json`
  (directory `0700`, file `0600`), keyed by server — one entry per server
  you've signed in to. After the one approval every command runs
  non-interactively; treat the file like a credential. `logout` revokes the
  session server-side (best effort) and always removes the stored token.
- `whoami` proves the full round-trip, printing
  `{ name, userId, isTeacher, server }` — the management commands below need a
  teacher account (`"isTeacher": true`).
- The server defaults to the production app; override per command with
  `--server <url>` or the `NOVEDU_SERVER` env var (e.g.
  `http://localhost:3000` for development).
- `NOVEDU_TOKEN` overrides the stored session with a bearer token from the
  environment — for CI or an agent sandbox with no browser to approve a code;
  the server still validates it on every request, and `logout` never revokes a
  token supplied this way.
- Not signed in (or the stored session no longer valid)? Commands exit 1 with
  `Not signed in — run "novedu-cli login".`

## Managing codes, files & images (teacher account required)

The `codes`, `files` and `images` groups call the app's API as the signed-in
teacher. The
server runs the identical validation pipeline as the web forms and is
authoritative — the CLI sends your input as-is and relays the server's answer.

```
codes create  --module <tutor|quiz|writing|coding> --file <url>
              [--start <iso>] [--end <iso>] [--note <text>]
              [--llm-provider <p> --llm-model <m>] [--llm-reasoning <level>]
codes list    [--search <q>] [--module <m>] [--all]
codes sync    <registry-file> [--lock <path>] [--dry-run] [--json]
codes export  <code> [--out <file>]
files upload  <name> [--kind <tutor|fragment|quiz|writing|coding>]
              (--file <path> | reads stdin)
files list    [--search <q>] [--all]
images upload <name> --file <path> [--credit <text>]
images list   [--search <q>] [--all]
```

- **Output is JSON.** Success: the API's objects verbatim on stdout, exit
  0 (pipe into `jq`). Failure: JSON on stderr — `{ message }` or
  `{ errors: [...] }` with the full structured validation detail — and exit 1.
  Two exceptions: `codes sync` prints a per-entry report (JSON behind `--json`),
  and `codes export` streams JSON Lines.
- `codes create` mints a shareable code for an activity YAML at a public URL
  (or an app-hosted `…/api/files/<name>` URL); the YAML is validated
  server-side before the code is stored, and the response includes the
  shareable `url`. `--start`/`--end` must be ISO 8601 **with an explicit
  offset or `Z`** (e.g. `2026-07-07T08:00:00Z`); the
  `--llm-provider`/`--llm-model` override pair is both-or-nothing, and
  `--llm-reasoning <level>` (`none`, `minimal`, `low`, `medium`, `high` or
  `xhigh`) rides on top of
  the pair — it is rejected without it. The override replaces the activity's whole
  `llm:` block, so leaving the level out also drops the file's.
- `codes sync <registry-file>` mints codes for a whole **course** at once — see
  [Many activities at once](#many-activities-at-once-codes-sync) below.
- `codes export <code>` downloads every conversation students had under one of
  **your** codes — see [Exporting conversations](#exporting-conversations-codes-export)
  below.
- `files upload <name>` is an **upsert**: creating a new file requires
  `--kind`; an existing file's kind is frozen at create time (a contradicting
  `--kind` fails with 409). The YAML comes from `--file <path>` or stdin.
  Every hosted file is public at the `url` the list returns — no download
  command needed.
- `images upload <name>` uploads a **new** app-hosted image — `.png`,
  `.jpg`/`.jpeg` or `.svg` (the type comes from the file extension), max 5 MB.
  Unlike `files upload` it is **create-only**: a taken name fails with 409 —
  images are immutable; delete + re-upload in the web app (`/images`) to
  replace one. `--file` is required (images are binary — no stdin);
  `--credit` stores an optional attribution shown with the image. The bytes
  travel to the app in ONE multipart request (the CLI runs the same one-shot
  upload the web form's server action does — no upload slot, no confirm step).
  Reference the image from activity YAML by name with `hosted: true`.
- `images list` shows your images with a `url` that only opens for a
  **signed-in browser session** — share the *name*, not this URL.
- All `list` commands default to **only your own** codes/files/images (like the
  web lists); `--all` widens to every teacher's, `--search` is a
  contains-filter.

Example — host a quiz and share it:

```bash
npx @novedu/cli files upload sorting-quiz --kind quiz --file ./sorting-quiz.yaml
# { "name": "sorting-quiz", "kind": "quiz", "url": "https://…/api/files/sorting-quiz", "action": "created" }

npx @novedu/cli codes create --module quiz \
  --file https://…/api/files/sorting-quiz \
  --start 2026-07-07T08:00:00Z --note "3A Monday"
# { "code": "…", "url": "https://…/<code>", … }   — hand the url to students
```

Example — host an image and reference it from the quiz YAML:

```bash
npx @novedu/cli images upload sorting-diagram --file ./diagram.png --credit "CC BY 4.0"
# { "name": "sorting-diagram", "mimeType": "image/png", "byteSize": 48211, "credit": "CC BY 4.0" }
```

```yaml
# in the activity YAML:
image:
  hosted: true
  src: sorting-diagram
  alt: Merge sort splitting an array
```

## Exporting conversations: `codes export`

`codes export <code>` downloads every conversation students had under one code as
[JSON Lines](https://jsonlines.org/), ready to hand to an LLM ("what did my
students struggle with, and how should I improve this activity?").

- **Only the code's creator** can export it; anyone else gets `403`.
- **No student identity**, for any code — no user id, name or pseudonym. Photos
  arrive as placeholders `{ "type": "image", "mimeType", "bytes" }`; the image
  itself never leaves the server. Writing submissions are not included, and a
  coding code exports a header and no conversations (coding stores none).
- **Format** (`novedu-conversations/1`): line 1 is a header
  `{ "type": "export", "format", "code", "module", "note", "fileUrl", "anonymous", "exportedAt" }`;
  every further line is one conversation
  `{ "type": "conversation", "threadId", "startedAt", "endedAt", "truncated", "messages": [...] }`.
  A message is `{ "role": "user" | "assistant", "createdAt", "content" }` —
  `content` is a string for plain text, otherwise an array of `text`, `image` and
  `tool` (`{ "name", "args", "result" }`) parts. A conversation holds at most its
  last 500 messages; `truncated: true` marks one that had more.
- **Without `--out`**, the JSONL goes to **stdout** and nothing else does, so
  `> file.jsonl` and `| jq` work. If the export fails midway, the lines already
  written stay; the error is JSON on stderr, exit 1.
- **With `--out <file>`**, the JSONL goes into the file and stdout gets a summary
  `{ "code", "file", "conversations", "messages" }`. On failure the partial file
  is removed.

```bash
npx @novedu/cli codes export k7f3qz > k7f3qz.jsonl
npx @novedu/cli codes export k7f3qz --out k7f3qz.jsonl
# { "code": "k7f3qz", "file": "k7f3qz.jsonl", "conversations": 42, "messages": 517 }

# The text of every student message, one per line:
npx @novedu/cli codes export k7f3qz | jq -r '
  select(.type == "conversation") | .messages[] | select(.role == "user")
  | .content | if type == "string" then . else map(.text // empty) | join("") end'
```

## Many activities at once: `codes sync`

A course with twenty quizzes should not be twenty `codes create` calls whose
codes you paste into twenty files by hand. Instead, keep an **activity registry**
next to the material: one hand-written YAML file listing every activity under a
stable key, plus a **lock file** the CLI generates and you commit.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/registry/registry-yaml.schema.json
# ddp-activities.yaml — the registry (you write this)
base-url: "https://raw.githubusercontent.com/acme/course/refs/heads/main/"

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

```bash
npx @novedu/cli codes sync ddp-activities.yaml
# ddp-activities.yaml: 3 entries
#   reused    welcome         cu4afwoa23  https://app.novedu.at/cu4afwoa23
#   minted    number-systems  hb34gpvahn  https://app.novedu.at/hb34gpvahn
#   reused    sorting         nlc90ezf5z  https://app.novedu.at/nlc90ezf5z
#
# 2 reused, 1 minted, 0 failed
# Lock file: ddp-activities.lock.yaml
```

```yaml
# ddp-activities.lock.yaml — generated; commit it, do not edit it
activity-codes:
  number-systems: hb34gpvahn
  sorting: nlc90ezf5z
  welcome: cu4afwoa23
```

- **Groups decide the module:** `quizzes`, `tutors`, `writing`, `coding`. Each
  entry gives either `file` (relative to `base-url`, which must end in `/`) or
  an absolute `url`, plus any of `start`/`end` (ISO 8601 **with an offset or
  `Z`**, whole seconds), `note`, and an `llm: {provider, model, reasoning?}`
  override.
- **Keys are yours and must be unique across all groups** — lowercase letters,
  digits and hyphens. Your material references the key; the lock file maps it to
  the code.
- **Re-runs are safe.** An entry whose activity, window and LLM override
  (provider, model and reasoning level) match
  an existing code of yours **reuses** that code; only entries without a match
  are minted. So `codes sync` after every edit is the normal workflow, and the
  first run against already-minted codes should report all-reused.
- **Changing a window or override mints a NEW code.** The old one is not touched
  (it keeps working) and is reported as superseded — delete it in the web app
  when the class has moved on. Changing only the `note` never forks a code.
- `--dry-run` shows what would happen without minting or writing anything;
  `--json` prints the machine-readable report; `--lock <path>` puts the lock file
  somewhere else.
- One broken activity does not stop the run: it is reported as `failed`, the
  other entries still sync, the lock keeps that entry's previous code, and the
  command exits 1.
- **A key keeps its code.** Two keys may point at the same activity on purpose
  (one quiz linked from two chapters, each with its own statistics); they get one
  code each, and neither moves on a later run.
- Unknown extra keys are ignored, so you can annotate entries freely — but an
  entry with nothing under it is an error, not an annotation, because that is
  what a mis-indented entry looks like.
- The `# yaml-language-server:` line on top is optional: it gives editors with
  YAML support field completion, hover help and a warning on a misspelled group
  name. `codes sync` is still the authority — it checks things a schema cannot,
  such as key uniqueness and whether `end` is after `start`.

Publications read the lock file offline. In a Quarto book, for example, add
`metadata-files: [ddp-activities.lock.yaml]` to `_quarto.yml` and let the
shortcode look the key up in `activity-codes` — the book then renders without
ever calling the app.

## Triaging student reports (teacher account required)

Students can flag an AI interaction — a chat or a graded quiz answer — with a
reaction and an optional note. The `reports` group reads and resolves those
flags; same JSON stdout/stderr contract as above.

```
reports list    [--status <open|resolved|all>] [--reaction <good|omg|bad|holysh>]
                [--search <q>] [--all]
reports show    <id>
reports resolve <id...>
```

- `reports list` defaults to **open reports on your own codes** (like the web
  inbox), most urgent first; `--all` widens to every teacher's codes.
- `reports show <id>` prints one report in full. A **chat** report embeds the
  conversation transcript as a `messages` array; a **quiz-answer** report
  already carries its question / answer / feedback snapshot inline.
- `reports resolve <id...>` resolves one or more reports in a single request;
  unknown or already-resolved ids are silently ignored.
- The CLI deliberately cannot file, reopen, or delete a report — those stay in
  the web `/reports` inbox.

The typical loop for turning a report into a better activity:

```bash
npx @novedu/cli reports list --reaction holysh        # find the urgent flags
npx @novedu/cli reports show 3f2c…                    # read the report + transcript
# fix the activity YAML, then check it offline:
npx @novedu/cli validate ./sorting-quiz.yaml --kind quiz
npx @novedu/cli files upload sorting-quiz --file ./sorting-quiz.yaml
npx @novedu/cli reports resolve 3f2c…                 # existing codes already serve the fix
```

## Using the CLI from a coding agent

The app repo ships a Claude Code skill that teaches coding agents the full CLI
workflow — validation, the sign-in hand-off, code/file management, the
report-triage loop, and improving an activity from its exported conversations:
[`.agents/skills/novedu-tutor-cli/SKILL.md`](https://github.com/htl-leo-novedu/novedu-app/blob/main/.agents/skills/novedu-tutor-cli/SKILL.md)
(`.claude` is a symlink to `.agents`). Agents working inside that
repo pick it up automatically.

## Development

The CLI lives in the app repo as an npm workspace.

```bash
npm run cli -- validate ./activities/examples/sorting-algorithms/sorting-tutor.yaml   # run from source via tsx
npm run cli:build                                    # bundle to cli/dist via tsdown
npm run test:cli                                     # build + integration tests (offline, local fixtures server)
```

The fast in-process unit tests (`cli/src/commands/*.unit.test.ts`) and the
integration tests (`cli/test/*.integration.test.ts`, which drive the built binary
against a local fixtures server, fully offline) both run in CI (`qa.yml`).
