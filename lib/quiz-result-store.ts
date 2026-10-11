import { asc, count, eq, sql } from "drizzle-orm";
import { type QuizAttempt, RETAINED_NEWEST } from "@/lib/achievements/quiz";
import { HOME_TIME_ZONE } from "@/lib/achievements/time";
import { type DbExecutor, getDb } from "@/lib/db";
import { codes, quizResults } from "@/lib/db/schema";
import { reportStoreFailure } from "@/lib/store-failure";
import {
  enableQuizSavingInTransaction,
  lockSettingsInTransaction,
  saveQuizResultsInTransaction,
} from "@/lib/user-settings-store";

// Saved quiz results (`novedu_quiz_results`, docs/home.md → Saving a quiz
// result) — the THIRD sanctioned user↔code link, written only by the student's
// explicit choice on a quiz's Finish page or a cloze exercise's results screen.
// The ONLY access to the table, and it has NO teacher reader by construction:
// every exported function is keyed by the session user id its caller resolved,
// except `deleteResultsForCode` (the code-delete path), which returns nothing.
// Guard-tested: only lib/quiz-actions.ts, lib/cloze-actions.ts,
// lib/student-facts-store.ts, lib/code-stats-store.ts,
// lib/user-settings-actions.ts and the Settings page import this module.
//
// Never throws, except `deleteResultsForCode`, which runs inside the code-delete
// transaction and must roll it back.
//
// SERVER-ONLY: uses the database. Never import from client components.

const STORE = "quiz-result-store";

/** One attempt's slot counts, as the save action validated them. */
export interface QuizResultInput {
  /** The attempt's uuid. */
  id: string;
  code: string;
  correct: number;
  partial: number;
  incorrect: number;
  unanswered: number;
  total: number;
}

/**
 * - `this-time`: write the row, whatever the setting says.
 * - `always`: turn the setting on AND write the row, in one transaction.
 * - `automatic`: write the row only while the setting is on, read inside the
 *   transaction — a browser holding a stale "on" can never save after the
 *   switch was turned off.
 */
export type SaveMode = "this-time" | "always" | "automatic";

/** `not-saved`: an automatic save found the setting off. `code-gone`: the code was deleted. */
export type SaveOutcome = "saved" | "not-saved" | "code-gone";

/**
 * Per `(user, code)`: keeps the newest attempts (`finished_at, id` descending)
 * plus the best one (highest exact score, ties to the newest) and deletes the
 * rest. Scores are compared as `numeric` fractions — cast BEFORE the
 * arithmetic, so no int4 count can overflow — the same order
 * lib/achievements/quiz.ts computes with BigInt.
 */
function pruneStatement(userId: string, code: string) {
  return sql`
    DELETE FROM novedu_quiz_results r
    WHERE r.user_id = ${userId} AND r.code = ${code}
      AND r.id NOT IN (
        SELECT k.id FROM novedu_quiz_results k
        WHERE k.user_id = ${userId} AND k.code = ${code}
        ORDER BY k.finished_at DESC, k.id DESC
        LIMIT ${RETAINED_NEWEST})
      AND r.id <> (
        SELECT b.id FROM novedu_quiz_results b
        WHERE b.user_id = ${userId} AND b.code = ${code}
        ORDER BY (2 * b.correct::numeric + b.partial) / nullif(2 * b.total::numeric, 0) DESC NULLS LAST,
                 b.finished_at DESC, b.id DESC
        LIMIT 1)
  `;
}

/**
 * Saves one attempt. ONE transaction: the `(user, code)` advisory lock (so two
 * saves of one user on one quiz serialize and the retention bound holds), then
 * the code row `FOR SHARE` (a concurrent code delete, which locks the row `FOR
 * UPDATE`, either waits for this save and then deletes its row, or has already
 * removed the code — then nothing is written), then the setting per `mode`, the
 * insert (a repeated attempt id is a no-op) and the prune. Returns undefined on
 * a database error, with everything rolled back.
 */
