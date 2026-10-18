"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { SearchIcon } from "@/components/icons";
import { listHref, paramValue } from "@/components/list/url";
import { Spinner } from "@/components/spinner";
import { Input } from "@/components/ui/input";
import type { ParamRecord } from "@/lib/db/paging";

// The list's text search: Enter submits, the server filters. Builds the next URL
// from the current params like every other filter control, so the other filters,
// the sort and the page size survive and the page resets; an empty term removes
// the param rather than leaving `?q=` behind.
export function SearchBox({
  pathname,
  params,
  label,
  placeholder,
}: {
  pathname: string;
  params: ParamRecord;
  label: string;
  placeholder: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const current = paramValue(params, "q");

  return (
    <search className="block w-full md:w-72">
      <form
        // Remount on a URL change, so "Clear all" also clears a typed value.
        key={current}
        className="relative"
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault();
          const term = String(new FormData(event.currentTarget).get("q") ?? "").trim();
          startTransition(() => router.push(listHref(pathname, params, { q: term || undefined })));
        }}
      >
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-foreground/50 [&_svg]:size-4">
          {pending ? <Spinner /> : <SearchIcon />}
        </span>
        <Input
          type="search"
          name="q"
          defaultValue={current}
          aria-label={label}
          placeholder={placeholder}
          className="w-full pl-9"
        />
      </form>
    </search>
  );
}
