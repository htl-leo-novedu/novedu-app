import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";

// The grading action's LLM selection and the photo-answer handling:
// `submitAnswer` re-verifies the code, re-loads the quiz, validates the images
// against the question's EFFECTIVE imageInput flag (both stay real), and runs
// the server-only `quizEvaluator` with the EFFECTIVE provider/model — the code's
// LLM override pair when set, the quiz YAML's llm values otherwise
// (`effectiveLlm` stays real). `startDiscussion` seeds the graded turn — photos
// as stored `file` parts — into a Mastra thread. The I/O seams are mocked: the
// session, the code gate, the quiz load, the Mastra agent + memory, the usage
// counter and the telemetry helpers.

const getSession = vi.hoisted(() => vi.fn());
const checkCode = vi.hoisted(() => vi.fn());
const loadQuiz = vi.hoisted(() => vi.fn());
const generate = vi.hoisted(() => vi.fn());
const createThread = vi.hoisted(() => vi.fn());
const saveMessages = vi.hoisted(() => vi.fn());
const emitEvent = vi.hoisted(() => vi.fn());
// The result-save seams: the store and the start page's cache invalidation.
const storeQuizResult = vi.hoisted(() => vi.fn());
const invalidateHome = vi.hoisted(() => vi.fn());
const recordQuizAnswer = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session", () => ({ getSession }));
vi.mock("@/lib/code-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-store")>()),
  checkCode,
}));
vi.mock("@/lib/quiz-fetch", () => ({ loadQuiz }));
vi.mock("@/app/mastra", () => ({
  mastra: {
    getAgent: () => ({ generate, getMemory: async () => ({ createThread, saveMessages }) }),
  },
}));
vi.mock("@/lib/usage-store", () => ({ recordQuizAnswer }));
vi.mock("@/lib/quiz-result-store", () => ({ saveQuizResult: storeQuizResult }));
vi.mock("@/lib/home-data", () => ({ invalidateHome }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));
// Reached by lib/quiz-truncation-retry.ts.
vi.mock("@/lib/telemetry", () => ({ emitEvent }));
vi.mock("next/server", () => ({ after: (callback: () => unknown) => callback() }));

import {
  QUIZ_EVAL_INSTRUCTIONS,
  QUIZ_EVAL_MODEL,
  QUIZ_EVAL_PROVIDER,
} from "@/app/mastra/quiz-agents";
import { saveQuizResult, startDiscussion, submitAnswer } from "@/lib/quiz-actions";
import { getThreadTokenSecret, verifyThreadToken } from "@/lib/thread-token";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";

const entry = {
  code: "a1b2c3d4e5",
  module: "quiz",
  fileUrl: "https://example.com/api/files/q",
  llm: null,
};

const quiz = {
  model: "yaml-model",
  provider: "SCCH",
  imageInput: false,
  questions: [{ id: "q1", question: "What is 2+2?", evaluation: "4 is correct." }],
};

/** A well-formed image data URL whose decoded payload is `bytes` long. */
function dataUrlOfBytes(bytes: number): string {
  return `data:image/png;base64,${Buffer.alloc(bytes).toString("base64")}`;
}

const PHOTO = dataUrlOfBytes(16);

/** The mocked quiz with photo answers enabled at the given levels. */
function quizWithImageInput(quizLevel: boolean, questionLevel?: boolean) {
  return {
    ...quiz,
    imageInput: quizLevel,
    questions: [
      {
        ...quiz.questions[0],
        ...(questionLevel === undefined ? {} : { imageInput: questionLevel }),
      },
    ],
  };
}

// The evaluator's requestContext, captured from the generate() call.
function gradedContext(): { get(k: string): unknown } {
  const options = generate.mock.calls[0]?.[1] as { requestContext: { get(k: string): unknown } };
  return options.requestContext;
}

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: "student-1" } });
  checkCode.mockResolvedValue({ ok: true, entry });
  loadQuiz.mockResolvedValue({ ok: true, quiz });
  generate.mockResolvedValue({ object: { result: "correct", feedback: "Well done." } });
  storeQuizResult.mockResolvedValue("saved");
});

