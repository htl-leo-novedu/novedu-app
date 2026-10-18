"use client";

import { cva } from "class-variance-authority";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  type SetStateAction,
  useContext,
  useState,
  useTransition,
} from "react";
import { SearchIcon } from "@/components/icons";
import { listHref } from "@/components/list/url";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { cardVariants } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import type { ParamRecord } from "@/lib/db/paging";
import { cn } from "@/lib/utils";

// The new list engine's filter panel (see `docs/filtered-lists.md`, "The new list
// engine"): a DRAFT of the list's filter params, applied only by "Apply" (or
// Enter in the search box). The controls below edit the draft through context,
// so a filter group renders them anywhere inside the panel without knowing the
// panel. Apply builds the next URL with `listHref` and navigates; the server
// filters. Closing the panel unmounts it, which throws the draft away.

/** Each filter param the panel owns, with its values — `[]` = not set. */
export type FilterDraft = Record<string, string[]>;

const DraftContext = createContext<{
  draft: FilterDraft;
  setDraft: (next: SetStateAction<FilterDraft>) => void;
} | null>(null);

function useDraft(param: string) {
  const context = useContext(DraftContext);
  if (!context) throw new Error("A filter control must sit inside FilterPanel.");
  const values = context.draft[param] ?? [];
  const set = (next: string[]) =>
    context.setDraft((draft) => ({ ...draft, [param]: next.filter(Boolean) }));
  return { values, set };
}

const sameValues = (a: string[] = [], b: string[] = []) =>
  a.length === b.length && a.every((value) => b.includes(value));

export function FilterPanel({
  id,
  pathname,
  params,
  applied,
  search,
  onClose,
  children,
}: {
  id: string;
  pathname: string;
  params: ParamRecord;
  /** The filters the URL applies now; its keys are every param the panel owns. */
  applied: FilterDraft;
  /** The search field, laid out across the panel's first row. */
  search: ReactNode;
  onClose: () => void;
  /** The filter groups. */
  children: ReactNode;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(applied);
  const [pending, startTransition] = useTransition();
  const keys = Object.keys(applied);
  const changed = keys.some((key) => !sameValues(draft[key], applied[key]));
  const anySet = keys.some((key) => (draft[key] ?? []).length > 0);

  function apply() {
    if (!changed) return onClose();
    const changes = Object.fromEntries(
      keys.map((key) => [key, (draft[key] ?? []).map((value) => value.trim()).join(",")]),
    );
    // One transition: the panel stays open (with "Applying…") until the filtered
    // page is ready, then closes with it.
    startTransition(() => {
      router.push(listHref(pathname, params, changes));
      onClose();
    });
  }

  return (
    <DraftContext.Provider value={{ draft, setDraft }}>
      <form
        id={id}
        aria-label="Filters"
        className={cardVariants()}
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <div className="px-4 pt-4">{search}</div>
        {/* Columns of at least 14rem, as many as fit — one column on a phone. */}
        <div className="grid gap-5 p-4 md:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]">
          {children}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-foreground/10 border-t px-4 py-2.5">
          {changed ? (
            <p className="mr-auto inline-flex items-center gap-1.5 text-sm text-warning before:size-1.5 before:rounded-full before:bg-current max-md:w-full">
              Not applied yet
            </p>
          ) : null}
          {anySet ? (
            <button
              type="button"
              className="text-foreground/70 text-sm underline hover:text-foreground"
              onClick={() => setDraft(Object.fromEntries(keys.map((key) => [key, []])))}
            >
              Clear all
            </button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Spinner /> : null}
            {pending ? "Applying…" : "Apply"}
          </Button>
        </div>
      </form>
    </DraftContext.Provider>
  );
}

// Inked when on, like every selection in the app (DESIGN.md).
const pillVariants = cva(
  "inline-flex h-8 items-center whitespace-nowrap rounded-full border px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
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

/**
 * One filter value as a toggle pill. `multi` toggles the value in a list
 * (`?module=tutor,quiz`); otherwise it is one choice of a single-value param,
 * where `value=""` stands for the param's default (not set).
 */
export function FilterToggle({
  param,
  value,
  multi = false,
  children,
}: {
  param: string;
  value: string;
  multi?: boolean;
  children: ReactNode;
}) {
  const { values, set } = useDraft(param);
  const on = multi || value !== "" ? values.includes(value) : values.length === 0;
  return (
    <button
      type="button"
      aria-pressed={on}
      className={pillVariants({ active: on })}
      onClick={() => {
        if (!multi) set([value]);
        else set(on ? values.filter((v) => v !== value) : [...values, value]);
      }}
    >
      {children}
    </button>
  );
}

/** A single-value choice from a long list (a school's teachers as owners). */
export function FilterSelect({
  param,
  label,
  placeholder,
  options,
}: {
  param: string;
  label: string;
  /** The empty first option, shown while none of `options` is chosen. */
  placeholder: string;
  options: { value: string; label: string }[];
}) {
  const { values, set } = useDraft(param);
  const current = options.some((option) => option.value === values[0]) ? (values[0] ?? "") : "";
  return (
    <Select
      aria-label={label}
      className={cn("h-8", current && "border-foreground")}
      value={current}
      onChange={(event) => set([event.target.value])}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}

/** The text search; Enter applies the whole panel, like "Apply". */
export function FilterSearch({
  param,
  label,
  placeholder,
}: {
  param: string;
  label: string;
  placeholder: string;
}) {
  const { values, set } = useDraft(param);
  return (
    <search className="relative block w-full md:max-w-md">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-foreground/50 [&_svg]:size-4">
        <SearchIcon />
      </span>
      <Input
        type="search"
        name={param}
        value={values[0] ?? ""}
        onChange={(event) => set([event.target.value])}
        aria-label={label}
        placeholder={placeholder}
        className="w-full pl-9"
      />
    </search>
  );
}
