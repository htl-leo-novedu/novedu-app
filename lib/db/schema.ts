import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// NOTE: unbounded free text is `text` (Postgres stores it exactly like a
// `varchar`, with no length ceiling) — the YAML bodies, report snapshots and
// saved student texts below. Key and other bounded columns keep an explicit
// `varchar(n)`: the cap documents the value's shape and is enforced by the
// database, not only by the app-side clamps that mirror it.

// App-owned tables in the `public` schema of the shared Postgres database. They
// live next to Mastra's auto-managed `mastra_*` tables (in their own `mastra`
// schema), distinguished by the `novedu_` prefix.
//
// HARD RULE: NO foreign keys between `novedu_*` and `mastra_*` tables — Mastra
// owns its schema and may recreate/migrate it at any time; we never couple to it.
// The relationships are by-value instead:
//
//   novedu_codes.code = novedu_user_chats.code = mastra_threads.resourceId
//   novedu_user_chats.thread_id = mastra_threads.id = mastra_messages.thread_id
//   novedu_reports.code = novedu_codes.code (report → code note/creator)
//   novedu_reports.user_id = novedu_user.id (report → reporter name)
//   novedu_coding_keys.code = novedu_codes.code (key → coding activity)
//   novedu_coding_keys.user_id = novedu_user.id (key → requester name)
//
// so user → user-chat → chat-history joins work in plain SQL without FKs.

