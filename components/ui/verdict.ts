import type { QuizVerdict } from "@/lib/quiz-types";

// Verdict accent: a card, tile or chip sets a local --verdict var per result and
// its descendants (border, heading, number, icon) consume it, so each verdict
// colour lives in one place. Shared by the quiz runner and the cloze runner.
// (Named --verdict, not --accent: the global shadcn token block defines --accent.)
export const VERDICT_VARS: Record<QuizVerdict, string> = {
  correct: "[--verdict:var(--color-success)]",
  partial: "[--verdict:var(--color-warning)]",
  incorrect: "[--verdict:var(--color-destructive)]",
};
