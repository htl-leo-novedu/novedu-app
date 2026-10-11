import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";

// The cloze server actions (docs/cloze.md). The I/O seams are mocked — the session, the
// code gate, the exercise load, the Mastra agent, the usage counter, the per-gap counts
// store and telemetry — while
// the security-critical pure parts stay real: the result-token HMAC, the pre-pass, both
// prompt builders, the grounding filter and `effectiveLlm`.

const getSession = vi.hoisted(() => vi.fn());
const checkCode = vi.hoisted(() => vi.fn());
const loadCloze = vi.hoisted(() => vi.fn());
const generate = vi.hoisted(() => vi.fn());
const emitEvent = vi.hoisted(() => vi.fn());
const recordError = vi.hoisted(() => vi.fn());
const recordClozeSubmission = vi.hoisted(() => vi.fn());
const recordClozeGapCounts = vi.hoisted(() => vi.fn());
const getAgent = vi.hoisted(() => vi.fn());
const storeQuizResult = vi.hoisted(() => vi.fn());
const invalidateHome = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session", () => ({ getSession }));
vi.mock("@/lib/code-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-store")>()),
  checkCode,
}));
vi.mock("@/lib/cloze-fetch", () => ({ loadCloze }));
vi.mock("@/app/mastra", () => ({ mastra: { getAgent } }));
vi.mock("@/lib/usage-store", () => ({ recordClozeSubmission }));
vi.mock("@/lib/cloze-counts-store", () => ({ recordClozeGapCounts }));
vi.mock("@/lib/telemetry", () => ({ emitEvent, recordError }));
vi.mock("next/server", () => ({ after: (callback: () => unknown) => callback() }));
vi.mock("@/lib/quiz-result-store", () => ({ saveQuizResult: storeQuizResult }));
vi.mock("@/lib/home-data", () => ({ invalidateHome }));
vi.mock("next/cache", () => ({ revalidatePath }));

import {
  CLOZE_EVAL_INSTRUCTIONS,
  CLOZE_EVAL_MODEL,
  CLOZE_EVAL_PROVIDER,
} from "@/app/mastra/cloze-agents";
import { explainCloze, gradeCloze, saveClozeResult } from "@/lib/cloze-actions";
import { getClozeResultSecret, signClozeResultToken } from "@/lib/cloze-result-token";
import { parseCloze } from "@/lib/cloze-yaml";
import type { QuizVerdict } from "@/lib/quiz-types";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";

const CODE = "a1b2c3d4e5";
const USER = "student-1";
const ATTEMPT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const entry = {
  code: CODE,
  module: "cloze",
  fileUrl: "https://example.com/api/files/c",
  llm: null,
};

const parsed = parseCloze(`
id: t
llm: { model: yaml-model }
evaluation: SECRET-CRITERIA
text: |
  Sue [[is going to]] start. The class [[starts|start]] at nine. Yes[[]] she said.
`);
assert(parsed.ok);
const cloze = parsed.cloze;

// A distinctive student answer: it must never reach telemetry.
const SECRET_ANSWER = "STUDENT-TEXT-xyz";

function modelVerdicts(gaps: { gap: number; result: QuizVerdict }[]) {
  return { object: { gaps: gaps.map((g) => ({ ...g, reason: "Because." })) } };
}

function contextOf(call: number): { get(k: string): unknown } {
  const options = generate.mock.calls[call]?.[1] as { requestContext: { get(k: string): unknown } };
  return options.requestContext;
}

/** Every value handed to telemetry, flattened to one string. */
function telemetryText(): string {
  return JSON.stringify([emitEvent.mock.calls, recordError.mock.calls]);
}

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: USER } });
  checkCode.mockResolvedValue({ ok: true, entry });
  loadCloze.mockResolvedValue({ ok: true, cloze });
  getAgent.mockReturnValue({ generate });
  generate.mockResolvedValue(modelVerdicts([{ gap: 2, result: "partial" }]));
  storeQuizResult.mockResolvedValue("saved");
});

const gradeInput = (answers: string[], round: "first" | "retry" = "first") => ({
  code: CODE,
  attemptId: ATTEMPT,
  round,
  answers,
});

