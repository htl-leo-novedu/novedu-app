import { z } from "zod";
import { MAX_CLOZE_GAPS } from "./cloze-types";
import { QUIZ_VERDICT_ENUM } from "./quiz-verdict-schema";

// The two STRUCTURED-OUTPUT schemas of the `clozeEvaluator` agent — one per call of the
// cloze pipeline (docs/cloze.md, "Grading"):
//
//   - the GRADING call: one verdict per undecided gap, with a one-sentence reason (the
//     reason feeds the eval report and is never shown to a student),
//   - the FEEDBACK call: up to three patterns that connect the student's mistakes, and a
//     note per non-correct gap. The server's grounding filter (lib/cloze-grounding.ts)
//     enforces the rules the schema cannot (≤ 3 patterns, ≥ 2 non-correct gaps each), so
//     an over-long answer is trimmed rather than failing the whole call.
//
// On their own, like `QUIZ_VERDICT_SCHEMA`, so both sides reach them: the actions pass
// them to `generate({ structuredOutput })`, and the prompt dump (`lib/prompt-dump.ts`,
// `@novedu/cli prompts --kind cloze`) emits them as plain JSON Schema.
//
// PURE / CLI-safe: zod only. Never move them under `app/mastra/` (its graph does a
// top-level-await network call at import time).

const GAP_NUMBER = z.number().int().min(1).max(MAX_CLOZE_GAPS);

export const CLOZE_GRADING_SCHEMA = z.object({
  gaps: z.array(
    z.object({
      gap: GAP_NUMBER,
      result: QUIZ_VERDICT_ENUM,
      reason: z.string(),
    }),
  ),
});

export type ClozeGradingOutput = z.infer<typeof CLOZE_GRADING_SCHEMA>;

export const CLOZE_FEEDBACK_SCHEMA = z.object({
  patterns: z.array(
    z.object({
      title: z.string(),
      explanation: z.string(),
      gaps: z.array(GAP_NUMBER),
      next_time: z.string(),
    }),
  ),
  gap_notes: z.array(
    z.object({
      gap: GAP_NUMBER,
      note: z.string(),
    }),
  ),
});

export type ClozeFeedbackOutput = z.infer<typeof CLOZE_FEEDBACK_SCHEMA>;

/**
 * True when a grading output names every undecided gap exactly once and no other — the
 * grading call's contract. `gradeCloze` and the eval runner both retry a mismatch once,
 * then fail.
 */
export function clozeGradingCovers(
  output: ClozeGradingOutput | undefined,
  undecided: readonly number[],
): boolean {
  if (!output) return false;
  const named = output.gaps.map((entry) => entry.gap);
  return (
    named.length === undecided.length &&
    new Set(named).size === named.length &&
    undecided.every((gap) => named.includes(gap))
  );
}

/** The free-text fields of a grading output — what the truncation retry inspects. */
export function clozeGradingTexts(output: ClozeGradingOutput): string[] {
  return output.gaps.map((entry) => entry.reason);
}

/** The free-text fields of a feedback output — what the truncation retry inspects. */
export function clozeFeedbackTexts(output: ClozeFeedbackOutput): string[] {
  return [
    ...output.patterns.flatMap((pattern) => [
      pattern.title,
      pattern.explanation,
      pattern.next_time,
    ]),
    ...output.gap_notes.map((note) => note.note),
  ];
}

/** `CLOZE_GRADING_SCHEMA` as plain JSON Schema — the grading call's response contract. */
export function clozeGradingResponseJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(CLOZE_GRADING_SCHEMA, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}

/** `CLOZE_FEEDBACK_SCHEMA` as plain JSON Schema — the feedback call's response contract. */
export function clozeFeedbackResponseJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(CLOZE_FEEDBACK_SCHEMA, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}
