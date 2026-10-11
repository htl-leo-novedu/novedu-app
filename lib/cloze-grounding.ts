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
// What it cannot check is whether an explanation is TRUE of the cited answers. A
// non-correct gap without a note still shows its verdict and its possible answer.
//
// PURE: no I/O.

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

export interface ClozeGroundedFeedback {
  patterns: ClozePattern[];
  gapNotes: ClozeGapNote[];
}

/**
 * Filters the feedback call's output against the final verdicts. `verdicts` is
 * index-aligned with the gaps (gap N's verdict is `verdicts[N - 1]`).
 */
export function groundClozeFeedback(
  raw: ClozeFeedbackOutput,
  verdicts: readonly QuizVerdict[],
): ClozeGroundedFeedback {
  const isMistake = (gap: number): boolean => {
    const verdict = Number.isInteger(gap) && gap >= 1 ? verdicts[gap - 1] : undefined;
    return verdict !== undefined && verdict !== "correct";
  };

  const patterns: ClozePattern[] = [];
  for (const pattern of raw.patterns) {
    if (patterns.length >= MAX_CLOZE_PATTERNS) break;
    const { gaps } = pattern;
    if (gaps.length < 2 || new Set(gaps).size !== gaps.length || !gaps.every(isMistake)) {
      continue;
    }
    patterns.push({
      title: pattern.title.trim(),
      explanation: pattern.explanation.trim(),
      gaps: [...gaps].sort((a, b) => a - b),
      nextTime: pattern.next_time.trim(),
    });
  }

  const noted = new Set<number>();
  const gapNotes: ClozeGapNote[] = [];
  for (const { gap, note } of raw.gap_notes) {
    if (!isMistake(gap) || noted.has(gap) || note.trim() === "") continue;
    noted.add(gap);
    gapNotes.push({ gap, note: note.trim() });
  }
  gapNotes.sort((a, b) => a.gap - b.gap);

  return { patterns, gapNotes };
}
