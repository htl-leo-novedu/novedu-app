import { beforeEach, describe, expect, it, vi } from "vitest";

// The report server actions. Every I/O seam is mocked — the session, the code
// gate, the shared quiz verification, the report store, telemetry, the teacher
// gate — but `lib/thread-token` stays REAL (docs/testing.md: security-critical
// pure modules are exercised for real), so the chat action's ownership proof is a
// genuine HMAC over a genuinely-signed token. The quiz snapshot is asserted to
// use the SERVER's question text, and the telemetry payload to carry no content.

const getSession = vi.hoisted(() => vi.fn());
const checkCode = vi.hoisted(() => vi.fn());
const verifyAndLoadQuestion = vi.hoisted(() => vi.fn());
const insertChatReport = vi.hoisted(() => vi.fn());
const insertQuizReport = vi.hoisted(() => vi.fn());
const countChatReports = vi.hoisted(() => vi.fn());
const countQuizReports = vi.hoisted(() => vi.fn());
const setReportsResolved = vi.hoisted(() => vi.fn());
const deleteReports = vi.hoisted(() => vi.fn());
const emitEvent = vi.hoisted(() => vi.fn());
const requireTeacherUserId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session", () => ({ getSession }));
vi.mock("@/lib/code-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-store")>()),
  checkCode,
}));
// Only the DB-touching quiz verification is stubbed.
vi.mock("@/lib/quiz-verify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quiz-verify")>()),
  verifyAndLoadQuestion,
}));
vi.mock("@/lib/report-store", () => ({
  insertChatReport,
  insertQuizReport,
  countChatReports,
  countQuizReports,
  setReportsResolved,
  deleteReports,
}));
vi.mock("@/lib/telemetry", () => ({ emitEvent }));
vi.mock("@/lib/student-mode", () => ({ requireTeacherUserId }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { CODE_REJECTION_MESSAGES } from "@/lib/activity-gate";
import {
  deleteSelectedReportsAction,
  markSelectedReportsResolvedAction,
  reopenSelectedReportsAction,
  submitChatReport,
  submitQuizReport,
} from "@/lib/report-actions";
import {
  getThreadTokenSecret,
  resetThreadTokenSecretForTests,
  signThreadToken,
} from "@/lib/thread-token";

const CODE = "a1b2c3d4e5";
const USER = "student-1";
const THREAD = "11111111-1111-1111-1111-111111111111";
const REPORT_ID = "22222222-2222-2222-2222-222222222222";

/** A genuine token for `(CODE, USER, THREAD)` signed with the test secret. */
function goodToken(): string {
  return signThreadToken({ code: CODE, userId: USER, threadId: THREAD }, getThreadTokenSecret());
}

function chatInput(overrides: Record<string, unknown> = {}) {
  return {
    code: CODE,
    threadId: THREAD,
    threadToken: goodToken(),
    reaction: "good",
    description: "",
    ...overrides,
  };
}

function quizInput(overrides: Record<string, unknown> = {}) {
  return {
    code: CODE,
    questionId: "q1",
    answer: "my answer",
    result: "correct",
    feedback: "well done",
    hadImages: false,
    reaction: "bad",
    description: "",
    ...overrides,
  };
}

beforeEach(() => {
  resetThreadTokenSecretForTests();
  getSession.mockResolvedValue({ user: { id: USER } });
  checkCode.mockResolvedValue({ ok: true, entry: { code: CODE } });
  countChatReports.mockResolvedValue(0);
  countQuizReports.mockResolvedValue(0);
  insertChatReport.mockResolvedValue(true);
  insertQuizReport.mockResolvedValue(true);
  verifyAndLoadQuestion.mockResolvedValue({
    ok: true,
    userId: USER,
    code: CODE,
    question: { id: "q1", question: "SERVER question text" },
  });
  requireTeacherUserId.mockResolvedValue({ ok: true, userId: "teacher-1" });
  setReportsResolved.mockResolvedValue(true);
  deleteReports.mockResolvedValue(true);
});

describe("submitChatReport", () => {
  it("stores the report under the SESSION oid and emits content-free telemetry", async () => {
    const result = await submitChatReport(chatInput({ reaction: "good", description: "  hi  " }));
    expect(result).toEqual({ ok: true });
    expect(insertChatReport).toHaveBeenCalledWith({
      code: CODE,
      userId: USER, // from the session, never from input
      threadId: THREAD,
      reaction: "good",
      description: "hi", // trimmed
    });
    expect(emitEvent).toHaveBeenCalledWith("report.submitted", {
      kind: "chat",
      reaction: "good",
      code: CODE,
    });
    // The telemetry payload carries METADATA ONLY — never the description.
    expect(Object.keys(emitEvent.mock.calls[0]?.[1] ?? {})).not.toContain("description");
  });

  it("rejects a missing token", async () => {
    const result = await submitChatReport(chatInput({ threadToken: "" }));
    expect(result).toEqual({ ok: false, message: "This conversation cannot be reported." });
    expect(insertChatReport).not.toHaveBeenCalled();
  });

  it("rejects an invalid token", async () => {
    const result = await submitChatReport(chatInput({ threadToken: "deadbeef" }));
    expect(result).toMatchObject({ ok: false });
    expect(insertChatReport).not.toHaveBeenCalled();
  });

  it("rejects a token signed for a DIFFERENT user (session oid is authoritative)", async () => {
    const foreign = signThreadToken(
      { code: CODE, userId: "someone-else", threadId: THREAD },
      getThreadTokenSecret(),
    );
    const result = await submitChatReport(chatInput({ threadToken: foreign }));
    expect(result).toEqual({ ok: false, message: "This conversation cannot be reported." });
    expect(insertChatReport).not.toHaveBeenCalled();
  });

  it("rejects an unknown reaction", async () => {
    const result = await submitChatReport(chatInput({ reaction: "meh" }));
    expect(result).toEqual({ ok: false, message: "Pick a reaction before reporting." });
    expect(insertChatReport).not.toHaveBeenCalled();
  });

  it("rejects an over-cap description", async () => {
    const result = await submitChatReport(chatInput({ description: "x".repeat(2001) }));
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("2000") });
    expect(insertChatReport).not.toHaveBeenCalled();
  });

  it("declines once the soft cap is reached", async () => {
    countChatReports.mockResolvedValue(3);
    const result = await submitChatReport(chatInput());
    expect(result).toMatchObject({ ok: false });
    expect(insertChatReport).not.toHaveBeenCalled();
  });

  it("surfaces an expired code with the shared rejection wording", async () => {
    checkCode.mockResolvedValue({ ok: false, reason: "expired" });
    const result = await submitChatReport(chatInput());
    expect(result).toEqual({ ok: false, message: CODE_REJECTION_MESSAGES.expired });
    expect(insertChatReport).not.toHaveBeenCalled();
  });

  it("requires a signed-in session", async () => {
    getSession.mockResolvedValue(null);
    const result = await submitChatReport(chatInput());
    expect(result).toMatchObject({ ok: false });
    expect(insertChatReport).not.toHaveBeenCalled();
  });
});

