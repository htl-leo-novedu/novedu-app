import Link from "next/link";
import type { ReactNode } from "react";
import { PageBody } from "@/components/page-main";
import { RememberListFilter } from "@/components/remember-list-filter";
import { buttonVariants } from "@/components/ui/button";
import {
  carryParams,
  lastPage,
  type PagedResult,
  type ParamRecord,
  pageHref,
} from "@/lib/db/paging";
import { type Sort, type SortDirection, sortHref } from "@/lib/db/sorting";
import { cn } from "@/lib/utils";

// A column-driven list table for "filtered list" pages (see
// `docs/filtered-lists.md`). This is a SERVER component: the rows arrive
// ALREADY filtered by the database (the page reads the URL search params and
// queries with a WHERE clause), so there is no client-side filtering. Column
// `render` functions stay server-side here — no Server→Client function boundary
// is crossed — and may return client leaf components (LocalTime, copy/delete
// buttons), which hydrate normally.
//
// The table itself is the standalone <ListTable> (used directly by embedded
// tables like the per-code ConversationStats); <DataList> wraps it in the
// PageBody shell with the toolbar and empty states for full list pages.

export type ListColumnKind = "numeric" | "time" | "actions";

// The table chrome — private: every table renders through <ListTable>.
const TABLE_CLASSES = "w-full border-collapse text-sm";
const TH_CLASSES =
  "border-foreground/25 border-b-2 bg-foreground/5 px-3 py-2 text-left font-semibold text-foreground/70 text-xs uppercase tracking-wide";
const TD_CLASSES = "border-foreground/15 border-b px-3 py-2 align-middle";
// The footer row (a totals line): the header's weight and tint, a heavy rule above.
const TF_CLASSES = "border-foreground/25 border-t-2 bg-foreground/5 px-3 py-2 font-semibold";

// Sticky mode pins the header and the footer while the body scrolls inside the
// table card (its height capped by the caller). Two things change for it:
//   - The separate border model: under `border-collapse` the table, not the cell,
//     paints the borders, so a pinned cell would leave its rule behind. Only the
//     bottom/top rules are set, so nothing doubles (the last body row drops its
//     hairline, see the card below).
//   - An opaque cell background: the `foreground/5` tint would let the scrolling
//     rows show through, so it is painted as a flat gradient layer over the card
//     colour, which looks the same and hides what is beneath.
const STICKY_TABLE_CLASSES = "border-separate border-spacing-0";
const STICKY_CELL_CLASSES = "z-1 bg-card bg-linear-to-r from-foreground/5 to-foreground/5";

// Built-in cell recipes so pages don't repeat alignment classes per column:
// numeric = right-aligned and snug (header right-aligned too), time = no wrap,
// actions = a right-aligned row of icon buttons in a snug column.
const HEADER_KIND_CLASSES: Record<ListColumnKind, string> = {
  numeric: "text-right",
  time: "",
  actions: "w-[1%]",
};

const CELL_KIND_CLASSES: Record<ListColumnKind, string> = {
  numeric: "w-[1%] whitespace-nowrap text-right",
  time: "whitespace-nowrap",
  actions: "flex items-center justify-end gap-2 whitespace-nowrap",
};

export interface ListColumn<T, K extends string = string> {
  /** Header cell content. */
  header: ReactNode;
  /** Body cell content for one row (returns the cell content, not the <td>). */
  render: (row: T) => ReactNode;
  /** Built-in cell recipe for the column (alignment, wrapping, width). */
  kind?: ListColumnKind;
  /** Optional extra classes on the <td>, cn-merged after the kind recipe. */
  className?: string;
  /** Optional extra classes on the <th>, cn-merged after the kind recipe. */
  headerClassName?: string;
  /**
   * Footer cell content (e.g. a column total). The table renders a footer row when
   * any column sets one; a column without it gets an empty cell there.
   */
  footer?: ReactNode;
  /** Visually hide the header label (e.g. the trailing Actions column). */
  srOnlyHeader?: boolean;
  /**
   * Opt this column into click-to-sort: its key in the list's `SORT_COLUMNS` map.
   * A list page pins `K` to `keyof typeof ITS_SORT_COLUMNS`, so a key the store
   * cannot order by is a compile error rather than a header that does nothing. Left
   * off by a column backed by something other than the list's own query (an
   * aggregate, a value derived in JS) — and inert without the URL props below.
   */
  sortKey?: K;
}

