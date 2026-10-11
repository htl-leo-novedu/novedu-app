import { describe, expect, it } from "vitest";
import { normalizeClozeAnswer, runClozePrepass, undecidedGaps } from "./cloze-prepass";

// The deterministic pre-pass table (docs/cloze.md, "Grading").

const gaps = [
  { number: 1, reference: "is going to" },
  { number: 2, reference: "starts" },
  { number: 3, reference: "" },
  { number: 4, reference: "" },
  { number: 5, reference: "won't" },
];

describe("normalizeClozeAnswer", () => {
  it("trims, collapses whitespace and unifies typographic apostrophes and quotes", () => {
    expect(normalizeClozeAnswer("  is   going\tto ")).toBe("is going to");
    expect(normalizeClozeAnswer("won’t")).toBe("won't");
    expect(normalizeClozeAnswer("“hi”")).toBe('"hi"');
  });

  it("is case-sensitive", () => {
    expect(normalizeClozeAnswer("Starts")).not.toBe(normalizeClozeAnswer("starts"));
  });
});

describe("runClozePrepass", () => {
  it("decides the table's rows and leaves the rest to the model", () => {
    const result = runClozePrepass(gaps, ["is  going to", "start", "", ", ", "won’t"]);
    expect(result).toEqual([
      { gap: 1, verdict: "correct", rule: "exact-match" },
      { gap: 2, verdict: null, rule: null },
      { gap: 3, verdict: "correct", rule: "empty-reference" },
      // `[[]]` with a non-empty answer goes to the model.
      { gap: 4, verdict: null, rule: null },
      { gap: 5, verdict: "correct", rule: "exact-match" },
    ]);
    expect(undecidedGaps(result)).toEqual([2, 4]);
  });

  it("an empty answer to a non-empty reference is not answered (incorrect)", () => {
    const [first] = runClozePrepass(gaps, ["   ", "", "", "", ""]);
    expect(first).toEqual({ gap: 1, verdict: "incorrect", rule: "not-answered" });
  });

  it("a case difference goes to the model", () => {
    expect(runClozePrepass([{ number: 1, reference: "starts" }], ["Starts"])).toEqual([
      { gap: 1, verdict: null, rule: null },
    ]);
  });
});
