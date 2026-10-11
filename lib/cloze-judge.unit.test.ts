import { describe, expect, it } from "vitest";
import {
  buildClozeJudgeSubject,
  CLOZE_JUDGE_CRITERIA,
  CLOZE_JUDGE_SYSTEM,
} from "@/lib/cloze-judge";
import { judgmentSchema } from "@/lib/quiz-feedback-judge";

// The cloze judge's contract — the sibling of lib/quiz-feedback-judge.unit.test.ts:
// every criterion is DEFINED where the model reads it, the guardrails are present, the
// taxonomy fits the kind-agnostic judge endpoint, and the subject carries every part.

describe("CLOZE_JUDGE_SYSTEM", () => {
  it("defines all five criteria by name", () => {
    expect([...CLOZE_JUDGE_CRITERIA]).toEqual([
      "unsupported_pattern",
      "contradicts_verdict",
      "misstates_facts",
      "ignores_instructions",
      "leaks_rubric",
    ]);
    for (const criterion of CLOZE_JUDGE_CRITERIA) {
      expect(CLOZE_JUDGE_SYSTEM, criterion).toContain(`"${criterion}"`);
    }
  });

  it("carries the load-bearing guardrails and no `ok` boolean", () => {
    expect(CLOZE_JUDGE_SYSTEM).toMatch(/Do NOT judge the verdicts themselves/);
    expect(CLOZE_JUDGE_SYSTEM).toMatch(/do not invent issues/);
    expect(CLOZE_JUDGE_SYSTEM).toMatch(/When in doubt, the feedback is ok/);
    expect(CLOZE_JUDGE_SYSTEM).toMatch(/EMPTY "issues"/);
    expect(CLOZE_JUDGE_SYSTEM).not.toMatch(/\bok:\s*(true|false)\b/);
  });

  it("fits the judge endpoint's 1–8 snake_case bound and its schema", () => {
    expect(CLOZE_JUDGE_CRITERIA.length).toBeLessThanOrEqual(8);
    for (const criterion of CLOZE_JUDGE_CRITERIA) expect(criterion).toMatch(/^[a-z_]{1,40}$/);
    const schema = judgmentSchema(CLOZE_JUDGE_CRITERIA);
    expect(
      schema.safeParse({ issues: [{ criterion: "unsupported_pattern", note: "n" }] }).success,
    ).toBe(true);
  });
});

describe("buildClozeJudgeSubject", () => {
  it("lays out the prompt, the answers and the surviving feedback in labeled blocks", () => {
    const subject = buildClozeJudgeSubject("FEEDBACK-SYSTEM", "ANSWERS-JSON", {
      patterns: [
        { title: "Future forms", explanation: "You used will.", gaps: [1, 4], nextTime: "Tip." },
      ],
      gapNotes: [{ gap: 4, note: "Use the present continuous." }],
    });
    const order = [
      "=== The system prompt the feedback writer was given ===",
      "FEEDBACK-SYSTEM",
      "=== The student's answers and their final verdicts ===",
      "ANSWERS-JSON",
      "=== The feedback the student saw (JUDGE THIS) ===",
      "Pattern 1 — gaps 1, 4: Future forms",
      "You used will.",
      "Next time: Tip.",
      "Gap 4: Use the present continuous.",
    ].map((part) => subject.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("says so when no pattern or note survived", () => {
    const subject = buildClozeJudgeSubject("S", "A", { patterns: [], gapNotes: [] });
    expect(subject).toContain("(no patterns)");
    expect(subject).toContain("(no gap notes)");
  });
});
