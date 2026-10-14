import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { HOME_TIME_ZONE, type LocalDate } from "@/lib/achievements/time";
import { type DbExecutor, getDb } from "@/lib/db";
import { authUsers } from "@/lib/db/auth-schema";
import { countRows } from "@/lib/db/count";
import { isUniqueViolation } from "@/lib/db/errors";
import type { OwnerOption } from "@/lib/db/owner-filter";
import { listOwners, ownerJoin, ownerLabel } from "@/lib/db/owners";
import { type PagedResult, type Paging, paginate } from "@/lib/db/paging";
import { affectedRows } from "@/lib/db/result";
import { files } from "@/lib/db/schema";
import { type SortColumns, sortOrder } from "@/lib/db/sort-order";
import type { Sort } from "@/lib/db/sorting";
import { containsAny } from "@/lib/db/text-filter";
// The pure name/kind helpers live in `lib/file-name.ts` (no DB import) so the
// public GET route, the image store and client components can use them too.
// Re-exported here so existing `@/lib/file-store` importers are unaffected.
import {
  FILE_NAME_PATTERN,
  type FileKind,
  type FileNameValidation,
  isFileKind,
  validateFileName,
} from "@/lib/file-name";
import { reportStoreFailure } from "@/lib/store-failure";

export { FILE_NAME_PATTERN, type FileKind, type FileNameValidation, isFileKind, validateFileName };

// Persistence for app-hosted YAML files in the `novedu_files` SQL table. The
// table is TEMPORAL/append-only: each row is one version of one file, the active
// version is the single row with `valid_until IS NULL`, every other row is
// history. See the schema comment in `lib/db/schema.ts` for the model; this
// module owns ALL access to the table so the "filter on the active version"
// invariant lives in one place.
//
// A file's stable identity is its `name` (the surrogate `id` is per-version), so
// every operation keys on the name. Functions never throw — a database problem
// surfaces as `undefined`/`{ ok: false }`, which callers turn into a graceful
// message.
//
// SERVER-ONLY: uses node:crypto and the database. Never import from client
// components.

/** A file as shown in the teacher's list — the active version, WITHOUT its (large) content. */
export interface FileListEntry {
  id: string;
  name: string;
  kind: string;
  title: string | null;
  description: string | null;
  /** When the active version was written = the file's "last updated" time. */
  validFrom: Date;
  /** Session user id of the writer of the active version = the file's "last writer". */
  createdBy: string;
}

/**
 * A file as the `/files` LIST shows it: the entry plus its OWNER's display name,
 * LEFT-JOINed from `novedu_user` by value — `null` when that teacher has never
 * signed in through the web app, in which case the page falls back to the raw user id.
 * "Owner" is the last writer here (see `createdBy` above), the word the UI and the
 * teacher guide use.
 */
export type FileListRow = FileListEntry & { ownerName: string | null };

/** The active version of one file, including its content (for the editor / GET). */
export interface ActiveFile extends FileListEntry {
  content: string;
}

// Column caps for the DENORMALIZED search fields (see `title`/`description` in
// lib/db/schema.ts). They exist only so the list can be searched without parsing
// every body — the authoritative text always lives in `content` — so clamping an
// unusually long title/description to the column width is lossless for the file
// itself, and it stops a perfectly VALID tutor (whose schema imposes no length
// cap) from failing the INSERT with a truncation error.
const TITLE_MAX = 512;
const DESCRIPTION_MAX = 2048;
function clamp(value: string | null, max: number): string | null {
  return value !== null && value.length > max ? value.slice(0, max) : value;
}

// The list's WHERE, built once and shared by the COUNT and the row query — they
// must never drift, or a page's total would describe a different set than its rows.
function listConditions(opts?: { search?: string; createdBy?: string }): SQL[] {
  const conditions: SQL[] = [isNull(files.validUntil)];
  const term = opts?.search?.trim();
  if (term) {
    const match = containsAny(term, [files.name, files.title, files.description]);
    if (match) conditions.push(match);
  }
  if (opts?.createdBy) conditions.push(eq(files.createdBy, opts.createdBy));
  return conditions;
}

// The row's owner name (display-only; see `ownerJoin`) and the label the `owner`
// sort key orders by — the same coalesced expression the dropdown shows, so the
// column sorts by exactly what it displays.
const JOIN_OWNER = ownerJoin(files.createdBy);
const OWNER_LABEL = ownerLabel(files.createdBy);

/** The `/files` list's sortable columns (ORDER BY map + `parseSort` allow-list). */
export const FILE_SORT_COLUMNS = {
  name: files.name,
  kind: files.kind,
  title: files.title,
  owner: OWNER_LABEL,
  updated: files.validFrom,
} satisfies SortColumns;

/**
 * The distinct owners (last writers) of the active files, for the `/files` owner
 * dropdown. Base conditions only — see `listOwners`. Never throws.
 */