export async function saveQuizResult(
  userId: string,
  input: QuizResultInput,
  mode: SaveMode,
): Promise<SaveOutcome | undefined> {
  try {
    return await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('novedu_quiz_results'), hashtext(${userId} || '/' || ${input.code}))`,
      );
      const live = await tx
        .select({ code: codes.code })
        .from(codes)
        .where(eq(codes.code, input.code))
        .for("share");
      if (live.length === 0) return "code-gone";
      if (mode === "automatic" && !(await saveQuizResultsInTransaction(tx, userId))) {
        return "not-saved";
      }
      if (mode === "always") await enableQuizSavingInTransaction(tx, userId);
      await tx
        .insert(quizResults)
        .values({
          ...input,
          userId,
          // Set here, not by the column default: JavaScript dates have millisecond
          // precision, so the start page's ordering (lib/achievements/quiz.ts)
          // sees exactly the value the prune orders by.
          finishedAt: new Date(),
        })
        .onConflictDoNothing({ target: [quizResults.userId, quizResults.id] });
      await tx.execute(pruneStatement(userId, input.code));
      return "saved";
    });
  } catch (error) {
    reportStoreFailure(STORE, "save result", error);
    return undefined;
  }
}

/** The own-results query: a range scan of the user's rows in `ix_novedu_quiz_results_user_code_finished`. */
function ownResultsQuery(userId: string) {
  return getDb()
    .select({
      id: quizResults.id,
      code: quizResults.code,
      correct: quizResults.correct,
      partial: quizResults.partial,
      incorrect: quizResults.incorrect,
      unanswered: quizResults.unanswered,
      total: quizResults.total,
      finishedAt: quizResults.finishedAt,
      finishedOn: sql<string>`((${quizResults.finishedAt} AT TIME ZONE ${HOME_TIME_ZONE})::date)::text`,
      note: sql<string>`coalesce(${codes.note}, '')`,
      // The same window rule as checkCode (lib/code-store.ts): an absent bound is open.
      open: sql<boolean>`(${codes.code} IS NOT NULL
        AND (${codes.validFrom} IS NULL OR ${codes.validFrom} <= now())
        AND (${codes.validUntil} IS NULL OR ${codes.validUntil} >= now()))`,
    })
    .from(quizResults)
    .leftJoin(codes, eq(codes.code, quizResults.code))
    .where(eq(quizResults.userId, userId))
    .orderBy(asc(quizResults.code), asc(quizResults.finishedAt), asc(quizResults.id));
}

/**
 * The user's saved results with each code's note and window (the start page's
 * "quiz" fact group) — one range scan over the user's rows.
 */
export async function listOwnQuizResults(userId: string): Promise<QuizAttempt[] | undefined> {
  try {
    return await ownResultsQuery(userId);
  } catch (error) {
    reportStoreFailure(STORE, "list own results", error);
    return undefined;
  }
}

/** How many results the user has saved (the Settings page). */
export async function countOwnQuizResults(userId: string): Promise<number | undefined> {
  try {
    const rows = await getDb()
      .select({ n: count() })
      .from(quizResults)
      .where(eq(quizResults.userId, userId));
    return rows[0]?.n ?? 0;
  } catch (error) {
    reportStoreFailure(STORE, "count own results", error);
    return undefined;
  }
}

/**
 * Deletes every saved result of the user and returns how many. Takes the
 * user's settings row `FOR UPDATE` first, so it serializes with automatic
 * saves. Earned achievements are not revoked.
 */
export async function deleteOwnQuizResults(userId: string): Promise<number | undefined> {
  try {
    return await getDb().transaction(async (tx) => {
      await lockSettingsInTransaction(tx, userId);
      const deleted = await tx
        .delete(quizResults)
        .where(eq(quizResults.userId, userId))
        .returning({ id: quizResults.id });
      return deleted.length;
    });
  } catch (error) {
    reportStoreFailure(STORE, "delete own results", error);
    return undefined;
  }
}

/**
 * Drops every saved result of a code, on the code-delete transaction
 * (lib/code-stats-store.ts). Returns nothing — the delete path learns nothing
 * about whose results they were. Throws, so the delete rolls back.
 */
export async function deleteResultsForCode(executor: DbExecutor, code: string): Promise<void> {
  await executor.delete(quizResults).where(eq(quizResults.code, code));
}
