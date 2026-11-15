import { createHmac, timingSafeEqual } from "node:crypto";
import type { HandInCounts } from "@/lib/moodle-score";
import type { QuizVerdict } from "@/lib/quiz-types";

// Signed receipts for the Moodle hand-in (docs/moodle.md). A graded answer on a
// Moodle-enabled code returns a receipt: HMAC-SHA256 over
// `(code, userId, attemptId, slot, questionId, verdict)` with a key derived from
// AUTH_SECRET under its own label. The hand-in COUNTS from verified receipts on
// the server, so a student cannot invent or edit numbers, reuse another user's,
// code's or attempt's receipts, or fill every slot with one easy question.
// Answering a slot again and keeping the better receipt stays possible —
// accepted, since retakes are unlimited anyway.
//
// Pure apart from `getReceiptSecret()`; the secret is passed in, so the module
// stays real in tests. SERVER-ONLY: node:crypto and the signing key.

const VERDICTS: readonly QuizVerdict[] = ["correct", "partial", "incorrect"];
const HEX_MAC = /^[0-9a-f]{64}$/;

/** What the browser keeps per answered slot and sends back on hand-in. */
export interface Receipt {
  slot: number;
  questionId: string;
  verdict: QuizVerdict;
  mac: string;
}

export interface ReceiptScope {
  code: string;
  userId: string;
  attemptId: string;
}

function mac(
  scope: ReceiptScope,
  slot: number,
  questionId: string,
  verdict: string,
  secret: string,
) {
  return createHmac("sha256", secret)
    .update(JSON.stringify([scope.code, scope.userId, scope.attemptId, slot, questionId, verdict]))
    .digest("hex");
}

export function signReceipt(
  scope: ReceiptScope,
  answer: { slot: number; questionId: string; verdict: QuizVerdict },
  secret: string,
): Receipt {
  return { ...answer, mac: mac(scope, answer.slot, answer.questionId, answer.verdict, secret) };
}

/** Whether `value` is a well-formed receipt signed for exactly this scope. */
export function verifyReceipt(
  value: unknown,
  scope: ReceiptScope,
  secret: string,
): value is Receipt {
  if (typeof value !== "object" || value === null) return false;
  const { slot, questionId, verdict, mac: given } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(slot) || (slot as number) < 0) return false;
  if (typeof questionId !== "string" || questionId === "") return false;
  if (!VERDICTS.includes(verdict as QuizVerdict)) return false;
  if (typeof given !== "string" || !HEX_MAC.test(given)) return false;
  const expected = mac(scope, slot as number, questionId, verdict as string, secret);
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export type CountResult = { ok: true; counts: HandInCounts } | { ok: false };

/**
 * Counts an attempt from its receipts. Rejects the whole call — never clamps —
 * on: no receipts, anything that is not an array, a bad signature, a slot
 * outside `0 … attemptLength−1`, two receipts for one slot, a question that is
 * no longer part of the quiz (receipts kept from before a teacher replaced
 * questions), or a question id appearing more often than
 * `ceil(attemptLength / pool size)` times.
 */
export function countReceipts(
  receipts: unknown,
  scope: ReceiptScope,
  quiz: { attemptLength: number; questionIds: ReadonlySet<string> },
  secret: string,
): CountResult {
  const poolSize = quiz.questionIds.size;
  if (!Array.isArray(receipts) || receipts.length === 0) return { ok: false };
  if (receipts.length > quiz.attemptLength || poolSize < 1) return { ok: false };
  const maxRepeats = Math.ceil(quiz.attemptLength / poolSize);
  const slots = new Set<number>();
  const perQuestion = new Map<string, number>();
  const counts: HandInCounts = { correct: 0, partial: 0, incorrect: 0, unanswered: 0 };
  for (const receipt of receipts) {
    if (!verifyReceipt(receipt, scope, secret)) return { ok: false };
    if (receipt.slot >= quiz.attemptLength || slots.has(receipt.slot)) return { ok: false };
    if (!quiz.questionIds.has(receipt.questionId)) return { ok: false };
    slots.add(receipt.slot);
    const seen = (perQuestion.get(receipt.questionId) ?? 0) + 1;
    if (seen > maxRepeats) return { ok: false };
    perQuestion.set(receipt.questionId, seen);
    counts[receipt.verdict] += 1;
  }
  counts.unanswered = quiz.attemptLength - receipts.length;
  return { ok: true, counts };
}

/** The production receipt key, derived from AUTH_SECRET under its own label. */
export function getReceiptSecret(): string {
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) throw new Error("AUTH_SECRET is not set — required to sign quiz receipts");
  return createHmac("sha256", authSecret).update("novedu:moodle-receipt:v1").digest("hex");
}
