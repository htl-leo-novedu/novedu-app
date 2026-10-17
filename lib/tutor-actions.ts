"use server";

import { verifyStudentActivity } from "@/lib/activity-gate";
import {
  getThreadTokenSecret,
  newThread,
  signThreadToken,
  THREAD_ID_PATTERN,
  verifyThreadToken,
} from "@/lib/thread-token";
import {
  historyEnabled,
  liveTutorAnonymous,
  ownerMayReopen,
  withinResumeWindow,
} from "@/lib/tutor-history-gate";
import {
  listOwnTutorThreads,
  ownsTutorThread,
  threadLastMessageAt,
} from "@/lib/tutor-history-store";
import type { ListTutorThreadsResult, OpenTutorThreadResult } from "@/lib/tutor-history-types";

// The student-facing tutor server actions: decide WHICH thread the chat uses.
// None of them returns a message — the conversation itself reaches the browser
// with the chat's `connect` (app/api/copilotkit/history-snapshot-runner.ts).
//
// - "start over" (`startNewTutorThread`): abandon the current conversation and
//   continue in a fresh Mastra thread.
// - "resume" (`resumeTutorThread`): after a reload, may this tab keep the thread
//   it stored in `sessionStorage` (lib/tutor-thread-storage.ts)?
// - "previous conversations" (`listTutorThreads`, `openTutorThread`): for a
//   per-user tutor only (lib/tutor-history-gate.ts), list the session user's own
//   conversations under this code and hand back a token for one of them.
//
// A thread is only usable with its `x-thread-token` — the stateless HMAC over
// `(code, userId, threadId)` keyed off AUTH_SECRET (lib/thread-token.ts,
// server-only) — so the browser CANNOT mint one; clearing the transcript
// client-side would leave the SAME threadId, whose last 40 messages the tutor
// still recalls. Hence the start-over round-trip. It grants nothing new:
// `app/[code]/page.tsx` already mints a fresh thread on every page load. Every
// action RE-VERIFIES the code (a code that fell out of its window mid-session
// cannot mint or resume a thread) and takes the user id from the session, never
// from the caller.
//
// Nothing is persisted and no Mastra call is made: a tutor thread is created
// lazily on its first run, exactly as the page-load path does. The ABANDONED
// thread is left untouched — the teacher can still read it and any report already
// filed against it still resolves.

export type StartOverResult =
  | { ok: true; threadId: string; threadToken: string }
  | { ok: false; message: string };

/**
 * Mints a fresh thread id + ownership token for the signed-in user on a valid,
 * in-window tutor code. The caller swaps the pair into the chat surface, whose
 * provider remounts on the new thread (see `providerKey` in app/module-chat.tsx).
 */
export async function startNewTutorThread(input: { code: string }): Promise<StartOverResult> {
  const gate = await verifyStudentActivity(input.code, "tutor");
  if (!gate.ok) return gate;
  return { ok: true, ...newThread(input.code, gate.userId) };
}

/**
 * May this tab keep the thread it stored before a reload? `{ ok: true }` only for
 * the session user's own token over `(code, user, threadId)` on a valid,
 * in-window tutor code whose thread has messages and EITHER its last one is less
 * than `TUTOR_RESUME_IDLE_MS` old OR (a per-user tutor) the student owns it, as
 * for a conversation reopened from "Previous conversations" (lib/tutor-history-gate.ts). The token is not
 * re-issued; the caller keeps using the one it holds, and the messages arrive
 * with the chat's `connect`. Persists nothing.
 *
 * Every refusal — signed out, a bad code, another user's or another thread's
 * token, an empty or idle thread, a database error — is the same opaque
 * `{ ok: false }`, so the action is no oracle for whether a thread exists, whose
 * it is, or why it was refused.
 */
export async function resumeTutorThread(input: {
  code: string;
  threadId: string;
  threadToken: string;
}): Promise<{ ok: boolean }> {
  const refused = { ok: false };
  if (typeof input.threadId !== "string" || !THREAD_ID_PATTERN.test(input.threadId)) {
    return refused;
  }
  const gate = await verifyStudentActivity(input.code, "tutor");
  if (!gate.ok) return refused;
  const { userId, entry } = gate;

  if (
    !verifyThreadToken(
      input.threadToken,
      { code: input.code, userId, threadId: input.threadId },
      getThreadTokenSecret(),
    )
  ) {
    return refused;
  }

  const lastMessageAt = await threadLastMessageAt(input.code, input.threadId);
  if (!(lastMessageAt instanceof Date)) return refused;
  if (withinResumeWindow(lastMessageAt, new Date())) return { ok: true };
  // Past the limit, only a conversation the student may reopen anyway (a
  // per-user tutor and their own ownership row): the same rule the snapshot
  // runner applies, so a reopened older conversation survives a reload too.
  const reopenable = await ownerMayReopen({
    code: input.code,
    frozenAnonymous: entry.anonymous,
    fileUrl: entry.fileUrl,
    userId,
    threadId: input.threadId,
  });
  return reopenable ? { ok: true } : refused;
}

/** The one answer to every refused open: no oracle for why. */
const OPEN_REFUSED_MESSAGE = "This conversation can't be opened.";

/**
 * The shared gate of the two history actions: the session user on a valid,
 * in-window tutor code whose history is enabled (frozen AND live `anonymous`
 * false). `undefined` when any part fails.
 */
async function historyGate(code: string): Promise<{ userId: string } | undefined> {
  const gate = await verifyStudentActivity(code, "tutor");
  if (!gate.ok) return undefined;
  const { userId, entry } = gate;
  // The frozen flag first: an anonymous code never pays the YAML read.
  if (entry.anonymous) return undefined;
  if (!historyEnabled(entry.anonymous, await liveTutorAnonymous(entry.fileUrl))) {
    return undefined;
  }
  return { userId };
}

/**
 * "Previous conversations": the session user's own conversations with THIS
 * tutor code, newest last activity first (at most 50, `more` when older ones
 * exist). Only on a history-enabled code; any refusal or failure is `{ ok: false }`.
 */
export async function listTutorThreads(input: { code: string }): Promise<ListTutorThreadsResult> {
  const gate = await historyGate(input.code);
  if (!gate) return { ok: false };
  const listed = await listOwnTutorThreads(gate.userId, input.code);
  if (!listed) return { ok: false };
  return { ok: true, threads: listed.threads, more: listed.more };
}

/**
 * Reopens one of the session user's earlier conversations: on a history-enabled
 * code, a `novedu_user_chats` row for exactly `(user, code, threadId)` and at
 * least one stored message, it signs a token for `(code, user, threadId)`. No
 * time limit. The chat swaps to that thread, and its messages arrive with the
 * `connect`. Every refusal carries the same message.
 */
export async function openTutorThread(input: {
  code: string;
  threadId: string;
}): Promise<OpenTutorThreadResult> {
  const refused = { ok: false as const, message: OPEN_REFUSED_MESSAGE };
  if (typeof input.threadId !== "string" || !THREAD_ID_PATTERN.test(input.threadId)) {
    return refused;
  }
  const gate = await historyGate(input.code);
  if (!gate) return refused;
  if ((await ownsTutorThread(gate.userId, input.code, input.threadId)) !== true) return refused;
  const lastMessageAt = await threadLastMessageAt(input.code, input.threadId);
  if (!(lastMessageAt instanceof Date)) return refused;

  const threadToken = signThreadToken(
    { code: input.code, userId: gate.userId, threadId: input.threadId },
    getThreadTokenSecret(),
  );
  return { ok: true, threadToken };
}
