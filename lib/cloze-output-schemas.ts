import { z } from "zod";
import { MAX_CLOZE_GAPS } from "./cloze-types";
import { QUIZ_VERDICT_ENUM } from "./quiz-verdict-schema";

// The two STRUCTURED-OUTPUT schemas of the `clozeEvaluator` agent — one per call of the
// cloze pipeline (docs/cloze.md, "Grading"):
//
//   - the GRADING call: one verdict per undecided gap, with a one-sentence reason (the
//     reason is never shown to a student),
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
