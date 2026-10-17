"use server";

import { randomUUID } from "node:crypto";
import { RequestContext } from "@mastra/core/request-context";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { mastra } from "@/app/mastra";
import { QUIZ_VERDICT_SCHEMA } from "@/app/mastra/quiz-agents";
import { validateAnswerImages } from "@/lib/answer-images";
import { invalidateHome } from "@/lib/home-data";
import { QUIZ_EVAL_CONTEXT, setLlmContext } from "@/lib/llm-context";
import { buildQuestionSeed, buildVerdictSeed } from "@/lib/quiz-discussion-prompt";
import { buildAnswerMessage, buildGradingPrompt } from "@/lib/quiz-grading-prompt";
import { type SaveMode, saveQuizResult as storeQuizResult } from "@/lib/quiz-result-store";
import { gradeWithTruncationRetry } from "@/lib/quiz-truncation-retry";
import type { QuizVerdict } from "@/lib/quiz-types";
import {
  attemptLength,
  effectiveImageInput,
  type QuizCodeInput,
  verifyAndLoadQuestion,
  verifyAndLoadQuiz,
} from "@/lib/quiz-verify";
import { newThread } from "@/lib/thread-token";
import { setUsageContext } from "@/lib/usage-context-keys";
import { recordQuizAnswer } from "@/lib/usage-store";

// The student-facing quiz server actions. The whole app sits behind the Entra
// gate, so any caller is authenticated; the quiz CODE (a `novedu_codes` row with
// `module: "quiz"`) is what authorizes the quiz experience, and it is RE-VERIFIED
// on every action (so a code outside its window stops accepting answers / opening
// discussions mid-session). The server-only `evaluation` grading prompts are read
// here and NEVER returned to the client.
//
// Grading goes through the memory-less `quizEvaluator` agent; the discussion is a
// Mastra thread seeded with three messages that the runtime route then continues
// with the `quizDiscussion` agent. resourceId = the CODE throughout (see
// docs/codes.md), exactly like every other module.

// The verification preamble (`verifyAndLoadQuestion`, `QuizCodeInput`,
// `effectiveImageInput`, and the rejection-message map) lives in the non-`"use
// server"` `lib/quiz-verify.ts` — exporting it from THIS file would mint a public
// endpoint returning the loaded quiz's server-only `evaluation` prompts. Do NOT
// re-export even the types from here: Next's `"use server"` transform emits a
// runtime reference for a type-only re-export, which crashes the module at load
// (import `QuizCodeInput` from `@/lib/quiz-verify` instead).

export type SubmitAnswerResult =
  | { ok: true; result: QuizVerdict; feedback: string }
  | { ok: false; message: string };

/** `saved: false` = an automatic save found the setting off; the Finish page asks instead. */
export type SaveQuizResultResult = { ok: true; saved: boolean } | { ok: false; message: string };

export type StartDiscussionResult =
  | { ok: true; threadId: string; threadToken: string }
  | { ok: false; message: string };

// The three messages that seed a discussion thread's MEMORY (question / answer /
// verdict+feedback) so the agent recalls full context. Server-internal only —
// the dialog shows just the graded feedback, never these as bubbles, so they are
// no longer handed back to the client. The student-answer seed may carry the
// answer's photos as `file` parts (data URLs), so the discussion agent sees them
// via memory recall and the read-only transcript viewer renders them inline.
interface QuizSeedMessage {
  role: "assistant" | "user";
  text: string;
  images?: string[];
}

// The GRADING prompt (`buildGradingPrompt` + the answer-message wrappers) and the
// DISCUSSION prompt/seed templates live in the pure, CLI-safe `lib/quiz-grading-prompt.ts`
// and `lib/quiz-discussion-prompt.ts`. They are imported — never copied — so
// `@novedu/cli prompts --kind quiz` dumps byte-identical production prompts.

/**
 * Grades one answer — free text, photos (when the question's effective
 * `imageInput` allows them), or both. Re-verifies the quiz code, re-loads the
 * quiz, finds the question, and runs the stateless `quizEvaluator` for a
 * structured verdict. Returns the verdict + markdown feedback; nothing is
 * persisted — the images are discarded after grading.
 */
