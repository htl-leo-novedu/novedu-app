import type { ReactElement, SVGProps } from "react";
import { CircleCheckIcon, CircleMinusIcon, CircleXIcon, HelpCircleIcon } from "@/components/icons";
import { Spinner } from "@/components/spinner";
import { cn } from "@/lib/utils";
import type { PrecheckState } from "./use-answer-precheck";

// The live pre-check's whole UI: a small tinted pill (icon + two-word label)
// beside the "Your answer" label, with the full caveat in the tooltip. Pure
// presentation (no "use client" needed — it only renders what the hook in
// use-answer-precheck.ts hands it), and the wording is OURS: the classifier
// produces an enum, never prose, so nothing model-generated is rendered.
//
// Colour alone would fail WCAG "use of colour" (and red/green is the
// colour-blind pair), so every state carries a distinct SHAPE and its label,
// plus the same sentence in `title` (the app's tooltip convention — no tooltip
// library) and `aria-label`. The sentence says "hint", not "grade", every time.

/** The student-facing wording per state — the one place these words are written. */
export const PRECHECK_LABELS = {
  checking: "checking…",
  correct: "looks correct",
  partial: "partly there",
  incorrect: "not yet",
  unsure: "unsure",
} as const;

export type PrecheckLabelKey = keyof typeof PRECHECK_LABELS;

/** The full tooltip/label sentence. Exported so tests assert the real wording. */
export function precheckHintText(key: PrecheckLabelKey): string {
  return `Live hint: ${PRECHECK_LABELS[key]} — a quick check while you type, not the final verdict.`;
}

// Same colour tokens as the verdict card's VERDICT_VARS (components/ui/verdict.ts), so a
// hint and the grade it anticipates never disagree on colour — which is why this
// is not a `Badge` (its palette is the list cells' emerald/orange/red, not the
// quiz's success/warning/destructive). `unsure` and `checking` stay neutral:
// they claim nothing about the answer.
const VISUALS: Record<
  PrecheckLabelKey,
  { Icon: (props: SVGProps<SVGSVGElement>) => ReactElement; tone: string }
> = {
  checking: {
    Icon: ({ className }) => <Spinner className={cn("size-4", className)} />,
    tone: "border-foreground/15 bg-foreground/5 text-muted-foreground",
  },
  correct: { Icon: CircleCheckIcon, tone: "border-success/30 bg-success/10 text-success" },
  partial: { Icon: CircleMinusIcon, tone: "border-warning/30 bg-warning/10 text-warning" },
  incorrect: {
    Icon: CircleXIcon,
    tone: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  unsure: {
    Icon: HelpCircleIcon,
    tone: "border-foreground/15 bg-foreground/5 text-muted-foreground",
  },
};

export function PrecheckIndicator({ state }: { state: PrecheckState }) {
  if (state.kind === "idle") return null;
  const key: PrecheckLabelKey = state.kind === "checking" ? "checking" : state.verdict;
  const { Icon, tone } = VISUALS[key];
  const text = precheckHintText(key);
  return (
    <span
      // `status` is a polite live region by definition: a change is read out
      // after the current word, never interrupting a student mid-sentence. The
      // accessible NAME is the full sentence (the caveat included); what gets
      // announced on change is the visible two-word label.
      role="status"
      aria-label={text}
      title={text}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-0.5 font-semibold text-sm",
        tone,
        // A hint about text the student has already changed: kept, but visibly
        // out of date until the next check confirms or replaces it.
        state.kind === "hint" && state.stale && "opacity-50",
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      <span className="first-letter:uppercase">{PRECHECK_LABELS[key]}</span>
    </span>
  );
}
