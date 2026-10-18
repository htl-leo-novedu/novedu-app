import { randomInt } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { CODE_MODULES, type CodeModule, isCodeModule } from "@/lib/code-modules/types";
import { WINDOW_STATUSES, type WindowStatus } from "@/lib/code-window";
import { getDb } from "@/lib/db";
import { authUsers } from "@/lib/db/auth-schema";
import { countRows } from "@/lib/db/count";
import { isUniqueViolation } from "@/lib/db/errors";
import type { OwnerOption } from "@/lib/db/owner-filter";
import { listOwners, ownerJoin, ownerLabel } from "@/lib/db/owners";
import { type PagedResult, type Paging, paginate } from "@/lib/db/paging";
import { affectedRows } from "@/lib/db/result";
import { codes } from "@/lib/db/schema";
import { type SortColumns, sortOrder } from "@/lib/db/sort-order";
import type { Sort } from "@/lib/db/sorting";
import { containsAny } from "@/lib/db/text-filter";
import {
  LLM_PROVIDERS,
  type LlmProvider,
  parseLenientProvider,
  parseLenientReasoningLevel,
  REASONING_LEVELS,
  type ReasoningLevel,
} from "@/lib/llm/provider";

// Persistence for codes in the `novedu_codes` SQL table: every code a teacher
// creates stores its `module`, the activity YAML URL (`file_url`), the
// availability window, an optional note, and the creating teacher (`created_by`).
// The stored row IS the security boundary — an activity at `/<code>` only opens
// while a matching row exists and "now" is inside its window. `generateCode()`
// mints 10 random characters from a 36-char alphabet (36^10 ≈ 3.6e15), so
// guessing one is not practical; the column is sized for future teacher-defined
// memorable codes, which trade enumeration-resistance for memorability (mitigated
// by the Entra auth gate, the window, and the thread-isolation HMAC).
//
// SERVER-ONLY: uses node:crypto and the database. Never import from client
// components.

// The accepted code shape: lowercase letters/digits/hyphen, 1–32 chars. Broad on
// purpose — it bounds the malformed-reject fast path AND admits future memorable
// codes (e.g. `bio101`); generation still mints the narrower `[a-z0-9]{10}`.
export const CODE_PATTERN = /^[a-z0-9-]{1,32}$/;

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const CODE_LENGTH = 10;

/** Crypto-secure random code (`randomInt` is uniform — no modulo bias). */
export function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

// The `note` and `llm_model` columns are unbounded `text` in Postgres; these
// caps are app-side UI/validation limits, not column widths.

/** Longest accepted teacher note. */
export const MAX_NOTE_LENGTH = 200;

/** Longest accepted override model id. */
export const MAX_LLM_MODEL_LENGTH = 256;

/** Longest accepted activity file URL (after normalisation to `URL.href`). */
export const MAX_FILE_URL_LENGTH = 2048;

/**
 * A code's per-code LLM override: replaces the activity YAML's
 * `llm.provider`/`llm.model`/`llm.reasoning` for every request served under the
 * code. The PAIR is both-or-nothing — it exists as a whole or not at all
 * (`null`); model ids are provider-specific, so a lone half is meaningless and
 * never stored. `reasoning` is an OPTIONAL third member: it requires the pair,
 * but the pair does not require it — an override without one means no
 * reasoning effort at all, even when the activity YAML declares one (the
 * override replaces the whole `llm:` block, see `effectiveLlm`).
 */
export interface CodeLlmOverride {
  provider: LlmProvider;
  model: string;
  reasoning?: ReasoningLevel;
}

/**
 * The provider+model (+ optional reasoning effort) a request under `entry` must
 * be served with: the code's override when set, the activity YAML's `llm:`
 * values otherwise. WHOLESALE — an override never merges with the YAML, so a
 * code overriding provider+model alone also drops the YAML's reasoning level.
 * The one definition of the precedence — every consumption site (the module
 * buildRequestContexts, the quiz grader, the tutor agent, the coding proxy)
 * goes through it.
 */
