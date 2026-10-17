import { type SQL, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { userChats } from "@/lib/db/schema";
import type { FileKind } from "@/lib/file-name";
import { readAnonymousFlag } from "@/lib/file-validators";
import { THREAD_ID_PATTERN } from "@/lib/thread-token";

// Records which signed-in user owns which chat (Mastra thread) in
// `novedu_user_chats` — the ONLY place tying users to chats. Attribution is
// opt-in per activity: by default (`anonymous: true`, the YAML's default)
// NOTHING is written here; only an activity with `anonymous: false` records the
// link. The flag is read LIVE from the activity YAML (per the code's file kind),
// never from anything the client sent.
//
// Called from the chat runtime route off the response path (next/server's
// `after()`) on every run request, so this module must never throw and must
// stay cheap for repeat calls: a small in-process dedupe cache remembers
// threads that were already handled (stored OR decided against), and only a
// cache miss pays the YAML fetch + insert.
//
// SERVER-ONLY: uses the database. Never import from client components.

// Insertion-ordered Map as a bounded dedupe cache (~one entry per chat opened
// since the server started). `true` = row written, `false` = decided not to
// write (anonymous activity) — both skip all further work. Only DEFINITIVE
// outcomes are cached: a failed YAML load or DB insert stays uncached so the
// next run request retries.
const DEDUPE_CACHE_LIMIT = 1000;
const dedupeCache = new Map<string, boolean>();

function rememberDecision(key: string, stored: boolean): void {
  if (dedupeCache.size >= DEDUPE_CACHE_LIMIT) {
    const oldest = dedupeCache.keys().next().value;
    if (oldest !== undefined) dedupeCache.delete(oldest);
  }
  dedupeCache.set(key, stored);
}

/** Clears the dedupe cache — for unit tests only. */
export function resetUserChatDedupeCacheForTests(): void {
  dedupeCache.clear();
}

/**
 * Persists the user↔chat link for a thread opened under a code — IF the activity
 * opts into attribution (`anonymous: false` in its YAML). The flag is read
 * server-side from the YAML behind the stored `fileUrl` (per the code's `kind`),
 * never from anything the client sent. When the YAML cannot be loaded, the
 * privacy-safe default applies: nothing is stored. Never throws.
 */
export async function recordUserChat(
  code: string,
  threadId: string,
  userId: string,
  fileUrl: string,
  kind: FileKind,
): Promise<void> {
  if (!THREAD_ID_PATTERN.test(threadId)) {
    console.error("user-chat-store: rejecting malformed thread id, chat not recorded");
    return;
  }
  const key = `${code}/${threadId}`;
  if (dedupeCache.has(key)) return;

  // One YAML read per new thread (not per request — the dedupe cache catches the
  // rest). A failure falls through to "anonymous": better to lose attribution
  // than to attribute against an activity we could not read.
  const { anonymous, definitive } = await readAnonymousFlag(kind, fileUrl);
  if (anonymous) {
    if (definitive) rememberDecision(key, false);
    return;
  }

  try {
    // A conflicting thread id just means the row already exists (e.g. after a
    // server restart emptied the cache) — a silent success, not an error.
    await getDb()
      .insert(userChats)
      .values({ threadId, code, userId, createdAt: new Date() })
      .onConflictDoNothing({ target: userChats.threadId });
    rememberDecision(key, true);
  } catch (error) {
    // NOT cached: a transient DB error should retry on the next run request.
    console.error("user-chat-store: failed to record user chat", error);
  }
}

/**
 * `(user_id, code, at)` for every chat on one of the teacher's codes whose
 * FROZEN `anonymous` flag is false, `at` = when the chat began — a subselect the
 * teacher facts store unions into its identified-students counts (docs/home.md →
 * Teacher dashboard). The caller only counts and dates them; no user id leaves it.
 */
export function chattersOfTeacherStatement(teacherId: string): SQL {
  return sql`
    SELECT uc.user_id, uc.code, uc.created_at AS at FROM novedu_user_chats uc
    JOIN novedu_codes c ON c.code = uc.code
    WHERE c.created_by = ${teacherId} AND NOT c.anonymous
  `;
}