// One row per shareable code, across every module. `module` (`tutor` | `quiz` |
// future) is the dispatch discriminator: the student entry route and the runtime
// route read it off the row to pick the renderer/agent. `file_url` is the
// activity YAML the code hands out. The creating teacher is `created_by` (the
// session user id, `novedu_user.id`). The validity window is inclusive in both
// directions, stored as UTC `timestamptz`; each bound is OPTIONAL — a null
// `valid_from` opens the code immediately, a null `valid_until` never expires it
// (both null = always valid). `origin` documents where the code was
// created (dev/prod host) and is NEVER used in lookups — a code created on
// localhost must work in production, since all environments share this database.
//
// `code` is sized generously (`varchar(32)`, `[a-z0-9-]`) so teacher-defined
// memorable codes fit later; today `generateCode()` mints `[a-z0-9]{10}`.
//
// `anonymous` is the activity YAML's privacy flag FROZEN at create time (the
// create action loads the YAML to validate it anyway). It governs the
// stats-display decision (per-student data) for the code's life. Editing the
// YAML later does NOT update this column — the value captured when the code was
// minted is the one that holds. (The runtime attribution path reads `anonymous`
// LIVE from the YAML instead — see lib/user-chat-store.ts.) Rows are kept until
// the teacher deletes the code (no garbage collection), so the activity at
// `/<code>` simply stops opening once the window closes (`checkCode`) while the
// code and its conversation data remain available for stats.
//
// `llm_provider`/`llm_model` are the code's OPTIONAL per-code LLM override: when
// set, they replace the activity YAML's `llm.provider`/`llm.model` for every
// request served under this code (docs/ai-models.md). BOTH-OR-NOTHING: either
// both are NULL (the YAML's `llm:` block applies) or both are set — model ids
// are provider-specific, so a lone half is meaningless and validation rejects
// it. Editable on /codes/edit (unlike the frozen `anonymous`/`file_url`). Sized
// like the usage tables' provider/model columns. `llm_reasoning` is the pair's
// OPTIONAL third member (the reasoning-effort level): it requires the pair but
// the pair does not require it — NULL simply means no `reasoning_effort` is sent.
export const codes = pgTable(
  "novedu_codes",
  {
    code: varchar("code", { length: 32 }).primaryKey(),
    module: varchar("module", { length: 16 }).notNull(),
    createdBy: varchar("created_by", { length: 64 }).notNull(),
    fileUrl: text("file_url").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }),
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "date" }),
    note: text("note").notNull().default(""),
    origin: text("origin"),
    // Default true = anonymous: the privacy-safe default, and what any row
    // predating this column should read as.
    anonymous: boolean("anonymous").notNull().default(true),
    // Per-code LLM override pair (see the block comment above): NULL = no
    // override. Set/cleared together, never singly.
    llmProvider: varchar("llm_provider", { length: 32 }),
    llmModel: text("llm_model"),
    llmReasoning: varchar("llm_reasoning", { length: 16 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  // The teacher's "Codes" page (and the stats pages) list by creator, and every
  // teacher start-page statement starts from the creator's codes (docs/home.md);
  // the module filter narrows by activity. No index on `valid_until`: nothing
  // deletes by expiry (deletion is explicit, teacher-initiated).
  (t) => [
    index("ix_novedu_codes_created_by").on(t.createdBy),
    index("ix_novedu_codes_module").on(t.module),
  ],
);

// Links a signed-in user to a chat (Mastra thread) opened under a code. Rows are
// written ONLY when the activity YAML opts out of anonymity (`anonymous: false`)
// — by default no user↔chat link is persisted. `code` is widened to match
// novedu_codes.code so a real code (any module) stores by value.
//
// No FK to novedu_codes either: these rows are deliberately kept even after a
// code is deleted, so chat-history attribution outlives the code.
export const userChats = pgTable(
  "novedu_user_chats",
  {
    threadId: varchar("thread_id", { length: 64 }).primaryKey(),
    code: varchar("code", { length: 32 }).notNull(),
    userId: varchar("user_id", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    // "All chats for a code" …
    index("ix_novedu_user_chats_code").on(t.code),
    // … and "all chats of a user".
    index("ix_novedu_user_chats_user_id").on(t.userId),
  ],
);

// A user's recently used codes, backing the shortcuts on the chat entry page
// (`/`). Pure convenience bookkeeping: the displayed label (the teacher's note)
// is NOT duplicated here — the entry page joins novedu_codes, so codes whose row
// was deleted silently drop out of the list. Kept separate from
// novedu_user_chats on purpose: that table is the privacy-gated user↔chat
// attribution, this one only says "this user opened this code".
export const recentCodes = pgTable(
  "novedu_recent_codes",
  {
    userId: varchar("user_id", { length: 64 }).notNull(),
    code: varchar("code", { length: 32 }).notNull(),
    lastUsed: timestamp("last_used", { withTimezone: true, mode: "date" }).notNull(),
  },
  // The PK doubles as the per-user lookup index (user_id prefix).
  (t) => [primaryKey({ columns: [t.userId, t.code] })],
);

// One saved text per `(code, student)` for the writing module — upserted on save
// (single active version, NO history). The student's saved Markdown plus the last
// save time. Rows exist only for non-anonymous writing codes (anonymous writing
// disables saving); the teacher review reads them back. `code` is widened to match
// novedu_codes.code so a real writing code stores by value; `user_id` is the
// student's session user id (`novedu_user.id`).
//
// No foreign keys (same rule as the other novedu_* tables): no FK to novedu_codes,
// so saved texts outlive a deleted code unless the code-delete path drops them
// explicitly.
export const writingSubmissions = pgTable(
  "novedu_writing_submissions",
  {
    code: varchar("code", { length: 32 }).notNull(),
    userId: varchar("user_id", { length: 64 }).notNull(),
    text: text("text").notNull().default(""),
    textUpdatedAt: timestamp("text_updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  // The PK enforces "one saved text per student per code" and doubles as the
  // per-code lookup index (code prefix) for the teacher review.
  (t) => [primaryKey({ columns: [t.code, t.userId] })],
);

// Student-submitted reports on an AI interaction (GH issue #24) — a student
// flags exceptional behavior (good or bad) in a chat or a graded quiz answer to
// the teacher, with a reaction and an optional description. `kind` discriminates
// the two shapes into ONE table (a single merged, filterable, bulk-resolvable
// teacher inbox), the same trade `novedu_codes.module` makes: the discriminator
// costs only nullable snapshot columns.
//
// SECOND user↔activity link, sanctioned: `user_id` (the reporting student's
// session user id, `novedu_user.id`) is ALWAYS set, even under an anonymous code. This is the ONE
// deliberate exception to the "novedu_user_chats is the only user↔chat link"
// invariant — a voluntary waiver of anonymity, created only by an explicit
// student action behind an on-form "reports are not anonymous" notice, never
// implicitly. The store never joins novedu_user_chats or surfaces any student
// but the reporter (docs/reports.md, docs/codes.md).
//
// A chat report proves thread ownership via the stateless HMAC thread token (no
// snapshot needed — the transcript is re-readable at /codes/<code>/c/<thread>).
// A quiz report must carry its OWN snapshot: quiz grading persists nothing
// (the memory-less `quizEvaluator`), so `question_text` (the SERVER's
// authoritative copy) / `answer_text` / `verdict` / `feedback_text` are stored
// on the row; photos are flagged (`had_images`) but NEVER stored.
//
// `resolved_at` is the single source of truth for resolution (resolved ⇔ NOT
// NULL); `resolved_by` is the session user id of the teacher who resolved it. Surrogate
// uuid PK like novedu_files/novedu_images; NO foreign keys (same rule as the
// other novedu_* tables) — reports are dropped explicitly when their code is
// deleted (lib/code-stats-store.ts).
export const reports = pgTable(
  "novedu_reports",
  {
    // Surrogate id (randomUUID).
    id: varchar("id", { length: 36 }).primaryKey(),
    // "chat" | "quiz-answer" — picks which snapshot columns are populated.
    kind: varchar("kind", { length: 16 }).notNull(),
    // The reported activity's code (by value; widened to match novedu_codes.code).
    code: varchar("code", { length: 32 }).notNull(),
    // The reporting student's session user id (`novedu_user.id`) — ALWAYS set (see the block above).
    userId: varchar("user_id", { length: 64 }).notNull(),
    reaction: varchar("reaction", { length: 16 }).notNull(),
    // Optional free text; empty string when the student gave none.
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    // chat only: the reported Mastra thread (null for quiz-answer reports).
    threadId: varchar("thread_id", { length: 64 }),
    // quiz only (all null for chat reports): the snapshot the teacher reviews.
    questionId: varchar("question_id", { length: 450 }),
    // The SERVER's authoritative question text (immune to client tampering and
    // later YAML edits); the answer/feedback are the student's own graded turn.
    questionText: text("question_text"),
    answerText: text("answer_text"),
    feedbackText: text("feedback_text"),
    verdict: varchar("verdict", { length: 16 }),
    // Whether the graded answer carried photos — flagged, never stored.
    hadImages: boolean("had_images").notNull().default(false),
    // Resolution: resolved ⇔ resolved_at IS NOT NULL; resolved_by = teacher's session user id.
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    resolvedBy: varchar("resolved_by", { length: 64 }),
  },
  (t) => [
    // The inbox lists by code (per-code drill-down) …
    index("ix_novedu_reports_code").on(t.code),
    // … and filters open vs. resolved (open rows are the working set).
    index("ix_novedu_reports_resolved_at").on(t.resolvedAt),
    // A reporter's own resolved reports — the start page's Bug Hunter badge
    // (docs/home.md). Partial: only resolved rows are ever read by user.
    index("ix_novedu_reports_user_id_resolved")
      .on(t.userId)
      .where(sql`${t.resolvedAt} IS NOT NULL`),
    // The reports a teacher resolved — the teacher start page's Listener badge
    // (docs/home.md). Partial: only resolved rows carry a resolver.
    index("ix_novedu_reports_resolved_by")
      .on(t.resolvedBy, t.resolvedAt)
      .where(sql`${t.resolvedBy} IS NOT NULL`),
  ],
);

// Per-user API keys for the coding module: one stable key per `(code, user)`,
// minted on the student's first visit to a coding activity (or, for a teacher
// testing their own code, by the detail page's explicit "Get my API key" button)
// and re-displayed on every later visit (any device). The key is what the PUBLIC
// coding proxy
// (`POST /api/coding/v1/chat/completions`) authenticates with, so it — like the
// stored code row beside it — IS the security boundary: both rows are re-verified
// on EVERY request, and a closed window or a deleted code kills all its keys on
// the next one (docs/coding.md).
//
// SECOND user↔code link, sanctioned: `user_id` (the requesting user's session
// user id, `novedu_user.id`) is ALWAYS stored, even though coding codes are frozen `anonymous: true`.
// Alongside `novedu_reports` this is the second deliberate exception to the
// "novedu_user_chats is the only user↔code link" invariant — issuance is a
// deliberate action behind an explicit on-page attribution notice on BOTH issuing
// surfaces, never implicit. Coding conversations themselves are NEVER stored (they happen in the
// student's own tool and only pass through the proxy), and the usage tables keep
// their own invariant: `usage_by_code` has no user, `usage_by_user` has no code.
//
// `api_key` is the secret, stored PLAINTEXT at the same trust level as
// `novedu_codes.code`: `nvk-` + 40 random `[a-z0-9]` chars (36^40 — unguessable;
// the prefix makes a leaked key recognizable as a Novedu coding key). It never
// appears in logs, telemetry, or error messages. `created_at` is the UTC issuance
// time the teacher's issued-keys list shows as "requested at".
//
// NO foreign keys (same rule as the other novedu_* tables) — key rows are dropped
// explicitly when their code is deleted (lib/code-stats-store.ts); nothing else
// deletes them (no revocation, no garbage collection).
export const codingKeys = pgTable(
  "novedu_coding_keys",
  {
    // The coding code this key belongs to (by value; widened to match novedu_codes.code).
    code: varchar("code", { length: 32 }).notNull(),
    // The requesting user's session user id (`novedu_user.id`) — ALWAYS set (see the block above).
    userId: varchar("user_id", { length: 64 }).notNull(),
    // The bearer secret handed to the student's coding tool (see the block above).
    apiKey: varchar("api_key", { length: 64 }).notNull(),
    // UTC issuance timestamp — the teacher-visible "requested at".
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    // The PK enforces "one stable key per user per code" and doubles as the
    // per-code lookup index (code prefix) for the teacher's issued-keys list.
    primaryKey({ columns: [t.code, t.userId] }),
    // The proxy's per-request resolution path: one indexed SELECT by key. Unique
    // so two users can never share a key (a mint collision fails loudly and the
    // store re-mints).
    uniqueIndex("ux_novedu_coding_keys_api_key").on(t.apiKey),
    // A user's own keys — the start page's coding facts (docs/home.md).
    index("ix_novedu_coding_keys_user_id").on(t.userId),
  ],
);

// App-hosted YAML files (tutor definitions and fragment libraries) that teachers
// author in-app instead of hosting on GitHub/S3/Azure Blob. The public GET
// endpoint (`/api/files/<name>`) serves the latest version as raw YAML, so such a
// URL drops straight into the existing tutor-code flow.
//
// TEMPORAL / append-only versioning: each row is ONE version of one file. The
// file's identity is its `name`; the ACTIVE version is the single row with
// `valid_until IS NULL`. Every other row is history (full content kept per
// version — never diffs). The transitions, all run in a transaction:
//
//   create: INSERT one active row.
//   update: close the active row (set valid_until + closed_by) and INSERT a new
//           active row — i.e. a soft-delete of the old version + a fresh version.
//   delete: close the active row (soft delete) and INSERT nothing.
//
// `created_by` is the session user id of whoever wrote a version; `closed_by` is
// the session user id of whoever ended it (the updater OR the deleter), so
// logical deletions are attributed too. The active row's `created_by` is therefore the file's "last
// writer". "At most one active row per name" is enforced at the DATABASE level
// by a PARTIAL UNIQUE index (`name` WHERE `valid_until IS NULL`), so two
// concurrent creates of the same name cannot both succeed — the conditional
// `UPDATE … WHERE id=? AND valid_until IS NULL` in update/delete is the matching
// optimistic-concurrency guard. There are NO foreign keys (same rule as the
// other novedu_* tables).
export const files = pgTable(
  "novedu_files",
  {
    // Surrogate id, unique PER VERSION (a fresh uuid for every row).
    id: varchar("id", { length: 36 }).primaryKey(),
    // Public identifier / GET-URL key. Bounded (see the note above). Allows letters/digits/underscore/hyphen today; `/`-separated
    // folder paths are a future extension (hence the generous length).
    name: varchar("name", { length: 450 }).notNull(),
    // "tutor" | "fragment" | "quiz" — chosen at create time, picks the validator.
    kind: varchar("kind", { length: 16 }).notNull(),
    // Denormalized from the validated YAML (tutor only; null for fragments/quiz) so
    // the file list can be searched by title/description without parsing every body.
    title: text("title"),
    description: text("description"),
    // The ENTIRE YAML for this version (unbounded `text`).
    content: text("content").notNull(),
    // Session user id of the writer who created this version.
    createdBy: varchar("created_by", { length: 64 }).notNull(),
    // When this version became active.
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull(),
    // When this version was closed; NULL = currently active.
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "date" }),
    // Session user id of whoever set valid_until (updater or deleter); NULL while active.
    closedBy: varchar("closed_by", { length: 64 }),
  },
  (t) => [
    // At most ONE active version per name — a Postgres PARTIAL unique index.
    // This both enforces the invariant (closing the create-time race) and serves
    // the GET/edit/close hot path, whose lookup is exactly `name WHERE
    // valid_until IS NULL`.
    uniqueIndex("ux_novedu_files_active_name").on(t.name).where(sql`${t.validUntil} IS NULL`),
    // "all active files" for the list page (active rows are the minority as
    // history accumulates, so an index on the discriminator pays off).
    index("ix_novedu_files_valid_until").on(t.validUntil),
    // A writer's own versions — the teacher start page's Iterator badge
    // (docs/home.md).
    index("ix_novedu_files_created_by").on(t.createdBy),
  ],
);

// App-hosted images that teachers upload for use in activity content. The bytes
// live in the configured image storage root (one object per row, keyed by
// `blob_path` — see `lib/image-fs.ts`); this table only tracks metadata. The
// object is published BEFORE its row is written, and the bytes are retrieved
// through the cookie-session route `GET /api/image-content/<id>`, which re-reads
// the active row on every request.
//
// TEMPORAL / append-only versioning, mirroring novedu_files: each row is ONE
// version of one image. The image's identity is its `name`; the ACTIVE version is
// the single row with `valid_until IS NULL`, every other row is history.
// `created_by` is the session user id of whoever wrote a version; `closed_by` is
// the session user id of whoever ended it. "At most one active row per name" is enforced at the DATABASE
// level by a PARTIAL UNIQUE index (`name` WHERE `valid_until IS NULL`). There
// are NO foreign keys (same rule as the other novedu_* tables).
export const images = pgTable(
  "novedu_images",
  {
    // Surrogate id, unique PER VERSION (a fresh uuid for every row).
    id: varchar("id", { length: 36 }).primaryKey(),
    // Public identifier the teacher picks.
    name: varchar("name", { length: 450 }).notNull(),
    // Server-chosen, opaque object key: `<uuid>.<ext>`. It never changes and is
    // never derived from the name.
    blobPath: varchar("blob_path", { length: 80 }).notNull(),
    // "image/png" | "image/jpeg" | "image/svg+xml".
    mimeType: varchar("mime_type", { length: 32 }).notNull(),
    // Size of the stored object in bytes, as measured while it was written.
    byteSize: integer("byte_size").notNull(),
    // Optional attribution / "Content Credentials" (e.g. a CC BY notice) shown
    // below the image wherever it is rendered. NULL when the teacher gave none.
    credit: text("credit"),
    // Session user id of the writer who created this version.
    createdBy: varchar("created_by", { length: 64 }).notNull(),
    // When this version became active.
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull(),
    // When this version was closed; NULL = currently active.
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "date" }),
    // Session user id of whoever set valid_until; NULL while active.
    closedBy: varchar("closed_by", { length: 64 }),
  },
  (t) => [
    // At most ONE active version per name — a Postgres PARTIAL unique index.
    uniqueIndex("ux_novedu_images_active_name").on(t.name).where(sql`${t.validUntil} IS NULL`),
    // "all active images" for the list page.
    index("ix_novedu_images_valid_until").on(t.validUntil),
  ],
);

