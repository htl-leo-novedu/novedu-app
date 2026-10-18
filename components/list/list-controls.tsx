"use client";

import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import { ChevronDownIcon, FilterIcon } from "@/components/icons";
import { type BulkActionSpec, BulkBar } from "@/components/list/bulk-bar";
import { useListSelection } from "@/components/list/selection";
import { Button, buttonVariants } from "@/components/ui/button";
import { cardVariants } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// The new list engine's control area (see `docs/filtered-lists.md`, "The new
// list engine"): the toolbar, the filter drawer under it and, while the drawer
// is closed, the active-filter chips. While rows are ticked the bulk bar takes
// the toolbar's place (from `md` up; on a phone it floats and the toolbar stays).
//
// Everything filter-related arrives server-rendered as nodes — the drawer's
// groups, the chips, the search box — and is only arranged here; the drawer's
// open state is the one piece of client state, and it survives the soft
// navigation a pill click makes, so a teacher can tick several filters in a row.
export function ListControls({
  search,
  sortMenu,
  filterCount,
  drawer,
  chips,
  clearHref,
  bulkActions,
  itemNoun,
}: {
  search: ReactNode;
  /** The phone Sort menu (folded rows have no headers); hidden from `md` up. */
  sortMenu?: ReactNode;
  /** How many filter values are active — the Filters button's badge. */
  filterCount: number;
  /** The filter groups. */
  drawer: ReactNode;
  /** The active-filter chips, shown while the drawer is closed. */
  chips: ReactNode;
  /** The list URL with every filter cleared. */
  clearHref: string;
  bulkActions: BulkActionSpec[];
  itemNoun: string;
}) {
  const { selectedIds } = useListSelection();
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const selecting = selectedIds.length > 0;

  return (
    <div className="flex w-0 min-w-full flex-col gap-3">
      {selecting ? <BulkBar actions={bulkActions} itemNoun={itemNoun} /> : null}
      <div className={cn("flex flex-wrap items-center gap-2", selecting && "md:hidden")}>
        <div className="max-md:order-last max-md:w-full">{search}</div>
        <div className="flex items-center gap-2 max-md:ml-auto">
          {sortMenu ? <div className="md:hidden">{sortMenu}</div> : null}
          <button
            type="button"
            className={buttonVariants({ variant: "outline" })}
            aria-expanded={open}
            aria-controls={drawerId}
            onClick={() => setOpen(!open)}
          >
            <FilterIcon />
            Filters
            {filterCount > 0 ? (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-background text-xs">
                {filterCount}
              </span>
            ) : null}
            <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
          </button>
        </div>
      </div>
      {open ? (
        <section id={drawerId} aria-label="Filters" className={cardVariants()}>
          {/* Columns of at least 14rem, as many as fit — one column on a phone. */}
          <div className="grid gap-5 p-4 md:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]">
            {drawer}
          </div>
          <div className="flex items-center justify-end gap-4 border-foreground/10 border-t px-4 py-2.5">
            {filterCount > 0 ? (
              <Link
                href={clearHref}
                className="text-foreground/70 text-sm underline hover:text-foreground"
              >
                Clear all
              </Link>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </section>
      ) : (
        chips
      )}
    </div>
  );
}
