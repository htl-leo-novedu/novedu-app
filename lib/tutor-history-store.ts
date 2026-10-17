import type { Message } from "@ag-ui/core";
import { and, eq, sql } from "drizzle-orm";
import { collapseReplayedRuns, toAguiMessage } from "@/lib/conversation-collapse";
import { getDb } from "@/lib/db";
import { userChats } from "@/lib/db/schema";
import { THREAD_ID_PATTERN } from "@/lib/thread-token";
import { buildPreview } from "@/lib/tutor-history-preview";
import type { TutorThreadSummary } from "@/lib/tutor-history-types";

// The student-side reads behind a tutor's conversation history: when a thread's
// last message was written, a thread's messages as AG-UI messages for the chat's
// `connect` snapshot (app/api/copilotkit/history-snapshot-runner.ts), and — for
// per-user tutors only — the session user's own conversations under one code
// ("Previous conversations") and whether a thread is theirs.
//
// Reads Mastra's tables by value with raw SQL (never declared to Drizzle — the
// pattern lib/code-stats-store.ts documents). Every read joins `mastra_threads`
// on `"resourceId" = code`, so a thread of another code yields nothing. The
// message reads run only after the caller proved ownership (the thread token over
// `(code, session user, threadId)`). The two `novedu_user_chats` reads are the
// student-side reader of that table: their `userId` always comes from the
// caller's SESSION, and no user id is ever returned.
//
// Its importers are guard-tested (lib/tutor-history-isolation.unit.test.ts).
//
// SERVER-ONLY: uses the database. Never import from client components.

/**
 * When the thread's latest message (user or assistant) was written, `null` for a
 * thread with no messages (or one of another code). Returns `undefined` on a
 * database error or a malformed thread id. Never throws.
 */
export async function threadLastMessageAt(
  code: string,
  threadId: string,
): Promise<Date | null | undefined> {
  if (!THREAD_ID_PATTERN.test(threadId)) return undefined;
  try {
    const res = await getDb().execute<{ lastAt: string | Date | null }>(sql`
      SELECT MAX(m."createdAtZ") AS "lastAt"
      FROM mastra.mastra_messages m
      JOIN mastra.mastra_threads t ON t.id = m.thread_id
      WHERE m.thread_id = ${threadId} AND t."resourceId" = ${code}
    `);
    const lastAt = res.rows[0]?.lastAt ?? null;
    return lastAt === null ? null : new Date(lastAt);
  } catch (error) {
    console.error("tutor-history-store: reading the thread's last message time failed", error);
    return undefined;
  }
}

/**
 * The thread's messages, oldest first, as AG-UI messages for the chat's
 * `connect` snapshot — ids unchanged (`mastra_messages.id`), which is what lets
 * the snapshot runner recognise the same messages in the in-process replay and
 * lets `@ag-ui/mastra` dedupe a re-sent user message. Replayed history is
 * collapsed so each turn shows once. `lastMessageAt` is `null` with no messages.
 * Returns `undefined` on a database error or a malformed thread id. Never throws.
 */
export async function loadThreadForChat(
  code: string,
  threadId: string,
): Promise<{ messages: Message[]; lastMessageAt: Date | null } | undefined> {
  if (!THREAD_ID_PATTERN.test(threadId)) return undefined;
  try {
    const res = await getDb().execute<{
      id: string;
      role: string;
      content: string;
      createdAt: string | Date;
    }>(sql`
      SELECT m.id, m.role, m.content, m."createdAtZ" AS "createdAt"
      FROM mastra.mastra_messages m
      JOIN mastra.mastra_threads t ON t.id = m.thread_id
      WHERE m.thread_id = ${threadId} AND t."resourceId" = ${code}
      ORDER BY m."createdAtZ" ASC, m.id ASC
    `);
    const last = res.rows.at(-1);
    const messages = res.rows.map(toAguiMessage).filter((m): m is Message => m !== null);
    return {
      messages: collapseReplayedRuns(messages),
      lastMessageAt: last ? new Date(last.createdAt) : null,
    };
  } catch (error) {
    console.error("tutor-history-store: loading the thread's messages failed", error);
    return undefined;
  }
}

