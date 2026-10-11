"use client";

import { useId, useState } from "react";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FieldError } from "@/components/ui/field";
import { deleteMyQuizResults, updateUserSettings } from "@/lib/user-settings-actions";
import { cn } from "@/lib/utils";

// The Settings page's "Quiz and exercise results" section: the switch behind the Finish
// page's "Always", and the student's saved results with a confirmed delete.
// The switch updates optimistically and rolls back with a message when the
// save fails — also when the call itself is lost (a rejected server action);
// deleting results never revokes an earned badge.

const SAVE_FAILED = "Your settings could not be saved right now. Please try again.";
const DELETE_FAILED = "Your saved results could not be deleted right now. Please try again.";

export function QuizResultsSettings({
  initialSaveQuizResults,
  initialSaved,
}: {
  initialSaveQuizResults: boolean;
  initialSaved: number;
}) {
  const [on, setOn] = useState(initialSaveQuizResults);
  const [switching, setSwitching] = useState(false);
  const [saved, setSaved] = useState(initialSaved);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const noticeId = useId();

  async function toggle() {
    if (switching) return;
    const next = !on;
    setOn(next);
    setSwitching(true);
    setError(null);
    const result = await updateUserSettings({ saveQuizResults: next }).catch(() => ({
      ok: false as const,
      message: SAVE_FAILED,
    }));
    setSwitching(false);
    if (!result.ok) {
      setOn(!next);
      setError(result.message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span id={labelId} className="font-medium text-sm">
            Save my quiz and exercise results for my personal statistics
          </span>
          <p id={noticeId} className="text-foreground/65 text-sm">
            Saved results give you medals, retake reminders and quiz badges on your start page. Only
            you can see them — your teacher cannot.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={noticeId}
          disabled={switching}
          onClick={toggle}
          className={cn(
            "relative mt-0.5 inline-flex h-6 w-11 flex-none cursor-pointer items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-wait",
            on ? "bg-foreground" : "bg-foreground/20",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-block size-5 rounded-full bg-background shadow-sm transition-transform",
              on ? "translate-x-5.5" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-foreground/10 border-t pt-4">
        <p className="text-sm" data-testid="saved-results">
          {saved === 0
            ? "You have no saved results."
            : `You have ${saved.toLocaleString("en")} saved result${saved === 1 ? "" : "s"}.`}
        </p>
        <DeleteResultsButton
          disabled={saved === 0}
          onDeleted={() => setSaved(0)}
          onError={setError}
        />
      </div>

      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

function DeleteResultsButton({
  disabled,
  onDeleted,
  onError,
}: {
  disabled: boolean;
  onDeleted: () => void;
  onError: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setPending(false);
    setError(null);
  }

  async function onConfirm() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await deleteMyQuizResults().catch(() => ({
      ok: false as const,
      message: DELETE_FAILED,
    }));
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    close();
    onError(null);
    onDeleted();
  }

  return (
    <>
      <Button
        variant="destructiveOutline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Delete my saved results
      </Button>
      <DialogShell
        open={open}
        onClose={close}
        title="Delete your saved results?"
        size="fit"
        className="w-[min(32rem,92vw)]"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <p>
            Your medals and retake reminders start over. Badges you have already earned stay. This
            cannot be undone.
          </p>
          <div className="flex items-center gap-3">
            <Button variant="destructiveOutline" onClick={onConfirm} disabled={pending}>
              {pending ? (
                <>
                  <Spinner /> Deleting…
                </>
              ) : (
                "Delete"
              )}
            </Button>
            <Button variant="outline" onClick={close} disabled={pending}>
              Cancel
            </Button>
          </div>
          {error ? <FieldError>{error}</FieldError> : null}
        </div>
      </DialogShell>
    </>
  );
}
