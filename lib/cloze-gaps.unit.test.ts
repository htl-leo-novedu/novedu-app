import { describe, expect, it } from "vitest";
import {
  formatGapInventory,
  type ParsedClozeText,
  parseClozeGaps,
  renderClozeText,
} from "@/lib/cloze-gaps";
import { MAX_CLOZE_ANSWER_LENGTH, MAX_CLOZE_GAPS } from "@/lib/cloze-types";

// The cloze gap parser: syntax, escapes, forbidden Markdown positions, limits and
// reading-order numbering. Pure — the Markdown parse is the real remark pipeline.

function ok(text: string): ParsedClozeText {
  const result = parseClozeGaps(text);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("\n"));
  return result;
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
const show = (parsed: ParsedClozeText) =>
  renderClozeText(parsed, (gap) => `<${gap.number}:${gap.reference}>`);

describe("parseClozeGaps — syntax", () => {
  it("reads gaps, references and hints, numbered in reading order", () => {
    const parsed = ok("She [[is going to]] start.\n\nThe class [[starts|start]] at nine.");
    expect(parsed.gaps).toEqual([
      { number: 1, reference: "is going to", line: 1, column: 5 },
      { number: 2, reference: "starts", hint: "start", line: 3, column: 11 },
    ]);
  });

  it("trims the reference and the hint", () => {
    expect(ok("A [[ is going to | go ]] b.").gaps[0]).toMatchObject({
      reference: "is going to",
      hint: "go",
    });
  });

  it("accepts an empty gap ([[]]) and an empty gap with a hint", () => {
    const parsed = ok("Yes[[]] she said[[|,?]] and left.");
    expect(parsed.gaps.map(({ reference, hint }) => ({ reference, hint }))).toEqual([
      { reference: "", hint: undefined },
      { reference: "", hint: ",?" },
    ]);
  });

  it("rebuilds the text around the gaps", () => {
    expect(show(ok("She [[is going to]] start [[it|x]]."))).toBe(
      "She <1:is going to> start <2:it>.",
    );
  });

  it("rejects an unclosed [[ and a gap spanning lines", () => {
    expect(codes("She [[is going to start.")).toEqual(["CLOZE_GAP_SYNTAX"]);
    expect(codes("She [[is going\nto]] start.")).toEqual(["CLOZE_GAP_SYNTAX"]);
  });

  it("rejects a gap containing another [[", () => {
    expect(codes("She [[is [[going]] start.")).toEqual(["CLOZE_GAP_SYNTAX"]);
  });

  it("rejects a stray ]] outside code", () => {
    expect(codes("She [[will]] go ]] now.")).toEqual(["CLOZE_GAP_SYNTAX"]);
  });

  it("rejects a second | and an empty hint", () => {
    expect(codes("A [[a|b|c]] b.")).toEqual(["CLOZE_GAP_SYNTAX"]);
    expect(codes("A [[a|]] b.")).toEqual(["CLOZE_GAP_SYNTAX"]);
    expect(codes("A [[a|  ]] b.")).toEqual(["CLOZE_GAP_SYNTAX"]);
  });

  it("rejects the reserved placeholder characters", () => {
    expect(codes("A [[a]] b.")).toEqual(["CLOZE_GAP_SYNTAX", "CLOZE_GAP_SYNTAX"]);
  });

  it("reports line and column of the problem (1-based, within text)", () => {
    const err = firstError("First line.\n\nSecond [[open");
    expect(err).toMatchObject({ code: "CLOZE_GAP_SYNTAX", line: 3, column: 8 });
    expect(err?.message).toMatch(/^Text line 3, column 8:/);
  });

  it("reports every problem, in reading order", () => {
    const result = parseClozeGaps("# H [[a]]\n\nok [[b|]] and `[[c]]`");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => [e.code, e.line, e.column])).toEqual([
        ["CLOZE_GAP_POSITION", 1, 5],
        ["CLOZE_GAP_SYNTAX", 3, 4],
        ["CLOZE_GAP_POSITION", 3, 16],
      ]);
    }
  });
});

