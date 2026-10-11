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
//   \[[  /  \]]       a literal `[[` / `]]`
// Gaps are numbered 1…N in reading order (the order they appear in `text`).
//
// `text` is Markdown, rendered by the sanitized MarkdownRenderer. A gap must end up
// as plain text — in a paragraph, a list item, a blockquote or a table cell — never
// in a heading, code (inline or fenced), math, link text or URL, image, raw HTML or
// footnote. Positions are decided by parsing the text with the SAME Markdown
// pipeline the renderer runs (remark-parse + remark-gfm + remark-math), with every
// gap first replaced by an inert run of letters of the same length: offsets stay
// identical, and the gap behaves exactly like the placeholder the student page
// renders (neither contains a character Markdown could read as structure).
//
// PURE / CLI-safe: no I/O, no `app/**`, no DB. Bundled into `@novedu/cli`.

import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
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

/**
 * The text between the gaps, as Markdown source, and the gaps themselves, in
 * order. Inside code a `\[[` escape is already resolved to `[[` (Markdown keeps a
 * backslash in code literally); everywhere else the source stays as written, since
 * Markdown itself renders `\[` as `[`.
 */
export type ClozeSegment = { kind: "text"; text: string } | { kind: "gap"; number: number };

export interface ParsedClozeText {
  gaps: ClozeGap[];
  segments: ClozeSegment[];
}

export type ClozeGapParseResult =
  | ({ ok: true } & ParsedClozeText)
  | { ok: false; errors: ValidationError[] };

/** A gap marker found by the lexical scan, before its position is checked. */
interface GapToken {
  start: number;
  end: number;
  reference: string;
  hint?: string;
}

/** A Markdown node, structurally — just what the position walk reads. */
interface MdNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
}

/** A range of `text` a gap may not touch, and how to say where it is. */
interface Zone {
  start: number;
  end: number;
  where: string;
  /** Code/math/HTML: the content is literal, so `]]` there is not markup. */
  literal: boolean;
  /** Code: a backslash is literal there, so a `\[[` escape must be resolved. */
  code: boolean;
}

// Every node type a gap must not sit in, with the phrase that completes "Gap N is …".
const FORBIDDEN: Record<string, { where: string; literal?: boolean; code?: boolean }> = {
  heading: { where: "in a heading" },
  code: { where: "in a code block", literal: true, code: true },
  inlineCode: { where: "in inline code", literal: true, code: true },
  math: { where: "in a math formula", literal: true },
  inlineMath: { where: "in a math formula", literal: true },
  html: { where: "in raw HTML", literal: true },
  link: { where: "in a link" },
  linkReference: { where: "in a link" },
  definition: { where: "in a link definition" },
  image: { where: "in an image" },
  imageReference: { where: "in an image" },
  footnoteDefinition: { where: "in a footnote" },
  footnoteReference: { where: "in a footnote" },
};

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** Odd number of backslashes right before `index` ⇒ the character there is escaped. */
function isEscaped(text: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

/** Maps a 0-based offset to a 1-based `{ line, column }`. */
function locator(text: string): (offset: number) => { line: number; column: number } {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (lineStarts[lo] ?? 0) + 1 };
  };
}

