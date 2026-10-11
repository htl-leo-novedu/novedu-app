import { z } from "zod";
import { QUIZ_VERDICT_ENUM, QUIZ_VERDICT_VALUES } from "@/lib/quiz-verdict-schema";
import { TUTOR_TOOL_NAMES } from "@/lib/tutor-tools/names";

// The zod source of truth for the EVAL YAML format (`docs/cli-eval.md`). ONE file format,
// a DISCRIMINATED UNION on `kind`, with one arm per eval kind:
//
//   quiz  (`kind` omitted or `quiz`) — GOLDEN ANSWERS for one quiz: teacher-written
//         student answers, each with the verdict the grader is expected to produce.
//         `novedu-cli eval` replays them against the real grading path so a rubric
//         change can be measured instead of guessed.
//   tutor (`kind: tutor`) — CONVERSATIONS for one tutor: the teacher scripts the whole
//         exchange (student turns AND any prior tutor turns) ending with a student turn;
//         the model under test generates exactly ONE response and an LLM judge checks it
//         against the tutor's own system prompt plus the case's grading instructions.
//
// `kind` is OPTIONAL on the quiz arm on purpose: every eval file written before the tutor
// kind existed stays valid byte-for-byte.
//
// The verdict enum is DERIVED from the grader's own structured-output schema
// (`QUIZ_VERDICT_ENUM`, lib/quiz-verdict-schema.ts) — never a mirrored literal list, so
// the two can never drift apart.
//
// `lib/schema-gen` generates `activities/evals/eval-yaml.schema.json` from
// `EvalYamlSchema`, so every field carries its teacher prose inline as
// `.meta({ description })`.
//
// PURE / CLI-safe: zod only — no I/O, no `app/**`, no DB (see the purity guard in
// `lib/prompt-dump.unit.test.ts`).

/**
 * The eval KINDS — the `kind` discriminator's values, and (by construction) a subset of
 * `PromptKind`: every eval kind evaluates an activity whose prompts `dumpPrompts` can
 * produce. `cli/src/eval-run.ts` re-exports these and pins that relationship in the type
 * system, so a kind can never be added here without a runner.
 */
export const EVAL_KINDS = ["quiz", "tutor"] as const;

export type EvalKind = (typeof EVAL_KINDS)[number];

/** The verdict an eval case may expect — the grader's own three literals. */
export type EvalVerdict = z.infer<typeof QUIZ_VERDICT_ENUM>;

/** The three verdicts in canonical order (best → worst); the sort key for expected sets. */
export const EVAL_VERDICTS: readonly EvalVerdict[] = QUIZ_VERDICT_VALUES;

/**
 * Eval ids share the flat namespace of report headers and `--out` files, so they stay
 * URL- and YAML-plain: an alphanumeric start, then alphanumerics, `.`, `-` or `_`.
 */
export const EVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ID_LENGTH = 128;

const expectSchema = z.union([QUIZ_VERDICT_ENUM, z.array(QUIZ_VERDICT_ENUM).min(1)]).meta({
  description:
    'The verdict this answer must be graded with: one of "correct", "partial", "incorrect", or a non-empty list of acceptable verdicts (e.g. [correct, partial]) when more than one grading is defensible.',
});

/** One golden answer: the student text plus the verdict(s) the grader must produce. */
export const EvalAnswerSchema = z.strictObject({
  expect: expectSchema,
  answer: z.string().min(1).meta({
    description:
      "The student answer to grade, verbatim. Written as a YAML block scalar (|) for multi-line answers.",
  }),
});

/** All golden answers for ONE question of the target quiz. */
export const EvalQuestionSchema = z.strictObject({
  question: z.string().min(1).meta({
    description:
      'The question id in the target quiz. For a question imported through quiz_files this is the namespaced "<alias>/<id>" form.',
  }),
  answers: z.array(EvalAnswerSchema).min(1).meta({
    description: "The golden answers for this question — at least one.",
  }),
});

const idSchema = z.string().regex(EVAL_ID_PATTERN).max(MAX_ID_LENGTH).meta({
  description:
    "Stable identifier of this eval, shown in the run report. Letters, digits, dot, dash and underscore.",
});

/** The QUIZ arm: golden answers replayed through the real grader. */
export const QuizEvalYamlSchema = z.strictObject({
  kind: z.literal("quiz").optional().meta({
    description:
      'The eval kind. Omit it (or write "quiz") for a golden-answer eval of a quiz rubric.',
  }),
  id: idSchema,
  target: z.string().min(1).meta({
    description:
      "The quiz YAML this eval grades against — a path relative to THIS file, or an absolute http(s) URL.",
  }),
  questions: z.array(EvalQuestionSchema).min(1).meta({
    description: "The evaluated questions — at least one, each with its golden answers.",
  }),
});

/**
 * ONE turn of a scripted conversation: a single-key map naming its speaker. The two
 * TEACHER-facing role names (`student` / `tutor`) are deliberate — the wire roles
 * (`user` / `assistant`) are an implementation detail nobody should have to author.
 */
export const EvalConversationTurnSchema = z.union([
  z.strictObject({
    student: z.string().min(1).meta({ description: "What the student says in this turn." }),
  }),
  z.strictObject({
    tutor: z.string().min(1).meta({
      description:
        "What the tutor already said in this turn — scripted by the teacher, not generated.",
    }),
  }),
]);

