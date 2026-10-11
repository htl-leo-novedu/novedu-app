# Postgres database, Drizzle & credentials

Deep reference for how the app talks to its one data store — Azure Database for
PostgreSQL Flexible Server. The always-on invariants are summarized in
`AGENTS.md`; this file has the full mechanics. Read it before touching Mastra
storage (`app/mastra/index.ts`), the Drizzle setup (`lib/db/`), or any of the
`novedu_*` stores.

## Auth rule (password OR Entra ID, chosen from the URL)

The connection config is built in ONE place — **`buildPoolConfig()` in
`lib/db/pool.ts`** — imported by every consumer (Drizzle, the Mastra store, the
e2e helper); never re-implement the parse/override at a call site. It parses
`DATABASE_URL` and chooses the auth mode **from the URL itself**:

1. **Password auth** — the URL carries a password
   (`postgresql://user:pw@host/db`). Dev/test/CI only.
2. **Microsoft Entra ID (passwordless)** — no password in the URL. `password`
   becomes an **async callback** that fetches an Entra access token for scope
   `https://ossrdbms-aad.database.windows.net/.default` via
   `buildDataStoreCredential()`; node-postgres calls the callback for every NEW
   physical connection, so tokens refresh by themselves. This is the default
   and what production uses (Managed Identity).

The choice is purely "does the URL carry a password?" — there is no separate
env flag. The URL is parsed **by hand** with `new URL()`, and `connectionString`
is **never** passed to the `Pool`: node-postgres re-parses a `connectionString`
and lets it override explicit fields, which would silently discard the token
callback.

Any `sslmode` other than `disable` in the URL turns on TLS with certificate
verification (`ssl: { rejectUnauthorized: true }`) — `require`, `verify-full`,
and libpq's `prefer`/`allow`/`verify-ca` alike, so an unrecognised mode can
never silently downgrade to plaintext; a local container URL without `sslmode`
stays plain TCP.

### When to use which (policy)

- **Production is ALWAYS passwordless Entra / Managed Identity.** A production
  `DATABASE_URL` must **never** carry a password — Entra keeps the DB secret
  out of the connection string, which is the whole point.
- **Password auth is a DEV/TEST/CI-ONLY escape hatch** for environments that
  cannot do Entra — the CI service container, a remote coding agent, a machine
  without `az login`. Both paths exist so those environments can still reach
  the database; neither may be removed (dev/test/CI needs password auth, prod
  needs Entra).
- A password-carrying `DATABASE_URL` **is itself a secret** (unlike the
  passwordless Entra URL), so treat it like one wherever it lives.

### The Entra credential chain

When the Entra path is taken, authenticate with an **explicit** credential
chain, never `DefaultAzureCredential`. The chain is `buildDataStoreCredential()`
(`lib/azure-credential.ts`), never hand-built at a call site:

```ts
new ChainedTokenCredential(
  new AzureCliCredential(tenantId ? { tenantId } : {}), // local dev: `az login`
  new ManagedIdentityCredential(),                       // on Azure: system-assigned MI
)
```

`DefaultAzureCredential` would try `EnvironmentCredential` first and pick up
`AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` — but those are set for
**user sign-in** (`auth.ts`) — the sign-in app registration, not an identity with
a Postgres role — so it would authenticate as the wrong service principal. The
explicit chain ignores those vars: locally it uses the `az login` identity of the
new environment's `az` profile; on Azure the `az` CLI is absent, so
the CLI credential fails fast and the chain falls through to the app's Managed
Identity.

- **`STORAGE_TENANT_ID`** is the tenant of the Postgres database
  (`91fc072c-…`, `docs/azure-access.md`). It is a **separate** variable from the
  user-sign-in `AZURE_TENANT_ID`, even though both name the same tenant today.
  Optional locally — if unset, the az credential uses its ambient default
  tenant. Irrelevant under password auth.
- **`AZURE_CONFIG_DIR`** selects the `az` profile the CLI credential shells out
  to. A local `.env` sets it to the absolute path of the new environment's
  profile (`/home/<you>/.htl-azure-novedu`); without it the credential asks your
  default profile, whose token the server rejects.

### Local dev identity vs. prod identity

The server is `psql-novedu` with one database per stage (`novedu_dev`,
`novedu_prod`; `docs/azure-runtime-env.md`). Its Entra admin is the security
group `novedu-dev`, and **every developer logs in under the group's name** with
their own Entra token as the password — so every developer's `DATABASE_URL` is
the same. Local development runs against `novedu_dev`; there, a group session
automatically acts as the dev stage's app role (`SET ROLE` default, see
*Privilege model*). Each stage's app logs in as its Managed Identity,
`ca-novedu-<stage>`. Both go through the same code path — only the role name
and database in the URL differ.

