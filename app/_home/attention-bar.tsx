"use client";

import Link from "next/link";
import { type ComponentType, type SVGProps, useId, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  InboxIcon,
  MessageSquareIcon,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HOME_CAPTION, HOME_CARD } from "./home-ui";

// The attention bar's counters (docs/home.md → Teacher dashboard). Each counter
// is a button that opens its codes in place, one panel at a time; a counter with
// nothing in it is a quiet "all clear" pill instead, so a calm week reads calm.
// Receives plain, pre-formatted rows from the server section.

export interface AttentionRow {
  code: string;
  label: string;
  /** A muted line beside the label (when the window ends, when it was created). */
  detail?: string;
  /** Shown in the destructive tone: the window ends today. */
  urgent?: boolean;
  /** A small status badge instead of the detail ("2 open"). */
  badge?: string;
}

export type AttentionCounter =
  | { id: "closing" | "reports" | "unused"; total: number; rows: AttentionRow[]; more: number }
  | { id: "closing" | "reports" | "unused"; unavailable: true };

const COPY: Record<
  AttentionCounter["id"],
  {
    label: string;
    clear: string;
    foot: string;
    icon: ComponentType<SVGProps<SVGSVGElement>>;
  }
> = {
  closing: {
    label: "Closing soon",
    clear: "Nothing closes in the next 3 days",
    foot: "Codes whose window ends within 3 days.",
    icon: ClockIcon,
  },
  reports: {
    label: "Open reports",
    clear: "No open reports",
    foot: "Unresolved student reports on your codes.",
    icon: MessageSquareIcon,
  },
  unused: {
    label: "Never used",
    clear: "Every code has been used",
    foot: "Created more than a week ago, open now, and nobody has used them yet.",
    icon: InboxIcon,
  },
};

const hasRows = (c: AttentionCounter): c is Extract<AttentionCounter, { total: number }> =>
  !("unavailable" in c) && c.total > 0;

export function AttentionBar({ counters }: { counters: AttentionCounter[] }) {
  const [open, setOpen] = useState<AttentionCounter["id"] | null>(
    () => counters.find(hasRows)?.id ?? null,
  );
  const panelId = useId();
  const current = counters.find((c) => c.id === open);
  const shown = current && hasRows(current) ? current : undefined;

  return (
    <section aria-labelledby="home-attention" className={HOME_CARD}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 px-4 py-3.5 md:px-6">
        <h2 id="home-attention" className="mr-1.5 font-semibold text-sm max-sm:w-full">
          Needs you
        </h2>
        {counters.map((c) => {
          const copy = COPY[c.id];
          if ("unavailable" in c) {
            return (
              <span
                key={c.id}
                className="inline-flex h-9 items-center rounded-full bg-foreground/5 px-3.5 text-foreground/65 text-sm max-sm:w-full"
              >
                {copy.label}: could not be loaded
              </span>
            );
          }
          if (c.total === 0) {
            return (
              <span
                key={c.id}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-emerald-600/15 pr-3.5 pl-2.5 font-semibold text-emerald-800 text-sm max-sm:w-full dark:text-emerald-300"
              >
                <CheckIcon className="size-4 text-success" />
                {copy.clear}
              </span>
            );
          }
          const Icon = copy.icon;
          const expanded = open === c.id;
          return (
            <button
              key={c.id}
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => setOpen(expanded ? null : c.id)}
              className={cn(
                buttonVariants({ variant: "outline" }),
                "gap-2 pr-2 pl-3 max-sm:w-full",
                expanded &&
                  "border-foreground bg-foreground text-background not-disabled:hover:bg-foreground/90",
              )}
            >
              <Icon />
              <span className="text-left max-sm:flex-1">{copy.label}</span>
              <span
                className={cn(
                  "inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-full px-1.5 font-bold text-xs tabular-nums",
                  expanded ? "bg-background text-foreground" : "bg-foreground text-background",
                )}
              >
                {c.total.toLocaleString("en")}
              </span>
              <ChevronDownIcon
                className={cn(
                  "opacity-60 transition-transform duration-200",
                  expanded && "rotate-180 opacity-90",
                )}
              />
            </button>
          );
        })}
      </div>
      <section
        id={panelId}
        aria-label={shown ? COPY[shown.id].label : undefined}
        hidden={!shown}
        className="border-foreground/15 border-t px-2 pt-1.5 pb-3 md:px-4"
      >
        {shown ? <Panel counter={shown} /> : null}
      </section>
    </section>
  );
}

function Panel({ counter }: { counter: Extract<AttentionCounter, { total: number }> }) {
  const copy = COPY[counter.id];
  return (
    <>
      <ul>
        {counter.rows.map((row, i) => (
          <li key={row.code} className={cn(i > 0 && "border-foreground/10 border-t")}>
            <Link
              href={`/codes/${encodeURIComponent(row.code)}`}
              className="grid items-center gap-x-4 gap-y-0.5 rounded-lg px-2 py-2.5 no-underline hover:bg-foreground/5 sm:grid-cols-[minmax(0,1fr)_auto]"
            >
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 sm:flex-nowrap">
                <span className="font-semibold text-sm sm:truncate">{row.label}</span>
                <span className="font-mono text-foreground/65 text-xs tracking-wide">
                  {row.code}
                </span>
              </span>
              {row.badge ? (
                <Badge
                  tone="orange"
                  className="justify-self-start tabular-nums sm:justify-self-end"
                >
                  {row.badge}
                </Badge>
              ) : (
                <span
                  className={cn(
                    "whitespace-nowrap text-sm tabular-nums",
                    row.urgent ? "font-semibold text-destructive" : "text-foreground/65",
                  )}
                >
                  {row.detail}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1.5 px-2 pt-2">
        <span className={HOME_CAPTION}>
          {copy.foot}
          {counter.more > 0
            ? ` ${counter.more.toLocaleString("en")} more ${counter.more === 1 ? "code" : "codes"} not shown.`
            : null}
        </span>
        {counter.id === "reports" ? (
          <Link href="/reports" className={cn(buttonVariants({ variant: "link" }), "text-sm")}>
            Open Reports
          </Link>
        ) : null}
      </div>
    </>
  );
}