export async function listFileOwners(): Promise<OwnerOption[]> {
  return listOwners(files, files.createdBy, listConditions());
}

/**
 * The active (non-deleted) files for the "YAML Files" list, newest first unless a
 * `sort` says otherwise. Filtering happens IN THE DATABASE (see `docs/filtered-lists.md`), never in
 * memory: an optional `search` term is a case-insensitive contains-match over
 * name/title/description, and `createdBy` narrows to one writer's files (the
 * owner dropdown). Content is intentionally NOT selected (it can be large
 * and the list never shows it). `undefined` on a database error, which the page
 * notes.
 *
 * `paging` makes the SKIP and the LIMIT part of the SQL too (`LIMIT/OFFSET`,
 * with a COUNT for the total), and `sort` the ORDER BY — so a sort spans the whole
 * filtered set, not one page. Omitting both returns every match in the default
 * order, which is what the bearer API route wants.
 */
export async function listFiles(opts?: {
  search?: string;
  createdBy?: string;
  paging?: Paging;
  sort?: Sort;
}): Promise<PagedResult<FileListRow> | undefined> {
  const conditions = listConditions(opts);
  try {
    return await paginate({
      paging: opts?.paging,
      count: () => countRows(files, conditions),
      // A FRESH builder per call — drizzle builders are stateful and `paginate`
      // may invoke this twice (once more after clamping an over-shot page).
      rows: (window) => {
        const query = getDb()
          .select({
            id: files.id,
            name: files.name,
            kind: files.kind,
            title: files.title,
            description: files.description,
            validFrom: files.validFrom,
            createdBy: files.createdBy,
            ownerName: authUsers.name,
          })
          .from(files)
          .leftJoin(authUsers, JOIN_OWNER)
          .where(and(...conditions))
          .orderBy(
            ...sortOrder(opts?.sort, FILE_SORT_COLUMNS, [desc(files.validFrom)], asc(files.id)),
          );
        return window ? query.limit(window.limit).offset(window.offset) : query;
      },
    });
  } catch (error) {
    console.error("file-store: listing files failed", error);
    return undefined;
  }
}

/**
 * The active version of a file by name, WITH content — backs the edit page and
 * the public GET endpoint. `null` if the name is malformed or no active version
 * exists (unknown or soft-deleted); `undefined` on a database error.
 */
export async function getActiveFile(name: string): Promise<ActiveFile | null | undefined> {
  const valid = validateFileName(name);
  if (!valid.ok) return null;
  try {
    const rows = await getDb()
      .select()
      .from(files)
      .where(and(eq(files.name, valid.name), isNull(files.validUntil)));
    const entry = rows[0];
    if (!entry) return null;
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      title: entry.title,
      description: entry.description,
      content: entry.content,
      validFrom: entry.validFrom,
      createdBy: entry.createdBy,
    };
  } catch (error) {
    console.error("file-store: active-file lookup failed", error);
    return undefined;
  }
}

export type CreateFileResult =
  | { ok: true; name: string }
  | { ok: false; reason: "name-taken" | "error" };

/**
 * Creates a brand-new file (version 1). Fails with `name-taken` if an active file
 * already uses the name (uniqueness is enforced here, among active files only, so
 * a name can be reused after its file is deleted). Runs in a transaction so the
 * existence check and the insert are atomic.
 */
export async function createFile(
  input: {
    name: string;
    kind: FileKind;
    content: string;
    title: string | null;
    description: string | null;
  },
  userId: string,
): Promise<CreateFileResult> {
  const now = new Date();
  try {
    return await getDb().transaction(async (tx) => {
      const existing = await tx
        .select({ id: files.id })
        .from(files)
        .where(and(eq(files.name, input.name), isNull(files.validUntil)));
      if (existing.length > 0) return { ok: false, reason: "name-taken" as const };

      await tx.insert(files).values({
        id: randomUUID(),
        name: input.name,
        kind: input.kind,
        title: clamp(input.title, TITLE_MAX),
        description: clamp(input.description, DESCRIPTION_MAX),
        content: input.content,
        createdBy: userId,
        validFrom: now,
        validUntil: null,
        closedBy: null,
      });
      return { ok: true, name: input.name };
    });
  } catch (error) {
    // The pre-check above handles the common case, but the partial unique index
    // is the real guard against a concurrent create racing in after it — it
    // rejected a second active row for the same name, SQLSTATE 23505.
    if (isUniqueViolation(error)) return { ok: false, reason: "name-taken" };
    console.error("file-store: create failed", error);
    return { ok: false, reason: "error" };
  }
}

export type UpdateFileResult = { ok: true } | { ok: false; reason: "not-found" | "error" };

/**
 * Saves a new version: closes the current active row (soft-delete it, recording
 * the writer in `closed_by`) and inserts a fresh active row carrying the new
 * content/title/description. The `kind` is preserved from the existing version.
 * The conditional close (`WHERE id=? AND valid_until IS NULL`) is the concurrency
 * guard — if a parallel writer already moved the file on, it affects 0 rows and
 * this returns `not-found` rather than minting a second active row.
 */