/** How many conversations "Previous conversations" lists at most. */
export const TUTOR_HISTORY_LIMIT = 50;

/**
 * The session user's own conversations with ONE tutor code, newest last activity
 * first, at most `TUTOR_HISTORY_LIMIT` (`more` = there are older ones). Starts
 * from their `novedu_user_chats` rows for the code and inner-joins
 * `mastra_threads` (so a thread without Mastra rows drops out); only threads the
 * student wrote into count. The preview is computed IN SQL from the first user
 * message's text parts and whether it carries a photo — the whole `content` is
 * never selected, since a photo is a multi-megabyte data URL. Returns `undefined`
 * on a database error. Never throws.
 */
export async function listOwnTutorThreads(
  userId: string,
  code: string,
): Promise<{ threads: TutorThreadSummary[]; more: boolean } | undefined> {
  try {
    const res = await getDb().execute<{
      threadId: string;
      lastAt: string | Date;
      userCount: string | number;
      previewText: string | null;
      hasFile: boolean | null;
    }>(sql`
      SELECT uc.thread_id AS "threadId",
             agg."lastAt",
             agg."userCount",
             first_user."previewText",
             first_user."hasFile"
      FROM novedu_user_chats uc
      JOIN mastra.mastra_threads t ON t.id = uc.thread_id AND t."resourceId" = uc.code
      CROSS JOIN LATERAL (
        SELECT MAX(m."createdAtZ") AS "lastAt",
               COUNT(*) FILTER (WHERE m.role = 'user') AS "userCount"
        FROM mastra.mastra_messages m
        WHERE m.thread_id = uc.thread_id
      ) agg
      LEFT JOIN LATERAL (
        SELECT
          (SELECT string_agg(p->>'text', '')
             FROM jsonb_array_elements(parts.arr) p
            WHERE p->>'type' = 'text') AS "previewText",
          EXISTS (SELECT 1
                    FROM jsonb_array_elements(parts.arr) p
                   WHERE p->>'type' = 'file') AS "hasFile"
        FROM mastra.mastra_messages m
        CROSS JOIN LATERAL (
          SELECT CASE WHEN jsonb_typeof((m.content::jsonb)->'parts') = 'array'
                      THEN (m.content::jsonb)->'parts' ELSE '[]'::jsonb END AS arr
        ) parts
        WHERE m.thread_id = uc.thread_id AND m.role = 'user'
        ORDER BY m."createdAtZ" ASC, m.id ASC
        LIMIT 1
      ) first_user ON true
      WHERE uc.user_id = ${userId} AND uc.code = ${code} AND agg."userCount" > 0
      ORDER BY agg."lastAt" DESC, uc.thread_id ASC
      LIMIT ${TUTOR_HISTORY_LIMIT + 1}
    `);
    const threads = res.rows.slice(0, TUTOR_HISTORY_LIMIT).map((row) => ({
      threadId: row.threadId,
      lastActivityAt: new Date(row.lastAt),
      userMessageCount: Number(row.userCount),
      preview: buildPreview({ text: row.previewText, hasFile: row.hasFile === true }),
    }));
    return { threads, more: res.rows.length > TUTOR_HISTORY_LIMIT };
  } catch (error) {
    console.error("tutor-history-store: listing the student's conversations failed", error);
    return undefined;
  }
}

/**
 * Whether the session user has a `novedu_user_chats` row for exactly this
 * `(code, threadId)` — the ownership proof for reopening an older conversation.
 * `false` for a malformed thread id, `undefined` on a database error. Never throws.
 */
export async function ownsTutorThread(
  userId: string,
  code: string,
  threadId: string,
): Promise<boolean | undefined> {
  if (!THREAD_ID_PATTERN.test(threadId)) return false;
  try {
    const rows = await getDb()
      .select({ threadId: userChats.threadId })
      .from(userChats)
      .where(
        and(
          eq(userChats.threadId, threadId),
          eq(userChats.code, code),
          eq(userChats.userId, userId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch (error) {
    console.error("tutor-history-store: checking conversation ownership failed", error);
    return undefined;
  }
}