describe("submitAnswer LLM selection", () => {
  it("grades with the quiz YAML's provider/model when the code has no override", async () => {
    const result = await submitAnswer({ code: entry.code, questionId: "q1", answer: "4" });
    expect(result).toEqual({ ok: true, result: "correct", feedback: "Well done." });
    expect(gradedContext().get(QUIZ_EVAL_MODEL)).toBe("yaml-model");
    expect(gradedContext().get(QUIZ_EVAL_PROVIDER)).toBe("SCCH");
    expect(storeQuizResult).not.toHaveBeenCalled();
  });

  it("grades with the code's LLM override pair when set", async () => {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { ...entry, llm: { provider: "Azure Foundry", model: "gpt-5.4-mini" } },
    });
    const result = await submitAnswer({ code: entry.code, questionId: "q1", answer: "4" });
    expect(result).toMatchObject({ ok: true });
    expect(gradedContext().get(QUIZ_EVAL_MODEL)).toBe("gpt-5.4-mini");
    expect(gradedContext().get(QUIZ_EVAL_PROVIDER)).toBe("Azure Foundry");
  });
});

describe("submitAnswer usage metering", () => {
  it("attributes the grader's usage to the code, the session user and the quiz module", async () => {
    await submitAnswer({ code: entry.code, questionId: "q1", answer: "4" });
    expect(gradedContext().get(USAGE_CODE)).toBe(entry.code);
    expect(gradedContext().get(USAGE_USER_ID)).toBe("student-1");
    expect(gradedContext().get(USAGE_MODULE)).toBe("quiz");
  });

  it("counts a graded answer once for the code and the session user", async () => {
    await submitAnswer({ code: entry.code, questionId: "q1", answer: "4" });
    expect(recordQuizAnswer).toHaveBeenCalledTimes(1);
    expect(recordQuizAnswer).toHaveBeenCalledWith({ code: entry.code, userId: "student-1" });
  });

  it("counts no answer when grading fails", async () => {
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    generate.mockRejectedValueOnce(new Error("provider down"));
    const result = await submitAnswer({ code: entry.code, questionId: "q1", answer: "4" });
    expect(result).toMatchObject({ ok: false });
    expect(recordQuizAnswer).not.toHaveBeenCalled();
  });
});

describe("submitAnswer grading-prompt composition", () => {
  const instructions = () => gradedContext().get(QUIZ_EVAL_INSTRUCTIONS) as string;

  it("orders compound preamble → source preamble → grading frame → evaluation", async () => {
    loadQuiz.mockResolvedValue({
      ok: true,
      quiz: {
        ...quiz,
        instructionsPreamble: "COMPOUND-PREAMBLE shared rules.",
        questions: [
          {
            id: "intro/q1",
            question: "What is 2+2?",
            evaluation: "EVAL-CRITERIA 4 is correct.",
            sourcePreamble: "SOURCE-PREAMBLE chapter rules.",
          },
        ],
      },
    });
    const result = await submitAnswer({ code: entry.code, questionId: "intro/q1", answer: "4" });
    expect(result).toMatchObject({ ok: true });
    const prompt = instructions();
    const compoundAt = prompt.indexOf("COMPOUND-PREAMBLE");
    const sourceAt = prompt.indexOf("SOURCE-PREAMBLE");
    const frameAt = prompt.indexOf("You are grading a student's open-ended answer");
    const evalAt = prompt.indexOf("EVAL-CRITERIA");
    expect(compoundAt).toBeGreaterThanOrEqual(0);
    expect(compoundAt).toBeLessThan(sourceAt);
    expect(sourceAt).toBeLessThan(frameAt);
    expect(frameAt).toBeLessThan(evalAt);
  });

  it("drops each preamble that is empty (a plain quiz grades exactly as before)", async () => {
    loadQuiz.mockResolvedValue({ ok: true, quiz: { ...quiz, instructionsPreamble: "" } });
    const result = await submitAnswer({ code: entry.code, questionId: "q1", answer: "4" });
    expect(result).toMatchObject({ ok: true });
    expect(instructions().startsWith("You are grading a student's open-ended answer")).toBe(true);
  });

  it("keeps the source preamble without a compound one (chapter question in a bare compound)", async () => {
    loadQuiz.mockResolvedValue({
      ok: true,
      quiz: {
        ...quiz,
        instructionsPreamble: "",
        questions: [
          {
            id: "intro/q1",
            question: "What is 2+2?",
            evaluation: "4 is correct.",
            sourcePreamble: "SOURCE-PREAMBLE chapter rules.",
          },
        ],
      },
    });
    await submitAnswer({ code: entry.code, questionId: "intro/q1", answer: "4" });
    expect(instructions().startsWith("SOURCE-PREAMBLE chapter rules.")).toBe(true);
  });
});