export function effectiveLlm(
  entry: Pick<CodeEntry, "llm">,
  activityLlm: { provider: LlmProvider; model: string; reasoning?: ReasoningLevel },
): { provider: LlmProvider; model: string; reasoning?: ReasoningLevel } {
  return entry.llm ?? activityLlm;
}

// Unix-seconds values are 10 digits today; 15 caps far beyond year 9999 while
// staying well inside Number.isSafeInteger territory.
const TIMESTAMP_PATTERN = /^\d{1,15}$/;

export type CodeRequestValidation =
  | {
      ok: true;
      payload: {
        fileUrl: string;
        validFrom: Date | null;
        validUntil: Date | null;
        note: string;
        llm: CodeLlmOverride | null;
      };
    }
  | { ok: false; message: string };

// Sentinels for an absent window bound: a code with no start opens immediately, a
// code with no end never expires. Coalescing a `null` bound to one of these lets
// the window comparisons stay branch-free (see `windowStatus`). These are the JS
// Date extremes, so they sort before/after any real "now".
export const DISTANT_PAST = new Date(-8_640_000_000_000_000);
export const DISTANT_FUTURE = new Date(8_640_000_000_000_000);

/**
 * Validates a teacher's raw "create code" form input (file URL string,
 * start/end as unix-second strings, free-text note). Pure so the server action
 * stays a thin, auth-handling shell around it.
 *
 * The file URL is NORMALIZED to `URL.href` before it is stored, so the same
 * activity always produces the same stored URL regardless of how the teacher
 * typed it (trailing spaces, un-encoded characters, …).
 */
export function validateCodeRequest(input: {
  file: unknown;
  start: unknown;
  end: unknown;
  note: unknown;
  llmProvider: unknown;
  llmModel: unknown;
  /** Optional third member of the override — only meaningful with the pair. */
  llmReasoning: unknown;
}): CodeRequestValidation {
  let url: URL;
  try {
    url = new URL(typeof input.file === "string" ? input.file.trim() : "");
  } catch {
    return { ok: false, message: "Provide a public http(s) URL to the activity YAML file." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "Provide a public http(s) URL to the activity YAML file." };
  }
  if (url.href.length > MAX_FILE_URL_LENGTH) {
    return {
      ok: false,
      message: `The file URL must be at most ${MAX_FILE_URL_LENGTH} characters long.`,
    };
  }

  // Either bound may be blank — a blank start means the code opens immediately, a
  // blank end means it never expires (open-ended codes). A bound that IS supplied
  // must be a unix-second value; the window is only range-checked when both ends
  // are present.
  const start = typeof input.start === "string" ? input.start : "";
  const end = typeof input.end === "string" ? input.end : "";
  if (start && !TIMESTAMP_PATTERN.test(start)) {
    return { ok: false, message: "The start date and time is invalid." };
  }
  if (end && !TIMESTAMP_PATTERN.test(end)) {
    return { ok: false, message: "The end date and time is invalid." };
  }
  const validFrom = start ? new Date(Number(start) * 1000) : null;
  const validUntil = end ? new Date(Number(end) * 1000) : null;
  if (validFrom && validUntil && validUntil <= validFrom) {
    return { ok: false, message: "The end of the availability window must be after its start." };
  }

  const note = (typeof input.note === "string" ? input.note : "").trim();
  if (note.length > MAX_NOTE_LENGTH) {
    return { ok: false, message: `The note must be at most ${MAX_NOTE_LENGTH} characters.` };
  }

  // The LLM override pair: blank fields mean "no override" (the activity YAML's
  // `llm:` block applies). The pair is both-or-nothing, and the provider must be
  // one of the known literals — free text in the form, strict here.
  const providerText = (typeof input.llmProvider === "string" ? input.llmProvider : "").trim();
  const modelText = (typeof input.llmModel === "string" ? input.llmModel : "").trim();
  if ((providerText === "") !== (modelText === "")) {
    return {
      ok: false,
      message:
        "The LLM override needs both a provider and a model — fill both fields or leave both blank.",
    };
  }
  // The reasoning level is the override's OPTIONAL third member: blank means "no
  // reasoning effort", and a level on its own is meaningless — it only ever
  // applies to an overriding pair.
  const reasoningText = (typeof input.llmReasoning === "string" ? input.llmReasoning : "").trim();
  if (reasoningText && !providerText) {
    return {
      ok: false,
      message:
        "The LLM reasoning level needs a provider and a model override — fill both fields or leave the level blank.",
    };
  }
  let llm: CodeLlmOverride | null = null;
  if (providerText) {
    const provider = parseLenientProvider(providerText);
    if (!provider) {
      return {
        ok: false,
        message: 'The LLM override provider must be "SCCH", "Azure Foundry" or "OpenRouter".',
      };
    }
    if (modelText.length > MAX_LLM_MODEL_LENGTH) {
      return {
        ok: false,
        message: `The LLM override model must be at most ${MAX_LLM_MODEL_LENGTH} characters.`,
      };
    }
    const reasoning = reasoningText ? parseLenientReasoningLevel(reasoningText) : undefined;
    if (reasoningText && !reasoning) {
      return {
        ok: false,
        message: `The LLM reasoning level must be one of ${REASONING_LEVELS.join(", ")}.`,
      };
    }
    llm = { provider, model: modelText, ...(reasoning ? { reasoning } : {}) };
  }

  return { ok: true, payload: { fileUrl: url.href, validFrom, validUntil, note, llm } };
}

