import type { Message } from "@ag-ui/core";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { mastra } from "@/app/mastra";
import { deleteGapCountsForCode } from "@/lib/cloze-counts-store";
import { deleteCodingKeysForCodes } from "@/lib/coding-key-store";
import { collapseReplayedRuns, toAguiMessage } from "@/lib/conversation-collapse";
import { type DbExecutor, getDb } from "@/lib/db";
import {
  codes as codesTable,
  recentCodes,
  reports,
  userChats,
  writingSubmissions,
} from "@/lib/db/schema";
import { deleteResultsForCode } from "@/lib/quiz-result-store";

// Read-side queries (and the destructive delete) behind a code's stats — shared
// by every module (tutor conversations, quiz discussions, …).
//
// The data lives across BOTH the app-owned `novedu_*` tables and Mastra's
// `mastra_*` tables, joined BY VALUE — the sanctioned cross-table pattern
// (docs/codes.md): `mastra_threads.resourceId` = the code,
// `mastra_messages.thread_id` = the thread, `novedu_user_chats.thread_id` ties a
// thread to a student (only for `anonymous: false` activities). Mastra owns its
// schema, so we only ever READ those tables with raw by-value SQL — never
// declare them to Drizzle (that would make `db:generate` try to migrate them).
// The one MUTATION of Mastra data, deleting a code's conversations, goes through
// Mastra's OWN storage API (`deleteThread`), so we still never touch its schema.
//
// "Interaction" / "conversation" throughout means a Mastra thread that has at
// least one `role = 'user'` message — a chat a student actually wrote into, not
// one merely opened. (`mastra_messages.role` is only ever 'user' or
// 'assistant' for these agents; a tutor's tool calls are `tool-invocation`
// parts inside its assistant rows, not separate rows.)
//
// SERVER-ONLY: uses the database and the Mastra store. Never import from client
// components.

// Thread ids are server-generated UUIDs; this guards the value before it reaches
// a query, mirroring the pattern in user-chat-store / the runtime route.
const THREAD_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * How many qualifying conversations each of the given codes has, as a map from
 * code to count (codes with none are simply absent → treat as 0). Backs the
 * interaction-count column on the Codes list, so it takes the whole set of a
 * teacher's codes in one round trip. Returns `undefined` on a database error
 * (the list then shows the count as unavailable). Never throws.
 */
export async function getInteractionCounts(
  codes: string[],
): Promise<Map<string, number> | undefined> {
  if (codes.length === 0) return new Map();
  try {
    const inList = sql.join(
      codes.map((code) => sql`${code}`),
      sql`, `,
    );
    const res = await getDb().execute<{ code: string; interactions: number }>(sql`
      SELECT t."resourceId" AS code, COUNT(*) AS interactions
      FROM mastra.mastra_threads t
      WHERE t."resourceId" IN (${inList})
        AND EXISTS (
          SELECT 1 FROM mastra.mastra_messages m
          WHERE m.thread_id = t.id AND m.role = 'user'
        )
      GROUP BY t."resourceId"
    `);
    const counts = new Map<string, number>();
    for (const row of res.rows) counts.set(row.code, Number(row.interactions));
    return counts;
  } catch (error) {
    console.error("code-stats-store: counting interactions failed", error);
    return undefined;
  }
}

/** One conversation in a code's stats. */
export interface Interaction {
  threadId: string;
  /** Timestamp of the first message in the conversation (user or assistant). */
  firstAt: Date;
  /** Timestamp of the last message in the conversation (user or assistant). */
  lastAt: Date;
  /** Number of `role = 'user'` messages — always ≥ 1 (that is what qualifies). */
  userMessageCount: number;
  /**
   * The student's session user id (`novedu_user.id`), if recorded AND the code is non-anonymous.
   * `getCodeStats` forces this to `null` for anonymous codes (see there),
   * so a thread is attributable here only for an `anonymous: false` activity.
   */
  userId: string | null;
  /**
   * The student's display name (resolved from `novedu_user`) under the same
   * conditions as `userId`, or `null` when the code is anonymous, the thread is
   * unattributed, or no name has been recorded yet. The UI shows this in place of
   * the user id, falling back to `userId`.
   */
  userName: string | null;
}

/** The detailed stats for a single code. */
export interface CodeStats {
  /** Number of qualifying conversations. */
  conversations: number;
  /**
   * Distinct students with at least one conversation. Always `0` for anonymous
   * codes — `getCodeStats` zeroes it there, so it is meaningful only for
   * `anonymous: false` activities.
   */
  studentCount: number;
  /** The conversations themselves, newest activity first. */
  interactions: Interaction[];
}

