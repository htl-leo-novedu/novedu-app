"use client";

import { useId, useState } from "react";
import { FlagIcon } from "@/components/icons";
import { Spinner } from "@/components/spinner";
import { ATTRIBUTION_NOTICE } from "@/components/ui/attribution-notice";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Field, FieldError, FieldLabel, FieldSuccess } from "@/components/ui/field";
import { onModEnter, SUBMIT_KEYSHORTCUTS, useShortcutHint } from "@/lib/keyboard-shortcuts";
import type { QuizVerdict } from "@/lib/quiz-types";
import { submitChatReport, submitQuizReport } from "@/lib/report-actions";
import {
  REPORT_DESCRIPTION_MAX,
  REPORT_REACTION_LABELS,
  REPORT_REACTIONS,
  type ReportReaction,
} from "@/lib/report-types";
import { cn } from "@/lib/utils";

// THE ONE student-facing "report" control for all four reportable surfaces (the
// three chat surfaces + a graded quiz answer, GH issue #24). It is a small,
// unobtrusive button that opens a DialogShell holding the report form: the fixed
// four-level reaction scale as single-select toggles, an optional capped
// description, and the MANDATORY attribution notice — reports are attributed to
// the reporting student even on anonymous codes (a voluntary waiver, see
// docs/reports.md), so the form says so plainly.
//
// The component owns the DialogShell open state (it is the shell's caller) and
// dispatches to the right server action on `target.kind`. It uses no CopilotKit
// hooks, so mounting it as a `ModuleChat` child (writing) is safe. The server
// actions re-derive the reporter's user id from the session and re-verify the
// thread-ownership token / re-load the quiz question — the client is never
// trusted (see lib/report-actions.ts).

/** What a single ReportButton reports — a chat thread or one graded quiz answer. */
export type ReportTarget =
  | { kind: "chat"; code: string; threadId: string; threadToken: string }
  | {
      kind: "quiz-answer";
      code: string;
      questionId: string;
      answer: string;
      result: QuizVerdict;
      feedback: string;
      hadImages: boolean;
    };

// The reaction toggle recipe lives here only (one place, so inline per the
// styling reuse rule): the urgent `holysh` tier is red/destructive, the rest use
// the primary accent when picked and a neutral outline when not.
function reactionToggleClass(reaction: ReportReaction, selected: boolean): string {
  const base =
    "inline-flex h-8 cursor-pointer items-center rounded-full border px-3 font-semibold text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";
  if (reaction === "holysh") {
    return cn(
      base,
      selected
        ? "border-destructive bg-destructive text-white"
        : "border-destructive/45 text-destructive not-disabled:hover:bg-destructive/10",
    );
  }
  return cn(
    base,
    selected
      ? "border-primary bg-primary text-primary-foreground"
      : "border-foreground/25 text-foreground not-disabled:hover:bg-foreground/5",
  );
}

export function ReportButton({ target, className }: { target: ReportTarget; className?: string }) {
  const [open, setOpen] = useState(false);
  const [reaction, setReaction] = useState<ReportReaction | null>(null);
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const submitHint = useShortcutHint("submit");

  // The attribution notice names the reported thing by kind; the answer/quiz
  // wording is only reached from the quiz grade card.
  const targetNoun = target.kind === "chat" ? "conversation" : "answer";

  function resetForm() {
    setReaction(null);
    setDescription("");
    setPending(false);
    setSubmitted(false);
    setError(null);
  }

  function close() {
    setOpen(false);
    // Reset so reopening (or a second report on the same target) starts clean.
    resetForm();
  }

  async function onSubmit() {
    if (!reaction || pending) return;
    setPending(true);
    setError(null);
    const result =
      target.kind === "chat"
        ? await submitChatReport({
            code: target.code,
            threadId: target.threadId,
            threadToken: target.threadToken,
            reaction,
            description,
          })
        : await submitQuizReport({
            code: target.code,
            questionId: target.questionId,
            answer: target.answer,
            result: target.result,
            feedback: target.feedback,
            hadImages: target.hadImages,
            reaction,
            description,
          });
    setPending(false);
    if (result.ok) setSubmitted(true);
    else setError(result.message);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={cn("text-foreground/70", className)}
        onClick={() => setOpen(true)}
      >
        <FlagIcon /> Report
      </Button>

      <DialogShell
        open={open}
        onClose={close}
        title="Report to your teacher"
        size="fit"
        className="w-[min(32rem,92vw)]"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {submitted ? (
            <FieldSuccess>Thanks — your teacher will take a look.</FieldSuccess>
          ) : (
            <>
              {/* MANDATORY, visually prominent: reports waive anonymity. */}
              <p className={ATTRIBUTION_NOTICE}>
                Reports are not anonymous — your name and this {targetNoun} will be shared with your
                teacher.
              </p>

              <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
                <legend className="mb-1.5 font-semibold text-foreground/70 text-xs">
                  How was this {targetNoun}?
                </legend>
                <div className="flex flex-wrap gap-2">
                  {REPORT_REACTIONS.map((r) => {
                    const selected = reaction === r;
                    return (
                      <button
                        key={r}
                        type="button"
                        aria-pressed={selected}
                        className={reactionToggleClass(r, selected)}
                        onClick={() => setReaction(r)}
                        disabled={pending}
                      >
                        {REPORT_REACTION_LABELS[r]}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <Field>
                <FieldLabel htmlFor={descriptionId}>What happened? (optional)</FieldLabel>
                <textarea
                  id={descriptionId}
                  className="min-h-24 w-full resize-y rounded-lg border border-foreground/25 bg-background px-3 py-2 text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1"
                  value={description}
                  maxLength={REPORT_DESCRIPTION_MAX}
                  onChange={(event) => setDescription(event.target.value)}
                  onKeyDown={onModEnter(onSubmit)}
                  aria-keyshortcuts={SUBMIT_KEYSHORTCUTS}
                  disabled={pending}
                  placeholder="Add anything that would help your teacher understand…"
                />
                <p className="text-right text-foreground/55 text-xs">
                  {description.length} / {REPORT_DESCRIPTION_MAX}
                </p>
              </Field>

              <div className="flex items-center gap-3">
                <Button
                  onClick={onSubmit}
                  title={`Send report (${submitHint})`}
                  disabled={!reaction || pending}
                >
                  {pending ? (
                    <>
                      <Spinner /> Sending…
                    </>
                  ) : (
                    "Send report"
                  )}
                </Button>
              </div>

              {error ? <FieldError>{error}</FieldError> : null}
            </>
          )}
        </div>
      </DialogShell>
    </>
  );
}
