# Activity registry & `codes sync`

Deep reference for the **activity registry**: a hand-written YAML file that lists
every novedu activity a publication embeds, and the CLI command that reconciles
it with the server and writes a committed **lock file** of key → code. Read it
before touching `cli/src/registry.ts`, `cli/src/sync.ts`, the `sync` subcommand
in `cli/src/commands/codes.ts`, or the fake `/api/codes` in
`test-fixtures/serve.mjs`. Codes themselves are `docs/codes.md`; the bearer
channel the command speaks is `docs/api.md`.

## Why

A publication that embeds activities — the driving case is the Creative Coding
Quarto book, `rstropek/ddp-ts-p5-beginner-course` — references a minted code at
every reference site (`{{< quiz hb34gpvahn … >}}`). Minting each code by hand
(validate the YAML, build the raw URL, `codes create`, paste the code into the
chapter) does not scale to dozens of activities, and `novedu_codes` alone links no
activity YAML to its code in a form the publication can read.

The registry is the BibTeX of activity codes. One hand-written file lists the
activity URLs plus their minting parameters under stable keys; `codes sync`
reconciles it against the server and emits a generated key → code map the
publication consumes at render time. The publication's build never talks to the
API.

```
consumer repo (e.g. the book)                      novedu
─────────────────────────────                      ──────
ddp-activities.yaml   (hand-written)
        │
        ▼
novedu-cli codes sync ddp-activities.yaml
        │  1. parse + validate the registry (zod)
        │  2. GET /api/codes  ──────────────────►  list the caller's codes
        │  3. per entry: match by URL+module+window+llm
        │  4. no match: POST /api/codes ────────►  mint (server validates the YAML)
        ▼
ddp-activities.lock.yaml   (generated, committed)
        │
        ▼
book render (Quarto metadata-files + quiz.lua)  — offline, no API access
```

Sync runs on the author's machine with the usual CLI auth whenever the registry
or an activity YAML changes; the render step only reads the committed lock file.

## Registry file format

Hand-authored, lives in the **consumer** repo, format owned and documented here.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities/registry/registry-yaml.schema.json
# Activity registry — processed with: novedu-cli codes sync <this file>
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
    some-tutor:
      url: https://example.com/hosted/tutor.yaml
      llm:
        provider: Azure Foundry
        model: gpt-5
```

**Root**

| Field | Required | Rules |
| --- | --- | --- |
| `base-url` | only if any entry uses `file` | `http(s)` URL, must end with `/` (resolution is `new URL(file, baseUrl)`, so a missing slash would drop the last segment) |
| `activities` | yes | mapping of the five known group keys; an unknown group name is an **error** — it would silently drop every entry under it |

**Groups:** `quizzes` → module `quiz`, `tutors` → `tutor`, `writing` → `writing`,
`coding` → `coding`, `cloze` → `cloze` (singular like `writing` and `coding`). All groups
optional; an empty group is fine. There is no
`defaults` section — every entry states its own parameters.

**Entry** (the map key is the registry key)

| Field | Required | Rules |
| --- | --- | --- |
| key | — | `^[a-z0-9][a-z0-9-]*$`, ≤ 64 chars, **unique across all groups** (the lock namespace is flat) |
| `file` | exactly one of `file`/`url` | relative path resolved against `base-url` |
| `url` | ” | absolute `http(s)` URL |
| `start` / `end` | no | ISO 8601 **with an explicit offset or `Z`** (the rule `POST /api/codes` enforces), **whole seconds** (see below); `end` must be after `start` |
| `note` | no | ≤ 200 chars, trimmed like the server trims it, passed as the code's note at mint time; no behavioral effect |
| `llm` | no | `{provider, model, reasoning?}` — provider and model both required when present (the API's both-or-nothing rule); `provider` is `SCCH`, `Azure Foundry` or `OpenRouter`; `reasoning` an optional `none`/`minimal`/`low`/`medium`/`high`/`xhigh` (docs/ai-models.md) |

Resolved URLs are normalized with `URL.href` — the same form
`validateCodeRequest` stores in `file_url` — so matching compares identical
strings. Duplicate resolved URLs across entries are allowed on purpose (two keys
may deliberately mint distinct codes for one YAML, e.g. different windows, or the
same activity linked from two chapters with separate statistics).

A window bound must name a **whole second**: the API stores unix seconds
(`isoToUnixSeconds` floors), so a bound carrying milliseconds would come back
truncated, never match the entry that minted it, and mint a fresh code on every
run. The CLI rejects sub-second precision offline rather than truncating it,
which would make the registry lie about the window it asks for. `note` is
trimmed for the same class of reason: the server trims before storing, so an
untrimmed note would report "note differs" forever.

**Unknown extra properties are accepted and ignored** at root, group and entry
level, so authors can annotate freely and a newer registry keeps working with an
older CLI. Inside a group that tolerance is limited to properties that are **not
mapping-shaped** (`section: "Part 1"`, or a sequence): anything mapping-shaped IS
an entry and must be a valid one — silently dropping something that looks like an
entry is the failure mode this format exists to prevent. An **empty** value is
rejected outright: `welcome:` with its fields indented one level out parses as a
null entry plus loose siblings, and ignoring that would drop a published activity
from the lock while the run still reported success.

### Editor schema

`activities/registry/registry-yaml.schema.json` is the editor JSON Schema for this
format, referenced by the `# yaml-language-server:` modeline in the example above. Like
the five activity schemas it is **generated from zod** — `lib/registry-schema.ts` via
`npm run generate:schemas` — and guarded by the drift test in
`lib/schema-gen/generated-schemas.unit.test.ts`; do not hand-edit it.