/**
 * Detailed stats for one code: every qualifying conversation with its first/last
 * message time, user-message count, and (when recorded) the student. Returns
 * `undefined` on a database error. Never throws. Authorization (is the caller an
 * effective teacher?) is the caller's job — the page gates with
 * `requireTeacherPage()` and looks the code up via `getCode`.
 *
 * `anonymous` is the code's FROZEN flag (`novedu_codes.anonymous`). When it is
 * `true` this enforces the anonymity promise AT THE DATA LAYER: every `userId`
 * comes back `null` and `studentCount` is `0`, so a caller cannot surface who a
 * student is even by mistake — not even for the documented edge case where
 * `novedu_user_chats` holds rows because the activity YAML was toggled to
 * non-anonymous AFTER the code was minted (the live attribution flag and this
 * frozen display flag are read separately; see docs/codes.md). The UI's own
 * `!anonymous` gating is now belt-and-braces on top of this.
 */
export async function getCodeStats(
  code: string,
  anonymous: boolean,
): Promise<CodeStats | undefined> {
  try {
    // Raw `execute()` rows are NOT run through drizzle's column mappers: its
    // node-postgres session hands timestamps back as the wire strings, and
    // COUNT/SUM arrive as bigint strings — so both are converted below.
    const res = await getDb().execute<{
      threadId: string;
      firstAt: string;
      lastAt: string;
      userMessageCount: number | string;
      userId: string | null;
      userName: string | null;
    }>(sql`
      SELECT
        t.id AS "threadId",
        MIN(m."createdAtZ") AS "firstAt",
        MAX(m."createdAtZ") AS "lastAt",
        SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS "userMessageCount",
        uc.user_id AS "userId",
        un.name AS "userName"
      FROM mastra.mastra_threads t
      JOIN mastra.mastra_messages m ON m.thread_id = t.id
      LEFT JOIN novedu_user_chats uc ON uc.thread_id = t.id
      LEFT JOIN novedu_user un ON un.id = uc.user_id
      WHERE t."resourceId" = ${code}
      GROUP BY t.id, uc.user_id, un.name
      HAVING SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) >= 1
      ORDER BY MAX(m."createdAtZ") DESC
    `);

    const interactions: Interaction[] = res.rows.map((row) => ({
      threadId: row.threadId,
      firstAt: new Date(row.firstAt),
      lastAt: new Date(row.lastAt),
      userMessageCount: Number(row.userMessageCount),
      // Anonymous code → never emit the student id OR name, whatever the join returned.
      userId: anonymous ? null : (row.userId ?? null),
      userName: anonymous ? null : (row.userName ?? null),
    }));

    // Distinct recorded students. A student who opened several conversations
    // counts once; anonymous conversations (userId null) count toward none. For
    // an anonymous code every userId is null above, so this is 0.
    const students = new Set<string>();
    for (const i of interactions) if (i.userId) students.add(i.userId);

    return { conversations: interactions.length, studentCount: students.size, interactions };
  } catch (error) {
    console.error("code-stats-store: loading code stats failed", error);
    return undefined;
  }
}

/** One of a single student's conversations for a code (the userId is known). */
export interface StudentConversation {
  threadId: string;
  /** Timestamp of the first message in the conversation (user or assistant). */
  firstAt: Date;
  /** Timestamp of the last message in the conversation (user or assistant). */
  lastAt: Date;
  /** Number of `role = 'user'` messages — always ≥ 1 (that is what qualifies). */
  userMessageCount: number;
}

/**
 * One student's qualifying conversations for a code (threads with ≥ 1 user
 * message), newest activity first — backs the writing student page's conversation
 * list. INNER-joins `novedu_user_chats`, since attribution rows exist only for the
 * non-anonymous writing codes this serves. Returns `undefined` on a database
 * error. Never throws. Authorization is the caller's job (the page gates with
 * `requireTeacherPage()`; the lightbox action with `requireEffectiveTeacher()`).
 */
export async function listStudentConversations(
  code: string,
  userId: string,
): Promise<StudentConversation[] | undefined> {
  try {
    // Same raw-row conversions as getCodeStats (timestamps and SUM are strings).
    const res = await getDb().execute<{
      threadId: string;
      firstAt: string;
      lastAt: string;
      userMessageCount: number | string;
    }>(sql`
      SELECT
        t.id AS "threadId",
        MIN(m."createdAtZ") AS "firstAt",
        MAX(m."createdAtZ") AS "lastAt",
        SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS "userMessageCount"
      FROM mastra.mastra_threads t
      JOIN mastra.mastra_messages m ON m.thread_id = t.id
      JOIN novedu_user_chats uc ON uc.thread_id = t.id
      WHERE t."resourceId" = ${code} AND uc.user_id = ${userId}
      GROUP BY t.id
      HAVING SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) >= 1
      ORDER BY MAX(m."createdAtZ") DESC
    `);
    return res.rows.map((row) => ({
      threadId: row.threadId,
      firstAt: new Date(row.firstAt),
      lastAt: new Date(row.lastAt),
      userMessageCount: Number(row.userMessageCount),
    }));
  } catch (error) {
    console.error("code-stats-store: loading student conversations failed", error);
    return undefined;
  }
}

/**
 * The messages of one conversation, oldest first, as AG-UI messages ready for
 * `CopilotChatMessageView`. The `code` is required and re-checked against the
 * thread's `resourceId` (defense in depth on top of the caller's ownership
 * check). Replayed history is collapsed (`collapseReplayedRuns`) so each turn
 * shows once. Returns `undefined` on a database error, `[]` for an
 * unknown/empty thread. Never throws.
 */
