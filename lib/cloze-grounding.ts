import { MAX_CLOZE_PATTERNS } from "./cloze-feedback-prompt";
import type { ClozeFeedbackOutput } from "./cloze-output-schemas";
import type { QuizVerdict } from "./quiz-types";

// The GROUNDING FILTER of cloze feedback (docs/cloze.md): a model asked for patterns
// will invent them, so before anything reaches the browser the server keeps only what
// the student's actual verdicts support. Structural rules only:
//
//   - a pattern citing a correct, non-existent or duplicate gap, or fewer than two gaps,
//     is dropped; at most three survive (in the model's order);
//   - a gap note on a correct or non-existent gap is dropped; the first note per gap
//     wins; an empty note is dropped.
//
// What it cannot check — whether an explanation is TRUE of the cited answers — is the
// eval judge's job. A non-correct gap without a note still shows its verdict and its
// possible answer.
//
// PURE / CLI-safe: the eval runner applies the same filter locally, so its report shows
// exactly what a student would see — and lists what was dropped, and why.

/** A surviving pattern, as the student sees it (camelCase, gaps ascending). */
export interface ClozePattern {
  title: string;
  explanation: string;
  /** The cited gaps — every one non-correct, at least two, ascending. */
  gaps: number[];
  nextTime: string;
}

/** A surviving per-gap note. */
export interface ClozeGapNote {
  gap: number;
  note: string;
}

export type DroppedPatternReason =
  | "cites-correct-gap"
  | "cites-unknown-gap"
  | "cites-gap-twice"
  | "too-few-gaps"
  | "over-limit";

export type DroppedNoteReason = "correct-gap" | "unknown-gap" | "duplicate-note" | "empty-note";

export interface ClozeGroundedFeedback {
  patterns: ClozePattern[];
  gapNotes: ClozeGapNote[];
  /** What the filter removed, for the eval report — never sent to a student. */
  dropped: {
    patterns: { pattern: ClozeFeedbackOutput["patterns"][number]; reason: DroppedPatternReason }[];
    gapNotes: { note: ClozeFeedbackOutput["gap_notes"][number]; reason: DroppedNoteReason }[];
  };
}

/**
 * Filters the feedback call's output against the final verdicts. `verdicts` is
 * index-aligned with the gaps (gap N's verdict is `verdicts[N - 1]`).
 */
export function groundClozeFeedback(
  raw: ClozeFeedbackOutput,
  verdicts: readonly QuizVerdict[],
): ClozeGroundedFeedback {
  const verdictOf = (gap: number): QuizVerdict | undefined =>
    Number.isInteger(gap) && gap >= 1 ? verdicts[gap - 1] : undefined;

  const dropped: ClozeGroundedFeedback["dropped"] = { patterns: [], gapNotes: [] };

  const patterns: ClozePattern[] = [];
  for (const pattern of raw.patterns) {
    const reason = patternProblem(pattern.gaps, verdictOf);
    if (reason) {
      dropped.patterns.push({ pattern, reason });
      continue;
    }
    if (patterns.length >= MAX_CLOZE_PATTERNS) {
      dropped.patterns.push({ pattern, reason: "over-limit" });
      continue;
    }
    patterns.push({
      title: pattern.title.trim(),
      explanation: pattern.explanation.trim(),
      gaps: [...pattern.gaps].sort((a, b) => a - b),
      nextTime: pattern.next_time.trim(),
    });
  }

  const noted = new Set<number>();
  const gapNotes: ClozeGapNote[] = [];
  for (const note of raw.gap_notes) {
    const verdict = verdictOf(note.gap);
    const reason: DroppedNoteReason | undefined =
      verdict === undefined
        ? "unknown-gap"
        : verdict === "correct"
          ? "correct-gap"
          : noted.has(note.gap)
            ? "duplicate-note"
            : note.note.trim() === ""
              ? "empty-note"
              : undefined;
    if (reason) {
      dropped.gapNotes.push({ note, reason });
      continue;
    }
    noted.add(note.gap);
    gapNotes.push({ gap: note.gap, note: note.note.trim() });
  }
  gapNotes.sort((a, b) => a.gap - b.gap);

  return { patterns, gapNotes, dropped };
}

function patternProblem(
  gaps: readonly number[],
  verdictOf: (gap: number) => QuizVerdict | undefined,
): DroppedPatternReason | undefined {
  if (gaps.some((gap) => verdictOf(gap) === undefined)) return "cites-unknown-gap";
  if (new Set(gaps).size !== gaps.length) return "cites-gap-twice";
  if (gaps.some((gap) => verdictOf(gap) === "correct")) return "cites-correct-gap";
  if (gaps.length < 2) return "too-few-gaps";
  return undefined;
}
