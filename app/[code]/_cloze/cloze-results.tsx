"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { CheckIcon, MinusIcon, RotateCcwIcon, XIcon } from "@/components/icons";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { cardVariants } from "@/components/ui/card";
import { VERDICT_VARS } from "@/components/ui/verdict";
import type { ClozeGapNote, ClozePattern } from "@/lib/cloze-grounding";
import type { ClozeGapPublic } from "@/lib/cloze-types";
import type { QuizVerdict } from "@/lib/quiz-types";
import { cn } from "@/lib/utils";
import { ClozeText } from "./cloze-text";

// The cloze results screen (docs/cloze.md, "Results screen"): the "Your feedback"
// card (verdict counts, then the grounded patterns once `explainCloze` returns), the
// text with a verdict chip per gap — colour AND shape (✓ / – / ✕) — and the panel of
// the selected gap (the student's answer, a possible answer, the gap's note). Every
// chip is a real button; a pattern's "See your answers" chips select a gap and bring
// it into view. Model text renders as plain text, never Markdown.

/** One graded submission, as `gradeCloze` returned it. */
export interface Graded {
  attemptId: string;
  answers: string[];
  verdicts: QuizVerdict[];
  references: string[];
  resultToken: string;
}

/** The consolidated-feedback state of the graded submission. */
export type Feedback =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "all-correct" }
  | { status: "done"; patterns: ClozePattern[]; gapNotes: ClozeGapNote[] };

const MUTED = "text-foreground/60 text-sm";

const VERDICT_ICONS: Record<QuizVerdict, (props: { className?: string }) => ReactNode> = {
  correct: CheckIcon,
  partial: MinusIcon,
  incorrect: XIcon,
};

/** The student-facing verdict of one gap — an empty wrong answer reads "Not answered". */
function verdictText(verdict: QuizVerdict, answer: string): string {
  if (verdict === "incorrect" && answer.trim() === "") return "Not answered";
  return { correct: "Correct", partial: "Partly correct", incorrect: "Wrong" }[verdict];
}

function VerdictIcon({ verdict, className }: { verdict: QuizVerdict; className?: string }) {
  const Icon = VERDICT_ICONS[verdict];
  return <Icon className={cn("size-4 shrink-0", className)} />;
}