/** A code's stored data, as read back from `novedu_codes`. */
export interface CodeEntry {
  code: string;
  /** Which shareable-activity module this code dispatches to. */
  module: CodeModule;
  /** Session user id (`novedu_user.id`) of the creating teacher. */
  createdBy: string;
  /** Public URL of the activity-definition YAML (normalized via `URL.href`). */
  fileUrl: string;
  /** Window start, UTC. Inclusive. `null` = no start (the code opens immediately). */
  validFrom: Date | null;
  /** Window end, UTC. Inclusive. `null` = no end (the code never expires). */
  validUntil: Date | null;
  /** Teacher's note, shown in their code list. May be empty. */
  note: string;
  /**
   * Origin the code was created on, e.g. `http://localhost:3000`. FOR THE
   * OPERATOR'S EYES ONLY — it tells DEV from PROD rows. Lookups never read it:
   * a code created on localhost works in production (same database).
   */
  origin: string | null;
  /**
   * The activity YAML's `anonymous` flag, FROZEN at create time (default `true`).
   * `false` means the stats page may show per-student data. A later YAML edit
   * does not change it; the runtime attribution path reads `anonymous` LIVE
   * instead (lib/user-chat-store.ts).
   */
  anonymous: boolean;
  /**
   * The code's per-code LLM override, or `null` for "use the activity YAML's
   * `llm:` block". Editable on /codes/edit (NOT frozen like `anonymous`). Apply
   * it via `effectiveLlm` — never read its members directly.
   */
  llm: CodeLlmOverride | null;
  createdAt: Date;
}

/**
 * A code as the `/codes` LIST shows it: the stored entry plus its owner's display
 * name, LEFT-JOINed from `novedu_user` by value — `null` when that teacher has
 * never signed in through the web app, in which case the page falls back to the raw
 * `createdBy` user id. A superset of `CodeEntry`, so every `CodeEntry` consumer (the
 * bearer route's wire shape included) is unaffected.
 */
export type CodeListRow = CodeEntry & { ownerName: string | null };