/** Collects the forbidden zones and the plain-text ranges of the parsed probe. */
function collectZones(root: MdNode): { zones: Zone[]; textRanges: [number, number][] } {
  const zones: Zone[] = [];
  const textRanges: [number, number][] = [];
  const visit = (node: MdNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      const forbidden = FORBIDDEN[node.type];
      if (forbidden) {
        zones.push({
          start,
          end,
          where: forbidden.where,
          literal: forbidden.literal ?? false,
          code: forbidden.code ?? false,
        });
      }
      if (node.type === "text") textRanges.push([start, end]);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return { zones, textRanges };
}

/**
 * Parses the gaps of a cloze `text`. On success returns the gaps (numbered 1…N in
 * reading order) and the segments to rebuild the text from; otherwise every
 * problem found, each with its line and column.
 */
export function parseClozeGaps(text: string): ClozeGapParseResult {
  const at = locator(text);
  // Located problems, reported in reading order once the scan is complete.
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
      fail(
        "CLOZE_GAP_SYNTAX",
        index,
        `the text contains the reserved character U+${reserved.codePointAt(0)?.toString(16).toUpperCase()} — remove it.`,
      );
    }
  }

  // 1. Lexical scan: every unescaped `[[ … ]]` on one line is a gap marker; an
  //    unescaped `]]` outside a marker is remembered and judged once the code
  //    ranges are known (in code it is ordinary text).
  const tokens: GapToken[] = [];
  const strayClosers: number[] = [];
  const escapes: number[] = []; // offsets of the backslash of each `\[[`
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("[[", i)) {
      if (isEscaped(text, i)) {
        escapes.push(i - 1);
        i += 2;
        continue;
      }
      const close = text.indexOf("]]", i + 2);
      const inner = close < 0 ? "" : text.slice(i + 2, close);
      if (close < 0 || (inner.includes("\n") && inner.includes("[["))) {
        fail(
          "CLOZE_GAP_SYNTAX",
          i,
          "this [[ is never closed — a gap opens and closes on the same line ([[answer]]). Write \\[[ for a literal [[.",
        );
        i += 2;
        continue;
      }
      if (inner.includes("\n")) {
        fail(
          "CLOZE_GAP_SYNTAX",
          i,
          "this gap spans more than one line — a gap opens and closes on the same line ([[answer]]).",
        );
        i = close + 2;
        continue;
      }
      if (inner.includes("[[")) {
        fail(
          "CLOZE_GAP_SYNTAX",
          i,
          "a gap may not contain another [[ — close the first gap with ]] before opening the next.",
        );
        i = close + 2;
        continue;
      }
      const parts = inner.split("|");
      if (parts.length > 2) {
        fail(
          "CLOZE_GAP_SYNTAX",
          i,
          `a gap takes at most one | (answer|hint), but [[${inner}]] has ${parts.length - 1}.`,
        );
      } else if (parts.length === 2 && (parts[1] ?? "").trim() === "") {
        fail(
          "CLOZE_GAP_SYNTAX",
          i,
          `the hint after | is empty in [[${inner}]] — write [[answer|hint]], or drop the |.`,
        );
      }
      const reference = (parts[0] ?? "").trim();
      if (reference.length > MAX_CLOZE_ANSWER_LENGTH) {
        fail(
          "CLOZE_GAP_TOO_LONG",
          i,
          `the answer of this gap has ${reference.length} characters — at most ${MAX_CLOZE_ANSWER_LENGTH} are allowed.`,
        );
      }
      const hint = parts.length === 2 ? (parts[1] ?? "").trim() : "";
      tokens.push({ start: i, end: close + 2, reference, ...(hint ? { hint } : {}) });
      i = close + 2;
      continue;
    }
    if (text.startsWith("]]", i)) {
      if (!isEscaped(text, i)) strayClosers.push(i);
      i += 2;
      continue;
    }
    i++;
  }

  // 2. Positions: parse a probe in which every gap is an inert run of letters of the
  //    same length, so the probe's offsets are the text's offsets.
  let probe = "";
  let last = 0;
  for (const token of tokens) {
    probe += text.slice(last, token.start) + "g".repeat(token.end - token.start);
    last = token.end;
  }
  probe += text.slice(last);
  const { zones, textRanges } = collectZones(markdown.parse(probe) as MdNode);
  const zoneAt = (offset: number) => zones.find((z) => z.start <= offset && offset < z.end);

  tokens.forEach((token, index) => {
    const zone = zoneAt(token.start);
    if (zone) {
      fail(
        "CLOZE_GAP_POSITION",
        token.start,
        `gap ${index + 1} is ${zone.where} — gaps belong in paragraphs, list items, quotes or table cells.${zone.code ? " Write \\[[ for a literal [[ in code." : ""}`,
      );
    } else if (!textRanges.some(([start, end]) => start <= token.start && token.start < end)) {
      fail(
        "CLOZE_GAP_POSITION",
        token.start,
        `gap ${index + 1} is in a position where it cannot be shown — put it in a paragraph, list item, quote or table cell.`,
      );
    }
  });
  for (const offset of strayClosers) {
    if (!zoneAt(offset)?.literal) {
      fail(
        "CLOZE_GAP_SYNTAX",
        offset,
        "this ]] closes no gap — every gap is written [[answer]]. Write \\]] for a literal ]].",
      );
    }
  }

  const errors = located.sort((a, b) => a.offset - b.offset).map((entry) => entry.error);
  if (tokens.length === 0 && errors.length === 0) {
    errors.push(
      error(
        "CLOZE_NO_GAPS",
        "The text has no gaps — mark each one around its answer, e.g. She [[is going to]] start.",
      ),
    );
  }
  if (tokens.length > MAX_CLOZE_GAPS) {
    errors.push(
      error(
        "CLOZE_TOO_MANY_GAPS",
        `The text has ${tokens.length} gaps — at most ${MAX_CLOZE_GAPS} are allowed. Split it into two exercises.`,
      ),
    );
  }
  if (errors.length > 0) return { ok: false, errors };

  // 3. Segments: the text between the gaps, with every `\[[` inside code resolved.
  const codeEscapes = new Set(escapes.filter((offset) => zoneAt(offset)?.code));
  const segments: ClozeSegment[] = [];
  const gaps: ClozeGap[] = [];
  const pushText = (from: number, to: number) => {
    let chunk = "";
    for (let k = from; k < to; k++) if (!codeEscapes.has(k)) chunk += text[k];
    if (chunk) segments.push({ kind: "text", text: chunk });
  };
  let cursor = 0;
  tokens.forEach((token, index) => {
    pushText(cursor, token.start);
    const number = index + 1;
    gaps.push({
      number,
      reference: token.reference,
      ...(token.hint ? { hint: token.hint } : {}),
      ...at(token.start),
    });
    segments.push({ kind: "gap", number });
    cursor = token.end;
  });
  pushText(cursor, text.length);
  return { ok: true, gaps, segments };
}

/**
 * Rebuilds the text from its segments, writing each gap with `renderGap` — the
 * public projection writes a placeholder, a prompt builder writes the reference.
 */
export function renderClozeText(
  parsed: ParsedClozeText,
  renderGap: (gap: ClozeGap) => string,
): string {
  return parsed.segments
    .map((segment) => {
      if (segment.kind === "text") return segment.text;
      const gap = parsed.gaps[segment.number - 1];
      return gap ? renderGap(gap) : "";
    })
    .join("");
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
