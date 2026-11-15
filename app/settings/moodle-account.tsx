"use client";

import { useState } from "react";
import { LocalTime } from "@/app/local-time";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FieldError } from "@/components/ui/field";
import { unlinkMoodleAccount } from "@/lib/moodle-actions";

// The Settings page's "Moodle account" section (docs/moodle.md), rendered only
// while the session user has a link. Novedu keeps no Moodle name or username,
// so it cannot say which account; it says since when. Unlinking is confirmed
// first and deletes the link and every hand-in target; nothing is sent to Moodle.

const UNLINK_FAILED = "Your Moodle account could not be unlinked right now. Please try again.";

export function MoodleAccount({ linkedAtSeconds }: { linkedAtSeconds: number }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlinked, setUnlinked] = useState(false);

  function close() {
    setOpen(false);
    setPending(false);
    setError(null);
  }

  async function onConfirm() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await unlinkMoodleAccount().catch(() => ({
      ok: false as const,
      message: UNLINK_FAILED,
    }));
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    close();
    setUnlinked(true);
  }

  if (unlinked) {
    return (
      <p className="text-sm" role="status">
        Your Moodle account is no longer linked.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm">
        Your Novedu account is linked to a Moodle account since{" "}
        <LocalTime seconds={linkedAtSeconds} dateOnly />.
      </p>
      <Button variant="destructiveOutline" size="sm" onClick={() => setOpen(true)}>
        Unlink my Moodle account
      </Button>
      <DialogShell
        open={open}
        onClose={close}
        title="Unlink your Moodle account?"
        size="fit"
        className="w-[min(32rem,92vw)]"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <p>
            You won&apos;t be able to hand in to Moodle until you open an activity from Moodle again
            and confirm your account. Results already in Moodle stay there.
          </p>
          <div className="flex items-center gap-3">
            <Button variant="destructiveOutline" onClick={onConfirm} disabled={pending}>
              {pending ? (
                <>
                  <Spinner /> Unlinking…
                </>
              ) : (
                "Unlink"
              )}
            </Button>
            <Button variant="outline" onClick={close} disabled={pending}>
              Cancel
            </Button>
          </div>
          {error ? <FieldError>{error}</FieldError> : null}
        </div>
      </DialogShell>
    </div>
  );
}
