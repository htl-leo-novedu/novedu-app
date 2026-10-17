"use server";

import { revalidatePath } from "next/cache";
import { CODE_REJECTION_MESSAGES } from "@/lib/activity-gate";
import { checkCode } from "@/lib/code-store";
import { invalidateHome } from "@/lib/home-data";
import type { QuizVerdict } from "@/lib/quiz-types";
import { verifyAndLoadQuestion } from "@/lib/quiz-verify";
import {
  countChatReports,
  countQuizReports,
  deleteReports,
  insertChatReport,
  insertQuizReport,
  setReportsResolved,
} from "@/lib/report-store";
import {
  isReportReaction,
  MAX_REPORTS_PER_TARGET,
  REPORT_DESCRIPTION_MAX,
} from "@/lib/report-types";
import { getSession } from "@/lib/session";
import { requireTeacherUserId } from "@/lib/student-mode";
import { emitEvent } from "@/lib/telemetry";
import { getThreadTokenSecret, THREAD_ID_PATTERN, verifyThreadToken } from "@/lib/thread-token";

// The report server actions (GH issue #24). Two student-facing submit actions —
// one per reportable surface — and three teacher-only bulk actions for the
// `/reports` inbox. The whole app sits behind the Entra gate, so every caller is
// authenticated; the reporting student's user id always comes from the SESSION, never
// from input (it is stored on the row — the sanctioned waiver of anonymity, see
// docs/reports.md / the `novedu_reports` schema block).
//
// A CHAT report proves the reporter owns the reported thread via the stateless
// HMAC thread token (its designed first use), exactly like the runtime route. A
// QUIZ report carries its OWN snapshot because grading persists nothing: the
// question text is the SERVER's authoritative copy, the answer/verdict/feedback
// are the student's own graded turn (accepted as-is — the same trust trade as
// `startDiscussion`; nothing server-side exists to check them against).
//
// Telemetry is metadata-only — `emitEvent` NEVER carries the description or any
// snapshot content (docs/telemetry.md).

// A canonical UUID (what `randomUUID` mints for a report id) — the shape the bulk
// actions accept, so a malformed id list is rejected before any DB round-trip.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Client-sent answer/feedback are bounded so a tampered client cannot store an
// unbounded blob; well above any realistic graded answer/feedback length.
const QUIZ_SNAPSHOT_MAX = 32_000;

const REACTION_REQUIRED = "Pick a reaction before reporting.";
const COULD_NOT_SUBMIT = "The report could not be submitted right now. Please try again.";
const SOFT_CAP_MESSAGE =
  "You've already reported this a few times — your teacher will take a look.";

export type SubmitReportResult = { ok: true } | { ok: false; message: string };

// Trim the free-text description and enforce the shared cap. Returns the message
// on overflow so both submit actions reject identically.
function validateDescription(value: unknown): { ok: true; description: string } | { ok: false } {
  const description = typeof value === "string" ? value.trim() : "";
  return description.length > REPORT_DESCRIPTION_MAX ? { ok: false } : { ok: true, description };
}

function isQuizVerdict(value: unknown): value is QuizVerdict {
  return value === "correct" || value === "partial" || value === "incorrect";
}

/**
 * Files a report on a chat conversation (any of the three chat surfaces). The
 * reporter's user id is the session's; ownership of the thread is proven by the HMAC
 * token over `(code, userId, threadId)` — a leaked token+threadId is useless to
 * anyone but its owner. A soft per-`(thread, user)` cap keeps a single student
 * from flooding the inbox. On success emits a content-free telemetry event.
 */
export async function submitChatReport(input: {
  code: string;
  threadId: string;
  threadToken: string;
  reaction: string;
  description: string;
}): Promise<SubmitReportResult> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, message: "Please sign in to continue." };

  if (!isReportReaction(input.reaction)) return { ok: false, message: REACTION_REQUIRED };
  const desc = validateDescription(input.description);
  if (!desc.ok) {
    return {
      ok: false,
      message: `The description must be at most ${REPORT_DESCRIPTION_MAX} characters.`,
    };
  }
  const threadId = typeof input.threadId === "string" ? input.threadId : "";
  if (!THREAD_ID_PATTERN.test(threadId)) {
    return { ok: false, message: "This conversation cannot be reported." };
  }

  const verification = await checkCode(input.code);
  if (!verification.ok) {
    return { ok: false, message: CODE_REJECTION_MESSAGES[verification.reason] };
  }

  const owns = verifyThreadToken(
    input.threadToken,
    { code: input.code, userId, threadId },
    getThreadTokenSecret(),
  );
  if (!owns) return { ok: false, message: "This conversation cannot be reported." };

  const count = await countChatReports(threadId, userId);
  if (count === undefined) return { ok: false, message: COULD_NOT_SUBMIT };
  if (count >= MAX_REPORTS_PER_TARGET) return { ok: false, message: SOFT_CAP_MESSAGE };

  const stored = await insertChatReport({
    code: input.code,
    userId,
    threadId,
    reaction: input.reaction,
    description: desc.description,
  });
  if (!stored) return { ok: false, message: COULD_NOT_SUBMIT };

  // METADATA ONLY — never the description or any content (docs/telemetry.md).
  emitEvent("report.submitted", { kind: "chat", reaction: input.reaction, code: input.code });
  return { ok: true };
}

