"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The app's single modal: a native <dialog> (writing lightboxes, quiz
// discussion, teacher transcript, image lightbox). DialogShell owns the whole
// behavior contract — showModal()/close() driven by the `open` prop, closing on
// Escape, backdrop click, and the header's Close button, all routed through
// `onClose` so the caller stays the single source of open/closed truth.
//
// The shell is a flex COLUMN: DIALOG_BODY (flex-1) fills and scrolls without
// any per-consumer wrapper. `open:flex` — never a bare `flex` — because an
// author `display` beats the UA's `dialog:not([open]) { display: none }`, and a
// closed dialog would render inline. `m-auto` is load-bearing — Tailwind
// preflight zeroes the UA dialog margin that centers native modals in the top
// layer. `className` is a cn-merged WIDTH delta (e.g. "w-[min(32rem,92vw)]");
// height goes through the `size` variant, never a raw `h-*` class.
// `whitespace-normal` because the top layer does NOT break CSS inheritance: a
// dialog mounted next to its trigger inside e.g. a `whitespace-nowrap` table
// cell (the list rows' actions column) would inherit nowrap and stop wrapping
// its entire content — the shell resets it so a dialog reads the same from
// every mount point.
const dialogShellVariants = cva(
  "m-auto w-[min(48rem,92vw)] flex-col overflow-hidden whitespace-normal rounded-xl border border-foreground/15 bg-background p-0 text-foreground backdrop:bg-foreground/45 open:flex dark:backdrop:bg-black/60",
  {
    variants: {
      size: {
        // A fixed tall box for the dialogs that host an open-ended surface
        // (the transcript, the quiz discussion, the writing lightbox).
        tall: "h-[80vh]",
        // Shrink-to-fit for short content (confirmations, forms, images).
        // `h-fit`, NEVER `h-auto`: the UA gives an open modal `position: fixed`
        // with ALL insets 0 (the spec zeroes the inline pair on every dialog,
        // `dialog:modal` adds the block pair), and with `height: auto` those
        // insets resolve against the viewport, so the box stretches to the
        // full height (capped by max-h) and `m-auto` never centers it —
        // margin auto only centers a DEFINITE height. `fit-content` is
        // definite, so it wraps the content and centers. The inline axis has
        // the SAME trap: widths behave only because the shell always sets a
        // definite `w-*`, so a consumer overriding width must pass `w-fit`,
        // never `w-auto` (which stretches to the max-w cap exactly like
        // `h-auto` did vertically).
        fit: "h-fit max-h-[85vh]",
      },
    },
    defaultVariants: { size: "tall" },
  },
);

const HEADER = "flex items-center justify-between gap-4 border-foreground/15 border-b px-4 py-3";

// The scrolling content region for text-like dialogs; image-like content
// renders as bare children instead and sizes itself against the flex column.
// `wrap-anywhere` (overflow-wrap inherits) because dialog bodies show
// untrusted student text: a long unbroken token must wrap, not hand the modal
// a horizontal scrollbar (`overflow-y-auto` computes overflow-x to auto).
export const DIALOG_BODY = "wrap-anywhere min-h-0 flex-1 overflow-y-auto p-4";

export function DialogShell({
  open,
  onClose,
  title,
  size,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  className?: string;
  children: ReactNode;
} & VariantProps<typeof dialogShellVariants>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // No unmount cleanup, deliberately: the browser drops an unmounted open
  // dialog from the top layer by itself, and a cleanup close() would fire a
  // REAL close event during StrictMode's simulated mount cycle — a dialog
  // that mounts already open would tell its parent to close it again.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss is mouse-only; the native <dialog> already closes on Escape (onCancel/onClose), and the header Close button covers keyboard users.
    <dialog
      ref={dialogRef}
      className={cn(dialogShellVariants({ size }), className)}
      onClose={onClose}
      onCancel={onClose}
      // Clicking the backdrop (the dialog element itself, not its content) closes it.
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className={HEADER}>
        {/* The empty span keeps Close right-aligned when there is no title. */}
        {title != null ? <h3 className="font-semibold text-base">{title}</h3> : <span />}
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
      {children}
    </dialog>
  );
}
