"use client";

import { useEffect } from "react";
import { rememberListFilter } from "./list-filter-memory";

// The write half of the list-filter memory (see `docs/filtered-lists.md`).
// Mounted once per list ROUTE — by `DataList`, and by the new list engine's
// `/codes` body itself — never for an embedded list, which has no pathname of
// its own, so every applied filter is recorded exactly once. It renders nothing.
export function RememberListFilter({ pathname, search }: { pathname: string; search: string }) {
  useEffect(() => {
    rememberListFilter(pathname, search);
  }, [pathname, search]);
  return null;
}