A role name that is an Entra UPN (a personal login, e.g. for admin work) must be
**URL-encoded** in `DATABASE_URL` (`#` → `%23`, `@` → `%40`); `new
URL().username` keeps the encoding, so `buildPoolConfig` decodes it with
`decodeURIComponent`.

Your machine's IP needs a firewall rule on `psql-novedu`
(`docs/azure-runtime-env.md`).

Example URLs:

```
# Local dev, password-less (Entra, group login; .env also sets AZURE_CONFIG_DIR)
DATABASE_URL=postgresql://novedu-dev@psql-novedu.postgres.database.azure.com/novedu_dev?sslmode=require

# A stage, password-less (Managed Identity)
DATABASE_URL=postgresql://ca-novedu-prod@psql-novedu.postgres.database.azure.com/novedu_prod?sslmode=require

# Local container, password auth (dev/test/CI only)
DATABASE_URL=postgresql://postgres:Test-Passw0rd!@localhost:5432/novedu
```

## `lib/db/pool.ts` — the one seam

`lib/db/pool.ts` exports `buildPoolConfig(url)`, `getPool()`, `closePool()`
(test teardown only), and `databaseHost(url?)`. It deliberately imports
**nothing but `pg` and the credential builder** — no drizzle, nothing from
`app/**` — so the Playwright e2e helper (`e2e/db.ts`) can call `getPool()`
without pulling the app's query layer into the test runner.

`getPool()` returns **one `pg.Pool` per process**, cached on `globalThis` so
Next.js HMR reloads in dev reuse it instead of leaking a new pool per reload.
It throws a clear error (`"DATABASE_URL is not set — database storage is
unavailable"`) when the env var is missing, and attaches a `pool.on("error",
…)` listener so an error on an **idle** pooled client (a server restart, a
network drop, an Azure maintenance failover) is logged instead of crashing the
process as an unhandled event.

The pool is bounded and pinned:

- `max: 20` — Drizzle and the Mastra store share these clients. Both stages,
  local development and every Playwright worker share one small server
  (`max_connections = 50` on `psql-novedu`'s B1ms tier), so each stage's one
  process takes at most 20 and leaves the rest for developers, e2e runs and
  admin sessions.
- `connectionTimeoutMillis: 10_000` — a checkout waits at most 10 s for a free
  client. Without it node-postgres queues forever when the pool is exhausted or
  the server is unreachable, so requests would hang instead of failing into the
  stores' never-throw paths (and `/health` would never report it).
- `idleTimeoutMillis: 30_000`.
- `statement_timeout: 60_000`: the app's largest writes (Mastra messages
  carrying base64 photo attachments) must not be cut off, but a runaway
  statement must still fail loudly. This applies **per statement**.
