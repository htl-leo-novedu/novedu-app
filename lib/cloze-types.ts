// Client-safe cloze types, limits and the gap-placeholder contract. PURE — no I/O,
// no YAML or Markdown parser — so the student runner can import the public shapes
// and split the projected text on its placeholders without pulling the parsers
// into the browser bundle. The server-only shapes (reference answers, `evaluation`,
// the rendered preamble) and the lenient parser live in `lib/cloze-yaml.ts`; the
// gap parser in `lib/cloze-gaps.ts`.

/** At most this many gaps per exercise (the strict validator rejects more). */
export const MAX_CLOZE_GAPS = 40;

/**
 * The answer cap, in characters: no reference answer may be longer (the strict
 * validator rejects it), and no student answer may be either (enforced on both
 * sides of the wire).
 */
export const MAX_CLOZE_ANSWER_LENGTH = 200;

// The placeholder that stands in for gap N in the public text is N wrapped in two
// Private Use Area characters. Markdown treats them like letters, so a placeholder
// never changes the text's block or inline structure (no `[`, `|` or `*` that a
// parser could read as a link, a table cell or emphasis), and a teacher cannot type
// them by accident — the gap parser rejects a `text` that contains either one.
const PLACEHOLDER_OPEN = "";
const PLACEHOLDER_CLOSE = "";

/** The reserved characters a cloze `text` may not contain (they delimit placeholders). */
export const CLOZE_RESERVED_CHARACTERS = [PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE] as const;

/** The placeholder for gap `number` in {@link ClozePublic.text}. */
export function clozeGapPlaceholder(number: number): string {
  return `${PLACEHOLDER_OPEN}${number}${PLACEHOLDER_CLOSE}`;
}

/**
 * Splits a (rendered) text run on its gap placeholders: plain strings stay strings,
 * each placeholder becomes its gap number, in order. Empty strings are dropped.
 */
export function splitOnClozeGaps(text: string): (string | number)[] {
  const parts: (string | number)[] = [];
  const pattern = new RegExp(`${PLACEHOLDER_OPEN}(\\d+)${PLACEHOLDER_CLOSE}`, "g");
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(Number(match[1]));
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** One gap as shipped to the browser — its number and optional hint, NEVER its reference. */
export interface ClozeGapPublic {
  /** 1-based, in reading order. */
  number: number;
  /** Optional hint rendered after the gap, e.g. the verb in brackets. */
  hint?: string;
}

/** The student-facing projection of a cloze exercise — everything the runner needs, nothing more. */
export interface ClozePublic {
  /** Optional student heading. */
  title?: string;
  /** Optional task box above the text (Markdown). */
  description?: string;
  /**
   * The exercise text (Markdown) with every gap replaced by
   * {@link clozeGapPlaceholder}. Reference answers never appear in it.
   */
  text: string;
  /** Every gap, in reading order (gap N is `gaps[N - 1]`). */
  gaps: ClozeGapPublic[];
}
