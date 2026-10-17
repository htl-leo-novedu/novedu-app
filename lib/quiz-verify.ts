import { verifyStudentActivity } from "@/lib/activity-gate";
import { effectiveLlm } from "@/lib/code-store";
import type { LlmProvider, ReasoningLevel } from "@/lib/llm/provider";
import { loadQuiz } from "@/lib/quiz-fetch";
import type { Quiz, QuizQuestion } from "@/lib/quiz-yaml";

// The shared quiz-verification preamble — SERVER-ONLY, but deliberately WITHOUT a
// `"use server"` directive. It is imported by the `"use server"` file
// `lib/quiz-actions.ts` (grading, saving a result) AND by the report action; if this code
// lived in a `"use server"` module, exporting `verifyAndLoadQuestion` would mint a
// public server-action endpoint that returns the loaded `Quiz` — which carries the
// server-only `evaluation` grading prompts (they may embed the expected answer).
// Keeping the helper here, importable by server code only, keeps those prompts off
// the wire. (Touches the database and fetches arbitrary URLs — never client-safe.)

export interface QuizCodeInput {
  code: string;
}

export type LoadedQuestion = {
  ok: true;
  userId: string;
  code: string;
  fileUrl: string;
  quiz: Quiz;
  question: QuizQuestion;
  /**
   * The provider+model (+ optional reasoning effort) to grade with: the code's
   * LLM override or the quiz YAML's.
   */
  llm: { provider: LlmProvider; model: string; reasoning?: ReasoningLevel };
};

export type LoadedQuiz = Omit<LoadedQuestion, "question">;

// The quiz-level preamble: the shared student gate (session + valid, in-window quiz
// code, lib/activity-gate.ts) + the (server-authoritative) quiz re-loaded from the
// code's file. Returns a ready-to-show message on any failure. `saveQuizResult` uses
// it directly (it needs the attempt length, not a question).
export async function verifyAndLoadQuiz(
  input: QuizCodeInput,
): Promise<LoadedQuiz | { ok: false; message: string }> {
  const gate = await verifyStudentActivity(input.code, "quiz");
  if (!gate.ok) return gate;
  const { userId, entry } = gate;

  const loaded = await loadQuiz(entry.fileUrl);
  if (!loaded.ok) return { ok: false, message: loaded.message };

  return {
    ok: true,
    userId,
    code: input.code,
    fileUrl: entry.fileUrl,
    quiz: loaded.quiz,
    llm: effectiveLlm(entry, loaded.quiz),
  };
}

// The per-question preamble of the grading/discussion actions: the quiz-level
// checks above, plus the question by id.
export async function verifyAndLoadQuestion(
  input: QuizCodeInput & { questionId: string },
): Promise<LoadedQuestion | { ok: false; message: string }> {
  const ctx = await verifyAndLoadQuiz(input);
  if (!ctx.ok) return ctx;

  const question = ctx.quiz.questions.find((q) => q.id === input.questionId);
  if (!question) return { ok: false, message: "That question is no longer part of this quiz." };

  return { ...ctx, question };
}

/**
 * The attempt length the server derives from the re-loaded quiz: the authored
 * `question_count`, else every pool question once — the same rule the client's
 * sequence builder applies (`toPublicQuiz`).
 */
export function attemptLength(quiz: Quiz): number {
  return quiz.questionCount ?? quiz.questions.length;
}

// The question's EFFECTIVE photo-answers flag now lives in the pure `lib/quiz-yaml.ts`
// (next to `toPublicQuiz`, which resolves the same two-level flag) so the CLI's prompt
// dump can report it without importing this DB-backed module. Re-exported here so the
// server actions keep importing it from their verification preamble — and it is still
// re-derived server-side on every action; the client's resolved copy is never trusted.
export { effectiveImageInput } from "@/lib/quiz-yaml";