/** The last turn a conversation may end on: the student message the model must answer. */
function endsWithStudentTurn(turns: readonly EvalConversationTurn[]): boolean {
  const last = turns.at(-1);
  return last !== undefined && "student" in last;
}

/**
 * The tool names a case may REQUIRE, derived from the catalog's own name list
 * (`lib/tutor-tools/names.ts`) rather than a mirrored literal set — so a tool added to the
 * catalog is immediately requirable and a typo fails `validate` offline with a named enum
 * error, no run and no tokens spent.
 *
 * Non-empty and UNIQUE: an empty list would say nothing (write no `required_tools` at
 * all), and a repeated name is always an authoring slip — the check is "called at least
 * once", so naming a tool twice cannot mean anything a single mention does not.
 */
const requiredToolsSchema = z
  .array(z.enum(TUTOR_TOOL_NAMES))
  .min(1)
  .refine((tools) => new Set(tools).size === tools.length, {
    message: "Each tool may be listed only once.",
  })
  .meta({
    description:
      "Optional list of built-in tool names the tutor must call AT LEAST ONCE while answering this case (e.g. [random_number]). Reported only — a missing tool call never fails the run. Tools beyond this list are always fine, and every name must be one the target tutor's own `tools:` grant contains.",
  });

/** ONE tutor case: a scripted conversation plus the teacher's optional expectations. */
export const EvalConversationSchema = z.strictObject({
  title: z.string().min(1).max(MAX_ID_LENGTH).optional().meta({
    description:
      "Optional short label for this case, used as its stable heading in the run report.",
  }),
  required_tools: requiredToolsSchema.optional(),
  grading_instructions: z.string().min(1).optional().meta({
    description:
      'Optional extra expectations for THIS case, judged alongside the tutor\'s own system prompt (e.g. "the response must not contain a complete working loop").',
  }),
  conversation: z
    .array(EvalConversationTurnSchema)
    .min(1)
    .refine(endsWithStudentTurn, {
      // The model under test answers the LAST turn, so a conversation ending on a tutor
      // turn has nothing to generate.
      message: "The conversation must end with a `student` turn.",
    })
    .meta({
      description:
        "The scripted exchange, in order: `student:` and `tutor:` turns. It must END with a `student:` turn — that is the message the model under test answers.",
    }),
});

/** The TUTOR arm: conversations whose next tutor turn is generated and judged. */
export const TutorEvalYamlSchema = z.strictObject({
  kind: z.literal("tutor").meta({
    description: 'The eval kind. "tutor" evaluates a tutor\'s next response in a conversation.',
  }),
  id: idSchema,
  target: z.string().min(1).meta({
    description:
      "The tutor YAML this eval runs against — a path relative to THIS file, or an absolute http(s) URL.",
  }),
  conversations: z.array(EvalConversationSchema).min(1).meta({
    description: "The evaluated conversations — at least one; each one is a case.",
  }),
});

/**
 * The whole eval file: quiz (the default, `kind` omissible) or tutor.
 *
 * A discriminated union rather than a loose one, so a `kind: tutor` file with a typo in
 * `conversations` reports THAT problem instead of "no union member matched".
 */
export const EvalYamlSchema = z.discriminatedUnion("kind", [
  QuizEvalYamlSchema,
  TutorEvalYamlSchema,
]);

export type EvalYaml = z.infer<typeof EvalYamlSchema>;
export type QuizEvalYaml = z.infer<typeof QuizEvalYamlSchema>;
export type TutorEvalYaml = z.infer<typeof TutorEvalYamlSchema>;
export type EvalQuestion = z.infer<typeof EvalQuestionSchema>;
export type EvalAnswer = z.infer<typeof EvalAnswerSchema>;
export type EvalConversation = z.infer<typeof EvalConversationSchema>;
export type EvalConversationTurn = z.infer<typeof EvalConversationTurnSchema>;

/** The eval file's kind, with the quiz arm's omitted `kind` resolved to its default. */
export function evalKindOf(evalFile: EvalYaml): EvalKind {
  return evalFile.kind ?? "quiz";
}

/** A scripted turn as `{ role, text }` — the wire shape `POST /api/eval/respond` takes. */
export function turnToMessage(turn: EvalConversationTurn): {
  role: "user" | "assistant";
  text: string;
} {
  return "student" in turn
    ? { role: "user", text: turn.student }
    : { role: "assistant", text: turn.tutor };
}

/**
 * The canonical expected-verdict SET of one golden answer: a single verdict or a list,
 * deduped and sorted into `EVAL_VERDICTS` order. Canonical because the confusion
 * matrix keys its rows by this set — `correct|partial` must be one row no matter which
 * order the author happened to write it in.
 */
export function normalizeExpect(expect: EvalAnswer["expect"]): EvalVerdict[] {
  const values = Array.isArray(expect) ? expect : [expect];
  const unique = [...new Set(values)];
  return unique.sort((a, b) => EVAL_VERDICTS.indexOf(a) - EVAL_VERDICTS.indexOf(b));
}

/** The confusion matrix's row key for an expected set (already canonical). */
export function expectedKey(expected: readonly EvalVerdict[]): string {
  return expected.join("|");
}