describe("parseClozeGaps — escapes", () => {
  it("keeps \\[[ and \\]] as written in prose (Markdown renders them as [[ / ]])", () => {
    const parsed = ok("Write \\[[x\\]] for [[a]].");
    expect(parsed.gaps).toHaveLength(1);
    expect(show(parsed)).toBe("Write \\[[x\\]] for <1:a>.");
  });

  it("resolves \\[[ inside inline and fenced code to a literal [[", () => {
    const parsed = ok("Use `\\[[ -f x ]]` here: [[a]].\n\n```sh\nif \\[[ -f x ]]; then\n```\n");
    expect(show(parsed)).toBe("Use `[[ -f x ]]` here: <1:a>.\n\n```sh\nif [[ -f x ]]; then\n```\n");
  });

  it("treats an escaped backslash before [[ as a real gap", () => {
    expect(ok("A \\\\[[gap]] b.").gaps).toHaveLength(1);
  });

  it("allows a stray ]] inside code", () => {
    expect(ok("Index `a[b[0]]` with [[a]].").gaps).toHaveLength(1);
  });
});

describe("parseClozeGaps — positions", () => {
  it.each([
    ["an ATX heading", "## Head [[a]]\n\nText [[b]]."],
    ["a setext heading", "Head [[a]]\n---\n\nText [[b]]."],
    ["inline code", "Text `x [[a]]` and [[b]]."],
    ["a fenced code block", "```\n[[a]]\n```\n\nText [[b]]."],
    ["an indented code block", "Text [[b]].\n\n    code [[a]]\n"],
    ["inline math", "Solve $x = [[2]]$ and [[b]]."],
    ["a math block", "$$\nx = [[2]]\n$$\n\nText [[b]]."],
    ["link text", "See [the [[a]] page](https://x.test) and [[b]]."],
    ["a link URL", "See [page](https://x.test/[[a]]) and [[b]]."],
    ["an autolink literal", "See https://x.test/[[a]] and [[b]]."],
    ["an image", "![alt [[a]]](https://x.test/i.png) and [[b]]."],
    ["a raw HTML block", "<div>\n[[a]]\n</div>\n\nText [[b]]."],
    ["a footnote", "Text [[b]].[^1]\n\n[^1]: Note [[a]]."],
  ])("rejects a gap in %s", (_label, text) => {
    expect(codes(text)).toEqual(["CLOZE_GAP_POSITION"]);
  });

  it.each([
    ["a paragraph", "She [[is going to]] start."],
    ["emphasis", "She *[[is going to]]* start."],
    ["a bullet list item", "- She [[is going to]] start.\n- Next."],
    ["an ordered list item", "1. She [[is going to]] start."],
    ["a blockquote", "> She [[is going to]] start."],
    ["a table cell", "| verb | form |\n| --- | --- |\n| go | [[went|go]] |"],
    ["the very start of the text", "[[Will]] she start?"],
    // react-markdown drops inline HTML tags, so the text between them stays visible.
    ["text between inline HTML tags", "She <span>[[is going to]]</span> start."],
  ])("accepts a gap in %s", (_label, text) => {
    expect(ok(text).gaps).toHaveLength(1);
  });

  it("names the gap number and suggests the escape for code", () => {
    expect(firstError("A [[a]] and `[[b]]`.")?.message).toMatch(
      /gap 2 is in inline code.*\\\[\[ for a literal \[\[/,
    );
  });
});

describe("parseClozeGaps — limits", () => {
  it("rejects a text without gaps", () => {
    expect(codes("No gaps here.")).toEqual(["CLOZE_NO_GAPS"]);
  });

  it(`accepts ${MAX_CLOZE_GAPS} gaps and rejects one more`, () => {
    const gaps = (n: number) => Array.from({ length: n }, (_, i) => `[[w${i}]]`).join(" ");
    expect(ok(gaps(MAX_CLOZE_GAPS)).gaps).toHaveLength(MAX_CLOZE_GAPS);
    expect(codes(gaps(MAX_CLOZE_GAPS + 1))).toEqual(["CLOZE_TOO_MANY_GAPS"]);
  });

  it(`accepts a ${MAX_CLOZE_ANSWER_LENGTH}-character reference and rejects a longer one`, () => {
    const long = (n: number) => `A [[${"x".repeat(n)}]] b.`;
    expect(ok(long(MAX_CLOZE_ANSWER_LENGTH)).gaps).toHaveLength(1);
    expect(codes(long(MAX_CLOZE_ANSWER_LENGTH + 1))).toEqual(["CLOZE_GAP_TOO_LONG"]);
  });
});

describe("formatGapInventory", () => {
  it("lists the count and every gap with its reference and hint", () => {
    const { gaps } = ok("She [[is going to]] start. The class [[starts|start]] at [[|,]] nine.");
    expect(formatGapInventory(gaps)).toBe(
      '3 gaps · 1 "is going to" · 2 "starts" (start) · 3 (empty) (,)',
    );
  });

  it("uses the singular for one gap", () => {
    expect(formatGapInventory([{ number: 1, reference: "a" }])).toBe('1 gap · 1 "a"');
  });
});
