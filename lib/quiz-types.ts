// Client-safe quiz types and the verdict→label mapping. PURE — no I/O, no YAML
// parser, no node:crypto (only the pure, client-safe `lib/image-ref` types) — so
// a client component (the quiz runner) can import the student-facing types and
// `verdictLabel` without pulling the YAML parser into the browser bundle. The
// richer, server-only types and the lenient parser live in `lib/quiz-yaml.ts`.

import type { ImageRef, ResolvedImage } from "@/lib/image-ref";

// The grader's internal verdict vocabulary. Kept terse for the structured-output
// schema; the student never sees these raw values (see `verdictLabel`).
export type QuizVerdict = "correct" | "partial" | "incorrect";

/** The student-facing wording for a verdict — `partial` reads as "partly correct". */
export function verdictLabel(verdict: QuizVerdict): string {
  switch (verdict) {
    case "correct":
      return "correct";
    case "partial":
      return "partly correct";
    case "incorrect":
      return "wrong";
  }
}

/** A single question as shipped to the browser — NEVER carries the `evaluation` prompt. */
export interface QuizQuestionPublic {
  id: string;
  /** Optional short label for progress display. */
  title?: string;
  /** MARKDOWN shown to the student. */
  question: string;
  /** Optional content image — carries no secret, so it crosses the wire unchanged. */
  image?: ImageRef;
  /**
   * Whether the student may attach photos to the answer — the EFFECTIVE flag,
   * resolved server-side from the per-question override / quiz-level default
   * (`toPublicQuiz`). Carries no secret; the server actions re-derive it.
   */
  imageInput: boolean;
}

/** The student-facing projection of a quiz — everything the runner needs, nothing more. */
export interface QuizPublic {
  id: string;
  /** Optional welcome-screen title. */
  title?: string;
  /** Optional welcome-screen description (markdown). */
  description?: string;
  /** Present questions in a random order per attempt. */
  shuffle: boolean;
  /**
   * Questions per attempt — the EFFECTIVE `question_count`, resolved server-side to
   * the pool size when the quiz doesn't set one. May exceed the pool size (drill
   * mode — questions repeat). Drives the runner's sequence + progress label only;
   * grading stays per-question and stateless.
   */
  questionCount: number;
  questions: QuizQuestionPublic[];
}

/** A question with its `image` resolved to a usable URL for `<ContentImage>`. */
export interface ResolvedQuizQuestion extends Omit<QuizQuestionPublic, "image"> {
  image?: ResolvedImage;
}

/** A quiz whose questions carry resolved images — what the runner renders. */
export interface ResolvedQuiz extends Omit<QuizPublic, "questions"> {
  questions: ResolvedQuizQuestion[];
}
