import { feedbackLooksTruncated } from "@/lib/quiz-feedback-truncation";
import type { QuizVerdict } from "@/lib/quiz-types";
import { emitEvent } from "@/lib/telemetry";

// The ONE implementation of the issue-#115 mitigation every structured-output caller
// shares — the quiz grader's student path (`lib/quiz-actions.ts` `submitAnswer`), the
// teacher-only eval route (`app/api/eval/grade`), and both cloze calls
// (`lib/cloze-actions.ts`, through the generic `withTruncationRetry`). Deliberately identical by construction: an eval must measure
// what a student would actually have been shown.
//
// SERVER-ONLY (imports the telemetry seam) and NOT `"use server"` — a plain module, so
// nothing here becomes an endpoint.

/** The structured verdict a grading call produces (`QUIZ_VERDICT_SCHEMA`). */
export interface GradedVerdict {
  result: QuizVerdict;
  feedback: string;
}

/**
 * Grade once; when the feedback looks cut off mid-inline-code (`feedbackLooksTruncated`,
 * issue #115), grade ONE more time — the truncation is a provider-side artefact of the
 * JSON grammar, not a bad answer, and one more sample usually lands clean.
 *
 * The verdict already in hand is never lost to the retry: a retry that throws, or
 * returns no object, keeps the first attempt — a truncated-but-served feedback beats
 * refusing to grade. When the SERVED feedback is still truncated, the
 * `quiz.feedback.truncated` event (with `event` as its payload) makes the recurrence
 * visible; nothing else changes.
 *
 * `raw` is the attempt the served `object` came from, so a caller can derive
 * call-level detail (the eval route's token usage) from the matching result.
 */
export function gradeWithTruncationRetry<R>(
  grade: () => Promise<R>,
  objectOf: (result: R) => GradedVerdict | undefined,
  event: Record<string, string> = {},
): Promise<{ raw: R; object: GradedVerdict | undefined }> {
  return withTruncationRetry(
    grade,
    objectOf,
    (object) => [object.feedback],
    "quiz.feedback.truncated",
    event,
  );
}

/**
 * The same mitigation for ANY structured output: `textsOf` names the object's prose
 * fields, and the call is retried once when any of them looks truncated. The cloze
 * pipeline (lib/cloze-actions.ts) uses it for its grading reasons and its feedback
 * patterns and notes — strings under the same JSON grammar. `eventName` is emitted when
 * the SERVED object is still truncated.
 */
export async function withTruncationRetry<R, O>(
  run: () => Promise<R>,
  objectOf: (result: R) => O | undefined,
  textsOf: (object: O) => readonly string[],
  eventName: string,
  event: Record<string, string> = {},
): Promise<{ raw: R; object: O | undefined }> {
  const truncated = (object: O) => textsOf(object).some(feedbackLooksTruncated);
  let raw = await run();
  let object = objectOf(raw);
  if (object && truncated(object)) {
    try {
      const retried = await run();
      const retriedObject = objectOf(retried);
      if (retriedObject) {
        raw = retried;
        object = retriedObject;
      }
    } catch {
      // Keep the first object — see the header.
    }
    if (truncated(object)) emitEvent(eventName, event);
  }
  return { raw, object };
}
