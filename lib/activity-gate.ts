import type { CodeModule } from "@/lib/code-modules/types";
import { type CodeEntry, type CodeRejection, checkCode } from "@/lib/code-store";
import { getSession } from "@/lib/session";

// The student-side gate every activity's server actions open with: the session user,
// then `checkCode()` on the stored code row (re-run on EVERY touch — AGENTS.md), then
// the code's module. Returns a ready-to-show message on any failure, from ONE neutral
// table shared with the CopilotKit runtime route, so a student sees the same words
// whichever activity they are in.
//
// SERVER-ONLY, deliberately WITHOUT `"use server"`: imported by the `"use server"`
// action files (and `lib/quiz-verify.ts`); with the directive, these exports would
// become public server-action endpoints. Touches the database.

/** What a student reads when their code is refused, per `checkCode` reason. */
export const CODE_REJECTION_MESSAGES: Record<CodeRejection, string> = {
  "unknown-code": "This code is not valid.",
  "not-started": "This activity's availability window has not started yet.",
  expired: "This activity's availability window has ended.",
  "lookup-failed": "Codes cannot be checked right now — try again in a moment.",
};

export type StudentGate =
  | { ok: true; userId: string; entry: CodeEntry }
  | { ok: false; message: string };

/**
 * The session user (`novedu_user.id`) on a valid, in-window code of `module`, or the
 * message to show.
 */
export async function verifyStudentActivity(
  code: string,
  module: CodeModule,
): Promise<StudentGate> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, message: "Please sign in to continue." };

  const verification = await checkCode(code);
  if (!verification.ok) {
    return { ok: false, message: CODE_REJECTION_MESSAGES[verification.reason] };
  }
  if (verification.entry.module !== module) {
    return { ok: false, message: "This code is not for this activity." };
  }
  return { ok: true, userId, entry: verification.entry };
}
