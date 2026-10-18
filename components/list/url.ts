import { carryParams, type ParamRecord } from "@/lib/db/paging";

// The URL half of the new list engine's filters (see `docs/filtered-lists.md`,
// "The new list engine"). The URL stays the ONE filter state the server reads, so
// every filter control is a link (or a form) that builds the next URL from the
// current one. Directive-free and DB-free like `lib/db/paging.ts`: the server
// pages build their links here, the client filter panel its Apply.

/** A param's first value, trimmed — `""` when absent. First-wins, as everywhere. */
export function paramValue(sp: ParamRecord, key: string): string {
  const value = sp[key];
  return ((Array.isArray(value) ? value[0] : value) ?? "").trim();
}

/**
 * A multi-value filter is ONE comma-separated param (`?status=active,upcoming`),
 * never a repeated key: `carryParams` keeps only a repeated key's first value, and
 * the pager, sort links and filter memory all build on it. Values outside
 * `allowed` drop out (a typo or a stale bookmark degrades to "no filter", like
 * `parseSort`), duplicates collapse, and the result follows `allowed`'s order.
 */
export function parseMultiParam<T extends string>(
  sp: ParamRecord,
  key: string,
  allowed: readonly T[],
): T[] {
  const picked = new Set(paramValue(sp, key).split(","));
  return allowed.filter((value) => picked.has(value));
}

/**
 * The list URL with `changes` applied — a value sets the param, `undefined` or
 * `""` removes it — and `page` dropped, since a changed filter is a different
 * set (page 7 of it means nothing). Everything else rides along, `sort` and
 * `size` included. Commas stay readable: they need no escaping in a query.
 */
export function listHref(
  pathname: string,
  sp: ParamRecord,
  changes: Record<string, string | undefined>,
): string {
  const params = carryParams(sp, ["page", ...Object.keys(changes)]);
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString().replaceAll("%2C", ",");
  return qs ? `${pathname}?${qs}` : pathname;
}