describe("gradeCloze", () => {
  it("grades: the pre-pass decides what it can, the model only the rest", async () => {
    const result = await gradeCloze(gradeInput(["is  going to", "start", ""]));
    assert(result.ok);
    expect(result.verdicts).toEqual(["correct", "partial", "correct"]);
    expect(result.references).toEqual(["is going to", "starts", ""]);
    expect(getAgent).toHaveBeenCalledWith("clozeEvaluator");
    // Only gap 2 went to the model.
    const message = generate.mock.calls[0]?.[0] as string;
    expect(JSON.parse(message.slice(message.indexOf("\n[") + 1))).toEqual([
      { gap: 2, answer: "start" },
    ]);
  });

  it("runs the agent with the server-built prompt, the effective model and usage keys", async () => {
    await gradeCloze(gradeInput(["x", "y", ""]));
    const ctx = contextOf(0);
    expect(ctx.get(CLOZE_EVAL_INSTRUCTIONS)).toContain("SECRET-CRITERIA");
    expect(ctx.get(CLOZE_EVAL_MODEL)).toBe("yaml-model");
    expect(ctx.get(CLOZE_EVAL_PROVIDER)).toBe("SCCH");
    expect(ctx.get(USAGE_CODE)).toBe(CODE);
    expect(ctx.get(USAGE_USER_ID)).toBe(USER);
    expect(ctx.get(USAGE_MODULE)).toBe("cloze");
  });

  it("applies the code's LLM override", async () => {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { ...entry, llm: { provider: "SCCH", model: "override-model" } },
    });
    generate.mockResolvedValue(
      modelVerdicts([
        { gap: 1, result: "incorrect" },
        { gap: 2, result: "incorrect" },
      ]),
    );
    await gradeCloze(gradeInput(["x", "y", ""]));
    expect(contextOf(0).get(CLOZE_EVAL_MODEL)).toBe("override-model");
  });

  it("makes no model call when the pre-pass decides every gap", async () => {
    const result = await gradeCloze(gradeInput(["is going to", "", ""]));
    assert(result.ok);
    expect(result.verdicts).toEqual(["correct", "incorrect", "correct"]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("re-runs checkCode on every call and stops on a rejection", async () => {
    checkCode.mockResolvedValue({ ok: false, reason: "expired" });
    const result = await gradeCloze(gradeInput(["a", "b", ""]));
    expect(result).toEqual({
      ok: false,
      message: "This exercise's availability window has ended.",
    });
    expect(checkCode).toHaveBeenCalledWith(CODE);
    expect(loadCloze).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects a code of another module", async () => {
    checkCode.mockResolvedValue({ ok: true, entry: { ...entry, module: "quiz" } });
    const result = await gradeCloze(gradeInput(["a", "b", ""]));
    expect(result.ok).toBe(false);
    expect(loadCloze).not.toHaveBeenCalled();
  });

  it("checks the session before the code", async () => {
    getSession.mockResolvedValue(null);
    const result = await gradeCloze(gradeInput(["a", "b", ""]));
    expect(result.ok).toBe(false);
    expect(checkCode).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed attempt id", { attemptId: "nope" }],
    ["an unknown round", { round: "third" }],
    ["a non-array", { answers: "abc" }],
    ["an over-long answer", { answers: ["a".repeat(201), "b", ""] }],
  ])("rejects %s before any I/O", async (_, change) => {
    const result = await gradeCloze({ ...gradeInput(["a", "b", ""]), ...change } as never);
    expect(result.ok).toBe(false);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("rejects answers that no longer match the gap count (the text changed)", async () => {
    const result = await gradeCloze(gradeInput(["a", "b"]));
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/changed/) });
    expect(generate).not.toHaveBeenCalled();
  });

  it("retries once when the model does not cover the undecided gaps exactly, then succeeds", async () => {
    generate
      .mockResolvedValueOnce(modelVerdicts([{ gap: 1, result: "correct" }]))
      .mockResolvedValueOnce(
        modelVerdicts([
          { gap: 1, result: "incorrect" },
          { gap: 2, result: "partial" },
        ]),
      );
    const result = await gradeCloze(gradeInput(["x", "y", ""]));
    assert(result.ok);
    expect(result.verdicts).toEqual(["incorrect", "partial", "correct"]);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a missing gap", [{ gap: 1, result: "correct" }]],
    [
      "an extra gap",
      [
        { gap: 1, result: "correct" },
        { gap: 2, result: "correct" },
        { gap: 3, result: "correct" },
      ],
    ],
    [
      "a duplicate gap",
      [
        { gap: 1, result: "correct" },
        { gap: 1, result: "partial" },
      ],
    ],
  ] as const)("fails after the one retry on %s, counting nothing", async (_, gaps) => {
    generate.mockResolvedValue(modelVerdicts([...gaps]));
    const result = await gradeCloze(gradeInput(["x", "y", ""]));
    expect(result).toEqual({ ok: false, message: "Couldn't check your answers — try again." });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(recordClozeSubmission).not.toHaveBeenCalled();
    expect(recordClozeGapCounts).not.toHaveBeenCalled();
  });

  it("fails with the generic message when the model call throws", async () => {
    generate.mockRejectedValue(new Error(`provider said: ${SECRET_ANSWER}`));
    const result = await gradeCloze(gradeInput([SECRET_ANSWER, "y", ""]));
    expect(result).toEqual({ ok: false, message: "Couldn't check your answers — try again." });
    expect(recordError).toHaveBeenCalledWith(expect.any(Error), {
      "novedu.area": "cloze",
      stage: "grade",
    });
  });

  it("counts every successful grading, practice rounds included", async () => {
    await gradeCloze(gradeInput(["is going to", "", ""], "first"));
    await gradeCloze(gradeInput(["is going to", "", ""], "retry"));
    expect(recordClozeSubmission).toHaveBeenCalledTimes(2);
    expect(recordClozeSubmission).toHaveBeenCalledWith({ code: CODE, userId: USER });
  });

  it("adds a first round's verdicts to the per-gap counts, keyed by the reference", async () => {
    await gradeCloze(gradeInput(["is going to", "start", ""], "first"));
    expect(recordClozeGapCounts).toHaveBeenCalledTimes(1);
    expect(recordClozeGapCounts).toHaveBeenCalledWith(CODE, [
      { gap: 1, reference: "is going to", verdict: "correct" },
      { gap: 2, reference: "starts", verdict: "partial" },
      { gap: 3, reference: "", verdict: "correct" },
    ]);
  });

  it("never adds a practice round to the per-gap counts", async () => {
    await gradeCloze(gradeInput(["is going to", "", ""], "retry"));
    expect(recordClozeSubmission).toHaveBeenCalledTimes(1);
    expect(recordClozeGapCounts).not.toHaveBeenCalled();
  });

  it("reports the round content-free — no answer, reference or criteria in telemetry", async () => {
    generate.mockResolvedValue(
      modelVerdicts([
        { gap: 1, result: "incorrect" },
        { gap: 2, result: "incorrect" },
      ]),
    );
    await gradeCloze(gradeInput([SECRET_ANSWER, "y", ""], "retry"));
    expect(emitEvent).toHaveBeenCalledWith(
      "cloze.graded",
      expect.objectContaining({ code: CODE, round: "retry", gaps: 3, modelGaps: 2 }),
    );
    expect(telemetryText()).not.toContain(SECRET_ANSWER);
    expect(telemetryText()).not.toContain("is going to");
    expect(telemetryText()).not.toContain("SECRET-CRITERIA");
  });

  it("signs a result token that explainCloze accepts", async () => {
    const result = await gradeCloze(gradeInput(["is going to", "start", ""]));
    assert(result.ok);
    expect(result.resultToken).toBe(
      signClozeResultToken(
        {
          code: CODE,
          userId: USER,
          attemptId: ATTEMPT,
          answers: ["is going to", "start", ""],
          verdicts: result.verdicts,
        },
        getClozeResultSecret(),
      ),
    );
  });
});

