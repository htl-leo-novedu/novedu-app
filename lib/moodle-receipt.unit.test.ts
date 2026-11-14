import { describe, expect, it, vi } from "vitest";
import {
  countReceipts,
  getReceiptSecret,
  type Receipt,
  signReceipt,
  verifyReceipt,
} from "./moodle-receipt";
import { describeCounts, moodleComment, moodlePercent, moodleScore } from "./moodle-score";

// Receipts and the score text, with real crypto (docs/testing.md: security
// modules stay real).

const SECRET = "receipt-secret";
const SCOPE = {
  code: "quiz-code1",
  userId: "u1",
  attemptId: "6f1c2d3e-0000-4000-8000-000000000001",
};
const ids = (...list: string[]) => new Set(list);
const QUIZ = { attemptLength: 4, questionIds: ids("q1", "q2", "q3", "q4") };
const sign = (slot: number, questionId: string, verdict: Receipt["verdict"], scope = SCOPE) =>
  signReceipt(scope, { slot, questionId, verdict }, SECRET);

describe("verifyReceipt", () => {
  it("accepts a long question id (quiz ids have no length limit)", () => {
    const long = `lib/${"x".repeat(400)}`;
    expect(verifyReceipt(sign(0, long, "correct"), SCOPE, SECRET)).toBe(true);
  });

  it("accepts a receipt for exactly its scope", () => {
    expect(verifyReceipt(sign(0, "q1", "correct"), SCOPE, SECRET)).toBe(true);
  });

  it.each([
    ["another user", { ...SCOPE, userId: "u2" }],
    ["another code", { ...SCOPE, code: "quiz-code2" }],
    ["another attempt", { ...SCOPE, attemptId: "6f1c2d3e-0000-4000-8000-000000000002" }],
  ])("refuses %s", (_label, scope) => {
    expect(verifyReceipt(sign(0, "q1", "correct"), scope, SECRET)).toBe(false);
  });

  it("refuses an edited slot, question or verdict, and another secret", () => {
    const receipt = sign(0, "q1", "partial");
    expect(verifyReceipt({ ...receipt, slot: 1 }, SCOPE, SECRET)).toBe(false);
    expect(verifyReceipt({ ...receipt, questionId: "q2" }, SCOPE, SECRET)).toBe(false);
    expect(verifyReceipt({ ...receipt, verdict: "correct" }, SCOPE, SECRET)).toBe(false);
    expect(verifyReceipt(receipt, SCOPE, "other-secret")).toBe(false);
  });

  it("refuses malformed values without throwing", () => {
    for (const value of [null, "x", { ...sign(0, "q1", "correct"), mac: "zz" }, { slot: -1 }]) {
      expect(verifyReceipt(value, SCOPE, SECRET)).toBe(false);
    }
  });
});

describe("countReceipts", () => {
  it("counts verdicts and the unanswered rest", () => {
    const result = countReceipts(
      [sign(0, "q1", "correct"), sign(1, "q2", "partial"), sign(3, "q4", "incorrect")],
      SCOPE,
      QUIZ,
      SECRET,
    );
    expect(result).toEqual({
      ok: true,
      counts: { correct: 1, partial: 1, incorrect: 1, unanswered: 1 },
    });
  });

  it.each([
    ["no receipts", []],
    ["not an array", "nope"],
    ["a duplicate slot", [sign(0, "q1", "correct"), sign(0, "q2", "correct")]],
    ["a slot outside the attempt", [sign(4, "q1", "correct")]],
    ["a forged receipt", [{ ...sign(0, "q1", "incorrect"), verdict: "correct" }]],
    ["more receipts than slots", [0, 1, 2, 3, 4].map((slot) => sign(slot, `q${slot}`, "correct"))],
    ["a question no longer in the quiz", [sign(0, "removed", "correct")]],
  ])("rejects the whole call for %s", (_label, receipts) => {
    expect(countReceipts(receipts, SCOPE, QUIZ, SECRET)).toEqual({ ok: false });
  });

  it("limits how often one question may count (ceil(length / pool))", () => {
    const sameQuestion = [0, 1].map((slot) => sign(slot, "q1", "correct"));
    expect(countReceipts(sameQuestion, SCOPE, QUIZ, SECRET)).toEqual({ ok: false });
    // Drill mode: 4 slots from a pool of 2 → each question at most twice.
    const drill = { attemptLength: 4, questionIds: ids("q1", "q2") };
    expect(countReceipts(sameQuestion, SCOPE, drill, SECRET).ok).toBe(true);
    const thrice = [0, 1, 2].map((slot) => sign(slot, "q1", "correct"));
    expect(countReceipts(thrice, SCOPE, drill, SECRET)).toEqual({ ok: false });
  });
});

describe("the score", () => {
  const counts = { correct: 6, partial: 2, incorrect: 1, unanswered: 1 };

  it("counts partly correct as half, against all questions", () => {
    expect(moodleScore(counts)).toBe(7);
    expect(moodlePercent(counts, 10)).toBe(70);
    expect(moodlePercent({ correct: 1, partial: 0, incorrect: 0, unanswered: 2 }, 3)).toBe(33);
  });

  it("writes the comment exactly, leaving out zero parts", () => {
    expect(moodleComment(counts, 10)).toBe(
      "Novedu quiz: 10 questions — 6 correct, 2 partly correct, 1 wrong, 1 not answered.",
    );
    expect(moodleComment({ correct: 1, partial: 0, incorrect: 0, unanswered: 0 }, 1)).toBe(
      "Novedu quiz: 1 question — 1 correct.",
    );
    expect(describeCounts({ correct: 0, partial: 0, incorrect: 2, unanswered: 3 }, 5)).toBe(
      "5 questions — 2 wrong, 3 not answered",
    );
  });
});

describe("getReceiptSecret", () => {
  it("derives its own key from AUTH_SECRET", () => {
    vi.stubEnv("AUTH_SECRET", "a");
    const first = getReceiptSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe("a");
    vi.stubEnv("AUTH_SECRET", "b");
    expect(getReceiptSecret()).not.toBe(first);
  });
});
