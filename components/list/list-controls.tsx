"use client";

import { type ReactNode, useId, useState } from "react";
import { ChevronDownIcon, FilterIcon } from "@/components/icons";
import { type BulkActionSpec, BulkBar } from "@/components/list/bulk-bar";
import { type FilterDraft, FilterPanel } from "@/components/list/filter-panel";
import { useListSelection } from "@/components/list/selection";
import { buttonVariants } from "@/components/ui/button";
import type { ParamRecord } from "@/lib/db/paging";
import { cn } from "@/lib/utils";

// The new list engine's control area (see `docs/filtered-lists.md`, "The new
// list engine"): one toolbar row — view picker, the phone Sort menu, Filters, and
// the page's own actions on the right (on a phone they get the top row) — then
// the filter panel while it is open, then the summary line. While rows are
// ticked the bulk bar takes the toolbar's place (from `md` up; on a phone it
// floats and the toolbar stays).
//
// The view picker, the search field, the filter groups and the summary arrive
// server-rendered as nodes and are only arranged here; the panel's open state
// and its draft are the only client state.
export function ListControls({
  viewPicker,
  sortMenu,
  actions,
  filterCount,
  filters,
  search,
  groups,
  summary,
  bulkActions,
  itemNoun,
}: {
  viewPicker: ReactNode;
  /** The phone Sort menu (folded rows have no headers); hidden from `md` up. */
  sortMenu?: ReactNode;
  /** The page's own buttons (the engine switch, "New …"). */
  actions?: ReactNode;
  /** How many filter values the list applies — the Filters button's badge. */
  filterCount: number;
  /** Where Apply navigates from, and the filters applied now (see `FilterPanel`). */
  filters: { pathname: string; params: ParamRecord; applied: FilterDraft };
  /** The panel's search field. */
  search: ReactNode;
  /** The panel's filter groups. */
  groups: ReactNode;
  /** The row count and applied filters, under the toolbar. */
  summary: ReactNode;
  bulkActions: BulkActionSpec[];
  itemNoun: string;
}) {
  const { selectedIds } = useListSelection();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const selecting = selectedIds.length > 0;

  return (
    <div className="flex w-0 min-w-full flex-col gap-3">
      {selecting ? <BulkBar actions={bulkActions} itemNoun={itemNoun} /> : null}
      <div className={cn("flex flex-wrap items-center gap-2", selecting && "md:hidden")}>
        <div className="flex items-center gap-2 max-md:w-full">
          <div className="flex max-md:min-w-0 max-md:flex-1">{viewPicker}</div>
          {sortMenu ? <div className="md:hidden">{sortMenu}</div> : null}
          <button
            type="button"
            className={buttonVariants({ variant: "outline" })}
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen(!open)}
          >
            <FilterIcon />
            Filters
            {filterCount > 0 ? (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-background text-xs">
                {filterCount}
              </span>
            ) : null}
            <ChevronDownIcon
              className={cn("transition-transform max-md:hidden", open && "rotate-180")}
            />
          </button>
        </div>
        {actions ? (
          <div className="flex items-center gap-2 max-md:order-first max-md:w-full max-md:justify-end md:ml-auto">
            {actions}
          </div>
        ) : null}
      </div>
      {open ? (
        <FilterPanel
          id={panelId}
          pathname={filters.pathname}
          params={filters.params}
          applied={filters.applied}
          search={search}
          onClose={() => setOpen(false)}
        >
          {groups}
        </FilterPanel>
      ) : null}
      {summary}
    </div>
  );
}
