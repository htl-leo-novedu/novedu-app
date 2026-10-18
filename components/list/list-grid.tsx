import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { RowCheckbox, SelectAllCheckbox } from "@/components/list/selection";
import type { ParamRecord } from "@/lib/db/paging";
import { type Sort, type SortDirection, sortHref } from "@/lib/db/sorting";
import { cn } from "@/lib/utils";

// The new list engine's table (see `docs/filtered-lists.md`, "The new list
// engine"). A SERVER component: the rows arrive filtered, sorted and paged by
// the database. Every row has a leading checkbox and a trailing "…" menu.
//
// Below `md` each row FOLDS into a three-line entry instead of scrolling
// sideways: line 1 the row's title, line 2 its meta badges, line 3 the view's
// other columns as short facts joined by " · ". That entry is a second cell
// rendered next to the desktop cells in the same server render; CSS shows one
// or the other, so there is no client-side shaping and no second request.

export interface GridColumn<T> {
  id: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Opts the column into click-to-sort: its key in the list's sort-column map. */
  sortKey?: string;
  /** `numeric` right-aligns and keeps the cell snug; `time` keeps it on one line. */
  kind?: "numeric" | "time";
  className?: string;
  /** The column's short fact on a folded row's third line; omitted = not shown there. */
  fact?: (row: T) => ReactNode;
}

export interface GridSorting {
  pathname: string;
  params: ParamRecord;
  /** The active sort; `undefined` = the view's default order. */
  sort: Sort | undefined;
}

const TH =
  "border-foreground/25 border-b-2 bg-foreground/5 px-3 py-2 text-left font-semibold text-foreground/70 text-xs uppercase tracking-wide";
const TD = "border-foreground/15 border-b px-3 py-2 align-middle";
const KIND_CLASSES = { numeric: "w-[1%] whitespace-nowrap text-right", time: "whitespace-nowrap" };
const ARROWS: Record<SortDirection, string> = { asc: "↑", desc: "↓" };

function ariaSort(column: { sortKey?: string }, sort: Sort | undefined) {
  if (!column.sortKey) return undefined;
  if (sort?.key !== column.sortKey) return "none" as const;
  return sort.dir === "asc" ? ("ascending" as const) : ("descending" as const);
}

function HeaderCell<T>({ column, sorting }: { column: GridColumn<T>; sorting: GridSorting }) {
  if (!column.sortKey) return column.header;
  const active = sorting.sort?.key === column.sortKey ? sorting.sort : undefined;
  // A plain link: sorting works without JS. The arrow keeps a fixed slot (a dim
  // ↕ while inactive), so the header neither jumps nor hides that it sorts.
  return (
    <Link
      href={sortHref(sorting.pathname, sorting.params, column.sortKey, sorting.sort)}
      className="inline-flex items-center gap-1 hover:text-foreground"
    >
      {column.header}
      <span aria-hidden="true" className={active ? undefined : "text-foreground/30"}>
        {active ? ARROWS[active.dir] : "↕"}
      </span>
    </Link>
  );
}

/** The facts of a folded row: every column with a `fact`, in view order, " · "-joined. */
function Facts<T>({ row, columns }: { row: T; columns: GridColumn<T>[] }) {
  const facts = columns
    .map((column) => ({ id: column.id, node: column.fact?.(row) }))
    .filter((fact) => fact.node !== undefined && fact.node !== null && fact.node !== "");
  if (facts.length === 0) return null;
  return (
    <p className="text-foreground/65 text-xs">
      {facts.map((fact, index) => (
        <Fragment key={fact.id}>
          {index > 0 ? " · " : null}
          {fact.node}
        </Fragment>
      ))}
    </p>
  );
}

export function ListGrid<T>({
  rows,
  columns,
  rowKey,
  rowLabel,
  rowClassName,
  rowMenu,
  folded,
  sorting,
  sortLabel,
}: {
  rows: T[];
  columns: GridColumn<T>[];
  /** The row's selection id — what the list's bulk actions take. */
  rowKey: (row: T) => string;
  /** Names the row in its checkbox's accessible name ("Select <label>"). */
  rowLabel: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  /** The row's "…" menu. */
  rowMenu: (row: T) => ReactNode;
  /** Lines 1 and 2 of a folded phone row. */
  folded: { title: (row: T) => ReactNode; meta: (row: T) => ReactNode };
  sorting: GridSorting;
  /** The current order in words, for the folded list's header ("Default order"). */
  sortLabel: string;
}) {
  return (
    // The card scrolls sideways only as a last resort on a mid-size screen; a
    // phone gets the folded rows. Rounded so the row accent stripes clip with it.
    <div className="overflow-x-auto rounded-xl border border-foreground/10 bg-card shadow-xs [&_tbody_tr:last-child>td]:border-b-0">
      <div className="flex items-center justify-between gap-3 border-foreground/25 border-b-2 bg-foreground/5 px-3 py-2 md:hidden">
        <SelectAllCheckbox showLabel />
        <span className="text-foreground/65 text-xs">{sortLabel}</span>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead className="max-md:hidden">
          <tr>
            <th scope="col" className={cn(TH, "w-[1%] text-center")}>
              <SelectAllCheckbox />
            </th>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                aria-sort={ariaSort(column, sorting.sort)}
                className={cn(TH, column.kind === "numeric" && "text-right")}
              >
                <HeaderCell column={column} sorting={sorting} />
              </th>
            ))}
            <th scope="col" className={cn(TH, "w-[1%]")}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const label = rowLabel(row);
            const menu = rowMenu(row);
            return (
              <tr key={key} className={rowClassName?.(row)}>
                <td className={cn(TD, "w-[1%] text-center max-md:hidden")}>
                  <RowCheckbox id={key} label={label} />
                </td>
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cn(
                      TD,
                      column.kind && KIND_CLASSES[column.kind],
                      column.className,
                      "max-md:hidden",
                    )}
                  >
                    {column.render(row)}
                  </td>
                ))}
                <td className={cn(TD, "w-[1%] whitespace-nowrap max-md:hidden")}>{menu}</td>
                {/* The folded phone entry. */}
                <td colSpan={columns.length + 2} className={cn(TD, "md:hidden")}>
                  <div className="flex items-start gap-3">
                    <span className="flex h-6 items-center">
                      <RowCheckbox id={key} label={label} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="min-w-0 font-medium">{folded.title(row)}</div>
                      <div className="flex flex-wrap items-center gap-2">{folded.meta(row)}</div>
                      <Facts row={row} columns={columns} />
                    </div>
                    {menu}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
