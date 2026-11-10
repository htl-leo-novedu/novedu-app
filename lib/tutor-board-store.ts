import { sql } from "drizzle-orm";
import { type BoardCall, boardCallsFromStored } from "@/lib/board/calls";
import { getDb } from "@/lib/db";
import { THREAD_ID_PATTERN } from "@/lib/thread-token";

// The `board` tool's server-side read: the thread's earlier successful board
// calls, from ALL its stored messages (the agent's memory window holds only the
// last 40, so a long conversation would lose its early drawing otherwise).
//
// Reads Mastra's tables by value with raw SQL (the pattern lib/code-stats-store.ts
// documents), joined on `mastra_threads."resourceId" = code` like
// `loadThreadForChat`, so a thread of another code yields nothing. Only
// assistant rows that mention the tool are selected — never a student's message
// (which may hold a multi-megabyte photo). The caller is the tool binding inside
// a running agent; the thread id and code come from that run's context, which
// the CopilotKit route already gated (docs/tutor-board.md).
//
// SERVER-ONLY: uses the database. Never import from client components.

/**
 * The thread's successful board calls, oldest first, deduplicated by tool-call
 * id. `[]` for a malformed thread id; throws on a database error (the tool then
 * fails the call instead of drawing on a board it cannot see).
 */
export async function loadThreadBoardCalls(code: string, threadId: string): Promise<BoardCall[]> {
  if (!THREAD_ID_PATTERN.test(threadId)) return [];
  const res = await getDb().execute<{ role: string; content: string }>(sql`
    SELECT m.role, m.content
    FROM mastra.mastra_messages m
    JOIN mastra.mastra_threads t ON t.id = m.thread_id
    WHERE m.thread_id = ${threadId} AND t."resourceId" = ${code}
      AND m.role = 'assistant' AND m.content LIKE '%"toolName":"board"%'
    ORDER BY m."createdAtZ" ASC, m.id ASC
  `);
  return boardCallsFromStored(res.rows);
}
