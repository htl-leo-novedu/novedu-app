import { ChevronDownIcon, ColumnsIcon } from "@/components/icons";
import { ActionMenu } from "@/components/list/action-menu";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The new list engine's view picker (see `docs/filtered-lists.md`, "The new list
// engine"): the toolbar button naming the current view, opening a menu of every
// view with its one-line description, the current one ticked. Server-safe: the
// menu items are data.

export interface PickerView {
  label: string;
  description: string;
  /** The list URL showing this view. */
  href: string;
  current: boolean;
}

export function ViewPicker({ views }: { views: PickerView[] }) {
  const current = views.find((view) => view.current) ?? views[0];
  return (
    <ActionMenu
      label="View"
      items={views.map((view) => ({
        kind: "link" as const,
        label: view.label,
        description: view.description,
        href: view.href,
        checked: view.current,
      }))}
      align="start"
      triggerClassName={cn(
        buttonVariants({ variant: "outline" }),
        "max-md:w-full [&_svg]:shrink-0",
      )}
    >
      <ColumnsIcon />
      <span className="text-foreground/55 max-md:sr-only">View</span>
      <span className="min-w-0 truncate">{current?.label}</span>
      <ChevronDownIcon className="max-md:ml-auto" />
    </ActionMenu>
  );
}
