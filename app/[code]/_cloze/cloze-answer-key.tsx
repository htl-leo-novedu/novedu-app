"use client";

import type { CSSProperties, ReactNode } from "react";
import { VERDICT_VARS } from "@/components/ui/verdict";
import { type ClozeGapCount, gapTotal } from "@/lib/cloze-types";
import { cn } from "@/lib/utils";
import { ClozeText } from "./cloze-text";

// The teacher detail's answer key (docs/cloze.md → Teacher view): the current text
// read-only through the same `ClozeText` the student sees, each gap replaced by its
// number, the reference, the hint and a compact correct/partial/wrong bar with `n`.
// A client component only because `ClozeText` takes the per-gap renderer as a
// function; everything it shows arrives as plain data.

/** One gap of the current text with its counts (zero when nothing was submitted yet). */
export type GapResult = ClozeGapCount & { hint?: string };

const SEGMENTS = ["correct", "partial", "incorrect"] as const;

/** A thin three-segment bar of one gap's verdict shares, with its `n`. */
export function GapBar({ gap }: { gap: GapResult }) {
  const n = gapTotal(gap);
  const label =
    n === 0
      ? "no submissions yet"
      : `${gap.correct} correct, ${gap.partial} partial, ${gap.incorrect} wrong of ${n}`;
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <span
        role="img"
        aria-label={label}
        className="inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-foreground/10"
      >
        {n > 0
          ? SEGMENTS.map((verdict) =>
              gap[verdict] > 0 ? (
                <span
                  key={verdict}
                  data-verdict={verdict}
                  className={cn("h-full w-(--share) bg-(--verdict)", VERDICT_VARS[verdict])}
                  style={{ "--share": `${(gap[verdict] / n) * 100}%` } as CSSProperties}
                />
              ) : null,
            )
          : null}
      </span>
      <span className="text-foreground/60 text-xs tabular-nums">n={n}</span>
    </span>
  );
}

export function ClozeAnswerKey({ text, gaps }: { text: string; gaps: GapResult[] }) {
  function renderGap(number: number): ReactNode {
    const gap = gaps[number - 1];
    if (!gap) return null;
    return (
      <span
        data-testid={`cloze-key-gap-${number}`}
        className="inline-flex flex-wrap items-baseline gap-x-1.5 rounded-md border border-foreground/20 bg-foreground/5 px-2 leading-8"
      >
        <sup className="text-foreground/55">{number}</sup>
        {gap.reference ? (
          <strong>{gap.reference}</strong>
        ) : (
          <em className="text-foreground/60 text-sm">(empty)</em>
        )}
        {gap.hint ? <span className="text-foreground/55 text-sm">({gap.hint})</span> : null}
        <GapBar gap={gap} />
      </span>
    );
  }
  return <ClozeText text={text} renderGap={renderGap} />;
}
