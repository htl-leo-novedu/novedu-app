"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { cardVariants } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { type SaveQuizResultResult, saveQuizResult } from "@/lib/quiz-actions";
import { cn } from "@/lib/utils";

// The Finish page's "save to your personal statistics" step (docs/home.md →
// Saving a quiz result). With the setting off it asks — No / This time / Always
// — behind the notice that only the student can see the result. With the
// setting on it saves at once (mode `automatic`; the server re-reads the
// setting, so a stale "on" can never save) and says so, linking to Settings.
// An automatic save that finds the setting off falls back to asking. A failure
// shows its message and keeps the choices, so the student can try again.
// Never mounted for an attempt with nothing answered. Shared with the cloze
// results screen, which passes its own `save` action (`saveClozeResult`); both
// write the same store under the same setting.

export interface AttemptCounts {
  correct: number;
  partial: number;
  incorrect: number;
  unanswered: number;
}

/** A save action: `saveQuizResult` or `saveClozeResult` (the same input and result). */
export type SaveAction = (input: {
  code: string;
  attemptId: string;
  counts: AttemptCounts;
  total: number;
  mode: "this-time" | "always" | "automatic";
}) => Promise<SaveQuizResultResult>;

type State =
  | { kind: "ask"; error?: string }
  | { kind: "saving" }
  | { kind: "saved"; always: boolean }
  | { kind: "declined" };

const SETTINGS_LINK = (
  <Link href="/settings" className="underline underline-offset-2 hover:text-foreground">
    Settings
  </Link>
);

export function SaveResult({
  code,
  attemptId,
  counts,
  total,
  autoSave,
  save: saveAction = saveQuizResult,
}: {
  code: string;
  attemptId: string;
  counts: AttemptCounts;
  total: number;
  /** The user's setting at page render — a display hint; the server decides. */
  autoSave: boolean;
  /** The server action that saves; the quiz's by default. */
  save?: SaveAction;
}) {
  const [state, setState] = useState<State>(autoSave ? { kind: "saving" } : { kind: "ask" });
  const autoStarted = useRef(false);

  async function save(mode: "this-time" | "always" | "automatic") {
    setState({ kind: "saving" });
    // A dropped connection rejects the call; it must not escape the effect below.
    const result = await saveAction({ code, attemptId, counts, total, mode }).catch(() => ({
      ok: false as const,
      message: "Your result could not be saved right now. Please try again.",
    }));
    if (!result.ok) setState({ kind: "ask", error: result.message });
    else if (!result.saved) setState({ kind: "ask" });
    else setState({ kind: "saved", always: mode === "always" });
  }

  // Once per Finish page: a re-render must never save twice (a repeated save of
  // one attempt id is a no-op on the server anyway).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount by design.
  useEffect(() => {
    if (!autoSave || autoStarted.current) return;
    autoStarted.current = true;
    void save("automatic");
  }, []);

  if (state.kind === "saving") {
    return (
      <p role="status" className="flex items-center gap-2 text-foreground/65 text-sm">
        <Spinner /> Saving to your personal statistics…
      </p>
    );
  }
  if (state.kind === "saved") {
    return (
      <p role="status" className="text-foreground/65 text-sm">
        {state.always
          ? "Saved to your personal statistics — from now on, results are saved automatically. "
          : "Saved to your personal statistics. "}
        Only you can see it. Change this in {SETTINGS_LINK}.
      </p>
    );
  }
  if (state.kind === "declined") {
    return (
      <p role="status" className="text-foreground/65 text-sm">
        Not saved.
      </p>
    );
  }
  return (
    <section
      aria-labelledby="save-result-question"
      className={cn(cardVariants({ pad: "compact" }), "flex flex-col gap-3")}
    >
      <p id="save-result-question" className="text-sm">
        <span className="font-semibold">Save this result to your personal statistics?</span> Only
        you can see it — your teacher cannot.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setState({ kind: "declined" })}>
          No
        </Button>
        <Button variant="outline" size="sm" onClick={() => save("this-time")}>
          This time
        </Button>
        <Button variant="outline" size="sm" onClick={() => save("always")}>
          Always
        </Button>
      </div>
      <p className="text-foreground/65 text-xs">
        Saved results become medals and retake reminders on your start page. Manage them in{" "}
        {SETTINGS_LINK}.
      </p>
      {state.error ? <FieldError>{state.error}</FieldError> : null}
    </section>
  );
}
