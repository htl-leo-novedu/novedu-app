import { loadCloze } from "@/lib/cloze-fetch";
import { MAX_CLOZE_ANSWER_LENGTH } from "@/lib/cloze-types";
import type { Cloze } from "@/lib/cloze-yaml";
import { type CodeRejection, checkCode, effectiveLlm } from "@/lib/code-store";
import type { LlmProvider, ReasoningLevel } from "@/lib/llm/provider";
import { getSession } from "@/lib/session";

// The shared cloze-verification preamble — SERVER-ONLY, but deliberately WITHOUT a
// `"use server"` directive (exactly like lib/quiz-verify.ts). It is imported by the
// `"use server"` file `lib/cloze-actions.ts`; if this code lived in a `"use server"`
// module, exporting `verifyAndLoadCloze` would mint a public server-action endpoint
// returning the loaded `Cloze` — which carries the server-only reference answers and
// `evaluation`. Keeping it here, importable by server code only, keeps them off the
// wire. (Touches the database and fetches arbitrary URLs — never client-safe.)
//
// Check order, cheap before expensive: session → `checkCode()` (the stored row and its
// window, re-run on EVERY action) → `module === "cloze"` → the exercise re-loaded from
// the code's file.

export interface ClozeCodeInput {
  code: string;
}

export const CLOZE_CODE_REJECTION_MESSAGES: Record<CodeRejection, string> = {
  "unknown-code": "This exercise code is not valid.",
  "not-started": "This exercise's availability window has not started yet.",
  expired: "This exercise's availability window has ended.",
  "lookup-failed": "Exercise codes cannot be checked right now — try again in a moment.",
};

export type LoadedCloze = {
  ok: true;
  userId: string;
  code: string;
  fileUrl: string;
  cloze: Cloze;
  /** The provider + model (+ reasoning) to grade with: the code's override or the YAML's. */
  llm: { provider: LlmProvider; model: string; reasoning?: ReasoningLevel };
};

/**
 * The preamble of every cloze action: an authenticated session + a valid, in-window
 * cloze code + the (server-authoritative) exercise re-loaded from the code's file.
 * Returns a ready-to-show message on any failure.
 */
export async function verifyAndLoadCloze(
  input: ClozeCodeInput,
): Promise<LoadedCloze | { ok: false; message: string }> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, message: "Please sign in to continue." };

  const verification = await checkCode(input.code);
  if (!verification.ok) {
    return { ok: false, message: CLOZE_CODE_REJECTION_MESSAGES[verification.reason] };
  }
  const { entry } = verification;
  if (entry.module !== "cloze") {
    return { ok: false, message: "This code is not a cloze exercise." };
  }

  const loaded = await loadCloze(entry.fileUrl);
  if (!loaded.ok) return { ok: false, message: loaded.message };

  return {
    ok: true,
    userId,
    code: input.code,
    fileUrl: entry.fileUrl,
    cloze: loaded.cloze,
    llm: effectiveLlm(entry, loaded.cloze),
  };
}

/**
 * A well-formed answer list: an array of strings, none longer than the answer cap. The
 * cheap shape check every action runs BEFORE any I/O; the gap count is checked against
 * the reloaded exercise afterwards.
 */
export function isAnswerList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((answer) => typeof answer === "string" && answer.length <= MAX_CLOZE_ANSWER_LENGTH)
  );
}

/**
 * The answers no longer fit the exercise (one per gap): the teacher changed the gaps
 * after the page loaded (a known limitation — the student reloads).
 */
export const CLOZE_CHANGED_MESSAGE =
  "This exercise changed while you were working on it. Reload the page to start again.";