/**
 * Where the pager's and the sortable headers' links point. `DataList` is a server
 * component with no access to the URL, so the page hands over its own pathname plus
 * the already-awaited search params; each link carries every param it does not own
 * (`pageHref` drops `page`/`size`, `sortHref` drops `page`/`sort`).
 */
export interface ListUrl {
  /** The list route's pathname, e.g. `"/files"`. */
  pathname: string;
  /** The page's awaited `searchParams`. */
  params: ParamRecord;
}

/** What the sortable headers need on top of the list URL. */
export interface ListSorting extends ListUrl {
  /** The ACTIVE sort as the page parsed it; `undefined` = the list's default order. */
  sort: Sort | undefined;
}

/**
 * The store's `PagedResult` (structurally assignable) — `page` is the EFFECTIVE,
 * clamped page, and `total` the exact COUNT the current filter matches.
 */
export type ListPagination = Pick<PagedResult<unknown>, "page" | "pageSize" | "total">;

/**
 * `pathname` + `params` (from `ListUrl`) are what the pager and the sortable headers
 * build their links from, so BOTH are required for `pagination`/`sorting` to render
 * anything. They are optional only because an embedded, unpaged list (the writing
 * module's savers list) has no route of its own to name.
 */
export interface DataListProps<T, K extends string = string> extends Partial<ListUrl> {
  rows: T[];
  getRowKey: (row: T) => string;
  columns: ListColumn<T, K>[];
  /** Optional per-row <tr> classes (e.g. the codes list's module accent stripe). */
  rowClassName?: (row: T) => string | undefined;
  /** Top-left slot — the "New …" button/link. */
  actions?: ReactNode;
  /** Top-right slot — a <ListFilterBar> with the page's filter controls. */
  filterBar?: ReactNode;
  /** Intro paragraph above the toolbar. */
  hint?: ReactNode;
  /** Whether a filter is currently applied — picks empty vs no-match copy. */
  isFiltered: boolean;
  /** Body when there are no rows AND no filter is applied. */
  emptyState: ReactNode;
  /** Body when a filter is applied but matched nothing. */
  noMatchState: ReactNode;
  /** The store's `PagedResult` — opts into the pager below the table. */
  pagination?: ListPagination;
  /**
   * The page's ACTIVE sort. A column opts into click-to-sort with its own `sortKey`
   * (and the URL props above make the links buildable); this only says which of them
   * is currently sorted, so `undefined` means "sortable, none active".
   */
  sorting?: Sort;
  /**
   * Render in the wide, table-sized page column (`PageBody`'s `wide`) — what the
   * four full list pages do. Off for embedded/bounded lists.
   */
  wide?: boolean;
}

// A sortable header is a plain <Link> — sorting works without JS, same as the pager.
// The arrow sits in a fixed slot (a dimmed ↕ while the column is not the active
// sort) so the header neither jumps on click nor hides that it is clickable. The
// flex is `justify-between`-free on purpose: the link only wraps the label, so a
// right-aligned (`numeric`) header keeps its alignment from the <th>.
const SORT_LINK_CLASSES = "inline-flex items-center gap-1 hover:text-foreground";
const SORT_ARROWS: Record<SortDirection, string> = { asc: "↑", desc: "↓" };

// `aria-sort` belongs on the <th>, and only on a column that IS sortable here —
// "none" on a static column would announce it to a screen reader as sortable.
function ariaSort(
  sorting: ListSorting | undefined,
  sortKey: string | undefined,
): "ascending" | "descending" | "none" | undefined {
  if (!sorting || !sortKey) return undefined;
  if (sorting.sort?.key !== sortKey) return "none";
  return sorting.sort.dir === "asc" ? "ascending" : "descending";
}

