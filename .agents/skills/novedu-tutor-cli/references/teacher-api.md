# Codes, hosted files, images, student reports and conversation export

Everything here needs a signed-in **teacher** account and follows the JSON I/O
contract described in SKILL.md: success objects verbatim on stdout with exit 0,
failures as JSON on stderr with exit 1 (`codes export` streams JSON Lines
instead — see its section). Read the stderr JSON — the server's
structured validation detail names the exact problem.

```
codes create --module <tutor|quiz|writing|coding> --file <url>
             [--start <iso>] [--end <iso>] [--note <text>]
             [--llm-provider <p> --llm-model <m>] [--llm-reasoning <level>]
codes list   [--search <q>] [--module <m>] [--all]
codes export <code> [--out <file>]

files upload <name> [--kind <kind>] (--file <path> | reads stdin)
files list   [--search <q>] [--all]

images upload <name> --file <path> [--credit <text>]
images list  [--search <q>] [--all]

reports list    [--status open|resolved|all] [--reaction good|omg|bad|holysh]
                [--search <q>] [--all]
reports show    <id>
reports resolve <id...>
```

## `codes create`

The YAML at `--file <url>` — public, or an app-hosted `…/api/files/<name>` URL
(teacher-only to read, but the server reads it from its own database) —
is validated server-side before the code is stored, running the identical
pipeline as the web forms. The response includes the shareable `url`; hand that
to students.

- `--start`/`--end` must be ISO 8601 **with an explicit offset or `Z`**. A naive
  datetime is rejected.
- `--llm-provider` / `--llm-model` is both-or-nothing.
- `--llm-reasoning` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) is optional on top of that
  pair and rejected without it. The override replaces the activity's WHOLE `llm:`
  block, so omitting the level also drops the file's own.
- For material kept in a repo, prefer `codes sync` over minting by hand — see
  [registry-sync.md](registry-sync.md).

## `files upload`

An **upsert**: a new name requires `--kind`; an existing file's kind is frozen at
create time, so contradicting `--kind` returns 409. Existing codes keep serving
the file, which is why uploading a fix needs no re-share — this is the mechanism
behind the report loop below. Every hosted file is public at the `url` the list
returns.

## `images upload`

**Create-only** — unlike files there is no upsert, so a taken name returns 409.
Images are immutable; delete + re-upload happens in the web app (`/images`).

- `--file` is required (`.png`, `.jpg`/`.jpeg` or `.svg`, max 5 MB — the type
  comes from the extension; binary, so no stdin). One request carries the
  bytes to the app; there is no upload slot and no confirm step.
- `--credit` stores an optional attribution.
- Reference the uploaded image from activity YAML **by name** with
  `hosted: true`, e.g. a quiz question's
  `image: { src: <name>, hosted: true, alt: … }`. The `url` in `images list`
  only opens for a signed-in browser session — never embed it, always
  reference by name.

## `codes export`

Downloads every conversation students had under ONE code, as JSON Lines — the
raw material for "what did students struggle with, and how do I improve this
activity?".

- **Creator-only**: only the teacher who created the code may export it; anyone
  else gets `403 { message }` on stderr. `codes list` (default: your own codes)
  shows which codes those are.
- **No student identity**, for any code: no user id, name or pseudonym. Photos are
  placeholders `{ "type": "image", "mimeType", "bytes" }` — the image never leaves
  the server. Writing submissions are not included; a coding code exports a header
  and no conversations.
- **Format** `novedu-conversations/1`: line 1 is the header
  `{ "type": "export", "format", "code", "module", "note", "fileUrl", "anonymous", "exportedAt" }`,
  every further line one conversation
  `{ "type": "conversation", "threadId", "startedAt", "endedAt", "truncated", "messages" }`.
  A message's `content` is a string for plain text, otherwise an array of `text`,
  `image` and `tool` (`{ "name", "args", "result" }`) parts. At most the last 500
  messages per conversation (`truncated: true` beyond that).
- **Output**: without `--out` the JSONL is the ONLY thing on stdout (redirect or
  pipe it); with `--out <file>` it goes into the file and stdout gets the JSON
  summary `{ "code", "file", "conversations", "messages" }`. Prefer `--out` from an
  agent — the summary tells you the size before you read the file.
- **Partial output on failure**: the error is JSON on stderr, exit 1. In stdout
  mode lines already written stay (discard them); in `--out` mode the partial file
  is removed.
- The file holds student-written text: treat it like class material before handing
  it to a third-party service.

## The report-driven enhancement loop

Students flag an AI interaction — a chat or a graded quiz answer — with a
reaction and an optional note. Those flags usually point at something to fix in
the activity YAML, which is exactly this CLI's job:

1. `reports list` — see what students flagged (default: open reports on your own
   codes; `--reaction holysh` surfaces the urgent ones).
2. `reports show <id>` — read it. A **chat** report embeds the conversation
   transcript (`messages` array), so one command gives both the flag and the
   discussion behind it; a **quiz-answer** report carries its question / answer /
   feedback snapshot inline.
3. Fix the activity YAML the report's `code` points at, and `validate` the change
   offline.
4. `files upload <name>` — save the fix as a new version; existing codes serve it
   immediately.
5. `reports resolve <id...>` — close what you addressed (bulk, one request;
   unknown or already-resolved ids are silently ignored).

Pass `--status` / `--reaction` values verbatim — the server validates them, so an
unknown value returns a `400 { message }` on stderr, not a silent empty list.

## Examples

```bash
# Host a quiz and mint a code for it (new name → --kind required)
npx @novedu/cli files upload sorting-quiz --kind quiz --file ./sorting-quiz.yaml
npx @novedu/cli codes create --module quiz \
  --file https://…/api/files/sorting-quiz \
  --start 2026-07-07T08:00:00Z --note "3A Monday"
# → { "code": "…", "url": "https://…/<code>", … }   — hand the url to students

# Host an image, then reference it from a quiz question by name
npx @novedu/cli images upload sorting-diagram --file ./diagram.png --credit "CC BY 4.0"
# → in the YAML:  image: { src: sorting-diagram, hosted: true, alt: "…" }

# Export a code's conversations for analysis (your own code only)
npx @novedu/cli codes export k7f3qz --out k7f3qz.jsonl
# → { "code": "k7f3qz", "file": "k7f3qz.jsonl", "conversations": 42, "messages": 517 }

# Triage a report end-to-end
npx @novedu/cli reports show 3f2c… | jq '{reaction, description, messages}'
npx @novedu/cli files upload sorting-quiz --file ./sorting-quiz.yaml
npx @novedu/cli reports resolve 3f2c…
```
