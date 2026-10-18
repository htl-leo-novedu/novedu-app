"use client";

import { type ReactNode, useState } from "react";
import { ChevronDownIcon, XIcon } from "@/components/icons";
import { ActionMenu } from "@/components/list/action-menu";
import { type BulkAction, useListSelection } from "@/components/list/selection";
import { Spinner } from "@/components/spinner";
import { Button, buttonVariants } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { cn } from "@/lib/utils";

// The bulk-action bar of the new list engine: shown while at least one row is
// ticked. From `md` up it takes the toolbar's place at the toolbar's height (the
// caller hides the toolbar), with one button per action; on a phone it floats at
// the bottom of the screen and its actions sit behind an "Actions" sheet.
//
// An action is a server action over the selected ids. `confirm: "delete"` asks
// before it runs (the wording every bulk delete uses); success clears the
// selection and refreshes the page, a failure keeps the selection and shows the
// message.

export interface BulkActionSpec {
  label: string;
  /** Shown while it runs, e.g. "Deleting". */
  pendingLabel: string;
  action: BulkAction;
  icon?: ReactNode;
  destructive?: boolean;
  confirm?: "delete";
}

export function BulkBar({ actions, itemNoun }: { actions: BulkActionSpec[]; itemNoun: string }) {
  const { selectedIds, pending, run, clear } = useListSelection();
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const count = selectedIds.length;

  async function trigger(spec: BulkActionSpec) {
    if (spec.confirm === "delete") {
      const noun = count === 1 ? itemNoun : `${itemNoun}s`;
      const confirmed = window.confirm(
        `Delete ${count} ${noun}?\n\nThis permanently deletes them and cannot be undone.`,
      );
      if (!confirmed) return;
    }
    setError(null);
    setRunning(spec.label);
    const result = await run(spec.action);
    setRunning(null);
    if (!result.ok) setError(result.message ?? "The action could not be completed. Try again.");
  }

  return (
    <section
      aria-label="Bulk actions"
      className="flex min-h-9 w-0 min-w-full flex-wrap items-center gap-x-3 gap-y-2 max-md:fixed max-md:inset-x-3 max-md:bottom-3 max-md:z-40 max-md:w-auto max-md:rounded-2xl max-md:border max-md:border-foreground/15 max-md:bg-background max-md:p-2 max-md:pl-4 max-md:shadow-lg"
    >
      <p className="font-semibold text-sm" aria-live="polite">
        {count} selected
      </p>
      <div className="flex flex-wrap items-center gap-2 max-md:hidden">
        {actions.map((spec) => (
          <Button
            key={spec.label}
            size="sm"
            variant={spec.destructive ? "destructiveOutline" : "outline"}
            disabled={pending}
            onClick={() => trigger(spec)}
          >
            {running === spec.label ? (
              <>
                <Spinner /> {spec.pendingLabel}…
              </>
            ) : (
              <>
                {spec.icon}
                {spec.label}
              </>
            )}
          </Button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <span className="md:hidden">
          <ActionMenu
            label="Actions"
            triggerClassName={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            items={actions.map((spec) => ({
              kind: "button" as const,
              label: running === spec.label ? `${spec.pendingLabel}…` : spec.label,
              icon: spec.icon,
              destructive: spec.destructive,
              onSelect: () => trigger(spec),
            }))}
          >
            {pending ? <Spinner /> : null}
            Actions
            <ChevronDownIcon />
          </ActionMenu>
        </span>
        <Button variant="link" className="max-md:hidden" onClick={clear} disabled={pending}>
          Clear selection
        </Button>
        <button
          type="button"
          className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full hover:bg-foreground/5 md:hidden [&_svg]:size-4"
          onClick={clear}
          disabled={pending}
          aria-label="Clear selection"
        >
          <XIcon />
        </button>
      </div>
      {error ? <FieldError className="w-full">{error}</FieldError> : null}
    </section>
  );
}