describe("action failure paths (grader/agent never invoked)", () => {
  it("submitAnswer rejects when the code expires mid-quiz, without grading", async () => {
    checkCode.mockResolvedValue({ ok: false, reason: "expired" });
    const result = await submitAnswer({ code: entry.code, questionId: "q1", answer: "4" });
    expect(result).toEqual({
      ok: false,
      message: "This quiz's availability window has ended.",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("submitAnswer rejects an unknown question id (stale client), without grading", async () => {
    const result = await submitAnswer({ code: entry.code, questionId: "gone", answer: "4" });
    expect(result).toEqual({
      ok: false,
      message: "That question is no longer part of this quiz.",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("startDiscussion rejects a failing code / unknown question, without touching memory", async () => {
    checkCode.mockResolvedValue({ ok: false, reason: "expired" });
    const expired = await startDiscussion({
      code: entry.code,
      questionId: "q1",
      answer: "4",
      result: "correct",
      feedback: "Well done.",
    });
    expect(expired).toEqual({
      ok: false,
      message: "This quiz's availability window has ended.",
    });

    checkCode.mockResolvedValue({ ok: true, entry });
    const unknown = await startDiscussion({
      code: entry.code,
      questionId: "gone",
      answer: "4",
      result: "correct",
      feedback: "Well done.",
    });
    expect(unknown).toEqual({
      ok: false,
      message: "That question is no longer part of this quiz.",
    });
    expect(createThread).not.toHaveBeenCalled();
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it("startDiscussion signs the thread token for exactly this code, session user and thread", async () => {
    const result = await startDiscussion({
      code: entry.code,
      questionId: "q1",
      answer: "4",
      result: "correct",
      feedback: "Well done.",
    });
    assert(result.ok);
    expect(createThread).toHaveBeenCalledWith({
      threadId: result.threadId,
      resourceId: entry.code,
    });
    // The REAL check the CopilotKit route runs on every discussion turn.
    const owner = { code: entry.code, userId: "student-1", threadId: result.threadId };
    expect(verifyThreadToken(result.threadToken, owner, getThreadTokenSecret())).toBe(true);
    expect(storeQuizResult).not.toHaveBeenCalled();
  });

  it("resolves NAMESPACED question ids in both actions (compound quizzes)", async () => {
    loadQuiz.mockResolvedValue({
      ok: true,
      quiz: {
        ...quiz,
        questions: [{ id: "intro/q1", question: "What is 2+2?", evaluation: "4 is correct." }],
      },
    });
    const graded = await submitAnswer({ code: entry.code, questionId: "intro/q1", answer: "4" });
    expect(graded).toMatchObject({ ok: true });

    const discussion = await startDiscussion({
      code: entry.code,
      questionId: "intro/q1",
      answer: "4",
      result: "correct",
      feedback: "Well done.",
    });
    expect(discussion).toMatchObject({ ok: true });
    expect(saveMessages).toHaveBeenCalled();
  });
});

describe("submitAnswer photo answers", () => {
  it("rejects an empty submission (no text, no images)", async () => {
    const result = await submitAnswer({ code: entry.code, questionId: "q1", answer: "  " });
    expect(result).toEqual({
      ok: false,
      message: "Type an answer or add a photo before submitting.",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects images when the question's effective imageInput is false", async () => {
    const result = await submitAnswer({
      code: entry.code,
      questionId: "q1",
      answer: "4",
      images: [PHOTO],
    });
    expect(result).toEqual({ ok: false, message: "Images are not accepted for this question." });
    expect(generate).not.toHaveBeenCalled();
  });

  it("honors a per-question override in both directions", async () => {
    // Quiz-level ON, question opts OUT.
    loadQuiz.mockResolvedValue({ ok: true, quiz: quizWithImageInput(true, false) });
    const optOut = await submitAnswer({
      code: entry.code,
      questionId: "q1",
      answer: "4",
      images: [PHOTO],
    });
    expect(optOut).toEqual({ ok: false, message: "Images are not accepted for this question." });

    // Quiz-level OFF, question opts IN.
    loadQuiz.mockResolvedValue({ ok: true, quiz: quizWithImageInput(false, true) });
    const optIn = await submitAnswer({
      code: entry.code,
      questionId: "q1",
      answer: "4",
      images: [PHOTO],
    });
    expect(optIn).toMatchObject({ ok: true });
  });

  it("rejects too many and oversized images server-side", async () => {
    loadQuiz.mockResolvedValue({ ok: true, quiz: quizWithImageInput(true) });
    const tooMany = await submitAnswer({
      code: entry.code,
      questionId: "q1",
      answer: "4",
      images: [PHOTO, PHOTO, PHOTO, PHOTO],
    });
    expect(tooMany).toEqual({ ok: false, message: "At most 3 photos per answer." });

    const tooBig = await submitAnswer({
      code: entry.code,
      questionId: "q1",
      answer: "4",
      images: [dataUrlOfBytes(5 * 1024 * 1024 + 1)],
    });
    expect(tooBig).toEqual({ ok: false, message: "Each photo must be 5 MB or smaller." });
    expect(generate).not.toHaveBeenCalled();
  });

  it("grades text + photos as ONE multimodal user message", async () => {
    loadQuiz.mockResolvedValue({ ok: true, quiz: quizWithImageInput(true) });
    const result = await submitAnswer({
      code: entry.code,
      questionId: "q1",
      answer: "4",
      images: [PHOTO, PHOTO],
    });
    expect(result).toMatchObject({ ok: true });
    expect(generate.mock.calls[0]?.[0]).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "The student's answer:\n\n4" },
          { type: "image", image: PHOTO },
          { type: "image", image: PHOTO },
        ],
      },
    ]);
  });

  it("accepts an image-only answer and says so in the text part", async () => {
    loadQuiz.mockResolvedValue({ ok: true, quiz: quizWithImageInput(true) });
    const result = await submitAnswer({
      code: entry.code,
      questionId: "q1",
      answer: "",
      images: [PHOTO],
    });
    expect(result).toMatchObject({ ok: true });
    const message = generate.mock.calls[0]?.[0] as Array<{ content: Array<{ text?: string }> }>;
    expect(message[0]?.content[0]?.text).toBe(
      "The student answered with the attached photo(s) only.",
    );
  });

  it("keeps the plain-string prompt for a text-only answer", async () => {
    const result = await submitAnswer({ code: entry.code, questionId: "q1", answer: "4" });
    expect(result).toMatchObject({ ok: true });
    expect(generate.mock.calls[0]?.[0]).toBe("The student's answer:\n\n4");
  });
});

describe("startDiscussion photo seeds", () => {
  it("rejects images when the question's effective imageInput is false", async () => {
    const result = await startDiscussion({
      code: entry.code,
      questionId: "q1",
      answer: "4",
      result: "correct",
      feedback: "Well done.",
      images: [PHOTO],
    });
    expect(result).toEqual({ ok: false, message: "Images are not accepted for this question." });
    expect(saveMessages).not.toHaveBeenCalled();
  });

  it("seeds the student-answer message with one stored `file` part per photo", async () => {
    loadQuiz.mockResolvedValue({ ok: true, quiz: quizWithImageInput(true) });
    const result = await startDiscussion({
      code: entry.code,
      questionId: "q1",
      answer: "4",
      result: "correct",
      feedback: "Well done.",
      images: [PHOTO],
    });
    expect(result).toMatchObject({ ok: true });
    const messages = saveMessages.mock.calls[0]?.[0]?.messages as Array<{
      role: string;
      content: { parts: unknown[]; content: string };
    }>;
    expect(messages).toHaveLength(3);
    expect(messages[1]?.role).toBe("user");
    // The v2 UIMessage shape the transcript viewer parses: text part + `file`
    // part whose `data` is the data URL (see lib/conversation-collapse.ts).
    expect(messages[1]?.content.parts).toEqual([
      { type: "text", text: "4" },
      { type: "file", mimeType: "image/png", data: PHOTO },
    ]);
    // The other seeds stay text-only.
    expect(messages[0]?.content.parts).toEqual([
      { type: "text", text: expect.stringContaining("What is 2+2?") },
    ]);
  });

  it("accepts an image-only graded turn and seeds no empty text part", async () => {
    loadQuiz.mockResolvedValue({ ok: true, quiz: quizWithImageInput(true) });
    const result = await startDiscussion({
      code: entry.code,
      questionId: "q1",
      answer: "",
      result: "correct",
      feedback: "Well done.",
      images: [PHOTO],
    });
    expect(result).toMatchObject({ ok: true });
    const messages = saveMessages.mock.calls[0]?.[0]?.messages as Array<{
      content: { parts: Array<{ type: string }> };
    }>;
    expect(messages[1]?.content.parts).toEqual([
      { type: "file", mimeType: "image/png", data: PHOTO },
    ]);
  });

  it("still rejects a discussion with neither text nor images", async () => {
    const result = await startDiscussion({
      code: entry.code,
      questionId: "q1",
      answer: "",
      result: "correct",
      feedback: "Well done.",
    });
    expect(result).toEqual({ ok: false, message: "There is no answer to discuss yet." });
  });
});

describe("quiz-verify stays free of 'use server'", () => {
  it("never mints an endpoint that would return the evaluation prompts", () => {
    // `verifyAndLoadQuestion` returns the loaded Quiz, `evaluation` prompts and
    // all — a `"use server"` directive in that file would publish it.
    const source = readFileSync(join(__dirname, "quiz-verify.ts"), "utf8");
    expect(source).not.toMatch(/^\s*["']use server["']/m);
  });
});

describe("saveQuizResult", () => {
  const ATTEMPT = "0F8FAD5B-D9CB-469F-A165-70867728950E";
  // The mocked quiz has one question and no question_count: an attempt of 1.
  const valid = {
    code: entry.code,
    attemptId: ATTEMPT,
    counts: { correct: 1, partial: 0, incorrect: 0, unanswered: 0 },
    total: 1,
    mode: "this-time" as const,
  };

  it("saves the session user's attempt for the verified code and invalidates their home", async () => {
    await expect(saveQuizResult(valid)).resolves.toEqual({ ok: true, saved: true });
    expect(storeQuizResult).toHaveBeenCalledWith(
      "student-1",
      {
        id: ATTEMPT.toLowerCase(),
        code: entry.code,
        correct: 1,
        partial: 0,
        incorrect: 0,
        unanswered: 0,
        total: 1,
      },
      "this-time",
    );
    expect(invalidateHome).toHaveBeenCalledWith("student-1");
    expect(revalidatePath).toHaveBeenCalledWith("/");
    // Nothing about the quiz comes back.
    expect(JSON.stringify(await saveQuizResult(valid))).not.toContain("evaluation");
  });

  it.each(["this-time", "always", "automatic"] as const)(
    "passes mode %s to the store",
    async (mode) => {
      await saveQuizResult({ ...valid, mode });
      expect(storeQuizResult).toHaveBeenCalledWith("student-1", expect.anything(), mode);
    },
  );

  it("an automatic save with the setting off is not an error: saved = false, nothing invalidated", async () => {
    storeQuizResult.mockResolvedValue("not-saved");
    await expect(saveQuizResult({ ...valid, mode: "automatic" })).resolves.toEqual({
      ok: true,
      saved: false,
    });
    expect(invalidateHome).not.toHaveBeenCalled();
  });

  it.each([
    ["an attempt id that is not a uuid", { attemptId: "attempt-1" }],
    ["an unknown mode", { mode: "forever" }],
    ["a negative count", { counts: { correct: 2, partial: 0, incorrect: -1, unanswered: 0 } }],
    ["a fractional count", { counts: { correct: 0.5, partial: 0, incorrect: 0.5, unanswered: 0 } }],
    [
      "a count beyond int4",
      { counts: { correct: 2 ** 31, partial: 0, incorrect: 0, unanswered: 0 }, total: 2 ** 31 },
    ],
    [
      "a count that is a string",
      { counts: { correct: "1", partial: 0, incorrect: 0, unanswered: 0 } },
    ],
    ["counts that don't sum to total", { total: 2 }],
    ["nothing answered", { counts: { correct: 0, partial: 0, incorrect: 0, unanswered: 1 } }],
    ["missing counts", { counts: undefined }],
  ])("rejects %s — before any I/O", async (_name, override) => {
    const result = await saveQuizResult({ ...valid, ...override } as typeof valid);
    expect(result.ok).toBe(false);
    expect(getSession).not.toHaveBeenCalled();
    expect(storeQuizResult).not.toHaveBeenCalled();
  });

  it("rejects a total above the attempt length the server derives from the re-loaded quiz", async () => {
    const result = await saveQuizResult({
      ...valid,
      counts: { correct: 1, partial: 0, incorrect: 0, unanswered: 1 },
      total: 2,
    });
    expect(result).toEqual({ ok: false, message: expect.stringContaining("quiz changed") });
    expect(storeQuizResult).not.toHaveBeenCalled();
  });

  it("accepts a total up to the authored question_count (drill mode)", async () => {
    loadQuiz.mockResolvedValue({ ok: true, quiz: { ...quiz, questionCount: 3 } });
    await expect(
      saveQuizResult({
        ...valid,
        counts: { correct: 1, partial: 1, incorrect: 0, unanswered: 1 },
        total: 3,
      }),
    ).resolves.toEqual({ ok: true, saved: true });
  });

  it.each([
    ["no session", () => getSession.mockResolvedValue(null)],
    ["an unknown code", () => checkCode.mockResolvedValue({ ok: false, reason: "unknown-code" })],
    ["an expired code", () => checkCode.mockResolvedValue({ ok: false, reason: "expired" })],
    [
      "a code of another module",
      () => checkCode.mockResolvedValue({ ok: true, entry: { ...entry, module: "tutor" } }),
    ],
  ])("rejects %s without touching the store", async (_name, arrange) => {
    arrange();
    const result = await saveQuizResult(valid);
    expect(result.ok).toBe(false);
    expect(storeQuizResult).not.toHaveBeenCalled();
  });

  it("reports a deleted code and a store failure as messages, never throws", async () => {
    storeQuizResult.mockResolvedValue("code-gone");
    await expect(saveQuizResult(valid)).resolves.toEqual({
      ok: false,
      message: expect.stringContaining("no longer exists"),
    });
    storeQuizResult.mockResolvedValue(undefined);
    await expect(saveQuizResult(valid)).resolves.toEqual({
      ok: false,
      message: expect.stringContaining("could not be saved"),
    });
    expect(invalidateHome).not.toHaveBeenCalled();
  });
});