export async function submitAnswer(
  input: QuizCodeInput & { questionId: string; answer: string; images?: string[] },
): Promise<SubmitAnswerResult> {
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  if (!answer && (input.images === undefined || input.images.length === 0)) {
    return { ok: false, message: "Type an answer or add a photo before submitting." };
  }

  const ctx = await verifyAndLoadQuestion(input);
  if (!ctx.ok) return ctx;

  const checked = validateAnswerImages(input.images, effectiveImageInput(ctx.quiz, ctx.question));
  if (!checked.ok) return checked;
  const images = checked.images;

  // The effective llm: the quiz YAML's, or the code's override.
  const requestContext = new RequestContext();
  setLlmContext(
    requestContext,
    QUIZ_EVAL_CONTEXT,
    buildGradingPrompt(ctx.question, ctx.quiz.instructionsPreamble),
    ctx.llm,
  );
  // Attribute the server-only grader's token usage exactly like a runtime-route
  // agent — the observability exporter reads these off its MODEL_GENERATION span.
  setUsageContext(requestContext, { code: ctx.code, userId: ctx.userId, module: "quiz" });

  // Text-only answers keep the plain-string call; an answer with photos becomes
  // ONE multimodal user message (text part + one image part per photo — the
  // data URL carries its own mime type). Only the message shape changes; the
  // structured-output verdict flow is identical.
  const answerText = buildAnswerMessage(answer);
  const prompt =
    images.length === 0
      ? answerText
      : [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: answerText },
              ...images.map((image) => ({ type: "image" as const, image })),
            ],
          },
        ];

  try {
    const { object } = await gradeWithTruncationRetry(
      () =>
        mastra.getAgent("quizEvaluator").generate(prompt, {
          structuredOutput: { schema: QUIZ_VERDICT_SCHEMA },
          requestContext,
        }),
      (res) => res.object as { result: QuizVerdict; feedback: string } | undefined,
      { code: ctx.code },
    );
    if (!object) {
      return { ok: false, message: "The answer could not be graded right now. Please try again." };
    }
    // Count the answered question off the response path (the store never throws).
    after(() => recordQuizAnswer({ code: ctx.code, userId: ctx.userId }));
    return { ok: true, result: object.result, feedback: object.feedback };
  } catch (error) {
    console.error("quiz-actions: grading failed", error);
    return { ok: false, message: "The answer could not be graded right now. Please try again." };
  }
}

function safeVerdict(value: unknown): QuizVerdict {
  return value === "correct" || value === "partial" || value === "incorrect" ? value : "partial";
}

/**
 * Opens an opt-in discussion about a graded question. Mints a thread id, signs a
 * thread-ownership token, and seeds a Mastra thread with three messages
 * (question / answer / verdict+feedback) so the discussion agent has full context
 * via memory recall. Returns the thread id + token for the inline chat to mount.
 * resourceId = the quiz CODE (groups a quiz's discussions for stats), and the
 * token binds `(code, userId, threadId)` like every other module.
 */
export async function startDiscussion(
  input: QuizCodeInput & {
    questionId: string;
    answer: string;
    result: QuizVerdict;
    feedback: string;
    images?: string[];
  },
): Promise<StartDiscussionResult> {
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  const feedback = typeof input.feedback === "string" ? input.feedback : "";
  if (!answer && (input.images === undefined || input.images.length === 0)) {
    return { ok: false, message: "There is no answer to discuss yet." };
  }

  const ctx = await verifyAndLoadQuestion(input);
  if (!ctx.ok) return ctx;

  // The same photos the answer was graded with (the trust note below applies);
  // the imageInput gate + size checks still run — a question that does not
  // accept images never gets one persisted into a thread.
  const checked = validateAnswerImages(input.images, effectiveImageInput(ctx.quiz, ctx.question));
  if (!checked.ok) return checked;
  const images = checked.images;

  const resourceId = ctx.code;
  const { threadId, threadToken } = newThread(resourceId, ctx.userId);

  // The three seed messages. The question text is the SERVER's (authoritative);
  // the answer/verdict/feedback are the student's own graded turn — faking them
  // would only mislead the student's own chat, so they are accepted as-is.
  const seeds: QuizSeedMessage[] = [
    { role: "assistant", text: buildQuestionSeed(ctx.question.question.trim()) },
    { role: "user", text: answer, images },
    { role: "assistant", text: buildVerdictSeed(safeVerdict(input.result), feedback) },
  ];

  try {
    const memory = await mastra.getAgent("quizDiscussion").getMemory();
    if (!memory) {
      return { ok: false, message: "The discussion could not be started right now." };
    }
    await memory.createThread({ threadId, resourceId });
    // Distinct, increasing createdAt so the transcript orders by time, with the
    // id as tiebreaker. The stored content envelope is the v2 UIMessage
    // shape the read-only viewer parses (`lib/conversation-collapse.ts`): text
    // parts plus — for the student-answer seed — one `file` part per photo whose
    // `data` is the data URL, exactly what the tutor's attachments persist.
    const base = Date.now();
    await memory.saveMessages({
      messages: seeds.map((seed, i) => ({
        id: randomUUID(),
        role: seed.role,
        type: "text",
        threadId,
        resourceId,
        createdAt: new Date(base + i),
        content: {
          format: 2 as const,
          parts: [
            ...(seed.text ? [{ type: "text" as const, text: seed.text }] : []),
            ...(seed.images ?? []).map((image) => ({
              type: "file" as const,
              mimeType: image.slice("data:".length, image.indexOf(";")),
              data: image,
            })),
          ],
          content: seed.text,
        },
      })),
    });
    return { ok: true, threadId, threadToken };
  } catch (error) {
    console.error("quiz-actions: starting discussion failed", error);
    return {
      ok: false,
      message: "The discussion could not be started right now. Please try again.",
    };
  }
}