export async function getConversationMessages(
  code: string,
  threadId: string,
): Promise<Message[] | undefined> {
  if (!THREAD_ID_PATTERN.test(threadId)) return [];
  try {
    const res = await getDb().execute<{ id: string; role: string; content: string }>(sql`
      SELECT m.id, m.role, m.content
      FROM mastra.mastra_messages m
      JOIN mastra.mastra_threads t ON t.id = m.thread_id
      WHERE m.thread_id = ${threadId} AND t."resourceId" = ${code}
      ORDER BY m."createdAtZ" ASC, m.id ASC
    `);
    const messages = res.rows.map(toAguiMessage).filter((m): m is Message => m !== null);
    return collapseReplayedRuns(messages);
  } catch (error) {
    console.error("code-stats-store: loading conversation messages failed", error);
    return undefined;
  }
}

/**
 * Deletes ONE code's conversations (Mastra threads + their messages) through
 * Mastra's OWN storage API so we never mutate its schema by hand. Lives in the
 * Mastra pool, so it can NEVER share the Drizzle transaction the app-owned rows
 * use. Best-effort: returns `false` (never throws) if any thread delete fails.
 */
async function deleteCodeConversations(code: string): Promise<boolean> {
  try {
    const storage = mastra.getStorage();
    const memory = storage ? await storage.getStore("memory") : undefined;
    if (!memory) {
      console.error("code-stats-store: no Mastra storage configured — cannot delete conversations");
      return false;
    }
    const { threads } = await memory.listThreads({
      filter: { resourceId: code },
      perPage: false,
    });
    for (const thread of threads) {
      await memory.deleteThread({ threadId: thread.id });
    }
    return true;
  } catch (error) {
    console.error("code-stats-store: deleting conversations failed", error);
    return false;
  }
}

/**
 * Deletes ONE code's app-owned Drizzle rows on the given executor — user_chats
 * (attribution), recent_codes (shortcuts), writing_submissions (the writing
 * module's saved texts), reports (student-submitted reports, which have NO FK
 * to the code and so must be dropped explicitly), saved quiz results (through
 * their store, which reveals nothing about them) and the cloze per-gap counts
 * first, then the code row LAST
 * (while it exists the code still appears in the list, so a mid-way failure is
 * safe to retry). The coding module's key rows are NOT here — `deleteCodesAndData`
 * drops them for the whole batch in one statement before this loop. Throws on a
 * DB error (rolling the batch back).
 */
async function deleteCodeRows(executor: DbExecutor, code: string): Promise<void> {
  await executor.delete(userChats).where(eq(userChats.code, code));
  await executor.delete(recentCodes).where(eq(recentCodes.code, code));
  await executor.delete(writingSubmissions).where(eq(writingSubmissions.code, code));
  await executor.delete(reports).where(eq(reports.code, code));
  await deleteResultsForCode(executor, code);
  await deleteGapCountsForCode(executor, code);
  await executor.delete(codesTable).where(eq(codesTable.code, code));
}

export type DeleteCodesResult = { ok: boolean; deleted: number };

/**
 * Bulk delete (the list's "Delete Selected", the only way to delete a code) — the
 * teacher-initiated cleanup that replaced garbage collection. For each code, the
 * Mastra conversation deletes happen per code (separate pool — they can't join a
 * Drizzle transaction); all the app-owned ROW deletes then run in ONE Drizzle
 * transaction (all-or-nothing): the coding keys for the whole selection first (a
 * single batched statement — this is the ONLY path that deletes them, so the
 * codes' API keys die with their codes), then each code's remaining rows. The
 * transaction first locks every selected code row `FOR UPDATE` (in code order,
 * so two deletes cannot deadlock): a quiz-result save holds its code row `FOR
 * SHARE`, so a save either commits before the delete removes its row, or finds
 * the code gone and writes nothing. `ok` is
 * false if any Mastra step failed or the row transaction rolled back; `deleted` is
 * the number of codes whose rows were processed (0 if the transaction rolled
 * back). Never throws.
 */
export async function deleteCodesAndData(codes: string[]): Promise<DeleteCodesResult> {
  if (codes.length === 0) return { ok: true, deleted: 0 };

  // 1. Conversations (Mastra), per code — outside the Drizzle transaction.
  let ok = true;
  for (const code of codes) {
    if (!(await deleteCodeConversations(code))) ok = false;
  }

  // 2. All app-owned rows in ONE transaction so the set commits or rolls back together.
  try {
    await getDb().transaction(async (tx) => {
      await tx
        .select({ code: codesTable.code })
        .from(codesTable)
        .where(inArray(codesTable.code, codes))
        .orderBy(asc(codesTable.code))
        .for("update");
      await deleteCodingKeysForCodes(tx, codes);
      for (const code of codes) await deleteCodeRows(tx, code);
    });
  } catch (error) {
    console.error("code-stats-store: bulk deleting app-owned rows failed", error);
    return { ok: false, deleted: 0 };
  }

  return { ok, deleted: codes.length };
}