export async function updateFile(
  name: string,
  input: { content: string; title: string | null; description: string | null },
  userId: string,
): Promise<UpdateFileResult> {
  const now = new Date();
  try {
    return await getDb().transaction(async (tx) => {
      const rows = await tx
        .select({ id: files.id, kind: files.kind })
        .from(files)
        .where(and(eq(files.name, name), isNull(files.validUntil)));
      const active = rows[0];
      if (!active) return { ok: false, reason: "not-found" as const };

      const closed = await tx
        .update(files)
        .set({ validUntil: now, closedBy: userId })
        .where(and(eq(files.id, active.id), isNull(files.validUntil)));
      if (affectedRows(closed) < 1) return { ok: false, reason: "not-found" as const };

      await tx.insert(files).values({
        id: randomUUID(),
        name,
        kind: active.kind,
        title: clamp(input.title, TITLE_MAX),
        description: clamp(input.description, DESCRIPTION_MAX),
        content: input.content,
        createdBy: userId,
        validFrom: now,
        validUntil: null,
        closedBy: null,
      });
      return { ok: true };
    });
  } catch (error) {
    console.error("file-store: update failed", error);
    return { ok: false, reason: "error" };
  }
}

export type DeleteFileResult = { ok: true } | { ok: false; reason: "not-found" | "error" };

/**
 * The ONE soft-delete primitive: closes a file's active row (`valid_until` +
 * `closed_by`) on the given transaction executor — `softDeleteFiles` loops it over
 * the selected names. A single conditional statement; `not-found` (no active row)
 * is NOT an error, so it never rolls a batch back. A real DB error THROWS so the
 * surrounding transaction rolls back.
 */
async function closeActiveFile(
  executor: DbExecutor,
  name: string,
  userId: string,
  now: Date,
): Promise<DeleteFileResult> {
  const closed = await executor
    .update(files)
    .set({ validUntil: now, closedBy: userId })
    .where(and(eq(files.name, name), isNull(files.validUntil)));
  return affectedRows(closed) < 1 ? { ok: false, reason: "not-found" } : { ok: true };
}

export type DeleteFilesResult = { ok: boolean; deleted: number };

/**
 * Bulk soft-delete (the list's "Delete Selected", the only delete path): closes
 * every named file in ONE transaction via the `closeActiveFile` primitive — the
 * GET endpoint then 404s and the list drops the row, while the full history
 * (including who deleted it) stays. All-or-nothing: any DB error rolls the whole
 * batch back. `deleted` counts the rows actually closed (an already-gone name is a
 * no-op success).
 */
export async function softDeleteFiles(names: string[], userId: string): Promise<DeleteFilesResult> {
  if (names.length === 0) return { ok: true, deleted: 0 };
  const now = new Date();
  try {
    return await getDb().transaction(async (tx) => {
      let deleted = 0;
      for (const name of names) {
        const result = await closeActiveFile(tx, name, userId, now);
        if (result.ok) deleted++;
      }
      return { ok: true, deleted };
    });
  } catch (error) {
    console.error("file-store: bulk delete failed", error);
    return { ok: false, deleted: 0 };
  }
}

/**
 * The writer-versions statement — exported for its shape test. Over the versions the writer wrote (every row, active or closed,
 * of any name, read through the `created_by` index): the most versions of one
 * name, and the local date some name first reached `n` of them.
 */
export function writerVersionsStatement(userId: string, n: number): SQL {
  return sql`
    SELECT coalesce(max(v.k), 0) AS most,
           ((min(v.valid_from) FILTER (WHERE v.k = ${n}) AT TIME ZONE ${HOME_TIME_ZONE})::date)::text
             AS "reachedOn"
    FROM (
      SELECT f.valid_from, row_number() OVER (PARTITION BY f.name ORDER BY f.valid_from) AS k
      FROM novedu_files f
      WHERE f.created_by = ${userId}
    ) v
  `;
}

/**
 * The teacher start page's files fact group (docs/home.md → Iterator): how many
 * versions of one file the session user wrote at most, and when some file first
 * reached `n`. Counts and a date leave this function — no name, no content.
 * Returns `undefined` on a database error (reported with a fixed message, never
 * the raw error — it carries the user id). Never throws.
 */
export async function loadWriterVersions(
  userId: string,
  n: number,
): Promise<{ most: number; reachedOn?: LocalDate } | undefined> {
  try {
    const res = await getDb().execute<{ most: number | string; reachedOn: LocalDate | null }>(
      writerVersionsStatement(userId, n),
    );
    const row = res.rows[0];
    const most = Number(row?.most ?? 0);
    return row?.reachedOn ? { most, reachedOn: row.reachedOn } : { most };
  } catch (error) {
    reportStoreFailure("file-store", "load writer versions", error);
    return undefined;
  }
}
