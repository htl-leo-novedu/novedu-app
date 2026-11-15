"use client";

import { useState } from "react";
import { LocalTime } from "@/app/local-time";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { cardVariants } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { handInToMoodle } from "@/lib/moodle-actions";
import type { Receipt } from "@/lib/moodle-receipt";
import { describeCounts, type HandInCounts, moodlePercent } from "@/lib/moodle-score";
import { cn } from "@/lib/utils";

// The Finish page's "Hand in to Moodle" box (docs/moodle.md), below the "save to
// your personal statistics" step and independent of it. Mounted only where a
// hand-in is possible (the quiz page found a hand-in target for this student
// and code) and something was answered. One click sends the attempt's signed
// receipts; the server counts them and posts the score. Never an automatic
// retry: a failure shows its message, and "Try again" only where it can help.

type State =
  | { kind: "ready"; error?: string }
  | { kind: "working" }
  | { kind: "done"; handedInAt: string; percent: number }
  | { kind: "refused"; message: string };

const HAND_IN_FAILED = "Moodle could not be reached right now. Please try again.";

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export function HandIn({
  code,
  attemptId,
  receipts,
  counts,
  total,
  handedInAt,
}: {
  code: string;
  attemptId: string;
  /** The attempt's receipts, one per answered slot. */
  receipts: Receipt[];
  counts: HandInCounts;
  total: number;
  /** When this student last handed in this code to the same Moodle activity, else `null`. */
  handedInAt: string | null;
}) {
  const [state, setState] = useState<State>({ kind: "ready" });
  const percent = moodlePercent(counts, total);

  async function handIn() {
    if (state.kind === "working") return;
    setState({ kind: "working" });
    const result = await handInToMoodle({ code, attemptId, receipts }).catch(() => ({
      ok: false as const,
      message: HAND_IN_FAILED,
      retry: true,
    }));
    if (result.ok) {
      setState({ kind: "done", handedInAt: result.handedInAt, percent: result.percent });
    } else if (result.retry) {
      setState({ kind: "ready", error: result.message });
    } else {
      setState({ kind: "refused", message: result.message });
    }
  }

  return (
    <section
      aria-labelledby="hand-in-heading"
      className={cn(cardVariants({ pad: "compact" }), "flex flex-col gap-3")}
      data-testid="moodle-hand-in"
    >
      <h2 id="hand-in-heading" className="font-semibold text-sm">
        Hand in to Moodle
      </h2>
      {state.kind === "done" ? (
        <p role="status" className="text-sm">
          Handed in to Moodle on <LocalTime seconds={seconds(state.handedInAt)} /> ({state.percent}{" "}
          %).
        </p>
      ) : (
        <>
          <p className="text-sm">
            Moodle receives: {describeCounts(counts, total)} ({percent} %).
          </p>
          <p className="text-foreground/65 text-sm">
            Your teacher sees this in Moodle under your name.
          </p>
          {state.kind === "refused" ? (
            <FieldError>{state.message}</FieldError>
          ) : (
            <>
              {handedInAt ? (
                <p className="text-foreground/65 text-sm">
                  You already handed in on <LocalTime seconds={seconds(handedInAt)} />. Handing in
                  again replaces it.
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={handIn} disabled={state.kind === "working"}>
                  {state.kind === "working" ? (
                    <>
                      <Spinner /> Handing in…
                    </>
                  ) : state.kind === "ready" && state.error ? (
                    "Try again"
                  ) : (
                    "Hand in"
                  )}
                </Button>
              </div>
              {state.kind === "ready" && state.error ? (
                <FieldError>{state.error}</FieldError>
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  );
}
