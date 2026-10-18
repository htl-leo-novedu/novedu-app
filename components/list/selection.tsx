"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { cn } from "@/lib/utils";

// Row selection for the new list engine (see `docs/filtered-lists.md`, "The new
// list engine"): the selected-id set, page-scoped, plus the one way a bulk action
// runs over it. The selection id is what the list's bulk actions take (a code, a
// file name) — `allIds` and every `RowCheckbox` must use that same key.
//
// The classic engine has its own copy of this logic (`components/list-selection.tsx`);
// the duplication is deliberate and ends when the classic engine is removed.

export type BulkActionResult = { ok: boolean; message?: string };
export type BulkAction = (ids: string[]) => Promise<BulkActionResult>;

interface SelectionValue {
  selectedIds: string[];
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  selectAll: () => void;
  clear: () => void;
  /** Every visible row is selected (and there is at least one). */
  allSelected: boolean;
  pending: boolean;
  /** Runs `action` over the selection; on success clears it and refreshes the page. */
  run: (action: BulkAction) => Promise<BulkActionResult>;
}

const SelectionContext = createContext<SelectionValue | null>(null);

export function useListSelection(): SelectionValue {
  const value = useContext(SelectionContext);
  if (!value) throw new Error("useListSelection must be used within a ListSelection");
  return value;
}

export function ListSelection({ allIds, children }: { allIds: string[]; children: ReactNode }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pending, startTransition] = useTransition();

  // A stable signature of the visible set (NUL-separated, so two id sets can't
  // collide), so the effect and the memo below only react to a real change.
  const allKey = allIds.join("\u0000");

  // Drop departed ids (a filter, a page change, a delete) so the Set can't grow
  // as a teacher pages around.
  // biome-ignore lint/correctness/useExhaustiveDependencies: allIds is captured by allKey
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const allowed = new Set(allIds);
      const next = new Set([...prev].filter((id) => allowed.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [allKey]);

  // ...and narrow at render too: the effect runs after paint, and the count or a
  // bulk payload must never carry a row that is not on screen, not even for a frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: allIds is captured by allKey
  const allowed = useMemo(() => new Set(allIds), [allKey]);
  const selectedIds = useMemo(
    () => [...selected].filter((id) => allowed.has(id)),
    [selected, allowed],
  );

  const value: SelectionValue = {
    selectedIds,
    isSelected: (id) => selected.has(id) && allowed.has(id),
    toggle: (id) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    selectAll: () => setSelected(new Set(allIds)),
    clear: () => setSelected(new Set()),
    allSelected: allIds.length > 0 && selectedIds.length === allIds.length,
    pending,
    run: (action) =>
      new Promise<BulkActionResult>((resolve) => {
        startTransition(async () => {
          const result = await action(selectedIds);
          if (result.ok) {
            setSelected(new Set());
            router.refresh();
          }
          resolve(result);
        });
      }),
  };

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

const CHECKBOX = "size-4 shrink-0 cursor-pointer accent-foreground disabled:cursor-default";

/** One row's checkbox. `label` names the row for its accessible name. */
export function RowCheckbox({ id, label }: { id: string; label: string }) {
  const { isSelected, toggle, pending } = useListSelection();
  return (
    <input
      type="checkbox"
      className={CHECKBOX}
      checked={isSelected(id)}
      onChange={() => toggle(id)}
      disabled={pending}
      aria-label={`Select ${label}`}
    />
  );
}

/**
 * The page-scoped select-all checkbox: checked when every visible row is,
 * mixed when some are. With `showLabel` it carries a visible "Select all" (the
 * folded phone list's header row); otherwise the label is for screen readers.
 */
export function SelectAllCheckbox({
  showLabel,
  className,
}: {
  showLabel?: boolean;
  className?: string;
}) {
  const { selectedIds, allSelected, selectAll, clear, pending } = useListSelection();
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  const some = selectedIds.length > 0 && !allSelected;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className={CHECKBOX}
        checked={allSelected}
        onChange={() => (allSelected ? clear() : selectAll())}
        disabled={pending}
        aria-label={showLabel ? undefined : "Select all rows on this page"}
      />
      {showLabel ? (
        <label htmlFor={id} className="cursor-pointer font-medium text-sm">
          Select all
        </label>
      ) : null}
    </span>
  );
}
