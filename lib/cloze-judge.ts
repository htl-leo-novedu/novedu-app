import type { ClozeGapNote, ClozePattern } from "./cloze-grounding";

// The CLOZE FEEDBACK JUDGE surface (docs/cli-eval.md, docs/cloze.md): the taxonomy, the
// system prompt and the subject builder an LLM judge uses to audit the consolidated
// feedback of ONE cloze submission — the patterns and gap notes that SURVIVED the
// grounding filter, i.e. exactly what the student would see.
//
// The sibling of lib/quiz-feedback-judge.ts and lib/tutor-judge.ts, on the same insight:
// the specification for good feedback already exists — it is the feedback call's own
// system prompt. The grounding filter can only check structure (a pattern cites ≥ 2
// non-correct gaps); whether an explanation is TRUE of the cited answers is what
// `unsupported_pattern` asks the judge.
//
// It reuses the kind-agnostic `POST /api/eval/judge` unchanged: the CLI sends this
// prompt, the assembled subject and the criteria, and `judgmentSchema`
// (lib/quiz-feedback-judge.ts) constrains the model to them. Report-only, no `ok` flag.
//
// PURE / CLI-safe: types only — no I/O, no `"use server"`, no `app/`, no DB, no
// `lib/llm/**` (`lib/prompt-dump.unit.test.ts` guards it).

/**
 * The cloze-feedback taxonomy. Every definition lives in {@link CLOZE_JUDGE_SYSTEM},
 * where the model reads it — never only here, so the two cannot drift apart.
 */
export const CLOZE_JUDGE_CRITERIA = [
  "unsupported_pattern",
  "contradicts_verdict",
  "misstates_facts",
  "ignores_instructions",
  "leaks_rubric",
] as const;

export type ClozeJudgeCriterion = (typeof CLOZE_JUDGE_CRITERIA)[number];

/**
 * The judge's system prompt. The same three guardrails as the quiz judge: do not
 * re-grade, do not invent issues ("when in doubt, the feedback is ok"), and an EMPTY
 * `issues` array is the only way to say "acceptable" — there is no `ok` boolean.
 */
export const CLOZE_JUDGE_SYSTEM = `You are auditing the FEEDBACK a student received after completing a gap-fill (cloze) exercise.

You receive:
- the complete system prompt the feedback writer was given (it contains shared
  course rules, the grading criteria, and the exercise text with the teacher's
  reference answer for every gap),
- every gap's student answer with its FINAL verdict (correct / partial /
  incorrect; an empty answer means the gap was left empty),
- the feedback the student saw: "patterns" (each naming the gaps it is about)
  and per-gap notes.

Judge ONLY the feedback, on these criteria:

- "unsupported_pattern": a pattern's explanation is not true of the answers in
  the gaps it cites — e.g. it says the student used a form they did not write,
  or groups answers whose mistakes do not share the cause it names.
- "contradicts_verdict": a pattern or note disagrees with a verdict — e.g. it
  treats an answer as wrong although its verdict is correct, or as right
  although its verdict is not correct.
- "misstates_facts": the feedback asserts something the grading criteria or
  the reference answers contradict — factual errors about the subject matter.
- "ignores_instructions": the feedback violates an explicit rule the system
  prompt states about feedback, e.g. it is not addressed to the student, is
  written in a language the prompt does not allow, or ignores a formatting rule.
- "leaks_rubric": the feedback quotes the grading criteria verbatim, refers to
  the instructions ("my instructions say...", "the rubric requires..."), or
  reveals verdict boundaries the student is not supposed to see.

Do NOT judge the verdicts themselves — a different auditor covers that. Judge
the feedback GIVEN the verdicts. Stating the correct answer for a gap is fine:
the student is shown the reference answers anyway. Be strict about real
violations, but do not invent issues: stylistic taste, brevity, or a missing
pattern are NOT issues. When in doubt, the feedback is ok.

Return one entry in "issues" per violation you found, and an EMPTY "issues"
array when the feedback is acceptable. Answer with the JSON object only.`;

/**
 * The judge's USER message: the feedback writer's system prompt first, then the answers
 * with their verdicts (the feedback call's own user message), then the GROUNDED feedback
 * under judgment, in labeled `===` blocks. Nothing is escaped — every part is data.
 */
export function buildClozeJudgeSubject(
  feedbackSystem: string,
  answersMessage: string,
  feedback: { patterns: readonly ClozePattern[]; gapNotes: readonly ClozeGapNote[] },
): string {
  const patterns = feedback.patterns.length
    ? feedback.patterns.flatMap((pattern, i) => [
        `Pattern ${i + 1} — gaps ${pattern.gaps.join(", ")}: ${pattern.title}`,
        pattern.explanation,
        `Next time: ${pattern.nextTime}`,
        "",
      ])
    : ["(no patterns)", ""];
  const notes = feedback.gapNotes.length
    ? feedback.gapNotes.map((note) => `Gap ${note.gap}: ${note.note}`)
    : ["(no gap notes)"];
  return [
    "=== The system prompt the feedback writer was given ===",
    feedbackSystem,
    "",
    "=== The student's answers and their final verdicts ===",
    answersMessage,
    "",
    "=== The feedback the student saw (JUDGE THIS) ===",
    "Patterns:",
    ...patterns,
    "Gap notes:",
    ...notes,
  ].join("\n");
}