// Row shape from the DB has `module` as a plain string column; narrow it to the
// CodeModule union on read. A row whose module is not a known module — a corrupt
// or forward-compat row (e.g. a module written to the DB before its registry entry
// exists) — is treated as ABSENT (`null` here), so the registry is never indexed
// with an unknown key downstream: the runtime route, the stats/list pages, and the
// `/<code>` dispatcher all rely on `module` being a real `CodeModule`. checkCode
// then reports `unknown-code`, getCode `null`, and listCodes drops the row.
function toEntry(row: typeof codes.$inferSelect): CodeEntry | null {
  if (!isCodeModule(row.module)) {
    console.error(`code-store: code ${row.code} has unknown module ${JSON.stringify(row.module)}`);
    return null;
  }
  const { llmProvider, llmModel, llmReasoning, ...rest } = row;
  return {
    ...rest,
    module: row.module,
    llm: toLlmOverride(row.code, llmProvider, llmModel, llmReasoning),
  };
}

// Combines the three override columns into the both-or-nothing pair plus its
// optional reasoning level. Only the validated create/edit actions write them, so
// a lone half or an unknown provider is a corrupt row — logged, then treated as
// NO override so the code keeps working on the activity YAML's own `llm:`
// values. An unknown stored REASONING is the milder corruption: the pair is
// still meaningful on its own, so it survives and only the level is dropped.
function toLlmOverride(
  code: string,
  provider: string | null,
  model: string | null,
  reasoning: string | null,
): CodeLlmOverride | null {
  if (provider === null && model === null) return null;
  const parsed = provider === null ? undefined : parseLenientProvider(provider);
  if (!parsed || !model) {
    console.error(
      `code-store: code ${code} has an invalid LLM override ${JSON.stringify({ provider, model })}; ignoring it`,
    );
    return null;
  }
  const level = reasoning === null ? undefined : parseLenientReasoningLevel(reasoning);
  if (reasoning !== null && !level) {
    console.error(
      `code-store: code ${code} has an invalid LLM reasoning level ${JSON.stringify(reasoning)}; ignoring it`,
    );
  }
  return { provider: parsed, model, ...(level ? { reasoning: level } : {}) };
}

export type CreateCodeResult = { stored: true; code: string } | { stored: false };

// A duplicate primary key surfaces as SQLSTATE 23505 (unique_violation), wrapped
// by drizzle in a DrizzleQueryError whose `cause` is the driver error — the
// signal to retry with a fresh random code.

// With a 36^10 keyspace two consecutive collisions are practically impossible;
// the cap only guards against a systematic duplicate-key error turning into an
// infinite loop.
const MAX_CODE_ATTEMPTS = 10;

/**
 * Stores a freshly created code. Never throws: the database being unavailable
 * means `{ stored: false }`, which the create action surfaces as an error —
 * without a stored row there is nothing to hand out.
 */
export async function createCode(
  createdBy: string,
  data: {
    module: CodeModule;
    fileUrl: string;
    validFrom: Date | null;
    validUntil: Date | null;
    note: string;
    origin?: string;
    /** The activity YAML's `anonymous` flag, captured now and frozen on the row. */
    anonymous: boolean;
    /** The per-code LLM override (pair + optional reasoning), or `null` for none. */
    llm: CodeLlmOverride | null;
  },
): Promise<CreateCodeResult> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const candidate = generateCode();
    try {
      await getDb()
        .insert(codes)
        .values({
          code: candidate,
          module: data.module,
          createdBy,
          fileUrl: data.fileUrl,
          validFrom: data.validFrom,
          validUntil: data.validUntil,
          note: data.note,
          origin: data.origin,
          anonymous: data.anonymous,
          llmProvider: data.llm?.provider ?? null,
          llmModel: data.llm?.model ?? null,
          llmReasoning: data.llm?.reasoning ?? null,
          createdAt: new Date(),
        });
      return { stored: true, code: candidate };
    } catch (error) {
      if (isUniqueViolation(error)) continue; // code taken — retry with a new one
      console.error("code-store: failed to store code", error);
      return { stored: false };
    }
  }
  console.error("code-store: could not find a free code, code not stored");
  return { stored: false };
}

