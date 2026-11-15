import type { QuizVerdict } from "@/lib/quiz-types";

// What a Moodle hand-in sends (docs/moodle.md), as pure, client-safe helpers:
// the Finish page's box shows exactly the text and percentage the server sends.
// Partly correct counts half; unanswered questions count as not correct; the
// maximum is the attempt's question count. Never a school grade, never pass/fail.

export type HandInCounts = Record<QuizVerdict, number> & { unanswered: number };

/** `scoreGiven`: correct + 0.5 × partly correct. */
export function moodleScore(counts: HandInCounts): number {
  return counts.correct + 0.5 * counts.partial;
}

/** The whole-number percentage the box shows; Moodle receives the unrounded score. */
export function moodlePercent(counts: HandInCounts, total: number): number {
  return total > 0 ? Math.round((moodleScore(counts) / total) * 100) : 0;
}

/** "10 questions — 6 correct, 2 partly correct, 1 wrong, 1 not answered" (zero parts left out). */
export function describeCounts(counts: HandInCounts, total: number): string {
  const parts = [
    [counts.correct, "correct"],
    [counts.partial, "partly correct"],
    [counts.incorrect, "wrong"],
    [counts.unanswered, "not answered"],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, label]) => `${count} ${label}`);
  return `${total} question${total === 1 ? "" : "s"} — ${parts.join(", ")}`;
}

/** The comment Moodle shows as feedback, exactly. */
export function moodleComment(counts: HandInCounts, total: number): string {
  return `Novedu quiz: ${describeCounts(counts, total)}.`;
}
