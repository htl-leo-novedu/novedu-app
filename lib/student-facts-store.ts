import { type SQL, sql } from "drizzle-orm";
import type { StudentFacts } from "@/lib/achievements/catalog";
import type { UsageDay } from "@/lib/achievements/derive";
import { HOME_TIME_ZONE } from "@/lib/achievements/time";
import { listOwnKeyDates } from "@/lib/coding-key-store";
import { getDb } from "@/lib/db";
import { listOwnQuizResults } from "@/lib/quiz-result-store";
import { listOwnResolvedReportDates } from "@/lib/report-store";
import { reportStoreFailure } from "@/lib/store-failure";

// The facts behind a student's start page (docs/home.md → Facts queries). Every
// statement is keyed by the session user id and reads only that user's rows;
// each fact group is ONE statement and fails independently — a failed group
// comes back `undefined`, never as zeros. Never throws.
//
// Never reads `novedu_user_chats`, `novedu_recent_codes` or another user's rows.
//
// SERVER-ONLY: uses the database. Never import from client components.

const STORE = "student-facts-store";

// An active hour: any counted interaction; token-only buckets don't count.
const ACTIVE = sql.raw(
  "u.user_messages + u.quiz_answers + u.writing_saves + u.coding_requests + u.cloze_submissions > 0",
);

// `codingHours` counts distinct local hours: on the autumn clock change the two
// buckets sharing local 02:00 are one hour of the day.
/** The usage statement: a range scan of the PK, whose leading column is `user_id`. */
function usageStatement(userId: string): SQL {
  return sql`
    SELECT ((u.hour AT TIME ZONE ${HOME_TIME_ZONE})::date)::text AS day,
           count(*) FILTER (WHERE ${ACTIVE}) AS "activeHours",
           sum(u.user_messages) AS "userMessages",
           sum(u.quiz_answers) AS "quizAnswers",
           sum(u.writing_saves) AS "writingSaves",
           sum(u.coding_requests) AS "codingRequests",
           sum(u.cloze_submissions) AS "clozeSubmissions",
           count(DISTINCT extract(hour FROM u.hour AT TIME ZONE ${HOME_TIME_ZONE}))
             FILTER (WHERE u.coding_requests > 0) AS "codingHours"
    FROM novedu_usage_by_user u
    WHERE u.user_id = ${userId}
    GROUP BY 1
    HAVING count(*) FILTER (WHERE ${ACTIVE}) > 0
    ORDER BY 1
  `;
}

/**
 * The usage group: `novedu_usage_by_user` grouped by Vienna-local day over the
 * whole history — one PK range scan over the user's rows. An active hour is a
 * UTC-hour bucket with any counted interaction (token-only buckets don't
 * count); the two buckets sharing local 02:00 on the autumn clock change are
 * two hours.
 */
export async function loadStudentUsage(userId: string): Promise<UsageDay[] | undefined> {
  try {
    const res = await getDb().execute<{
      day: string;
      activeHours: number | string;
      userMessages: number | string;
      quizAnswers: number | string;
      writingSaves: number | string;
      codingRequests: number | string;
      clozeSubmissions: number | string;
      codingHours: number | string;
    }>(usageStatement(userId));
    return res.rows.map((row) => ({
      date: row.day,
      activeHours: Number(row.activeHours),
      userMessages: Number(row.userMessages),
      quizAnswers: Number(row.quizAnswers),
      writingSaves: Number(row.writingSaves),
      codingRequests: Number(row.codingRequests),
      clozeSubmissions: Number(row.clozeSubmissions),
      codingHours: Number(row.codingHours),
    }));
  } catch (error) {
    reportStoreFailure(STORE, "load usage", error);
    return undefined;
  }
}

/**
 * Every student fact group, loaded in parallel — each one statement through its
 * owning store (the coding keys, the saved quiz results and the own resolved
 * reports are read only by their stores).
 */
export async function loadStudentFacts(userId: string): Promise<StudentFacts> {
  const [usage, keys, quiz, reports] = await Promise.all([
    loadStudentUsage(userId),
    listOwnKeyDates(userId),
    listOwnQuizResults(userId),
    listOwnResolvedReportDates(userId),
  ]);
  return { usage, keys, quiz, reports };
}