// Usage metering — TWO INDEPENDENT hourly aggregate tables, deliberately NOT a
// (code × user) cross. `usage_by_code` has no user; `usage_by_user` has no code (and
// no module), so metering never recreates the user↔code link the anonymity
// invariant forbids for an anonymous code (docs/codes.md). The runtime knows the
// session user id even for anonymous codes, but here it is only ever stored against an hour
// bucket, never alongside the code. Written OFF the response path by
// lib/usage-store.ts via an increment-UPSERT; read via SQL / Log Analytics (there
// is no in-app read surface this iteration). No foreign keys (same rule as the
// other novedu_* tables); never garbage-collected.
//
// `hour` is the UTC top-of-hour bucket. Token sums are `bigint` (they can grow
// large across a busy hour); the discrete counts are `int`. `input_tokens_cached`
// counts prefix-cache hits (SCCH's `prompt_tokens_details.cached_tokens`; see
// docs/usage-metering.md); `output_tokens` already includes reasoning tokens.
export const usageByCode = pgTable(
  "novedu_usage_by_code",
  {
    code: varchar("code", { length: 32 }).notNull(),
    hour: timestamp("hour", { withTimezone: true, mode: "date" }).notNull(),
    // Denormalized from novedu_codes so admin can group by module without a join.
    module: varchar("module", { length: 16 }).notNull(),
    // Denormalized from the activity YAML (docs/usage-metering.md): which LLM
    // provider + model consumed the bucket's tokens. Nullable — only the LLM
    // recorder knows them; a counter recorder that creates the bucket first leaves
    // them NULL and recordLlmUsage COALESCE-fills on its increment. `model` is the
    // raw id (SCCH ids and Foundry deployment names are disjoint). NULL model on
    // pre-metering rows means "unknown".
    provider: varchar("provider", { length: 32 }),
    model: text("model"),
    inputTokensNew: bigint("input_tokens_new", { mode: "number" }).notNull().default(0),
    inputTokensCached: bigint("input_tokens_cached", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    userMessages: integer("user_messages").notNull().default(0),
    quizAnswers: integer("quiz_answers").notNull().default(0),
    writingSaves: integer("writing_saves").notNull().default(0),
    // Requests through the coding proxy (the coding route's usage tap).
    codingRequests: integer("coding_requests").notNull().default(0),
    // Graded cloze submissions (every successful `gradeCloze`, practice rounds included).
    clozeSubmissions: integer("cloze_submissions").notNull().default(0),
  },
  (t) => [
    // Per-code cost-over-time is the PK's natural read; the extra index serves the
    // admin time-range scan across ALL codes ("cost this week").
    primaryKey({ columns: [t.code, t.hour] }),
    index("ix_novedu_usage_by_code_hour").on(t.hour),
  ],
);

// Per-user hourly usage — the substrate a future per-student quota will `SUM` over a
// rolling window. NO `code` and NO `module`: this table must never reveal WHICH
// activity a student did, only how much they used in an hour. `user_id` is the
// student's session user id (`novedu_user.id`).
export const usageByUser = pgTable(
  "novedu_usage_by_user",
  {
    userId: varchar("user_id", { length: 64 }).notNull(),
    hour: timestamp("hour", { withTimezone: true, mode: "date" }).notNull(),
    inputTokensNew: bigint("input_tokens_new", { mode: "number" }).notNull().default(0),
    inputTokensCached: bigint("input_tokens_cached", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    userMessages: integer("user_messages").notNull().default(0),
    quizAnswers: integer("quiz_answers").notNull().default(0),
    writingSaves: integer("writing_saves").notNull().default(0),
    // Requests through the coding proxy (the coding route's usage tap).
    codingRequests: integer("coding_requests").notNull().default(0),
    // Graded cloze submissions (every successful `gradeCloze`, practice rounds included).
    clozeSubmissions: integer("cloze_submissions").notNull().default(0),
  },
  // The PK `(user_id, hour)` doubles as the per-user range-scan index: the quota
  // window and the start page's usage facts (docs/home.md).
  (t) => [primaryKey({ columns: [t.userId, t.hour] })],
);

// Earned achievements (the start page's badges — docs/home.md). One row per user
// and catalog id; rows are never deleted, so an earned badge survives deleted
// codes. The id is a generic catalog key (e.g. `weekly-streak-4`) and NEVER
// contains a code: this table must not become a user↔code link.
// `qualified_on` is the Vienna-local date on which the evidence was first
// complete (the calendar pins the badge there); `seen_at` null = "new".
export const achievements = pgTable(
  "novedu_achievements",
  {
    userId: varchar("user_id", { length: 64 }).notNull(),
    achievementId: varchar("achievement_id", { length: 64 }).notNull(),
    earnedAt: timestamp("earned_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    qualifiedOn: date("qualified_on", { mode: "string" }).notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.achievementId] })],
);

// Saved quiz results (docs/home.md → Saving a quiz result): one row per finished
// attempt a student CHOSE to save — the slot counts only, never an answer. The
// THIRD sanctioned user↔code link beside `novedu_reports` and
// `novedu_coding_keys`: written only by an explicit student action behind an
// on-page notice, even under an anonymous code, and read ONLY for the student
// themselves — `lib/quiz-result-store.ts` is the only access and has no teacher
// reader (guard-tested). `id` is the attempt's uuid, minted in the browser when
// the attempt starts, so a repeated save of one attempt is a no-op. Per
// `(user, code)` the store keeps the newest 50 attempts plus the best one. NO
// foreign keys: rows are dropped with their code (lib/code-stats-store.ts).
export const quizResults = pgTable(
  "novedu_quiz_results",
  {
    id: varchar("id", { length: 36 }).notNull(),
    userId: varchar("user_id", { length: 64 }).notNull(),
    code: varchar("code", { length: 32 }).notNull(),
    correct: integer("correct").notNull(),
    partial: integer("partial").notNull(),
    incorrect: integer("incorrect").notNull(),
    unanswered: integer("unanswered").notNull(),
    // The full attempt length (the sum of the four counts).
    total: integer("total").notNull(),
    // Server time of the save.
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One user's uuid can never block another user's save.
    primaryKey({ columns: [t.userId, t.id] }),
    // The per-quiz reads, the prune, and the start page's own-results read
    // (docs/home.md), whose order it delivers. "Newest" orders by `(finished_at DESC,
    // id DESC)`, which a backward scan of this ascending index serves exactly
    // (an index declared DESC would be NULLS LAST and match no plain DESC).
    index("ix_novedu_quiz_results_user_code_finished").on(t.userId, t.code, t.finishedAt, t.id),
    // The code-delete path.
    index("ix_novedu_quiz_results_code").on(t.code),
  ],
);

// Per-gap verdict counts of a cloze code (docs/cloze.md → Teacher view): how many
// FIRST submissions (practice rounds never count) answered each gap correctly,
// partly or wrongly. Anonymous by construction — no user id, no answer text, no
// time buckets; the only text is the teacher's own reference. Keyed by the
// reference too, so an edited or renumbered gap starts a fresh row and stale rows
// are never mixed in. `lib/cloze-counts-store.ts` is the only access (one
// multi-row increment-upsert per first-round grading); rows are dropped with
// their code (lib/code-stats-store.ts). No foreign keys.
export const clozeGapCounts = pgTable(
  "novedu_cloze_gap_counts",
  {
    code: varchar("code", { length: 32 }).notNull(),
    gap: integer("gap").notNull(),
    reference: text("reference").notNull(),
    correct: integer("correct").notNull().default(0),
    partial: integer("partial").notNull().default(0),
    incorrect: integer("incorrect").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  // The PK's leading `code` also serves the per-code read and the delete.
  (t) => [primaryKey({ columns: [t.code, t.gap, t.reference] })],
);

// Per-user preferences (the Settings page, docs/home.md). A table of its own
// because `novedu_user` is owned by better-auth. A missing row means every
// default; `lib/user-settings-store.ts` is the only access.
export const userSettings = pgTable("novedu_user_settings", {
  userId: varchar("user_id", { length: 64 }).primaryKey(),
  // The Finish page's "Always": save every quiz result without asking.
  saveQuizResults: boolean("save_quiz_results").notNull().default(false),
});