/**
 * Files a report on a single graded quiz answer. Re-verifies the code + loads the
 * question through the shared, server-only `verifyAndLoadQuestion` (which also
 * authenticates), then snapshots the SERVER's question text with the student's own
 * graded answer/verdict/feedback. The verdict must be a known value (reject, don't
 * coerce); answer/feedback are size-bounded. Soft-capped per `(code, question,
 * user)`. On success emits a content-free telemetry event.
 */
export async function submitQuizReport(input: {
  code: string;
  questionId: string;
  answer: string;
  result: string;
  feedback: string;
  hadImages: boolean;
  reaction: string;
  description: string;
}): Promise<SubmitReportResult> {
  if (!isReportReaction(input.reaction)) return { ok: false, message: REACTION_REQUIRED };
  const desc = validateDescription(input.description);
  if (!desc.ok) {
    return {
      ok: false,
      message: `The description must be at most ${REPORT_DESCRIPTION_MAX} characters.`,
    };
  }

  // auth + checkCode + module check + loadQuiz + find the question, all server-side.
  const ctx = await verifyAndLoadQuestion({ code: input.code, questionId: input.questionId });
  if (!ctx.ok) return ctx;

  // The verdict is the student's own graded turn — nothing server-side to check it
  // against (the grader persists nothing) — but it must be one of the known values.
  if (!isQuizVerdict(input.result))
    return { ok: false, message: "This answer cannot be reported." };

  // answer/feedback are client-sent, the same trust trade as `startDiscussion`'s
  // seed messages; bound their size so a tampered client can't store a huge blob.
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  const feedback = typeof input.feedback === "string" ? input.feedback.trim() : "";
  if (answer.length > QUIZ_SNAPSHOT_MAX || feedback.length > QUIZ_SNAPSHOT_MAX) {
    return { ok: false, message: "This answer is too long to report." };
  }

  const count = await countQuizReports(ctx.code, ctx.userId, ctx.question.id);
  if (count === undefined) return { ok: false, message: COULD_NOT_SUBMIT };
  if (count >= MAX_REPORTS_PER_TARGET) return { ok: false, message: SOFT_CAP_MESSAGE };

  const stored = await insertQuizReport({
    code: ctx.code,
    userId: ctx.userId,
    questionId: ctx.question.id,
    // The SERVER's authoritative copy — immune to client tampering and later YAML edits.
    questionText: ctx.question.question,
    answerText: answer,
    feedbackText: feedback,
    verdict: input.result,
    hadImages: input.hadImages === true,
    reaction: input.reaction,
    description: desc.description,
  });
  if (!stored) return { ok: false, message: COULD_NOT_SUBMIT };

  // METADATA ONLY — never the snapshot or description (docs/telemetry.md).
  emitEvent("report.submitted", { kind: "quiz-answer", reaction: input.reaction, code: ctx.code });
  return { ok: true };
}

// The teacher bulk actions share one gate + id-shape check. Result shape is
// `BulkDeleteResult`-compatible (components/list-selection.tsx), so the generic
// `BulkActionButton` / `DeleteSelectedButton` drive them unchanged.
function isReportIdList(ids: unknown): ids is string[] {
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((id) => typeof id === "string" && UUID_PATTERN.test(id))
  );
}

// A report write changes the acting teacher's "Open reports" counter: drop their
// cached start page on the server and in the browser's router cache (docs/home.md).
function refreshTeacherHome(userId: string): void {
  invalidateHome(userId);
  revalidatePath("/");
}

async function requireReportsTeacher(): Promise<
  { ok: true; userId: string } | { ok: false; message: string }
> {
  const gate = await requireTeacherUserId();
  if (!gate.ok) {
    return {
      ok: false,
      message: "Only teachers can manage reports.",
    };
  }
  return { ok: true, userId: gate.userId };
}

/** Bulk "Mark resolved" — teacher-only. Stamps `resolved_at`/`resolved_by`. */
export async function markSelectedReportsResolvedAction(
  ids: string[],
): Promise<SubmitReportResult> {
  const gate = await requireReportsTeacher();
  if (!gate.ok) return gate;
  if (!isReportIdList(ids)) return { ok: false, message: "Select at least one report." };

  if (!(await setReportsResolved(ids, true, gate.userId))) {
    return { ok: false, message: "Some reports could not be updated. Try again." };
  }
  revalidatePath("/reports");
  refreshTeacherHome(gate.userId);
  return { ok: true };
}

/** Bulk "Reopen" — teacher-only. Nulls `resolved_at`/`resolved_by`. */
export async function reopenSelectedReportsAction(ids: string[]): Promise<SubmitReportResult> {
  const gate = await requireReportsTeacher();
  if (!gate.ok) return gate;
  if (!isReportIdList(ids)) return { ok: false, message: "Select at least one report." };

  if (!(await setReportsResolved(ids, false, gate.userId))) {
    return { ok: false, message: "Some reports could not be updated. Try again." };
  }
  revalidatePath("/reports");
  refreshTeacherHome(gate.userId);
  return { ok: true };
}

/** Bulk "Delete Selected" — teacher-only, the only way to delete reports. */
export async function deleteSelectedReportsAction(ids: string[]): Promise<SubmitReportResult> {
  const gate = await requireReportsTeacher();
  if (!gate.ok) return gate;
  if (!isReportIdList(ids)) return { ok: false, message: "Select at least one report." };

  if (!(await deleteReports(ids))) {
    return { ok: false, message: "Some reports could not be deleted. Try again." };
  }
  revalidatePath("/reports");
  refreshTeacherHome(gate.userId);
  return { ok: true };
}
