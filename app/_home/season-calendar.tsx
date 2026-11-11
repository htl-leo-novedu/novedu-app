"use client";

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TOOLTIP_SURFACE } from "@/components/ui/tooltip";
import type { CalendarCell } from "@/lib/home-data";
import { cn } from "@/lib/utils";
import { BadgeGlyph, FAMILY_BG, familyInk } from "./badge-disc";
import { dayLabel, HOME_CAPTION, monthLabel, plural } from "./home-ui";

// The season calendar's interactive grid: 26 ISO weeks × 7 days, one cell per
// Vienna-local day, badges pinned to the day their evidence was complete.
//
// - The grid is ONE tab stop; the arrow keys move a day cursor (up/down = a
//   day, left/right = a week) and a polite live region reads the day.
// - Hover, focus and tap show the same details in one tooltip. It stays open
//   while the pointer moves onto it (a short grace period bridges the gap) and
//   Escape dismisses it (WCAG 1.4.13: hoverable, dismissible).
// - Pins are real buttons with an accessible name.
// - On narrow screens the grid scrolls inside its card, starting at today.

const HEAT_BG = ["bg-heat-0", "bg-heat-1", "bg-heat-2", "bg-heat-3"] as const;

/** How long the tooltip waits for the pointer to cross from the grid onto it. */
const TIP_GRACE_MS = 150;
const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];

interface Tip {
  anchor: Element;
  content: ReactNode;
}

function dayDetails(cell: CalendarCell): { node: ReactNode; text: string } {
  const label = dayLabel(cell.date);
  if (cell.future) return { node: <b className="font-semibold">{label}</b>, text: label };
  const activity = cell.activeHours
    ? plural(cell.activeHours, "active hour", "active hours")
    : "Not active";
  return {
    node: (
      <>
        <b className="font-semibold">{label}</b>
        <br />
        {cell.activeHours ? activity : <span className="text-slate-300">{activity}</span>}
      </>
    ),
    text: `${label}, ${activity}`,
  };
}

function pinDetails(cell: CalendarCell): { node: ReactNode; text: string } {
  const earned = `Earned ${dayLabel(cell.date)}`;
  return {
    node: (
      <>
        {cell.pins.map((pin) => (
          <span key={pin.id} className="block">
            <b className="font-semibold">{pin.name}</b>{" "}
            <span className="text-slate-300">· {pin.criterion}</span>
          </span>
        ))}
        <span className="text-slate-300">{earned}</span>
      </>
    ),
    text: `${cell.pins.map((p) => `${p.name}, ${p.criterion}`).join("; ")}. ${earned}`,
  };
}

