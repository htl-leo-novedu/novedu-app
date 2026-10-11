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
    expect(result.dropped.patterns).toEqual([]);
  });

  it.each([
    [[1, 2], "cites-correct-gap"],
    [[2, 9], "cites-unknown-gap"],
    [[2, 0], "cites-unknown-gap"],
    [[2, 2], "cites-gap-twice"],
    [[3], "too-few-gaps"],
  ] as const)("drops a pattern citing %j (%s)", (gaps, reason) => {
    const result = groundClozeFeedback({ patterns: [pattern([...gaps])], gap_notes: [] }, verdicts);
    expect(result.patterns).toEqual([]);
    expect(result.dropped.patterns.map((d) => d.reason)).toEqual([reason]);
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
    expect(result.dropped.patterns.map((d) => [d.pattern.title, d.reason])).toEqual([
      ["bad", "cites-correct-gap"],
      ["d", "over-limit"],
    ]);
  });
});

describe("groundClozeFeedback — gap notes", () => {
  it("keeps the first note per non-correct gap, sorted by gap", () => {
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
    expect(result.dropped.gapNotes.map((d) => [d.note.gap, d.reason])).toEqual([
      [2, "duplicate-note"],
      [1, "correct-gap"],
      [7, "unknown-gap"],
      [3, "empty-note"],
    ]);
  });
});
