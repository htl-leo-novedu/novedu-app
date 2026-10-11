import { describe, expect, it } from "vitest";
import { groundClozeFeedback } from "./cloze-grounding";
import type { QuizVerdict } from "./quiz-types";

// The grounding filter's structural rules (docs/cloze.md).

// Gap 1 correct, 2 incorrect, 3 partial, 4 incorrect, 5 correct.
const verdicts: QuizVerdict[] = ["correct", "incorrect", "partial", "incorrect", "correct"];

const pattern = (gaps: number[], title = `P ${gaps.join(",")}`) => ({
  title,
  explanation: " Why. ",
  gaps,
  next_time: " Tip. ",
});

describe("groundClozeFeedback — patterns", () => {
  it("keeps a pattern backed by two or more non-correct gaps, gaps ascending, text trimmed", () => {
    const result = groundClozeFeedback({ patterns: [pattern([4, 2])], gap_notes: [] }, verdicts);
    expect(result.patterns).toEqual([
      { title: "P 4,2", explanation: "Why.", gaps: [2, 4], nextTime: "Tip." },
    ]);
  });

  it.each([
    ["a correct gap", [1, 2]],
    ["an unknown gap", [2, 9]],
    ["gap 0", [2, 0]],
    ["a gap twice", [2, 2]],
    ["a single gap", [3]],
  ] as const)("drops a pattern citing %s", (_label, gaps) => {
    const result = groundClozeFeedback({ patterns: [pattern([...gaps])], gap_notes: [] }, verdicts);
    expect(result.patterns).toEqual([]);
  });

  it("keeps at most three patterns, in the model's order", () => {
    const patterns = [
      pattern([2, 3], "a"),
      pattern([1, 2], "bad"),
      pattern([3, 4], "b"),
      pattern([2, 4], "c"),
      pattern([2, 3, 4], "d"),
    ];
    const result = groundClozeFeedback({ patterns, gap_notes: [] }, verdicts);
    expect(result.patterns.map((p) => p.title)).toEqual(["a", "b", "c"]);
  });
});

describe("groundClozeFeedback — gap notes", () => {
  it("keeps the first note per non-correct gap, sorted; drops correct, unknown and empty ones", () => {
    const gap_notes = [
      { gap: 4, note: "four" },
      { gap: 2, note: " two " },
      { gap: 2, note: "again" },
      { gap: 1, note: "correct one" },
      { gap: 7, note: "unknown" },
      { gap: 3, note: "   " },
    ];
    const result = groundClozeFeedback({ patterns: [], gap_notes }, verdicts);
    expect(result.gapNotes).toEqual([
      { gap: 2, note: "two" },
      { gap: 4, note: "four" },
    ]);
  });
});