export function SeasonCalendar({
  cells,
  monthStarts,
  label,
}: {
  cells: CalendarCell[];
  monthStarts: (number | null)[];
  /** The grid's accessible name (the window's totals). */
  label: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tipRef = useRef<HTMLDivElement>(null);
  const todayIndex = Math.max(
    0,
    cells.findIndex((c) => c.today),
  );
  const [cursor, setCursor] = useState<number | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [live, setLive] = useState("");

  // Start at today: the newest week is at the right edge.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  const place = useCallback(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const r = tip.anchor.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.max(
      8,
      Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8),
    );
    let top = r.top - height - 8;
    if (top < 8) top = r.bottom + 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [tip]);

  useLayoutEffect(place, [place]);

  // Leaving the grid hides the tooltip only after a grace period, cancelled when
  // the pointer arrives on the tooltip itself.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelHide = useCallback(() => clearTimeout(hideTimer.current), []);
  const hideSoon = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setTip(null), TIP_GRACE_MS);
  }, []);
  useEffect(() => cancelHide, [cancelHide]);

  // Escape dismisses the tooltip wherever focus is (the grid, a pin, or none
  // for a hover); the day cursor stays.
  useEffect(() => {
    if (!tip) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTip(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tip]);

  // Any scroll (the page, the calendar) moves the anchor: follow it.
  useEffect(() => {
    if (!tip) return;
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [tip, place]);

  function showCell(index: number) {
    cancelHide();
    const cell = cells[index];
    const anchor = cellRefs.current[index];
    if (!cell || !anchor) return;
    const day = dayDetails(cell);
    const pins = cell.pins.length > 0 ? pinDetails(cell) : undefined;
    setTip({
      anchor,
      content: pins ? (
        <>
          {day.node}
          <br />
          {pins.node}
        </>
      ) : (
        day.node
      ),
    });
    return pins ? `${day.text}. ${pins.text}` : day.text;
  }

  function moveCursor(index: number) {
    const next = Math.max(0, Math.min(cells.length - 1, index));
    setCursor(next);
    cellRefs.current[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    setLive(showCell(next) ?? "");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    moveCursor((cursor ?? todayIndex) + step);
  }

  function showPin(index: number, anchor: Element) {
    cancelHide();
    const cell = cells[index];
    if (cell) setTip({ anchor, content: pinDetails(cell).node });
  }

  return (
    <>
      {/* Calendar geometry (arbitrary values on purpose): a fixed weekday-label
          column, and on phones fixed 20px (1.25rem) day columns and rows so the
          grid scrolls inside its card instead of shrinking below a tappable
          size; from md up, 26 flexible 3:2 columns. The padding keeps the
          today/cursor rings from being clipped by the scroller. */}
      <div ref={scroller} className="-mx-1.5 overflow-x-auto px-1.5 pt-2 pb-1.5">
        <div className="grid w-max grid-cols-[1.75rem_auto] gap-x-2 gap-y-1.5 md:w-auto md:min-w-190 md:grid-cols-[2.25rem_1fr]">
          <div
            aria-hidden="true"
            className={cn(
              HOME_CAPTION,
              "col-start-2 grid h-4 grid-cols-[repeat(26,1.25rem)] gap-1 md:grid-cols-26",
            )}
          >
            {monthStarts.map((month, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one fixed slot per week column
              <span key={i} className="whitespace-nowrap">
                {month === null ? "" : monthLabel(month)}
              </span>
            ))}
          </div>
          <div
            aria-hidden="true"
            className={cn(HOME_CAPTION, "grid grid-rows-[repeat(7,1.25rem)] gap-1 md:grid-rows-7")}
          >
            {WEEKDAY_LABELS.map((day, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one fixed slot per weekday row
              <span key={i} className="flex items-center">
                {day}
              </span>
            ))}
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; this is a keyboard-navigable calendar grid. */}
          <div
            role="group"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the grid is one tab stop; the arrow keys move a day cursor inside it.
            tabIndex={0}
            aria-label={label}
            aria-describedby="home-calendar-help"
            onKeyDown={onKeyDown}
            onFocus={(event) => {
              if (event.target === event.currentTarget) moveCursor(cursor ?? todayIndex);
            }}
            onBlur={(event) => {
              if (event.target === event.currentTarget) {
                setCursor(null);
                setTip(null);
              }
            }}
            onPointerLeave={hideSoon}
            className="grid grid-flow-col grid-cols-[repeat(26,1.25rem)] grid-rows-[repeat(7,1.25rem)] gap-1 outline-none md:grid-cols-26 md:grid-rows-7"
          >
            {cells.map((cell, index) => {
              const top = cell.pins[cell.pins.length - 1];
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: pointer details for a day; keyboard users reach the same details through the grid's arrow-key cursor.
                // biome-ignore lint/a11y/useKeyWithClickEvents: as above — the grid owns the keyboard.
                <div
                  key={cell.date}
                  ref={(el) => {
                    cellRefs.current[index] = el;
                  }}
                  data-date={cell.date}
                  data-level={cell.future ? "future" : cell.level}
                  data-today={cell.today || undefined}
                  onPointerEnter={() => showCell(index)}
                  onClick={() => showCell(index)}
                  className={cn(
                    "relative rounded-sm hover:brightness-95 md:aspect-3/2 md:rounded-md",
                    cell.future
                      ? "bg-transparent ring-1 ring-foreground/15 ring-inset"
                      : HEAT_BG[cell.level],
                    cell.today && "ring-2 ring-foreground ring-offset-2 ring-offset-card",
                    // The day cursor is an outline OVER today's ring, so it stays
                    // visible when it sits on today (where focus lands first).
                    cursor === index && "outline-2 outline-brand-deep outline-offset-4",
                  )}
                >
                  {top ? (
                    <button
                      type="button"
                      aria-label={cell.pins
                        .map(
                          (p) =>
                            `${p.name}, earned ${dayLabel(cell.date)}${p.isNew ? ", new since your last visit" : ""}`,
                        )
                        .join("; ")}
                      onPointerEnter={(event) => {
                        event.stopPropagation();
                        showPin(index, event.currentTarget);
                      }}
                      onFocus={(event) => showPin(index, event.currentTarget)}
                      onBlur={() => setTip(null)}
                      onClick={(event) => {
                        event.stopPropagation();
                        showPin(index, event.currentTarget);
                      }}
                      className={cn(
                        "absolute inset-0 z-10 m-auto grid size-5 cursor-pointer place-items-center rounded-full shadow-md ring-2 ring-card transition-transform duration-200 ease-out hover:scale-110 focus-visible:scale-110 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-4 md:size-6 [&_svg]:size-3 md:[&_svg]:size-3.5",
                        FAMILY_BG[top.family] ?? "bg-foreground",
                        familyInk(top.family),
                        cell.pins.some((p) => p.isNew) &&
                          "ring-brand-amber ring-offset-2 ring-offset-card",
                      )}
                    >
                      <BadgeGlyph icon={top.icon} />
                      {/* The count bubble sits on a 16px disc corner, so its numeral
                          is below the type scale's smallest step. */}
                      {cell.pins.length > 1 ? (
                        <span className="absolute -top-2 -right-2 grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 font-bold text-[0.625rem] text-background ring-2 ring-card">
                          {cell.pins.length}
                        </span>
                      ) : null}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p id="home-calendar-help" className="sr-only">
        Use the arrow keys to move between days.
      </p>
      <p className="sr-only" aria-live="polite" data-testid="calendar-live">
        {live}
      </p>
      {/* Pointer handlers keep the tooltip open while it is hovered (WCAG 1.4.13). */}
      <div
        ref={tipRef}
        role="tooltip"
        hidden={!tip}
        onPointerEnter={cancelHide}
        onPointerLeave={hideSoon}
        className={cn(TOOLTIP_SURFACE, "fixed z-50 max-w-64")}
      >
        {tip?.content}
      </div>
    </>
  );
}
