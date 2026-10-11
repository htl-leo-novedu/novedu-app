import { eq, type SQL, sql } from "drizzle-orm";
import {
  type CodeDay,
  CROWD_MAX,
  type IdentifiedStudents,
  ITERATOR_VERSIONS,
  LISTENER_REPORTS,
  type TeacherCode,
  type TeacherFacts,
  windowStart,
} from "@/lib/achievements/teacher";
import {
  HOME_TIME_ZONE,
  type LocalDate,
  SCHOOL_DAY_END,
  SCHOOL_DAY_START,
} from "@/lib/achievements/time";
import { CODE_MODULES, type CodeModule } from "@/lib/code-modules/types";
import { keyHoldersOfTeacherStatement } from "@/lib/coding-key-store";
import { getDb } from "@/lib/db";
import { codes } from "@/lib/db/schema";
import { loadWriterVersions } from "@/lib/file-store";
import { loadTeacherReports } from "@/lib/report-store";
import { reportStoreFailure } from "@/lib/store-failure";
import { chattersOfTeacherStatement } from "@/lib/user-chat-store";
import { writersOfTeacherStatement } from "@/lib/writing-store";

// The facts behind a teacher's start page (docs/home.md → Teacher dashboard and
// Teacher achievements). Every statement is keyed by the session user id and
// restricted to the codes that teacher created (`created_by`) — or, for the
// reports they resolved and the file versions they wrote, to the teacher's own
// rows; each fact group is ONE statement and fails independently — a failed
// group comes back `undefined`, never as zeros. Never throws.
//
// Student counts read the frozen `anonymous` flag exactly like `getCodeStats`,
// and never name a student: only counts leave this module. Never reads the
// students' saved quiz results — they have no teacher reader at all.
//
// SERVER-ONLY: uses the database. Never import from client components.

const STORE = "teacher-facts-store";

const KNOWN_MODULES = new Set<string>(CODE_MODULES);

/** The teacher's codes — one scan of the `created_by` index. */
export async function listTeacherCodes(teacherId: string): Promise<TeacherCode[] | undefined> {
  try {
    const rows = await getDb()
      .select({
        code: codes.code,
        module: codes.module,
        note: codes.note,
        validFrom: codes.validFrom,
        validUntil: codes.validUntil,
        createdAt: codes.createdAt,
      })
      .from(codes)
      .where(eq(codes.createdBy, teacherId));
    // An unrecognized module is no activity for anyone (`checkCode` agrees).
    return rows
      .filter((row) => KNOWN_MODULES.has(row.module))
      .map((row) => ({ ...row, module: row.module as CodeModule }));
  } catch (error) {
    reportStoreFailure(STORE, "list codes", error);
    return undefined;
  }
}

// A counted interaction, as in the student facts: token-only buckets add nothing.
const INTERACTIONS = sql.raw(
  "(u.user_messages + u.quiz_answers + u.writing_saves + u.coding_requests + u.cloze_submissions)",
);

/**
 * The usage statement — exported for its shape test. Per code and Vienna-local day over the whole history: the sums the
 * dashboard and the badges read. A bucket is outside school hours on a weekend
 * or outside the local `SCHOOL_DAY_START ≤ h < SCHOOL_DAY_END` (the same rule as
 * `isSchoolHour`).
 */
export function usageStatement(teacherId: string): SQL {
  const local = sql`(u.hour AT TIME ZONE ${HOME_TIME_ZONE})`;
  const outside = sql`(extract(isodow FROM ${local}) > 5
    OR extract(hour FROM ${local}) < ${SCHOOL_DAY_START}
    OR extract(hour FROM ${local}) >= ${SCHOOL_DAY_END})`;
  return sql`
    SELECT u.code,
           (${local})::date::text AS date,
           sum(${INTERACTIONS}) AS interactions,
           coalesce(sum(${INTERACTIONS}) FILTER (WHERE ${outside}), 0) AS "outsideSchool",
           sum(u.quiz_answers) AS "quizAnswers",
           sum(u.input_tokens_new + u.input_tokens_cached) AS "inputTokens",
           sum(u.output_tokens) AS "outputTokens"
    FROM novedu_codes c
    JOIN novedu_usage_by_code u ON u.code = c.code
    WHERE c.created_by = ${teacherId}
    GROUP BY u.code, 2
    ORDER BY u.code, 2
  `;
}

