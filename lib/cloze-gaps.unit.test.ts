import { describe, expect, it } from "vitest";
import {
  type ClozeGap,
  formatGapInventory,
  parseClozeGaps,
  renderClozeText,
} from "@/lib/cloze-gaps";
import { MAX_CLOZE_ANSWER_LENGTH, MAX_CLOZE_GAPS } from "@/lib/cloze-types";

// The cloze gap parser: syntax, limits, line/column and reading-order numbering.

function ok(text: string): ClozeGap[] {
  const result = parseClozeGaps(text);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("\n"));
  return result.gaps;
}

function codes(text: string): string[] {
  const result = parseClozeGaps(text);
  return result.ok ? [] : result.errors.map((e) => e.code);
}

function firstError(text: string) {
  const result = parseClozeGaps(text);
  if (result.ok) throw new Error("expected a failure");
  return result.errors[0];
}

/** Rebuilds the text with each gap written as `<n:reference>`. */
const show = (text: string) =>
  renderClozeText(text, ok(text), (gap) => `<${gap.number}:${gap.reference}>`);

describe("parseClozeGaps — syntax", () => {
  it("reads gaps, references and hints, numbered in reading order", () => {
    expect(ok("She [[is going to]] start.\n\nThe class [[starts|start]] at nine.")).toEqual([
      { number: 1, reference: "is going to", line: 1, column: 5 },
      { number: 2, reference: "starts", hint: "start", line: 3, column: 11 },
    ]);
  });

  it("trims the reference and the hint", () => {
    expect(ok("A [[ is going to | go ]] b.")[0]).toMatchObject({
      reference: "is going to",
      hint: "go",
    });
  });

  it("accepts an empty gap ([[]]) and an empty gap with a hint", () => {
    const gaps = ok("Yes[[]] she said[[|,?]] and left.");
    expect(gaps.map(({ reference, hint }) => ({ reference, hint }))).toEqual([
      { reference: "", hint: undefined },
      { reference: "", hint: ",?" },
    ]);
  });

  it("accepts gaps in Markdown around them — list items, emphasis, a table cell", () => {
    expect(ok("- She *[[is going to]]* start.\n- Next [[one]].")).toHaveLength(2);
    expect(ok("| verb | form |\n| --- | --- |\n| go | [[went|go]] |")).toHaveLength(1);
  });

  it("rebuilds the text around the gaps", () => {
    expect(show("She [[is going to]] start [[it|x]].")).toBe("She <1:is going to> start <2:it>.");
  });

  it("rejects an unclosed [[ and a gap spanning lines", () => {
    expect(codes("She [[is going to start.")).toEqual(["CLOZE_GAP_SYNTAX"]);
    expect(codes("She [[is going\nto]] start.")).toEqual(["CLOZE_GAP_SYNTAX", "CLOZE_GAP_SYNTAX"]);
  });

  it("rejects a gap containing another [[", () => {
    expect(codes("She [[is [[going]] start.")).toEqual(["CLOZE_GAP_SYNTAX"]);
  });

  it("rejects a stray ]]", () => {
    expect(codes("She [[will]] go ]] now.")).toEqual(["CLOZE_GAP_SYNTAX"]);
    expect(codes("Index `a[b[0]]` with [[a]].")).toEqual(["CLOZE_GAP_SYNTAX"]);
  });

  it("rejects a second | and an empty hint", () => {
    expect(codes("A [[a|b|c]] b.")).toEqual(["CLOZE_GAP_SYNTAX"]);
    expect(codes("A [[a|]] b.")).toEqual(["CLOZE_GAP_SYNTAX"]);
    expect(codes("A [[a|  ]] b.")).toEqual(["CLOZE_GAP_SYNTAX"]);
  });

  it("rejects the reserved placeholder characters", () => {
    expect(codes("A [[a]] b.")).toEqual(["CLOZE_GAP_SYNTAX", "CLOZE_GAP_SYNTAX"]);
  });

  it("reports line and column of the problem (1-based, within text)", () => {
    const err = firstError("First line.\n\nSecond [[open");
    expect(err).toMatchObject({ code: "CLOZE_GAP_SYNTAX", line: 3, column: 8 });
    expect(err?.message).toMatch(/^Text line 3, column 8:/);
  });

  it("reports every problem, in reading order", () => {
    const result = parseClozeGaps("A ]] b [[a]]\n\nok [[b|]] and [[c");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => [e.code, e.line, e.column])).toEqual([
        ["CLOZE_GAP_SYNTAX", 1, 3],
        ["CLOZE_GAP_SYNTAX", 3, 4],
        ["CLOZE_GAP_SYNTAX", 3, 15],
      ]);
    }
  });
});

describe("parseClozeGaps — limits", () => {
  it("rejects a text without gaps", () => {
    expect(codes("No gaps here.")).toEqual(["CLOZE_NO_GAPS"]);
  });

  it(`accepts ${MAX_CLOZE_GAPS} gaps and rejects one more`, () => {
    const gaps = (n: number) => Array.from({ length: n }, (_, i) => `[[w${i}]]`).join(" ");
    expect(ok(gaps(MAX_CLOZE_GAPS))).toHaveLength(MAX_CLOZE_GAPS);
    expect(codes(gaps(MAX_CLOZE_GAPS + 1))).toEqual(["CLOZE_TOO_MANY_GAPS"]);
  });

  it(`accepts a ${MAX_CLOZE_ANSWER_LENGTH}-character reference and rejects a longer one`, () => {
    const long = (n: number) => `A [[${"x".repeat(n)}]] b.`;
    expect(ok(long(MAX_CLOZE_ANSWER_LENGTH))).toHaveLength(1);
    expect(codes(long(MAX_CLOZE_ANSWER_LENGTH + 1))).toEqual(["CLOZE_GAP_TOO_LONG"]);
  });
});

describe("formatGapInventory", () => {
  it("lists the count and every gap with its reference and hint", () => {
    const gaps = ok("She [[is going to]] start. The class [[starts|start]] at [[|,]] nine.");
    expect(formatGapInventory(gaps)).toBe(
      '3 gaps · 1 "is going to" · 2 "starts" (start) · 3 (empty) (,)',
    );
  });

  it("uses the singular for one gap", () => {
    expect(formatGapInventory([{ number: 1, reference: "a" }])).toBe('1 gap · 1 "a"');
  });
});