export type CheckCodeResult =
  // The code exists and "now" is inside its window — the activity may open.
  | { ok: true; entry: CodeEntry }
  // No row with this code — never issued or mistyped.
  | { ok: false; reason: "unknown-code" }
  // The code exists but "now" is outside its window; the relevant bound is
  // included so the UI can say WHEN the code opens/closed, in local time. Each
  // rejection carries only the bound that fired (and which is therefore present —
  // an absent bound can never reject), so no `null` reaches the error view.
  | { ok: false; reason: "not-started"; validFrom: Date }
  | { ok: false; reason: "expired"; validUntil: Date }
  // Database misconfigured/unreachable — retrying later may work.
  | { ok: false; reason: "lookup-failed" };

export type CodeRejection = Extract<CheckCodeResult, { ok: false }>["reason"];

/**
 * THE security check for a code, used by the student entry route
 * (`app/[code]/page.tsx`), the chat runtime route, and the quiz actions — all of
 * which re-check on EVERY request, so an open activity stops accepting input once
 * the window closes. Both window bounds are inclusive. `now` is injected for
 * testability. Malformed codes are rejected without a database round-trip. Never
 * throws.
 */
export async function checkCode(code: string, now: Date = new Date()): Promise<CheckCodeResult> {
  if (!CODE_PATTERN.test(code)) return { ok: false, reason: "unknown-code" };

  let rows: (typeof codes.$inferSelect)[];
  try {
    rows = await getDb().select().from(codes).where(eq(codes.code, code));
  } catch (error) {
    console.error("code-store: code lookup failed", error);
    return { ok: false, reason: "lookup-failed" };
  }

  const row = rows[0];
  if (!row) return { ok: false, reason: "unknown-code" };
  const entry = toEntry(row);
  // An unrecognized module is as good as no code for a student.
  if (!entry) return { ok: false, reason: "unknown-code" };
  // An absent bound is "open" on that side: the truthiness guard short-circuits,
  // so a `null` start never reports not-started and a `null` end never expires
  // (equivalent to coalescing to DISTANT_PAST / DISTANT_FUTURE). The guard also
  // narrows the carried bound to non-null.
  if (entry.validFrom && now < entry.validFrom) {
    return { ok: false, reason: "not-started", validFrom: entry.validFrom };
  }
  if (entry.validUntil && now > entry.validUntil) {
    return { ok: false, reason: "expired", validUntil: entry.validUntil };
  }
  return { ok: true, entry };
}

// The list's WHERE, built once and shared by the COUNT and the row query — they
// must never drift, or a page's total would describe a different set than its rows.
/** The `/codes` list's filters — every one a SQL condition (see `listConditions`). */
export interface CodeListFilter {
  search?: string;
  createdBy?: string;
  /** One activity — the classic list's dropdown and the bearer API. */
  module?: CodeModule;
  /** Any of these activities — the new list's multi-select; empty = no filter. */
  modules?: readonly CodeModule[];
  /** Any of these window states, judged against `now`; empty = no filter. */
  statuses?: readonly WindowStatus[];
  /** The request's "now" — the same instant the page's status badges use. */
  now?: Date;
}

/**
 * The SQL twin of `windowStatus` (`lib/code-window.ts`): a code is in ANY of
 * `statuses` at `now`. Bounds are inclusive and a NULL bound is open, exactly as
 * the badge reads them. `undefined` when the set filters nothing (none or all
 * three). Exported for the SQL-text tests.
 */
export function windowStatusCondition(
  statuses: readonly WindowStatus[],
  now: Date,
): SQL | undefined {
  if (statuses.length === 0 || statuses.length >= WINDOW_STATUSES.length) return undefined;
  // "Started" is the complement of upcoming, so upcoming wins over expired here
  // just as in `windowStatus`. A NULL `valid_from` makes `gt` NULL, i.e. false.
  const started = or(isNull(codes.validFrom), lte(codes.validFrom, now));
  const byStatus: Record<WindowStatus, SQL | undefined> = {
    upcoming: gt(codes.validFrom, now),
    expired: and(started, lt(codes.validUntil, now)),
    active: and(started, or(isNull(codes.validUntil), gte(codes.validUntil, now))),
  };
  return or(...statuses.map((status) => byStatus[status]));
}

