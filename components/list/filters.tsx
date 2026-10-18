import { cva } from "class-variance-authority";
import Link from "next/link";
import type { ReactNode } from "react";
import { XIcon } from "@/components/icons";
import { META_LABEL } from "@/components/ui/meta-label";
import { cn } from "@/lib/utils";

// The new list engine's filter building blocks (see `docs/filtered-lists.md`,
// "The new list engine"). Server-safe: every control is a LINK to the URL with
// that filter changed, built by the page (`listHref`), so a click is a plain
// navigation and the server re-queries — no client filter state, no Apply.
//
// A group knows nothing about where it sits: the drawer (`ListControls`) is only
// a container, so moving the groups into a side panel later is a container swap.

export function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls; these are links
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-2">
      <p className={META_LABEL} aria-hidden="true">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

// Inked when on, like every selection in the app (DESIGN.md).
const pillVariants = cva(
  "inline-flex h-8 items-center whitespace-nowrap rounded-full border px-3 text-sm no-underline transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
  {
    variants: {
      active: {
        true: "border-foreground bg-foreground text-background",
        false: "border-foreground/25 bg-background text-foreground hover:bg-foreground/5",
      },
    },
    defaultVariants: { active: false },
  },
);

/** One filter value; `href` is the URL with this value toggled. */
export function FilterPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={pillVariants({ active })}
    >
      {children}
    </Link>
  );
}

export interface FilterChip {
  label: string;
  /** The URL with this one filter value removed. */
  removeHref: string;
}

/** The active filters while the drawer is closed: one removable chip each, then "Clear all". */
export function FilterChips({ chips, clearHref }: { chips: FilterChip[]; clearHref: string }) {
  if (chips.length === 0) return null;
  return (
    <ul
      aria-label="Active filters"
      className="flex w-0 min-w-full items-center gap-2 max-md:overflow-x-auto max-md:pb-1 md:flex-wrap"
    >
      {chips.map((chip) => (
        <li key={chip.label} className="shrink-0">
          <Link
            href={chip.removeHref}
            aria-label={`Remove filter ${chip.label}`}
            className={cn(
              pillVariants({ active: false }),
              "h-7 gap-1.5 bg-foreground/10 pr-2 hover:bg-foreground/15 [&_svg]:size-3.5",
            )}
          >
            {chip.label}
            <XIcon />
          </Link>
        </li>
      ))}
      <li className="shrink-0">
        <Link
          href={clearHref}
          className="text-foreground/70 text-sm underline hover:text-foreground"
        >
          Clear all
        </Link>
      </li>
    </ul>
  );
}