// Saving a finished attempt to the student's own statistics (docs/home.md →
// Saving a quiz result). Only on the student's explicit choice on the Finish
// page ("This time" / "Always") or — with the setting on — automatically. The
// row is the THIRD sanctioned user↔code link (docs/codes.md); only the student
// ever sees it. The counts come from the browser, so a student can forge their
// OWN result — accepted: nobody else sees it and the XP it can reach is
// bounded. Nothing about the quiz is returned.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT4_MAX = 2_147_483_647;
const SAVE_MODES: readonly SaveMode[] = ["this-time", "always", "automatic"];
const SAVE_FAILED = "Your result could not be saved right now. Please try again.";
const SAVE_REJECTED = "This result cannot be saved.";
const CODE_GONE = "This quiz no longer exists, so the result cannot be saved.";

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= INT4_MAX
  );
}

/**
 * Saves the session user's finished attempt. Runs the same verification as
 * `submitAnswer` on every call (session, the stored code row, module = quiz, the
 * quiz re-loaded) and REJECTS — never clamps — a malformed attempt id, a count
 * that is not a non-negative int4, counts that don't sum to `total`, an attempt
 * with nothing answered, and a `total` above the attempt length the server
 * derives from the re-loaded quiz.
 */
export async function saveQuizResult(
  input: QuizCodeInput & {
    attemptId: string;
    counts: { correct: number; partial: number; incorrect: number; unanswered: number };
    total: number;
    mode: SaveMode;
  },
): Promise<SaveQuizResultResult> {
  // Cheap checks before any I/O.
  const counts = input?.counts;
  if (
    typeof input?.attemptId !== "string" ||
    !UUID.test(input.attemptId) ||
    !SAVE_MODES.includes(input.mode) ||
    typeof counts !== "object" ||
    counts === null ||
    ![counts.correct, counts.partial, counts.incorrect, counts.unanswered, input.total].every(
      isCount,
    )
  ) {
    return { ok: false, message: SAVE_REJECTED };
  }
  const { correct, partial, incorrect, unanswered } = counts;
  if (correct + partial + incorrect + unanswered !== input.total) {
    return { ok: false, message: SAVE_REJECTED };
  }
  if (correct + partial + incorrect === 0) {
    return { ok: false, message: "Answer at least one question to save a result." };
  }

  const ctx = await verifyAndLoadQuiz(input);
  if (!ctx.ok) return ctx;
  if (input.total > attemptLength(ctx.quiz)) {
    return {
      ok: false,
      message:
        "This quiz changed while you were taking it, so this result cannot be saved. You can take it again.",
    };
  }

  const outcome = await storeQuizResult(
    ctx.userId,
    {
      id: input.attemptId.toLowerCase(),
      code: ctx.code,
      correct,
      partial,
      incorrect,
      unanswered,
      total: input.total,
    },
    input.mode,
  );
  if (outcome === undefined) return { ok: false, message: SAVE_FAILED };
  if (outcome === "code-gone") return { ok: false, message: CODE_GONE };
  if (outcome === "not-saved") return { ok: true, saved: false };
  // The server's per-user cache AND the browser's router cache: a start page
  // visited earlier must not come back from Back/Forward without the result.
  invalidateHome(ctx.userId);
  revalidatePath("/");
  return { ok: true, saved: true };
}
