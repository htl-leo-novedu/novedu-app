"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CopyIconButton } from "@/components/copy-icon-button";
import { ActionMenu, type ActionMenuItem } from "@/components/list/action-menu";
import { iconButtonVariants } from "@/components/ui/icon-button";

// The new list engine's row actions (see `docs/filtered-lists.md`, "The new list
// engine"): ONE item list, shown two ways. From `xl` up there is room for every
// action as an icon button, as on the classic lists; below it they fold into the
// row's "…" menu (and a folded phone row only ever shows the menu). CSS picks
// one — both are in the same render, so inline icons and menu can never
// disagree. A client component because the copy button builds its link from
// `window.location` at click time; a server page still passes the items, which
// are plain data (only the `button` kind carries a function, for client callers).

/** A row action: a menu item that also has an icon for its inline button. */
export type RowActionItem = ActionMenuItem & { icon: ReactNode };

export function RowActions({ label, items }: { label: string; items: RowActionItem[] }) {
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; these are a row's links and buttons. */}
      <div role="group" aria-label={label} className="hidden items-center gap-1 xl:flex">
        {items.map((item) => (
          <InlineAction key={item.label} item={item} />
        ))}
      </div>
      <div className="xl:hidden">
        <ActionMenu label={label} items={items} />
      </div>
    </>
  );
}

function InlineAction({ item }: { item: RowActionItem }) {
  switch (item.kind) {
    case "link":
      return item.newTab ? (
        // A plain <a>: a new tab is always a full document load, so <Link>
        // would only add a prefetch that can never be used.
        <a
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          className={iconButtonVariants()}
          aria-label={item.label}
          title={item.label}
        >
          {item.icon}
        </a>
      ) : (
        <Link
          href={item.href}
          className={iconButtonVariants()}
          aria-label={item.label}
          title={item.label}
        >
          {item.icon}
        </Link>
      );
    case "copy-link":
      return (
        <CopyIconButton
          text={() => `${window.location.origin}${item.path}`}
          label={item.label}
          promptLabel="Copy the link:"
        />
      );
    case "disabled":
      // Kept in its slot, so the icons line up from row to row.
      return (
        <button
          type="button"
          disabled
          className={iconButtonVariants()}
          aria-label={`${item.label} (${item.reason})`}
          title={`${item.label} (${item.reason})`}
        >
          {item.icon}
        </button>
      );
    case "button":
      return (
        <button
          type="button"
          onClick={item.onSelect}
          className={iconButtonVariants()}
          aria-label={item.label}
          title={item.label}
        >
          {item.icon}
        </button>
      );
  }
}
