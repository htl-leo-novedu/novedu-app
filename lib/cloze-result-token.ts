import { createHmac, timingSafeEqual } from "node:crypto";
import type { QuizVerdict } from "@/lib/quiz-types";

// Cloze RESULT tokens: `gradeCloze` signs the verdicts it just produced, and
// `explainCloze` runs the feedback call only for a token that matches the answers and
// verdicts it is handed (docs/cloze.md). That keeps the feedback writer working from
// verdicts the SERVER produced — a student cannot get feedback on invented verdicts —
// and keeps `explainCloze` from being a general-purpose LLM endpoint: every call needs a
// prior, successful grading of exactly these answers by the same session user under
// the same code.
//
// The thread-token family (lib/thread-token.ts): a stateless HMAC-SHA256, nothing
// persisted, and its own purpose-bound key derived from AUTH_SECRET — a thread token can
// never pass as a result token or vice versa.
//
// Pure sign/verify (the secret is always passed in, so they are unit-testable with the
// real HMAC); `getClozeResultSecret()` is the production secret.
//
// SERVER-ONLY: uses node:crypto and handles the signing secret. Never import from
// client components.

export interface ClozeResultPayload {
  /** The cloze code the exercise was opened under. */
  code: string;
  /** Session user id (`novedu_user.id`) of the student. */
  userId: string;
  /** The browser-minted attempt id (a uuid). */
  attemptId: string;
  /** The answers as graded, index-aligned with the gaps. */
  answers: readonly string[];
  /** The final verdicts the server produced, index-aligned with the gaps. */
  verdicts: readonly QuizVerdict[];
}

// JSON-encoding the tuple as an array is injective for arbitrary strings — no separator
// can collide with content (answers are free text).
export function canonicalClozeResultPayload(payload: ClozeResultPayload): string {
  return JSON.stringify([
    payload.code,
    payload.userId,
    payload.attemptId,
    payload.answers,
    payload.verdicts,
  ]);
}

export function signClozeResultToken(payload: ClozeResultPayload, secret: string): string {
  return createHmac("sha256", secret).update(canonicalClozeResultPayload(payload)).digest("hex");
}

/**
 * Verifies a client-sent token against the payload the SERVER believes in — the user id
 * always comes from the current session and the code from the verified request.
 */
export function verifyClozeResultToken(
  token: unknown,
  payload: ClozeResultPayload,
  secret: string,
): boolean {
  if (typeof token !== "string" || !/^[0-9a-f]+$/i.test(token)) return false;
  // Reject non-hex up front: Buffer.from(.., "hex") silently stops at the first invalid
  // character, which would otherwise accept e.g. `<sig>zz`.
  const a = Buffer.from(token, "hex");
  const b = Buffer.from(signClozeResultToken(payload, secret), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

let cachedSecret: string | undefined;

/** The result-token key: HMAC of AUTH_SECRET over its own purpose string. */
export function getClozeResultSecret(): string {
  if (cachedSecret !== undefined) return cachedSecret;
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) {
    throw new Error("AUTH_SECRET is not set — required to sign cloze result tokens");
  }
  cachedSecret = createHmac("sha256", authSecret).update("novedu:cloze-result:v1").digest("hex");
  return cachedSecret;
}

/** Clears the memoized secret — for unit tests only. */
export function resetClozeResultSecretForTests(): void {
  cachedSecret = undefined;
}