- `options: "-c TimeZone=UTC"` — pins the session timezone to UTC as a defence.
  The app's own queries are written timezone-independently (`date_trunc(...,
  'UTC')`, `timestamptz` columns), but `now()` and any ad-hoc expression still
  follow the session setting.
- `application_name: "novedu"`.

`databaseHost(url)` returns the URL's hostname (or `null` when unset/
unparseable) for the `/health` dashboard's DNS probe (probe key `db-host`,
label "Database host", test id `health-db-host`; `checkDb` still round-trips
through Mastra storage — see `lib/health.ts`).

## One pool, two consumers

Both consumers take the **same** `getPool()` handle — one pool, one auth
decision, no lifecycle mismatch:

1. **The app's Drizzle handle** (`lib/db/index.ts`, `getDb()` — `drizzle({
   client: getPool() })`, no `schema`/`relations` registered, since every
   store builds its statements from the table objects in `./schema` directly
   and `db.query.*` is unused). Owns the `novedu_*` tables in the `public`
   schema.
2. **Mastra** (`app/mastra/index.ts`): `new PostgresStore({ id:
   "mastra-storage", pool: getPool(), schemaName: "mastra" })` (`@mastra/pg`).
   A pool passed in via `pool:` is never closed by Mastra, so there is no
   lifecycle coupling. One domain is deliberately swapped out: the
   **workflows domain runs in-memory** (`WorkflowsInMemory`). Every agent run
   writes a transient "pending" agentic-loop snapshot at start, reads it back,
   and deletes it at the end — three database round trips per turn for state
   nothing here ever resumes (no suspend/approval flows), so they stay in
   process memory. Threads/messages (Mastra Memory) stay in Postgres, in
   schema `mastra`.

Unset `DATABASE_URL` → the app boots without persistence (warns; the boot
sequence skips migrations); chat then fails because tutor codes and the tutor
agent's memory need the database.

## Privilege model

The web app's Postgres role is a **plain login role** — not superuser, no
`CREATEDB` / `CREATEROLE`, and **not the database owner**. It holds `CONNECT` +
`CREATE` on its stage's database and `USAGE` + `CREATE` on exactly two schemas: `public`
(the app-owned `novedu_*` tables, migrated by Drizzle at boot) and `mastra`
(created by provisioning; Mastra's own tables are created inside it by
`initMastraStorage()`). `CREATE` on the *database* only permits creating
schemas; it is required because Drizzle's migrator always runs `CREATE SCHEMA
IF NOT EXISTS` for its bookkeeping schema (`public`) before anything else, and
Postgres checks that privilege before the `IF NOT EXISTS` shortcut — without it
the boot fails with `permission denied for database`. That same grant is what
lets `initMastraStorage()` run its own `CREATE SCHEMA IF NOT EXISTS "mastra"`
on a database where provisioning has not (a container, CI). `REVOKE CREATE ON
SCHEMA public FROM public` closes the default-open schema, so nothing but the
app role (and the admin) may create objects there. The role **OWNS the tables
it creates at boot** — Drizzle's migrations in `public`, Mastra's `init()` in
`mastra` — and nothing else.

**Why not DML-only.** Mastra's `init()` runs `CREATE TABLE IF NOT EXISTS` /
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on every boot, even when nothing
needs creating — and Postgres refuses `ALTER TABLE` for a non-owner. A
DML-only grant (`SELECT`/`INSERT`/`UPDATE`/`DELETE` without ownership) would
make every boot against an up-to-date schema fail. Table ownership is
therefore the app role's actual runtime requirement, not an over-grant.

**Revisit point.** A future Row-Level Security step (part of the multi-tenant
roadmap) changes this calculus: table **owners bypass RLS** unless a table is
marked `FORCE ROW LEVEL SECURITY`. That is the point to decide on a stricter
split (a separate owner role, out-of-band migrations, a DML-only app role) —
not before RLS is actually on the table.

**Provisioning.** `scripts/db/provision-stage.mjs <dev|prod>` (with
`provision-stage.sql`) is the setup of one stage, run by a member of the
server's Entra admin group; it is idempotent, and `--check` verifies a stage
without changing it (`docs/azure-runtime-env.md`, "Postgres roles and stage
isolation"). On the `postgres` database it registers the stage's Managed
Identity as a role (`pgaadauth_create_principal('ca-novedu-<stage>', false,
false)`) and creates the database, owned by the admin group; in that database
it creates the `mastra` schema, runs `revoke create on schema public from
public` and `revoke connect on database … from public`, and grants the
privileges above. The app creates the `mastra` schema itself when it is missing
(`initMastraStorage()`), but provisioning still creates it explicitly: created
by the admin, the schema is **owned** by the admin with `USAGE` + `CREATE`
granted to the app role — whereas whichever identity boots first against an
unprovisioned database ends up owning it.

**Local boots act as the dev app role.** In `novedu_dev` only, the admin group
is a member of `ca-novedu-dev` and carries the role default
`alter role "novedu-dev" in database novedu_dev set role = 'ca-novedu-dev'`, so
every developer session — a local `npm run dev`, an e2e run, an admin script —
acts as the app role from its first statement. Whatever a local boot creates
(a new migration's tables, a Mastra upgrade's columns or functions) is therefore
owned by `ca-novedu-dev` from the start, exactly as if the dev stage had
booted it, and the stage is never locked out of its own objects. Admin work
that must not act as the app role starts with `SET ROLE NONE`. `novedu_prod`
has no such default and no developer boots against it: its objects are created
only by the prod stage's own boot.

## App-owned schema (`novedu_*`) & Drizzle workflow

- Schema lives in **two files**, both listed in `drizzle.config.ts`'s `schema`
  array and migrated together: **`lib/db/schema.ts`** (`drizzle-orm/pg-core`,
  the app's own `novedu_*` tables) and **`lib/db/auth-schema.ts`** (the
  hand-maintained mirror of better-auth's five tables — its header comment
  explains how to re-check it after a better-auth upgrade). SQL migrations are
  generated with **`npm run db:generate`** (drizzle-kit, no DB connection
  needed) into the committed **`drizzle/`** folder (`migration.sql` +
  `snapshot.json` per folder, drizzle-kit v1 layout; no `meta/_journal.json`).
  Creating and dropping a table in the same generate run needs an explicit
  `--hints` argument naming the create (drizzle-kit otherwise cannot tell that
  apart from a rename); `npx drizzle-kit generate --help` documents the flag's
  shape.
- Before anything writes to the database, startup runs the read-only **provenance
  preflight** (`lib/db/auth-mode-preflight.ts`): one sign-in mode per database, so an
  Entra build refuses a database holding demo (`credential`) accounts and a demo
  build refuses one holding any other provider's accounts; a database without
  `novedu_account` yet is fresh and accepted (`docs/auth.md`, "Demo mode").
- Migrations are applied **automatically at server startup**
  (`instrumentation.ts` → `lib/db/migrate.ts`, `drizzle-orm/node-postgres/migrator`),
  bookkept in **`novedu_drizzle_migrations`**. `migrationsSchema` is pinned to
  `public` on purpose (the driver's default is a *separate* `drizzle` schema;
  the bookkeeping belongs beside the tables it tracks). The migrator still
  runs `CREATE SCHEMA IF NOT EXISTS "public"` on every boot, which is why the
  app role holds `CREATE` on the database (see "Privilege model"). A failed
  migration aborts startup on purpose.
- Applying migrations seeds `novedu_user` and `novedu_account` from every user
  id already referenced across the app's other tables (`created_by`, `user_id`,
  `resolved_by`, `closed_by`, …), so every user id those tables reference
  resolves: each seeded `novedu_user.id` is the id already in use by that
  row (the user's Entra `oid`), and its matching
  `novedu_account` row (`provider_id = 'microsoft'`, `account_id` = that same
  id) is what lets that identity's first sign-in through better-auth link back
  to the seeded row instead of minting a second one. A user signing in for the
  first time gets a random id instead.
- Startup then calls **`initMastraStorage()`** (`app/mastra/index.ts`), which
  runs `CREATE SCHEMA IF NOT EXISTS "mastra"` on the shared pool and then creates
  Mastra's own `mastra.*` tables. The schema statement lives in that function,
  immediately before `PostgresStore.init()`, so the invariant "the schema exists
  before the store initializes" has exactly one home — and deliberately *not* in a
  Drizzle migration, which would pull Mastra's schema into the `novedu_*`
  migration history the two are otherwise decoupled from. `PostgresStore` creates
  the tables itself, but only **lazily** — on the store's first use, i.e. the first agent run — and
  `lib/code-stats-store.ts` reads `mastra.mastra_threads` /
  `mastra.mastra_messages` *directly*, so on a database where no agent has run
  yet a teacher's code detail page would degrade to "Stats temporarily
  unavailable". Doing it at boot keeps the contract simple: **once startup
  finishes, every table this server reads exists.** Fails loud, same as a
  migration failure. A demo build then seeds its four personas
  (`lib/demo-seed.ts`, `docs/auth.md`). The Dockerfile copies `drizzle/` into the standalone
  image. (`instrumentation.ts` has a second, independent duty — bringing up
  telemetry *before* migrations and exporting the `onRequestError` hook; that
  is gated on its own connection string and documented in
  **`docs/telemetry.md`**.)
- **HARD RULE: no foreign keys between `novedu_*` and `mastra_*` tables.**
  Mastra owns its data model; relationships are by-value (see `docs/codes.md`
  for the join model). There is also deliberately no FK `novedu_user_chats →
  novedu_codes` and none for `novedu_recent_codes` (shortcuts join at read
  time). The only foreign keys anywhere in the `novedu_*` space are the two
  among the auth tables — `novedu_session.user_id` and `novedu_account.user_id`,
  both `→ novedu_user.id ON DELETE CASCADE` (`docs/auth.md`); every other
  `user_id`/`created_by` column joins `novedu_user` by value, like everything
  else here.

### Type mapping

`lib/db/schema.ts` maps its columns as follows: bounded/key columns are
`varchar(n)`; unbounded free text (YAML bodies, report snapshots, saved
student texts, `note`, `description`, `title`, `credit`,
`llm_model`, `model`, `file_url`, `origin`) is `text` (Postgres stores it
exactly like a `varchar`, with no length ceiling — the cap on a bounded column
documents the value's shape and is enforced by the database, not only by the
app-side clamps that mirror it); timestamps are `timestamp({ withTimezone:
true, mode: "date" })` (`timestamptz`, always UTC); flags are `boolean`;
token counters are `bigint({ mode: "number" })` (they arrive from the driver
as strings and drizzle converts them); discrete counts are `integer`.

### Partial unique indexes

`novedu_files` and `novedu_images` are the repo's **temporal (append-only)
tables**, sharing one model: each row is one version, the *active* version is
the single row with `valid_until IS NULL`, and "at most one active version per
name" is enforced by a **Postgres partial unique index**:
`uniqueIndex(...).on(t.name).where(sql\`${t.validUntil} IS NULL\`)`. Update =
close the active row + insert a new one; delete = close only. See
`docs/files.md` (and `docs/images.md`) for the full model and the matching
optimistic-concurrency guard.

### Upserts and duplicate-key handling

Increment/overwrite writes are single `INSERT … ON CONFLICT … DO UPDATE`
statements: `recent-code-store` and `writing-store` each
upsert one row (the display name shown everywhere is better-auth's own
`novedu_user.name`, overwritten from the Entra profile on every sign-in by
better-auth itself — there is no app-level upsert-on-sign-in step, see
`docs/auth.md`); both `usage-store` increments add onto existing counters
(`col = table.col + excluded.col`) and COALESCE-fill the nullable
`provider`/`model` columns (`provider = COALESCE(table.provider,
excluded.provider)`) so the first writer with that knowledge wins.
`user-chat-store` uses `ON CONFLICT DO NOTHING` (a duplicate simply means
"already linked").

Real duplicate-key **branches** (code minting retries, a file/image
`name-taken` check, the coding-key mint loop) go through the shared
**`isUniqueViolation()`** in `lib/db/errors.ts`: Postgres reports a
unique-constraint violation as SQLSTATE `23505`, and drizzle wraps the driver
error so the code sits on a nested `cause` rather than the thrown error
itself — `isUniqueViolation` walks up to 10 levels of `cause` looking for it.
Conditional `UPDATE`s (e.g. the optimistic-concurrency guard on
`novedu_files`/`novedu_images`) read node-postgres's `rowCount`, falling back
to `0` when it is absent.

## Table inventory

Tables (details in `docs/codes.md`):

| Table | Keys | Purpose |
| --- | --- | --- |
| `novedu_codes` | PK `code` | Shareable codes across modules: `module` discriminator, file URL, window, note, creating teacher, frozen `anonymous` flag |
| `novedu_user_chats` | PK `thread_id` | user↔chat attribution (only when the activity opts out of anonymity) |
| `novedu_recent_codes` | PK (`user_id`, `code`) | a user's recently used codes (the start page's Recently used) |
| `novedu_writing_submissions` | PK (`code`, `user_id`) | a student's saved writing text — one upserted row per student per code, non-anonymous codes only (details in `docs/writing.md`) |
| `novedu_reports` | PK `id`; indexes on `code`, `resolved_at`; partial index on `user_id WHERE resolved_at IS NOT NULL`; partial index on (`resolved_by`, `resolved_at`) `WHERE resolved_by IS NOT NULL` | student-submitted reports on an AI interaction, always attributed to the reporter's user id even under an anonymous code (details in `docs/reports.md`); the partial indexes serve the reporter's and the resolving teacher's start pages (`docs/home.md`) |
| `novedu_coding_keys` | PK (`code`, `user_id`); unique index on `api_key`; index on `user_id` | the coding module's per-user API keys — one stable `nvk-…` key per student per coding code, the second sanctioned user↔code attribution (details in `docs/coding.md`) |
| `novedu_files` | PK `id` (per-version); partial UK `name WHERE valid_until IS NULL`; index on `created_by` | App-hosted YAML files, **temporal/append-only** (details in `docs/files.md`) |
| `novedu_images` | PK `id` (per-version); partial UK `name WHERE valid_until IS NULL` | App-hosted image metadata (bytes under the configured `IMAGE_STORAGE_ROOT` filesystem), **temporal/append-only** (details in `docs/images.md`) |
| `novedu_usage_by_code` | PK (`code`, `hour`) | per-hour token/tool/activity counts by code, no user (details in `docs/usage-metering.md`) |
| `novedu_usage_by_user` | PK (`user_id`, `hour`) | per-hour token/tool/activity counts by user, no code (details in `docs/usage-metering.md`) |
| `novedu_achievements` | PK (`user_id`, `achievement_id`) | a user's earned start-page badges: generic catalog ids (never a code), the Vienna-local `qualified_on` date, `seen_at` (null = new); never deleted (details in `docs/home.md`) |
| `novedu_quiz_results` | PK (`user_id`, `id`); indexes on (`user_id`, `code`, `finished_at`, `id`) and `code` | a student's saved quiz attempts — slot counts only, written only on the student's explicit choice; the third sanctioned user↔code link, read only by the student (details in `docs/home.md`) |
| `novedu_cloze_gap_counts` | PK (`code`, `gap`, `reference`) | a cloze code's per-gap verdict counters (`correct` / `partial` / `incorrect`) of first submissions — no user id, no answer text, keyed by the teacher's reference so an edited gap starts fresh (details in `docs/cloze.md`) |
| `novedu_user_settings` | PK `user_id` | per-user preferences of the Settings page (`save_quiz_results`); a missing row means every default (details in `docs/home.md`) |
| `novedu_drizzle_migrations` | — | Drizzle migration bookkeeping (schema `public`) |
| `novedu_user` | PK `id` | one row per signed-in person: display name, email, `is_teacher`; the id every `user_id`/`created_by` column across the tables above stores by value (details in `docs/auth.md`) |
| `novedu_session` | PK `id`; unique `token`; FK `user_id → novedu_user.id` cascade | one row per live session, shared by the cookie and bearer channels (details in `docs/auth.md`) |
| `novedu_account` | PK `id`; FK `user_id → novedu_user.id` cascade | the link to the identity provider — `account_id` holds the Entra `oid` (details in `docs/auth.md`) |
| `novedu_verification` | PK `id` | better-auth's short-lived sign-in state, transient (details in `docs/auth.md`) |
| `novedu_device_code` | PK `id`; unique `device_code`, `user_code` | one row per CLI sign-in attempt via the device-authorization flow; `user_id` has no foreign key (details in `docs/api.md`) |