describe("submitQuizReport", () => {
  it("snapshots the SERVER question text + session oid and emits content-free telemetry", async () => {
    const result = await submitQuizReport(
      quizInput({ answer: "  4  ", feedback: "  nice  ", reaction: "bad", description: "  d  " }),
    );
    expect(result).toEqual({ ok: true });
    expect(insertQuizReport).toHaveBeenCalledWith({
      code: CODE,
      userId: USER,
      questionId: "q1",
      questionText: "SERVER question text", // the loaded question, NOT any client copy
      answerText: "4",
      feedbackText: "nice",
      verdict: "correct",
      hadImages: false,
      reaction: "bad",
      description: "d",
    });
    expect(emitEvent).toHaveBeenCalledWith("report.submitted", {
      kind: "quiz-answer",
      reaction: "bad",
      code: CODE,
    });
    expect(Object.keys(emitEvent.mock.calls[0]?.[1] ?? {})).not.toContain("description");
  });

  it("does not trust a client-sent question text (uses the loaded question)", async () => {
    // A hostile client cannot smuggle its own question text — the action only reads
    // it from the server-loaded question.
    await submitQuizReport(
      quizInput({ questionText: "CLIENT-TAMPERED" } as Record<string, unknown>),
    );
    expect(insertQuizReport.mock.calls[0]?.[0]?.questionText).toBe("SERVER question text");
  });

  it("returns the verification failure for an unknown question", async () => {
    verifyAndLoadQuestion.mockResolvedValue({
      ok: false,
      message: "That question is no longer part of this quiz.",
    });
    const result = await submitQuizReport(quizInput());
    expect(result).toEqual({
      ok: false,
      message: "That question is no longer part of this quiz.",
    });
    expect(insertQuizReport).not.toHaveBeenCalled();
  });

  it("rejects an invalid verdict (reject, never coerce)", async () => {
    const result = await submitQuizReport(quizInput({ result: "sorta" }));
    expect(result).toEqual({ ok: false, message: "This answer cannot be reported." });
    expect(insertQuizReport).not.toHaveBeenCalled();
  });

  it("rejects an unknown reaction before touching the DB", async () => {
    const result = await submitQuizReport(quizInput({ reaction: "meh" }));
    expect(result).toEqual({ ok: false, message: "Pick a reaction before reporting." });
    expect(verifyAndLoadQuestion).not.toHaveBeenCalled();
  });

  it("declines once the soft cap is reached", async () => {
    countQuizReports.mockResolvedValue(3);
    const result = await submitQuizReport(quizInput());
    expect(result).toMatchObject({ ok: false });
    expect(insertQuizReport).not.toHaveBeenCalled();
  });
});