function listConditions(opts?: CodeListFilter): SQL[] {
  // A row whose `module` the app doesn't know is not a usable code (see
  // `toEntry`). Filtering it out HERE rather than after the query is what keeps a
  // page's row count and its total in agreement.
  const conditions: SQL[] = [inArray(codes.module, CODE_MODULES)];
  const term = opts?.search?.trim();
  if (term) {
    const match = containsAny(term, [codes.note, codes.code]);
    if (match) conditions.push(match);
  }
  if (opts?.createdBy) conditions.push(eq(codes.createdBy, opts.createdBy));
  if (opts?.module) conditions.push(eq(codes.module, opts.module));
  if (opts?.modules?.length) conditions.push(inArray(codes.module, [...opts.modules]));
  if (opts?.statuses?.length) {
    const inWindow = windowStatusCondition(opts.statuses, opts.now ?? new Date());
    if (inWindow) conditions.push(inWindow);
  }
  return conditions;
}

// The row's owner name (display-only; see `ownerJoin`) and the label the `owner`
// sort key orders by — the same coalesced expression the dropdown shows, so the
// column sorts by exactly what it displays.
const JOIN_OWNER = ownerJoin(codes.createdBy);
const OWNER_LABEL = ownerLabel(codes.createdBy);

/**
 * The override model the list's "Override model" column shows: `llm_model` when
 * the row holds a usable override pair (a known provider AND a non-empty model —
 * the SQL twin of `toLlmOverride`), else NULL. Ascending lists the overrides
 * first, A–Z, since Postgres sorts NULL last. Exported for the SQL-text tests.
 */
export const LLM_OVERRIDE_MODEL = sql<
  string | null
>`CASE WHEN ${inArray(codes.llmProvider, [...LLM_PROVIDERS])} AND ${codes.llmModel} <> '' THEN ${codes.llmModel} END`;

/**
 * The `/codes` list's sortable columns (ORDER BY map + `parseSort` allow-list).
 * `module` sorts by the STORED value (coding, quiz, tutor, writing alphabetically),
 * not by the badge label the row renders. The list's "Interactions" column is
 * deliberately absent: it is a separate aggregate over the Mastra-owned tables,
 * computed for the page AFTER it is read, so it cannot be an ORDER BY term of this query.
 */
export const CODE_SORT_COLUMNS = {
  module: codes.module,
  note: codes.note,
  owner: OWNER_LABEL,
  from: codes.validFrom,
  until: codes.validUntil,
  override: LLM_OVERRIDE_MODEL,
} satisfies SortColumns;

/** Every `/codes` sort key. */
export type CodeSortKey = keyof typeof CODE_SORT_COLUMNS;

/**
 * The distinct owners (creating teachers) of the listed codes, for the `/codes`
 * owner dropdown. Base conditions only — see `listOwners`. Never throws.
 */
export async function listCodeOwners(): Promise<OwnerOption[]> {
  return listOwners(codes, codes.createdBy, listConditions());
}

/**
 * Codes for the "Codes" page — ALL teachers' codes (a teacher may see/manage
 * every code; finer-grained RBAC is planned), newest first unless a `sort` says
 * otherwise, including not-yet-started and expired ones. Filtering happens IN THE DATABASE (see
 * `docs/filtered-lists.md`), never in memory: an optional `search` term is a
 * case-insensitive contains-match over note/code, `createdBy` narrows to one
 * teacher's codes (the owner filter), `module` / `modules` narrow to one or any
 * of several activities, and `statuses` to codes whose window is active /
 * upcoming / expired at `now`. Never throws — an unreachable database reads as
 * `undefined`, which the page notes.
 *
 * `paging` makes the SKIP and the LIMIT part of the SQL too (`LIMIT/OFFSET`,
 * with a COUNT for the total), and `sort` the ORDER BY — so a sort spans the whole
 * filtered set, not one page. Omitting both returns every match in the default
 * order, which is what the bearer API route wants.
 */