Mastra's own tables live in schema `mastra` (`mastra_threads`, `mastra_messages`,
`mastra_resources`, `mastra_workflow_snapshot`, `mastra_evals`, `mastra_traces`,
`mastra_scorers`, `mastra_notifications`); their camelCase columns (e.g.
`"resourceId"`, `"createdAt"`) must be double-quoted in any raw SQL that reads
them, since Postgres lower-cases an unquoted identifier.

Rows from a raw `db.execute(sql\`…\`)` bypass drizzle's column mappers: the
node-postgres session returns every timestamp as its wire string and
`COUNT`/`SUM` as bigint strings. A store that reads them converts explicitly
(`new Date(row.firstAt)`, `Number(row.total)`), as `lib/code-stats-store.ts`
and `lib/usage-stats-store.ts` do.

## Deletion (no garbage collection)

There is **no** automatic garbage collection. `novedu_achievements` rows are
never deleted at all: an earned badge holds no code, so deleting codes leaves it
in place (`docs/home.md`). Codes and their conversation
data live until a teacher deletes them on `/codes` via "Delete Selected" (the
only delete path). The bulk delete (`deleteCodesAndData` in
`lib/code-stats-store.ts`) removes, per selected code:

1. every Mastra thread under `resourceId = code` and its messages — through
   Mastra's OWN storage API (`getStore("memory").deleteThread`, which deletes a
   thread's messages and the thread in one transaction), so we never mutate the
   `mastra.*` schema by hand;
2. the app-owned rows via Drizzle, all in **one transaction**: the selected
   `novedu_codes` rows locked `FOR UPDATE` first (in code order — a quiz-result
   save holds its code row `FOR SHARE`, so it either commits before the delete or
   finds the code gone), then the selected codes'
   `novedu_coding_keys` rows (one batched statement for the whole selection —
   the only path that ever deletes them), then per code `novedu_user_chats`,
   `novedu_recent_codes`, `novedu_writing_submissions`, `novedu_reports`,
   `novedu_quiz_results` (through `deleteResultsForCode`),
   `novedu_cloze_gap_counts` (through `deleteGapCountsForCode`), and
   finally the `novedu_codes` row LAST (so a mid-way failure leaves the code
   still listed and the operation safe to retry; it is idempotent).

The READ side of stats — counts, per-conversation timings — is plain by-value
SQL against `mastra.mastra_threads`/`mastra.mastra_messages`; see `docs/codes.md`.