describe("teacher bulk actions", () => {
  it("marks selected reports resolved under the teacher oid", async () => {
    const result = await markSelectedReportsResolvedAction([REPORT_ID]);
    expect(result).toEqual({ ok: true });
    expect(setReportsResolved).toHaveBeenCalledWith([REPORT_ID], true, "teacher-1");
  });

  it("reopens selected reports (resolution cleared)", async () => {
    const result = await reopenSelectedReportsAction([REPORT_ID]);
    expect(result).toEqual({ ok: true });
    expect(setReportsResolved).toHaveBeenCalledWith([REPORT_ID], false, "teacher-1");
  });

  it("deletes selected reports", async () => {
    const result = await deleteSelectedReportsAction([REPORT_ID]);
    expect(result).toEqual({ ok: true });
    expect(deleteReports).toHaveBeenCalledWith([REPORT_ID]);
  });

  it.each([
    markSelectedReportsResolvedAction,
    reopenSelectedReportsAction,
    deleteSelectedReportsAction,
  ])("blocks a non-teacher on %o", async (action) => {
    requireTeacherUserId.mockResolvedValue({ ok: false });
    const result = await action([REPORT_ID]);
    expect(result).toEqual({ ok: false, message: "Only teachers can manage reports." });
    expect(setReportsResolved).not.toHaveBeenCalled();
    expect(deleteReports).not.toHaveBeenCalled();
  });

  it("rejects an empty or non-uuid id list", async () => {
    await expect(markSelectedReportsResolvedAction([])).resolves.toMatchObject({ ok: false });
    await expect(deleteSelectedReportsAction(["not-a-uuid"])).resolves.toMatchObject({ ok: false });
    expect(setReportsResolved).not.toHaveBeenCalled();
    expect(deleteReports).not.toHaveBeenCalled();
  });
});