/** The usage group: per code and local day, PK range scans over the teacher's codes only. */
export async function loadTeacherUsage(teacherId: string): Promise<CodeDay[] | undefined> {
  try {
    const res = await getDb().execute<{
      code: string;
      date: LocalDate;
      interactions: number | string;
      outsideSchool: number | string;
      quizAnswers: number | string;
      inputTokens: number | string;
      outputTokens: number | string;
    }>(usageStatement(teacherId));
    return res.rows.map((row) => ({
      code: row.code,
      date: row.date,
      interactions: Number(row.interactions),
      outsideSchool: Number(row.outsideSchool),
      quizAnswers: Number(row.quizAnswers),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
    }));
  } catch (error) {
    reportStoreFailure(STORE, "load usage", error);
    return undefined;
  }
}

/**
 * The conversations statement: threads of the teacher's codes with a user
 * message in the window — the `EXISTS` shape of `getDashboardKpis`
 * (docs/dashboard.md), restricted by code. Exported for its shape test.
 */
export function conversationsStatement(teacherId: string, start: Date): SQL {
  return sql`
    SELECT count(*) AS conversations
    FROM novedu_codes c
    JOIN mastra.mastra_threads t ON t."resourceId" = c.code
    WHERE c.created_by = ${teacherId}
      AND EXISTS (
        SELECT 1 FROM mastra.mastra_messages m
        WHERE m.thread_id = t.id AND m.role = 'user' AND m."createdAtZ" >= ${start}
      )
  `;
}

export async function countTeacherConversations(
  teacherId: string,
  start: Date,
): Promise<number | undefined> {
  try {
    const res = await getDb().execute<{ conversations: number | string }>(
      conversationsStatement(teacherId, start),
    );
    return Number(res.rows[0]?.conversations ?? 0);
  } catch (error) {
    reportStoreFailure(STORE, "count conversations", error);
    return undefined;
  }
}

/**
 * The identified-students statement — exported for its shape test. Over
 * the per-user chats and saved texts of the teacher's non-anonymous codes and
 * the key holders of their coding codes, all time, the teacher's own id
 * excluded (each subselect comes from the store that owns its table): per code,
 * the distinct students and the local dates the first `CROWD_MAX` of them were
 * first seen; plus one row with a NULL code holding the distinct students
 * overall. Only counts and dates leave it.
 */
export function studentsStatement(teacherId: string): SQL {
  return sql`
    WITH seen AS (
      SELECT s.code, s.user_id, min(s.at) AS at
      FROM (
        ${chattersOfTeacherStatement(teacherId)}
        UNION ALL
        ${writersOfTeacherStatement(teacherId)}
        UNION ALL
        ${keyHoldersOfTeacherStatement(teacherId)}
      ) s
      WHERE s.user_id <> ${teacherId}
      GROUP BY s.code, s.user_id
    ), ranked AS (
      SELECT code, at, row_number() OVER (PARTITION BY code ORDER BY at) AS k FROM seen
    )
    SELECT code,
           count(*) AS students,
           array_agg(((at AT TIME ZONE ${HOME_TIME_ZONE})::date)::text ORDER BY at)
             FILTER (WHERE k <= ${CROWD_MAX}) AS "firstSeen"
    FROM ranked
    GROUP BY code
    UNION ALL
    SELECT NULL, count(DISTINCT user_id), NULL FROM seen
  `;
}

/** The students group: identified students per code and overall. */
export async function loadIdentifiedStudents(
  teacherId: string,
): Promise<IdentifiedStudents | undefined> {
  try {
    const res = await getDb().execute<{
      code: string | null;
      students: number | string;
      firstSeen: LocalDate[] | null;
    }>(studentsStatement(teacherId));
    let total = 0;
    const perCode = [];
    for (const row of res.rows) {
      if (row.code === null) total = Number(row.students);
      else
        perCode.push({
          code: row.code,
          count: Number(row.students),
          firstSeen: row.firstSeen ?? [],
        });
    }
    return { total, perCode };
  } catch (error) {
    reportStoreFailure(STORE, "load students", error);
    return undefined;
  }
}

/**
 * Every teacher fact group, loaded in parallel (six statements; the grants are
 * the seventh, read by lib/achievement-store.ts).
 */
export async function loadTeacherFacts(teacherId: string, now: Date): Promise<TeacherFacts> {
  const [teacherCodes, usage, conversations, students, reports, files] = await Promise.all([
    listTeacherCodes(teacherId),
    loadTeacherUsage(teacherId),
    countTeacherConversations(teacherId, windowStart(now)),
    loadIdentifiedStudents(teacherId),
    loadTeacherReports(teacherId, LISTENER_REPORTS),
    loadWriterVersions(teacherId, ITERATOR_VERSIONS),
  ]);
  return { codes: teacherCodes, usage, conversations, students, reports, files };
}
