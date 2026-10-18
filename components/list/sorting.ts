import type { ActionMenuItem } from "@/components/list/action-menu";
import type { GridColumn, GridSorting } from "@/components/list/list-grid";
import { listHref } from "@/components/list/url";
import { formatSort, type Sort } from "@/lib/db/sorting";

// Sorting for the folded phone list, which has no column headers: a Sort menu
// and a one-line description of the current order. Server-safe and DB-free.

const ARROWS = { asc: "↑", desc: "↓" } as const;

/** The current order in words: "Note ↑", or `defaultLabel` when unsorted. */
export function describeSort<T>(
  columns: GridColumn<T>[],
  sort: Sort | undefined,
  defaultLabel = "Default order",
): string {
  const column = sort && columns.find((c) => c.sortKey === sort.key);
  return column && sort ? `${column.header} ${ARROWS[sort.dir]}` : defaultLabel;
}

/**
 * The Sort menu's items: the default order, then every sortable column of the
 * view. Picking a column sorts ascending; picking the active one flips it.
 */
export function sortMenuItems<T>(
  columns: GridColumn<T>[],
  { pathname, params, sort }: GridSorting,
  defaultLabel = "Default order",
): ActionMenuItem[] {
  const items: ActionMenuItem[] = [
    {
      kind: "link",
      label: sort ? defaultLabel : `${defaultLabel} ✓`,
      href: listHref(pathname, params, { sort: undefined }),
    },
  ];
  for (const column of columns) {
    if (!column.sortKey) continue;
    const active = sort?.key === column.sortKey ? sort : undefined;
    const next: Sort = {
      key: column.sortKey,
      dir: active?.dir === "asc" ? "desc" : "asc",
    };
    items.push({
      kind: "link",
      label: active ? `${column.header} ${ARROWS[active.dir]}` : column.header,
      href: listHref(pathname, params, { sort: formatSort(next) }),
    });
  }
  return items;
}
