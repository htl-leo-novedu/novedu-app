import { asc, eq, inArray, sql } from "drizzle-orm";
import type { ClozeGapCount } from "@/lib/cloze-types";
import { type DbExecutor, getDb } from "@/lib/db";
import { clozeGapCounts } from "@/lib/db/schema";
import type { QuizVerdict } from "@/lib/quiz-types";
import { reportStoreFailure } from "@/lib/store-failure";

// Per-gap verdict counts of cloze codes (`novedu_cloze_gap_counts`, docs/cloze.md →
// Teacher view) — the ONLY access to the table. Written once per FIRST-round
// grading (`gradeCloze`, off the response path); read by the teacher detail page and
// the /codes list. Anonymous by construction: a row is (code, gap, the teacher's
// reference) plus three counters — no user id, no answer text, no time bucket.
//
// Never throws, except `deleteGapCountsForCode`, which runs inside the code-delete
// transaction and must roll it back.
//
// SERVER-ONLY: uses the database. Never import from client components.

const STORE = "cloze-counts-store";

/** One gap of one graded first submission. */
export interface ClozeGapVerdict {
  gap: number;
  reference: string;
  verdict: QuizVerdict;
}

/**
 * Adds one first submission: ONE multi-row increment-upsert, one row per gap (a gap
 * number appears once per submission, so no statement touches a row twice).
 */
export async function recordClozeGapCounts(
  code: string,
  gaps: readonly ClozeGapVerdict[],
): Promise<void> {
  if (gaps.length === 0) return;
  try {
    const updatedAt = new Date();
    await getDb()
      .insert(clozeGapCounts)
      .values(
        gaps.map(({ gap, reference, verdict }) => ({
          code,
          gap,
          reference,
          correct: verdict === "correct" ? 1 : 0,
          partial: verdict === "partial" ? 1 : 0,
          incorrect: verdict === "incorrect" ? 1 : 0,
          updatedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [clozeGapCounts.code, clozeGapCounts.gap, clozeGapCounts.reference],
        set: {
          correct: sql`${clozeGapCounts.correct} + excluded.correct`,
          partial: sql`${clozeGapCounts.partial} + excluded.partial`,
          incorrect: sql`${clozeGapCounts.incorrect} + excluded.incorrect`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  } catch (error) {
    reportStoreFailure(STORE, "record counts", error);
  }
}

/** Every stored row of a code, by gap number then reference. */
export async function listClozeGapCounts(code: string): Promise<ClozeGapCount[] | undefined> {
  try {
    return await getDb()
      .select({
        gap: clozeGapCounts.gap,
        reference: clozeGapCounts.reference,
        correct: clozeGapCounts.correct,
        partial: clozeGapCounts.partial,
        incorrect: clozeGapCounts.incorrect,
      })
      .from(clozeGapCounts)
      .where(eq(clozeGapCounts.code, code))
      .orderBy(asc(clozeGapCounts.gap), asc(clozeGapCounts.reference));
  } catch (error) {
    reportStoreFailure(STORE, "list counts", error);
    return undefined;
  }
}

/**
 * "First submissions" per code — the largest per-gap total among the code's stored
 * rows (the detail page computes the same from `listClozeGapCounts`) — for the /codes
 * list, in one round trip. Codes without rows are absent (→ 0).
 */
export async function countClozeSubmissions(
  codes: string[],
): Promise<Map<string, number> | undefined> {
  if (codes.length === 0) return new Map();
  try {
    const rows = await getDb()
      .select({
        code: clozeGapCounts.code,
        submissions: sql<number>`max(${clozeGapCounts.correct} + ${clozeGapCounts.partial} + ${clozeGapCounts.incorrect})::int`,
      })
      .from(clozeGapCounts)
      .where(inArray(clozeGapCounts.code, codes))
      .groupBy(clozeGapCounts.code);
    return new Map(rows.map((row) => [row.code, Number(row.submissions)]));
  } catch (error) {
    reportStoreFailure(STORE, "count submissions", error);
    return undefined;
  }
}

/**
 * Drops a code's rows, on the code-delete transaction (lib/code-stats-store.ts).
 * Throws, so the delete rolls back.
 */
export async function deleteGapCountsForCode(executor: DbExecutor, code: string): Promise<void> {
  await executor.delete(clozeGapCounts).where(eq(clozeGapCounts.code, code));
}