`lib/registry-schema.ts` owns the FORMAT (group names, key rules, entry fields) and is
what both the CLI and the generator use. `cli/src/registry.ts` keeps the parsing
**strategy**: its `rootSchema` leaves `activities` opaque to zod so the hand-written walk
can name the exact YAML path in every message. `RegistryYamlSchema` — the document shape
the schema is generated from — builds its group properties from `GROUP_MODULES`, so
the group names cannot drift from the walk.

Two divergences from CLI validation are deliberate, and neither should be "fixed":

- A misspelled entry field (`fil:`) is **not** flagged. Root and entry are
  `z.looseObject` because unknown properties are accepted by design (above); making them
  strict for the editor's benefit would misrepresent the format.
- A non-mapping annotation inside a group (`section: "Part 1"`) **is** flagged, because
  the schema expects an entry at every key. The CLI still ignores it.

The rules a JSON Schema cannot express stay CLI-only: cross-group key uniqueness,
`base-url`'s trailing slash, `end` after `start`, and URL resolution. `codes sync` remains
the authority.

## Lock file format

Default path: the registry path with `.yaml`/`.yml` replaced by `.lock.yaml`
(override with `--lock <path>`). CLI-generated, **committed**.

```yaml
# Generated by @novedu/cli — do not edit.
# Regenerate with: novedu-cli codes sync ddp-activities.yaml
activity-codes:
  number-systems: hb34gpvahn
  welcome: cu4afwoa23
```

- A single top-level key `activity-codes`, namespaced so the file can be merged
  into other metadata (Quarto `metadata-files`) without collisions.
- Flat map, keys sorted alphabetically — stable diffs, byte-identical re-runs.
- Fully rewritten on every sync. Keys removed from the registry disappear from
  the lock; their server codes are untouched but **reported** as orphaned.
- Codes only. Consumers already know the server origin (the book keeps its
  `novedu-base-url` in `_quarto.yml`); `codes sync --json` prints full URLs for
  anyone who needs them.

## `codes sync <registry-file>`

Options: `--lock <path>`, `--dry-run`, `--json`, `--server <url>` (the usual
resolution: flag > `NOVEDU_SERVER` > production). Requires a signed-in teacher,
same bearer plumbing as the other `codes` commands.

1. **Parse + validate** the registry. Any schema violation, duplicate key or
   unresolvable URL aborts **before any server call** (exit 1) — a typo must
   never leave half a class's codes minted. All issues are reported at once,
   each with its YAML path.
2. **Fetch the caller's codes once** (`GET /api/codes`, no filter — one listing
   serves every group; the API's `mine` default already scopes it to the caller).
3. **Select one code per key**, then per entry, in registry order:
   - **Match** = a code whose normalized `fileUrl`, `module`, `validFrom`,
     `validUntil` and `llm` (provider, model AND reasoning level — a differing
     level mints a new code) all equal the entry's. Timestamps compare as
     **instants** (epoch), not strings, so `+02:00` and `Z` spellings of the same
     moment match; an absent bound matches only `null`. **`note` is excluded** —
     it is a label for the teacher, not part of the code's behavior, so editing
     it must not fork a new code.
   - **Selection claims.** Every key that still matches the code the previous
     lock gave it keeps that code — all of them, before any key takes a free one
     — and each remaining key then takes the newest code no other key has
     claimed. So a key's published code never moves while a matching code
     exists, and two entries describing one activity keep one code each instead
     of both being handed the newest. Matches left over are reported as
     duplicates; a differing note is reported as info, never a mismatch.
   - **No match left** → `POST /api/codes` with the entry's parameters (the server
     fetches and validates the activity YAML right then, exactly as `codes
     create` does). A failure for one entry is recorded and the run continues.
