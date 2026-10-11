import type { ClozeGap } from "./cloze-gaps";
import type { QuizVerdict } from "./quiz-types";

// The deterministic PRE-PASS of cloze grading (docs/cloze.md, "Grading"): every gap it
// can decide without judgement never reaches the model, so an exact answer is always
// correct and an empty one always "not answered", whatever a model would have said.
//
//   reference   answer                            verdict
//   ""          empty                             correct    (nothing belongs here)
//   non-empty   empty                             incorrect  (shown as "not answered")
//   any         equal after normalization         correct
//   otherwise                                     → the model
//
// `[[]]` with a NON-empty answer goes to the model: under the exercise's `evaluation` it
// may be a defensible variant. Normalization trims, collapses internal whitespace and
// unifies typographic apostrophes/quotes; it is deliberately CASE-SENSITIVE (a capital
// letter may be the point of the gap).
//
// PURE: no I/O, no `app/**`, no DB.

export interface ClozePrepassEntry {
  /** The gap number (1-based, reading order). */
  gap: number;
  /** The decided verdict, or `null` when the model must decide. */
  verdict: QuizVerdict | null;
}

// Typographic apostrophes and primes → `'`; typographic double quotes → `"`.
const APOSTROPHES = /[‘’‚‛ʼ′]/g;
const QUOTES = /[“”„‟″«»]/g;

/** The pre-pass's comparison form of an answer or reference. */
export function normalizeClozeAnswer(value: string): string {
  return value
    .normalize("NFC")
    .replace(APOSTROPHES, "'")
    .replace(QUOTES, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Decides what the pre-pass can decide. `answers` is index-aligned with `gaps`
 * (gap N's answer is `answers[N - 1]`); the result is index-aligned too.
 */
export function runClozePrepass(
  gaps: readonly Pick<ClozeGap, "number" | "reference">[],
  answers: readonly string[],
): ClozePrepassEntry[] {
  return gaps.map((gap, i) => {
    const answer = normalizeClozeAnswer(answers[i] ?? "");
    const reference = normalizeClozeAnswer(gap.reference);
    if (answer === "") {
      return { gap: gap.number, verdict: reference === "" ? "correct" : "incorrect" };
    }
    return { gap: gap.number, verdict: answer === reference ? "correct" : null };
  });
}

/** The gap numbers the pre-pass left to the model, in reading order. */
export function undecidedGaps(prepass: readonly ClozePrepassEntry[]): number[] {
  return prepass.filter((entry) => entry.verdict === null).map((entry) => entry.gap);
}