export function ClozeResults({
  text,
  gaps,
  graded,
  feedback,
  onRetryFeedback,
  onTryAgain,
}: {
  text: string;
  gaps: ClozeGapPublic[];
  graded: Graded;
  feedback: Feedback;
  onRetryFeedback: () => void;
  onTryAgain: () => void;
}) {
  const { verdicts, answers, references } = graded;
  const total = verdicts.length;
  const firstMiss = verdicts.findIndex((verdict) => verdict !== "correct");
  const [selected, setSelected] = useState(firstMiss >= 0 ? firstMiss + 1 : 1);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const chipRefs = useRef(new Map<number, HTMLButtonElement>());

  // Results replace the text in place: move the focus (and the view) to the feedback.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  function reveal(gap: number) {
    setSelected(gap);
    chipRefs.current.get(gap)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  const counts = { correct: 0, partial: 0, incorrect: 0 };
  for (const verdict of verdicts) counts[verdict] += 1;
  const misses = total - counts.correct;

  function renderChip(number: number): ReactNode {
    const verdict = verdicts[number - 1];
    if (!verdict) return null;
    const answer = answers[number - 1] ?? "";
    const hint = gaps[number - 1]?.hint;
    const isSelected = selected === number;
    return (
      <span className="whitespace-nowrap">
        <sup aria-hidden="true" className="mr-0.5 text-foreground/55">
          {number}
        </sup>
        <button
          type="button"
          ref={(node) => {
            if (node) chipRefs.current.set(number, node);
            else chipRefs.current.delete(number);
          }}
          aria-pressed={isSelected}
          aria-label={`Gap ${number}: ${answer.trim() || "empty"} — ${verdictText(verdict, answer)}`}
          data-testid={`cloze-chip-${number}`}
          data-verdict={verdict}
          onClick={() => setSelected(number)}
          className={cn(
            "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-(--verdict) bg-(--verdict)/5 px-3 align-baseline text-(--verdict) text-base leading-none focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
            isSelected && "ring-(--verdict) ring-2 ring-offset-2",
            VERDICT_VARS[verdict],
          )}
        >
          {answer.trim() ? answer : <em className="text-sm opacity-75">empty</em>}
          <VerdictIcon verdict={verdict} />
        </button>
        {hint ? <span className="ml-1 text-foreground/55 text-sm">({hint})</span> : null}
      </span>
    );
  }

  const selectedVerdict = verdicts[selected - 1] ?? "incorrect";
  const selectedAnswer = answers[selected - 1] ?? "";
  const note =
    feedback.status === "done"
      ? feedback.gapNotes.find((entry) => entry.gap === selected)?.note
      : undefined;

  return (
    <>
      <section className={cardVariants({ pad: "section" })} aria-labelledby="cloze-feedback">
        <h2
          id="cloze-feedback"
          ref={headingRef}
          tabIndex={-1}
          className="font-bold text-xl focus:outline-none"
        >
          Your feedback
        </h2>
        <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm" data-testid="cloze-counts">
          {(["correct", "partial", "incorrect"] as const).map((verdict) => (
            <span
              key={verdict}
              className={cn("flex items-center gap-1.5 text-(--verdict)", VERDICT_VARS[verdict])}
            >
              <VerdictIcon verdict={verdict} />
              <strong>{counts[verdict]}</strong>
              {verdict === "incorrect" ? "wrong" : verdict}
            </span>
          ))}
        </p>
        <div className="mt-4 border-foreground/15 border-t pt-4">
          <FeedbackBody
            feedback={feedback}
            total={total}
            misses={misses}
            selected={selected}
            onSelect={reveal}
            onRetry={onRetryFeedback}
          />
        </div>
      </section>

      <section className={cardVariants({ pad: "section" })}>
        <ClozeText text={text} renderGap={renderChip} />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-foreground/15 border-t pt-4">
          <p className={MUTED}>
            All {total} {total === 1 ? "answer" : "answers"} · select a gap for its explanation
          </p>
          <Button variant="outline" onClick={onTryAgain}>
            Try again <RotateCcwIcon />
          </Button>
        </div>
      </section>

      <section
        className={cn(cardVariants({ pad: "section" }), VERDICT_VARS[selectedVerdict])}
        aria-live="polite"
        data-testid="cloze-gap-panel"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-lg">Gap {selected}</h2>
          <span className="flex items-center gap-1.5 font-semibold text-(--verdict) text-sm">
            <VerdictIcon verdict={selectedVerdict} />
            {verdictText(selectedVerdict, selectedAnswer)}
          </span>
        </div>
        <dl className="mt-3 grid gap-3 border-foreground/15 border-y py-3 sm:grid-cols-2">
          <div>
            <dt className={MUTED}>Your answer</dt>
            <dd className="mt-1 font-semibold">{selectedAnswer.trim() || "(no answer)"}</dd>
          </div>
          <div>
            <dt className={MUTED}>A possible answer</dt>
            <dd className="mt-1 font-semibold">{references[selected - 1] || "(leave empty)"}</dd>
          </div>
        </dl>
        {note ? <p className="mt-3 leading-relaxed">{note}</p> : null}
        {!note && feedback.status === "loading" && selectedVerdict !== "correct" ? (
          <p className={cn("mt-3", MUTED)}>The explanation is on its way…</p>
        ) : null}
      </section>
    </>
  );
}

function FeedbackBody({
  feedback,
  total,
  misses,
  selected,
  onSelect,
  onRetry,
}: {
  feedback: Feedback;
  total: number;
  misses: number;
  selected: number;
  onSelect: (gap: number) => void;
  onRetry: () => void;
}) {
  switch (feedback.status) {
    case "all-correct":
      return (
        <p>
          All {total} {total === 1 ? "gap" : "gaps"} correct.
        </p>
      );
    case "loading":
      return (
        <p role="status" className={cn("flex items-center gap-2", MUTED)}>
          <Spinner /> Looking for patterns in your answers…
        </p>
      );
    case "failed":
      return (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-destructive text-sm">
            {feedback.message}
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      );
    case "done":
      if (feedback.patterns.length === 0) {
        return (
          <p>
            {misses >= 2
              ? "Your mistakes don't share a common cause — see each gap below."
              : "Select the marked gap below for its explanation."}
          </p>
        );
      }
      return (
        <div
          className={cn(
            "grid gap-6",
            feedback.patterns.length > 1 && "md:grid-cols-2",
            feedback.patterns.length > 2 && "lg:grid-cols-3",
          )}
        >
          {feedback.patterns.map((pattern) => (
            <article
              key={pattern.title + pattern.gaps.join()}
              data-testid="cloze-pattern"
              className="flex flex-col gap-3 md:not-first:border-foreground/15 md:not-first:border-l md:not-first:pl-6"
            >
              <h3 className="font-semibold">{pattern.title}</h3>
              <p className="leading-relaxed">{pattern.explanation}</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className={MUTED}>See your answers</span>
                {pattern.gaps.map((gap) => (
                  <Button
                    key={gap}
                    size="sm"
                    variant="outline"
                    aria-pressed={selected === gap}
                    onClick={() => onSelect(gap)}
                    className={cn(
                      selected === gap &&
                        "border-foreground bg-foreground text-background not-disabled:hover:bg-foreground/90",
                    )}
                  >
                    Gap {gap}
                  </Button>
                ))}
              </div>
              <p className="leading-relaxed">
                <strong>Next time:</strong> {pattern.nextTime}
              </p>
            </article>
          ))}
        </div>
      );
  }
}