function SortableHeader({
  header,
  sortKey,
  sorting,
}: {
  header: ReactNode;
  sortKey: string;
  sorting: ListSorting;
}) {
  const active = sorting.sort?.key === sortKey ? sorting.sort : undefined;
  return (
    <Link
      href={sortHref(sorting.pathname, sorting.params, sortKey, sorting.sort)}
      className={SORT_LINK_CLASSES}
    >
      {header}
      <span aria-hidden="true" className={active ? undefined : "text-foreground/30"}>
        {active ? SORT_ARROWS[active.dir] : "↕"}
      </span>
    </Link>
  );
}

/** The bare table — column recipes included, no page shell or toolbar. */
export function ListTable<T, K extends string = string>({
  rows,
  getRowKey,
  columns,
  rowClassName,
  sorting,
  sticky,
  className,
}: {
  rows: T[];
  getRowKey: (row: T) => string;
  columns: ListColumn<T, K>[];
  /** Optional per-row <tr> classes (e.g. the codes list's module accent stripe). */
  rowClassName?: (row: T) => string | undefined;
  /**
   * Opt into click-to-sort headers. Omitted — as the embedded tables do — every
   * header renders plain, even for a column that carries a `sortKey`.
   */
  sorting?: ListSorting;
  /**
   * Pin the header (and the footer row, if any) while the body scrolls. Only
   * meaningful with a height cap on the card, passed as `className` (e.g.
   * `max-h-80`): the card is the scroll container the cells stick to.
   */
  sticky?: boolean;
  /** Extra classes on the table card (the scroll container), cn-merged. */
  className?: string;
}) {
  // Cell classes vary only by COLUMN, so merge them once per column here
  // instead of once per cell inside the row loop. `aria-sort` is per-column too,
  // so the whole <th> attribute set is built here and spread below.
  const headerProps = columns.map((column) => ({
    scope: "col" as const,
    className: cn(
      TH_CLASSES,
      sticky && cn(STICKY_CELL_CLASSES, "sticky top-0"),
      column.kind && HEADER_KIND_CLASSES[column.kind],
      column.srOnlyHeader && "w-[1%]",
      column.headerClassName,
    ),
    "aria-sort": ariaSort(sorting, column.sortKey),
  }));
  const cellClasses = columns.map((column) =>
    cn(TD_CLASSES, column.kind && CELL_KIND_CLASSES[column.kind], column.className),
  );
  const hasFooter = columns.some((column) => column.footer !== undefined);
  const footerClasses = columns.map((column) =>
    cn(
      TF_CLASSES,
      sticky && cn(STICKY_CELL_CLASSES, "sticky bottom-0"),
      column.kind && CELL_KIND_CLASSES[column.kind],
      column.className,
    ),
  );

  return (
    // The white card holding every table: rounded so the row accent stripes clip
    // with it; the last row drops its hairline so it doesn't double the card edge.
    // The card is also the horizontal SCROLLER — a scroll container clips exactly
    // like `overflow-hidden`, but a table wider than its column stays reachable
    // instead of being cut off; the scrollbar renders on the card's bottom edge
    // only when it overflows. This is the universal fallback for every table,
    // embedded ones included, at any window size.
    <div
      className={cn(
        "overflow-x-auto rounded-xl border border-foreground/10 bg-card shadow-xs [&_tbody_tr:last-child>td]:border-b-0",
        className,
      )}
    >
      <table className={cn(TABLE_CLASSES, sticky && STICKY_TABLE_CLASSES)}>
        <thead>
          <tr>
            {columns.map((column, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are static per render — the index is a stable identity
              <th key={index} {...headerProps[index]}>
                {column.srOnlyHeader ? (
                  <span className="sr-only">{column.header}</span>
                ) : sorting && column.sortKey ? (
                  <SortableHeader
                    header={column.header}
                    sortKey={column.sortKey}
                    sorting={sorting}
                  />
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)} className={rowClassName?.(row)}>
              {columns.map((column, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are static per render — the index is a stable identity
                <td key={index} className={cellClasses[index]}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {hasFooter ? (
          <tfoot>
            <tr>
              {columns.map((column, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are static per render — the index is a stable identity
                <td key={index} className={footerClasses[index]}>
                  {column.footer}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

// Prev/Next share one recipe; the unavailable end renders as a <span> instead of
// a <Link> because `buttonVariants`' `disabled:` styles only bite on a <button>,
// and swapping the element (rather than dropping it) keeps the row from shifting.
const PAGER_STEP = buttonVariants({ variant: "outline", size: "sm" });

function PagerStep({ href, label }: { href: string | undefined; label: string }) {
  return href ? (
    <Link href={href} className={PAGER_STEP}>
      {label}
    </Link>
  ) : (
    <span aria-disabled="true" className={cn(PAGER_STEP, "pointer-events-none opacity-50")}>
      {label}
    </span>
  );
}

/**
 * The server-rendered pager: a range label plus prev/next links that set `?page=`
 * (plain <Link>s, so paging works without JS). Hrefs derive from the EFFECTIVE
 * page in `pagination`, never from the URL — a clamped page must not offer a
 * "Next" that doesn't exist.
 */
function Pager({
  url,
  result,
  rowCount,
}: {
  url: ListUrl;
  result: ListPagination;
  rowCount: number;
}) {
  const { pathname, params } = url;
  const { page, pageSize, total } = result;
  // No chrome for an empty list. `rowCount` is checked too: COUNT and the row
  // query aren't in one transaction, so a concurrent delete can leave a total
  // with no rows — better no pager than "Showing 21–20 of 137".
  if (total === 0 || rowCount === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(from + rowCount - 1, total);
  const hasMorePages = total > pageSize;

  return (
    <nav
      aria-label="Pagination"
      // `w-0 min-w-full`: excluded from the wide column's intrinsic width (see
      // the warning in DataList) — only the table sizes that column.
      className="flex w-0 min-w-full flex-wrap items-center justify-between gap-3 text-sm"
    >
      <p className="text-foreground/70">
        Showing {from}–{to} of {total}
      </p>
      {hasMorePages ? (
        <div className="flex items-center gap-2">
          <PagerStep
            href={page > 1 ? pageHref(pathname, params, page - 1, pageSize) : undefined}
            label="‹ Previous"
          />
          <PagerStep
            href={
              page < lastPage(total, pageSize)
                ? pageHref(pathname, params, page + 1, pageSize)
                : undefined
            }
            label="Next ›"
          />
        </div>
      ) : null}
    </nav>
  );
}

export function DataList<T, K extends string = string>({
  pathname,
  params,
  rows,
  getRowKey,
  columns,
  rowClassName,
  actions,
  filterBar,
  hint,
  isFiltered,
  emptyState,
  noMatchState,
  pagination,
  sorting,
  wide,
}: DataListProps<T, K>) {
  // The one place the URL half is assembled: both the pager and the sortable
  // headers need it, and neither can render without it.
  const url: ListUrl | undefined =
    pathname !== undefined && params !== undefined ? { pathname, params } : undefined;

  // ONLY the table may size the wide column. Every other child carries
  // `w-0 min-w-full` — zero intrinsic contribution to the `fit-content` column,
  // then the column's resolved width to lay out and wrap in. Applied
  // unconditionally (a no-op in the default `w-full` column).
  // WARNING: a child added here WITHOUT these classes silently inflates the page
  // width of every wide list — a long hint or a wide filter bar would then decide
  // the layout instead of the table. (`RememberListFilter` is exempt: it renders
  // null, so it contributes no box at all.)
  return (
    <PageBody wide={wide}>
      {url ? (
        // The filter memory writes only for a list with a route of its own, and
        // never remembers the PAGE — a remembered list reopens on page one.
        <RememberListFilter
          pathname={url.pathname}
          search={carryParams(url.params, ["page"]).toString()}
        />
      ) : null}

      {hint ? <p className="w-0 min-w-full text-foreground/70 text-sm">{hint}</p> : null}

      <div className="flex w-0 min-w-full flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
        {filterBar}
      </div>

      {rows.length === 0 ? (
        <p className="w-0 min-w-full">{isFiltered ? noMatchState : emptyState}</p>
      ) : (
        <ListTable
          rows={rows}
          getRowKey={getRowKey}
          columns={columns}
          rowClassName={rowClassName}
          sorting={url && { ...url, sort: sorting }}
        />
      )}

      {url && pagination ? <Pager url={url} result={pagination} rowCount={rows.length} /> : null}
    </PageBody>
  );
}