4. **Report** — human-readable by default, structured with `--json`: per entry
   `reused` / `minted` / `failed` (with the server's error), plus advisory
   findings (superseded codes, duplicate matches, orphaned lock keys).
5. **Write the lock file** (skipped by `--dry-run`), fully rewritten from the
   run. An entry that FAILED this run keeps the code the previous lock had for
   it — a transient error must not break the consumer's build; a failed entry
   with no previous code is simply absent.
6. **Exit 0** when every entry resolved, **exit 1** when any entry failed (the
   lock is still written as described).

**Upsert semantics, stated plainly:** changed parameters produce a **new** code.
Existing codes are never modified or deleted — the API has no code-update
endpoint and that stays out of scope, so the old code keeps working and is only
*reported* as superseded. Retiring it is a deliberate act in the web app.

`--dry-run` performs steps 1–4 read-only (no mint, no lock write) and labels
would-be actions (`would mint`).

`--json` prints one object:
`{ dryRun?, entries: [{ key, module, fileUrl, action, code?, url?, error? }], warnings: [...] }`.
Hard failures stay on the CLI's usual contract — JSON on **stderr**, exit 1 — in
both modes: an invalid registry, no token, an unreachable server, a lock file
that cannot be written. The per-entry `failed` outcome is part of the report, not
of that contract.

## Code map

| File | Role |
| --- | --- |
| `cli/src/registry.ts` | The zod schema + loader: parse, validate, resolve each entry into the parameters `POST /api/codes` takes. Pure apart from the file read. |
| `cli/src/sync.ts` | The engine, all pure: `matchEntry`, `mintBody`, `collectWarnings`, `buildLockCodes`, `serializeLock`/`parseLock`, `formatSyncReport`. |
| `cli/src/commands/codes.ts` | The `sync` subcommand: the I/O around those functions (read registry + lock, list, mint, print, write). |
| `cli/src/api.ts` | `performApiRequest({ quiet: true })` — the per-entry mint returns its failure payload instead of printing it, so one rejection cannot abort the run. |

**No server-side changes.** `GET /api/codes` already returns `fileUrl`, `module`,
`validFrom`, `validUntil`, `llm` and `createdAt` per row; matching is entirely
client-side. A `?fileUrl=` filter on the listing is a possible later
optimization, not a requirement.

The registry duplicates two server constants it cannot import (`lib/code-store.ts`
is server-only): the 200-char note limit and the 256-char model limit. Both are
re-checked by the server — the copies only turn a guaranteed rejection into an
offline error.

## Consuming the lock file (Quarto pattern)

The reference consumer, in its own repo:

1. `ddp-activities.yaml` at the repo root lists every quiz under
   `activities.quizzes`, keyed by chapter slug.
2. `_quarto.yml` adds `metadata-files: [ddp-activities.lock.yaml]`, making
   `activity-codes` available as document metadata.
3. `_extensions/quiz/quiz.lua` takes a registry **key** as its first positional
   argument and resolves `meta["activity-codes"][key]`; an unknown key produces a
   clear render error naming the key and telling the author to run `codes sync`
   and commit the lock. URL construction from `novedu-base-url` is unchanged.
4. Call sites read `{{< quiz welcome title="Welcome" >}}`.

New-activity flow with that consumer pattern: write YAML → `validate` → push → add one
registry line → `codes sync` → reference it by key.

## Testing

- **Unit, pure** — `cli/src/registry.unit.test.ts` (every schema rule, unknown
  properties at each level, URL resolution/normalization, all issues in one run)
  and `cli/src/sync.unit.test.ts` (matcher edge cases incl. timezone spellings
  and absent bounds, claim-based selection and its stability, lock determinism +
  previous-code retention, the warning set, the report lines).
- **Unit, command level** — the `codes sync` block in
  `cli/src/commands/codes.unit.test.ts`: reuse + mint in one run (one GET, the
  POST bodies, the lock content), partial failure (continues, keeps the previous
  code, exit 1), `--dry-run`, `--json`, `--lock`, and every hard failure as JSON
  on stderr. Registry and lock live in a `fs.mkdtemp` directory — the only CLI
  unit tests that touch the filesystem; keep that pattern in that file.
- **Integration** — `cli/test/sync.integration.test.ts` runs the built binary
  against the fixtures server's fake `/api/codes`
  (`test-fixtures/serve.mjs`: GET lists, POST mints deterministic `synced0001…`
  codes, any bearer accepted) with the test-only `NOVEDU_TOKEN` override
  (`cli/src/auth.ts`, checked before the stored session): first run mints and writes
  the lock, second run reports all-reused and leaves the lock byte-identical, and
  the committed broken fixture
  (`test-fixtures/activities/registry/broken-activities.yaml`) exits 1 with the
  zod issues on stderr and no lock. The valid registry is written to a temp dir
  because its `base-url` carries the server's ephemeral port.