export async function listCodes(
  opts?: CodeListFilter & { paging?: Paging; sort?: Sort },
): Promise<PagedResult<CodeListRow> | undefined> {
  const conditions = listConditions(opts);
  try {
    return await paginate({
      paging: opts?.paging,
      count: () => countRows(codes, conditions),
      // A FRESH builder per call — drizzle builders are stateful and `paginate`
      // may invoke this twice (once more after clamping an over-shot page).
      rows: async (window) => {
        const query = getDb()
          // The stored columns spread rather than restated, plus the joined owner
          // name — so a schema change reaches the list without an edit here.
          .select({ ...getTableColumns(codes), ownerName: authUsers.name })
          .from(codes)
          .leftJoin(authUsers, JOIN_OWNER)
          .where(and(...conditions))
          .orderBy(
            ...sortOrder(opts?.sort, CODE_SORT_COLUMNS, [desc(codes.createdAt)], asc(codes.code)),
          );
        const rows = await (window ? query.limit(window.limit).offset(window.offset) : query);
        // Unreachable now that the module check is a WHERE condition (a dropped
        // row would make a page short and disagree with the COUNT) — kept so a
        // future condition change can't silently reintroduce that mismatch.
        // `getCode`/`checkCode` still exercise toEntry's corrupt-row logging.
        return rows
          .map(({ ownerName, ...row }) => {
            const entry = toEntry(row);
            return entry && { ...entry, ownerName };
          })
          .filter((entry): entry is CodeListRow => entry !== null);
      },
    });
  } catch (error) {
    console.error("code-store: listing codes failed", error);
    return undefined;
  }
}

/**
 * Looks up a single code by value, WITHOUT an ownership check — the gate for the
 * stats / conversation-viewer / edit / delete paths now that any effective
 * teacher may manage any code (finer-grained RBAC is planned; the page-level
 * `requireTeacherPage()` / action-level `requireTeacherUserId()` gate still
 * applies). Returns the row, `null` if the code is malformed or does not exist,
 * or `undefined` on a database error. Never throws.
 */
export async function getCode(code: string): Promise<CodeEntry | null | undefined> {
  if (!CODE_PATTERN.test(code)) return null;
  try {
    const rows = await getDb().select().from(codes).where(eq(codes.code, code));
    const row = rows[0];
    return row ? toEntry(row) : null;
  } catch (error) {
    console.error("code-store: code lookup failed", error);
    return undefined;
  }
}

export type UpdateCodeResult = { ok: true } | { ok: false; reason: "not-found" | "error" };

/**
 * Updates the editable fields of a code: the availability window, the note, and
 * the LLM override (set or cleared as a whole, its reasoning level included). The file URL is
 * INTENTIONALLY not updatable here — and neither is the frozen `anonymous` flag
 * (which is tied to that URL): editing them would break the documented
 * "anonymous frozen at create time" invariant. `not-found` if no row matches
 * (deleted meanwhile). Never throws.
 */
export async function updateCode(
  code: string,
  data: {
    validFrom: Date | null;
    validUntil: Date | null;
    note: string;
    llm: CodeLlmOverride | null;
  },
): Promise<UpdateCodeResult> {
  if (!CODE_PATTERN.test(code)) return { ok: false, reason: "not-found" };
  try {
    const updated = await getDb()
      .update(codes)
      .set({
        validFrom: data.validFrom,
        validUntil: data.validUntil,
        note: data.note,
        llmProvider: data.llm?.provider ?? null,
        llmModel: data.llm?.model ?? null,
        llmReasoning: data.llm?.reasoning ?? null,
      })
      .where(eq(codes.code, code));
    if (affectedRows(updated) < 1) return { ok: false, reason: "not-found" };
    return { ok: true };
  } catch (error) {
    console.error("code-store: updating code failed", error);
    return { ok: false, reason: "error" };
  }
}
