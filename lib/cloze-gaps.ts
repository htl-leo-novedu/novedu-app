// The cloze GAP PARSER — reads the gap markup inside a cloze `text` and reports
// every problem with its 1-based line and column. Shared by the strict authoring
// validator (`lib/cloze-validate.ts`) and the lenient runtime parser
// (`lib/cloze-yaml.ts`), so the student page, the grader and the validator agree on
// what the gaps are.
//
// Syntax (docs/cloze.md):
//   [[answer]]        a gap and its reference answer
//   [[answer|hint]]   plus a hint rendered after the gap, e.g. "(start)"
//   [[]]              "nothing belongs here" — an empty answer is correct
// A gap opens and closes on one line. Gaps are numbered 1…N in reading order. There
// is no escape: a literal `[[` or `]]` is not supported, and the scan knows nothing
// about Markdown — teachers put gaps in ordinary sentences and list items.
//
// PURE / CLI-safe: no I/O, no `app/**`, no DB. Bundled into `@novedu/cli`.

import { CLOZE_RESERVED_CHARACTERS, MAX_CLOZE_ANSWER_LENGTH, MAX_CLOZE_GAPS } from "./cloze-types";
import { type ErrorCode, error, type ValidationError } from "./prompt-fragments/errors";

/** One gap of a cloze text, INCLUDING its server-only reference answer. */
export interface ClozeGap {
  /** 1-based, in reading order. */
  number: number;
  /** The reference answer, trimmed; `""` for `[[]]` ("nothing belongs here"). */
  reference: string;
  /** Optional hint rendered after the gap, trimmed. */
  hint?: string;
  /** 1-based line of the gap's opening `[[` in `text`. */
  line: number;
  /** 1-based column of the gap's opening `[[` in `text`. */
  column: number;
}

export type ClozeGapParseResult =
  | { ok: true; gaps: ClozeGap[] }
  | { ok: false; errors: ValidationError[] };

// One gap: `[[`, the shortest run of characters on the same line (`.` never matches a
// line break), `]]`. In a text the parser accepted, this matches exactly its gaps, in
// order — `renderClozeText` relies on that.
const GAP_PATTERN = /\[\[(.*?)\]\]/g;

/** Maps a 0-based offset to a 1-based `{ line, column }`. */
function locator(text: string): (offset: number) => { line: number; column: number } {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  return (offset) => {
    let line = 0;
    while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? 0) <= offset) line++;
    return { line: line + 1, column: offset - (lineStarts[line] ?? 0) + 1 };
  };
}

/**
 * Parses the gaps of a cloze `text`. On success returns the gaps, numbered 1…N in
 * reading order; otherwise every problem found, each with its line and column.
 */
export function parseClozeGaps(text: string): ClozeGapParseResult {
  const at = locator(text);
  const located: { offset: number; error: ValidationError }[] = [];
  const fail = (code: ErrorCode, offset: number, message: string) => {
    const { line, column } = at(offset);
    located.push({
      offset,
      error: error(code, `Text line ${line}, column ${column}: ${message}`, { line, column }),
    });
  };

  for (const reserved of CLOZE_RESERVED_CHARACTERS) {
    const index = text.indexOf(reserved);
    if (index >= 0) {
      const hex = reserved.codePointAt(0)?.toString(16).toUpperCase();
      fail(
        "CLOZE_GAP_SYNTAX",
        index,
        `the text contains the reserved character U+${hex} — remove it.`,
      );
    }
  }

  const gaps: ClozeGap[] = [];
  // The text with every well-formed gap blanked out (same length, so offsets stay
  // valid): any `[[` or `]]` left in it is unmatched.
  let rest = text;
  for (const match of text.matchAll(GAP_PATTERN)) {
    const start = match.index;
    const inner = match[1] ?? "";
    rest = rest.slice(0, start) + " ".repeat(match[0].length) + rest.slice(start + match[0].length);
    if (inner.includes("[[")) {
      // `[[a [[b]]`: the first `[[` was never closed.
      fail("CLOZE_GAP_SYNTAX", start, "this [[ is never closed — write each gap as [[answer]].");
      continue;
    }
    const parts = inner.split("|");
    if (parts.length > 2) {
      fail(
        "CLOZE_GAP_SYNTAX",
        start,
        `a gap takes at most one | (answer|hint), but [[${inner}]] has ${parts.length - 1}.`,
      );
    }
    const reference = (parts[0] ?? "").trim();
    const hint = (parts[1] ?? "").trim();
    if (parts.length === 2 && hint === "") {
      fail(
        "CLOZE_GAP_SYNTAX",
        start,
        `the hint after | is empty in [[${inner}]] — write [[answer|hint]], or drop the |.`,
      );
    }
    if (reference.length > MAX_CLOZE_ANSWER_LENGTH) {
      fail(
        "CLOZE_GAP_TOO_LONG",
        start,
        `the answer of this gap has ${reference.length} characters — at most ${MAX_CLOZE_ANSWER_LENGTH} are allowed.`,
      );
    }
    gaps.push({
      number: gaps.length + 1,
      reference,
      ...(hint ? { hint } : {}),
      ...at(start),
    });
  }

  for (const match of rest.matchAll(/\[\[|\]\]/g)) {
    fail(
      "CLOZE_GAP_SYNTAX",
      match.index,
      match[0] === "[["
        ? "this [[ is never closed — a gap opens and closes on the same line ([[answer]])."
        : "this ]] closes no gap — every gap is written [[answer]] on one line.",
    );
  }

  const errors = located.sort((a, b) => a.offset - b.offset).map((entry) => entry.error);
  if (gaps.length === 0 && errors.length === 0) {
    errors.push(
      error(
        "CLOZE_NO_GAPS",
        "The text has no gaps — mark each one around its answer, e.g. She [[is going to]] start.",
      ),
    );
  }
  if (gaps.length > MAX_CLOZE_GAPS) {
    errors.push(
      error(
        "CLOZE_TOO_MANY_GAPS",
        `The text has ${gaps.length} gaps — at most ${MAX_CLOZE_GAPS} are allowed. Split it into two exercises.`,
      ),
    );
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, gaps };
}

/**
 * Rebuilds a text the parser accepted, writing each gap with `renderGap` — the public
 * projection writes a placeholder, a prompt builder writes the reference.
 */
export function renderClozeText(
  text: string,
  gaps: readonly ClozeGap[],
  renderGap: (gap: ClozeGap) => string,
): string {
  let index = 0;
  return text.replace(GAP_PATTERN, () => {
    const gap = gaps[index++];
    return gap ? renderGap(gap) : "";
  });
}

/** One gap of the inventory — the reference and hint, without the source position. */
export interface ClozeGapSummary {
  number: number;
  reference: string;
  hint?: string;
}

/** The gap's inventory entry, e.g. `3 "starts" (start)` or `4 (empty)`. */
function inventoryEntry(gap: ClozeGapSummary): string {
  const reference = gap.reference === "" ? "(empty)" : `"${gap.reference}"`;
  return `${gap.number} ${reference}${gap.hint ? ` (${gap.hint})` : ""}`;
}

/**
 * The one-line gap inventory a successful validation reports:
 * `10 gaps · 1 "is going to" · 2 "is going to" · 3 "starts" (start) · …`.
 */
export function formatGapInventory(gaps: readonly ClozeGapSummary[]): string {
  const count = `${gaps.length} gap${gaps.length === 1 ? "" : "s"}`;
  return [count, ...gaps.map(inventoryEntry)].join(" · ");
}