describe("explainCloze", () => {
  const answers = [SECRET_ANSWER, "start", ""];
  const verdicts: QuizVerdict[] = ["incorrect", "partial", "correct"];
  const token = () =>
    signClozeResultToken(
      { code: CODE, userId: USER, attemptId: ATTEMPT, answers, verdicts },
      getClozeResultSecret(),
    );
  const input = () => ({ code: CODE, attemptId: ATTEMPT, answers, verdicts, resultToken: token() });

  beforeEach(() => {
    generate.mockResolvedValue({
      object: {
        patterns: [
          { title: "Future forms", explanation: "Both.", gaps: [1, 2], next_time: "Tip." },
          { title: "Invented", explanation: "No.", gaps: [2, 3], next_time: "Tip." },
        ],
        gap_notes: [
          { gap: 1, note: "Note one." },
          { gap: 3, note: "Correct gap note." },
        ],
      },
    });
  });

  it("returns only the grounded patterns and notes", async () => {
    const result = await explainCloze(input());
    expect(result).toEqual({
      ok: true,
      patterns: [{ title: "Future forms", explanation: "Both.", gaps: [1, 2], nextTime: "Tip." }],
      gapNotes: [{ gap: 1, note: "Note one." }],
    });
    // The feedback prompt and message: the server's text, the verdicts as facts.
    expect(contextOf(0).get(CLOZE_EVAL_INSTRUCTIONS)).toContain("never re-grade");
    const message = generate.mock.calls[0]?.[0] as string;
    expect(JSON.parse(message.slice(message.indexOf("\n[") + 1))).toEqual([
      { gap: 1, answer: SECRET_ANSWER, verdict: "incorrect" },
      { gap: 2, answer: "start", verdict: "partial" },
      { gap: 3, answer: "", verdict: "correct" },
    ]);
    expect(contextOf(0).get(USAGE_MODULE)).toBe("cloze");
  });

  it.each([
    ["verdicts", { verdicts: ["correct", "correct", "correct"] }],
    ["answers", { answers: ["other", "start", ""] }],
    ["attempt", { attemptId: "11111111-1111-4111-8111-111111111111" }],
    ["token", { resultToken: "ab".repeat(32) }],
  ])("rejects a token that does not match the %s", async (_, change) => {
    const result = await explainCloze({ ...input(), ...change } as never);
    expect(result).toEqual({ ok: false, message: "This submission cannot be checked." });
    expect(checkCode).toHaveBeenCalledWith(CODE);
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects another user's token", async () => {
    getSession.mockResolvedValue({ user: { id: "student-2" } });
    const result = await explainCloze(input());
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it("re-runs checkCode before the token", async () => {
    checkCode.mockResolvedValue({ ok: false, reason: "unknown-code" });
    const result = await explainCloze(input());
    expect(result).toEqual({ ok: false, message: "This exercise code is not valid." });
    expect(generate).not.toHaveBeenCalled();
  });

  it("makes no model call when every gap is correct", async () => {
    const all: QuizVerdict[] = ["correct", "correct", "correct"];
    const resultToken = signClozeResultToken(
      { code: CODE, userId: USER, attemptId: ATTEMPT, answers, verdicts: all },
      getClozeResultSecret(),
    );
    const result = await explainCloze({ ...input(), verdicts: all, resultToken });
    expect(result).toEqual({ ok: true, patterns: [], gapNotes: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("fails with the generic message and content-free telemetry when the call throws", async () => {
    generate.mockRejectedValue(new Error("boom"));
    const result = await explainCloze(input());
    expect(result).toEqual({ ok: false, message: "Couldn't load the feedback — try again." });
    expect(recordError).toHaveBeenCalledWith(expect.any(Error), {
      "novedu.area": "cloze",
      stage: "explain",
    });
  });

  it("puts no answer or feedback text into telemetry", async () => {
    await explainCloze(input());
    expect(emitEvent).toHaveBeenCalledWith(
      "cloze.explained",
      expect.objectContaining({ code: CODE, patterns: 1, droppedPatterns: 1, notes: 1 }),
    );
    expect(telemetryText()).not.toContain(SECRET_ANSWER);
    expect(telemetryText()).not.toContain("Future forms");
    expect(telemetryText()).not.toContain("Note one.");
  });

  it("neither meters nor counts a submission", async () => {
    await explainCloze(input());
    expect(recordClozeSubmission).not.toHaveBeenCalled();
    expect(recordClozeGapCounts).not.toHaveBeenCalled();
  });
});

describe("saveClozeResult", () => {
  // The mocked exercise has three gaps: a result must cover exactly three slots.
  const valid = {
    code: CODE,
    attemptId: ATTEMPT.toUpperCase(),
    counts: { correct: 1, partial: 1, incorrect: 0, unanswered: 1 },
    total: 3,
    mode: "this-time" as const,
  };

  it("saves the session user's counts into the shared store and invalidates their home", async () => {
    await expect(saveClozeResult(valid)).resolves.toEqual({ ok: true, saved: true });
    expect(storeQuizResult).toHaveBeenCalledWith(
      USER,
      { id: ATTEMPT, code: CODE, correct: 1, partial: 1, incorrect: 0, unanswered: 1, total: 3 },
      "this-time",
    );
    expect(invalidateHome).toHaveBeenCalledWith(USER);
    expect(revalidatePath).toHaveBeenCalledWith("/");
    // Nothing about the exercise comes back.
    expect(JSON.stringify(await saveClozeResult(valid))).not.toMatch(/SECRET|is going to/);
  });

  it.each(["this-time", "always", "automatic"] as const)(
    "passes mode %s to the store",
    async (mode) => {
      await saveClozeResult({ ...valid, mode });
      expect(storeQuizResult).toHaveBeenCalledWith(USER, expect.anything(), mode);
    },
  );

  it("an automatic save with the setting off is not an error: saved = false, nothing invalidated", async () => {
    storeQuizResult.mockResolvedValue("not-saved");
    await expect(saveClozeResult({ ...valid, mode: "automatic" })).resolves.toEqual({
      ok: true,
      saved: false,
    });
    expect(invalidateHome).not.toHaveBeenCalled();
  });

  it.each([
    ["an attempt id that is not a uuid", { attemptId: "attempt-1" }],
    ["an unknown mode", { mode: "forever" }],
    ["a negative count", { counts: { correct: 3, partial: 1, incorrect: -1, unanswered: 0 } }],
    ["a fractional count", { counts: { correct: 1.5, partial: 1.5, incorrect: 0, unanswered: 0 } }],
    [
      "a count beyond int4",
      { counts: { correct: 2 ** 31, partial: 0, incorrect: 0, unanswered: 0 }, total: 2 ** 31 },
    ],
    [
      "a count that is a string",
      { counts: { correct: "1", partial: 1, incorrect: 0, unanswered: 1 } },
    ],
    ["counts that don't sum to total", { total: 4 }],
    ["nothing answered", { counts: { correct: 0, partial: 0, incorrect: 0, unanswered: 3 } }],
    ["missing counts", { counts: undefined }],
  ])("rejects %s — before any I/O", async (_name, override) => {
    const result = await saveClozeResult({ ...valid, ...override } as typeof valid);
    expect(result.ok).toBe(false);
    expect(getSession).not.toHaveBeenCalled();
    expect(storeQuizResult).not.toHaveBeenCalled();
  });

  it.each([
    ["fewer", { counts: { correct: 1, partial: 1, incorrect: 0, unanswered: 0 }, total: 2 }],
    ["more", { counts: { correct: 1, partial: 1, incorrect: 0, unanswered: 2 }, total: 4 }],
  ])("rejects a total with %s slots than the re-loaded exercise has gaps", async (_, override) => {
    const result = await saveClozeResult({ ...valid, ...override });
    expect(result).toEqual({ ok: false, message: expect.stringContaining("exercise changed") });
    expect(storeQuizResult).not.toHaveBeenCalled();
  });

  it.each([
    ["no session", () => getSession.mockResolvedValue(null)],
    ["an unknown code", () => checkCode.mockResolvedValue({ ok: false, reason: "unknown-code" })],
    ["an expired code", () => checkCode.mockResolvedValue({ ok: false, reason: "expired" })],
    [
      "a code of another module",
      () => checkCode.mockResolvedValue({ ok: true, entry: { ...entry, module: "quiz" } }),
    ],
  ])("rejects %s without touching the store", async (_name, arrange) => {
    arrange();
    const result = await saveClozeResult(valid);
    expect(result.ok).toBe(false);
    expect(storeQuizResult).not.toHaveBeenCalled();
  });

  it("re-runs checkCode on every call", async () => {
    await saveClozeResult(valid);
    await saveClozeResult(valid);
    expect(checkCode).toHaveBeenCalledTimes(2);
  });

  it("reports a deleted code and a store failure as messages, never throws", async () => {
    storeQuizResult.mockResolvedValue("code-gone");
    await expect(saveClozeResult(valid)).resolves.toEqual({
      ok: false,
      message: expect.stringContaining("no longer exists"),
    });
    storeQuizResult.mockResolvedValue(undefined);
    await expect(saveClozeResult(valid)).resolves.toEqual({
      ok: false,
      message: expect.stringContaining("could not be saved"),
    });
    expect(invalidateHome).not.toHaveBeenCalled();
  });
});

describe("cloze-verify stays free of 'use server'", () => {
  it("never mints an endpoint that would return the references and evaluation", () => {
    const source = readFileSync(join(__dirname, "cloze-verify.ts"), "utf8");
    expect(source).not.toMatch(/^\s*["']use server["']/m);
  });
});
