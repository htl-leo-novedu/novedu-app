"use client";

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { HelpCircleIcon, InfoIcon } from "@/components/icons";
import { TOOLTIP_SURFACE } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// A small round icon button explaining the thing next to it in a tooltip that
// opens on hover and keyboard focus, stays open while the pointer moves onto
// it, and closes on Escape (WCAG 1.4.13: hoverable, dismissible). Used by the
// teacher board's "Outside school hours" column and the usage dashboard's cost
// card. The icon is picked by name, so a server component can render it.

/** How long the tooltip waits before closing, so the pointer can cross the gap onto it. */
const TIP_GRACE_MS = 150;

const ICONS = { info: InfoIcon, help: HelpCircleIcon } as const;

export function HelpTip({
  label,
  icon = "info",
  children,
}: {
  /** The button's accessible name, e.g. "What counts as outside school hours". */
  label: string;
  /** `info` = a circled "i", `help` = a circled "?". */
  icon?: keyof typeof ICONS;
  /** The explanation; it also becomes the button's accessible description. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const Icon = ICONS[icon];

  const cancelHide = useCallback(() => clearTimeout(hideTimer.current), []);
  const show = () => {
    cancelHide();
    setOpen(true);
  };
  const hideSoon = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => setOpen(false), TIP_GRACE_MS);
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => cancelHide, [cancelHide]);

  return (
    <span className="relative inline-flex" onPointerEnter={show} onPointerLeave={hideSoon}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={tipId}
        onFocus={show}
        onBlur={() => setOpen(false)}
        className="inline-flex size-5 cursor-help items-center justify-center rounded-full text-foreground/60 hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <Icon className="size-3.5" />
      </button>
      <span
        id={tipId}
        role="tooltip"
        hidden={!open}
        className={cn(
          TOOLTIP_SURFACE,
          // Undo what a surrounding heading or table head sets: uppercase,
          // tracking, weight and nowrap.
          "absolute top-full right-0 z-10 mt-1.5 w-max max-w-72 whitespace-normal text-left font-normal normal-case tracking-normal",
        )}
      >
        {children}
      </span>
    </span>
  );
}
