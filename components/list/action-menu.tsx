"use client";

import Link from "next/link";
import {
  type KeyboardEvent,
  type ReactNode,
  type ToggleEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { CheckIcon, MoreHorizontalIcon } from "@/components/icons";
import { iconButtonVariants } from "@/components/ui/icon-button";
import { useCopyToClipboard } from "@/components/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

// The new list engine's one menu: a trigger button plus a native `popover`
// panel (see `docs/filtered-lists.md`, "The new list engine"). The row "…" menus,
// the view picker, the Sort menu and the phone bulk "Actions" all use it.
//
// - The popover lives in the TOP LAYER, so it escapes the table card's
//   `overflow-x-auto` clipping, and the platform supplies light dismiss and Escape.
// - From `md` up it drops from the trigger (right-aligned, or left with
//   `align="start"`): its position is computed when it
//   opens and handed to the static `md:` utilities through CSS variables (the
//   docs/styling.md pattern for runtime values). Below `md` it is a bottom sheet
//   with 48px rows, pure CSS — the variables are simply unused there.
// - Arrow keys, Home and End move between the items; opening focuses the first.
//
// Items are plain data, so a SERVER page can build a row's menu; only the
// `button` kind carries a function and is for client callers (the bulk bar).

export type ActionMenuItem =
  | {
      kind: "link";
      label: string;
      href: string;
      icon?: ReactNode;
      newTab?: boolean;
      /** A second, muted line under the label. */
      description?: string;
      /** The current choice (the view picker's view, the Sort menu's order): a tick, `aria-current`. */
      checked?: boolean;
    }
  /** Copies this app's origin + `path` (e.g. a code's share link). */
  | { kind: "copy-link"; label: string; path: string; icon?: ReactNode }
  /** Shown but not actionable, with the reason next to it. */
  | { kind: "disabled"; label: string; reason: string; icon?: ReactNode }
  | {
      kind: "button";
      label: string;
      onSelect: () => void;
      icon?: ReactNode;
      destructive?: boolean;
    };

// The top layer does not reset inherited styles: a menu opened from a table
// header or a `whitespace-nowrap` cell would inherit them, so the panel resets
// the ones that matter. `[popover]`'s UA margin/inset centring is replaced by
// the two placements below.
const PANEL =
  "m-0 whitespace-normal rounded-lg border border-foreground/15 bg-background p-1 text-left font-normal text-foreground text-sm normal-case tracking-normal shadow-lg " +
  // Phone: a bottom sheet over a dimmed page.
  "max-md:inset-x-0 max-md:top-auto max-md:bottom-0 max-md:w-full max-md:max-w-none max-md:rounded-b-none max-md:rounded-t-2xl max-md:p-2 max-md:pb-[max(0.5rem,env(safe-area-inset-bottom))] max-md:backdrop:bg-foreground/45 " +
  // md+: dropped from the trigger (positions set in `place`).
  "md:inset-auto md:top-[var(--menu-top)] md:left-[var(--menu-left)] md:min-w-48 md:max-w-80";

const ITEM =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left no-underline hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:outline-none max-md:min-h-12 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-foreground/60";

export function ActionMenu({
  label,
  items,
  children,
  triggerClassName,
  align = "end",
}: {
  /** The trigger's accessible name and tooltip; also heads the phone sheet. */
  label: string;
  items: ActionMenuItem[];
  /** The trigger's content; defaults to the "…" icon in a round icon button. */
  children?: ReactNode;
  /** Replaces the default icon-button recipe on the trigger. */
  triggerClassName?: string;
  /** Which trigger edge the panel lines up with from `md` up. */
  align?: "start" | "end";
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const close = () => panelRef.current?.hidePopover();

  function place() {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const edge = 8;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    // Lined up with the trigger's end (or start) edge, kept on screen; above it
    // when there is no room below.
    const anchor = align === "start" ? rect.left : rect.right - width;
    const left = Math.max(edge, Math.min(anchor, window.innerWidth - width - edge));
    const below = rect.bottom + gap;
    const above = rect.top - gap - height;
    const top = below + height > window.innerHeight - edge && above >= edge ? above : below;
    panel.style.setProperty("--menu-left", `${left}px`);
    panel.style.setProperty("--menu-top", `${top}px`);
  }

  function enabledItems(): HTMLElement[] {
    return Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled])') ??
        [],
    );
  }

  function onToggle(event: ToggleEvent<HTMLDivElement>) {
    const isOpen = event.newState === "open";
    setOpen(isOpen);
    if (!isOpen) return;
    place();
    enabledItems()[0]?.focus();
  }

  // The panel is pinned where the trigger was when it opened, so a page scroll
  // or resize would detach it — close instead.
  useEffect(() => {
    if (!open) return;
    const hide = () => panelRef.current?.hidePopover();
    function onScroll(event: Event) {
      if (!panelRef.current?.contains(event.target as Node)) hide();
    }
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = enabledItems();
    if (list.length === 0) return;
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next = {
      ArrowDown: (index + 1) % list.length,
      ArrowUp: (index - 1 + list.length) % list.length,
      Home: 0,
      End: list.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    list[next]?.focus();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={children ? undefined : label}
        title={children ? undefined : label}
        className={triggerClassName ?? cn(iconButtonVariants(), "size-8 border-transparent")}
      >
        {children ?? <MoreHorizontalIcon />}
      </button>
      <div
        ref={panelRef}
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        className={PANEL}
        onToggle={onToggle}
        onKeyDown={onKeyDown}
      >
        {/* Visual only: the menu's `aria-label` already names it. */}
        <p
          aria-hidden="true"
          className="px-3 pt-1 pb-2 font-semibold text-foreground/65 text-xs md:hidden"
        >
          {label}
        </p>
        {items.map((item) => (
          <MenuItem key={item.label} item={item} close={close} />
        ))}
      </div>
    </>
  );
}

function MenuItem({ item, close }: { item: ActionMenuItem; close: () => void }) {
  switch (item.kind) {
    case "link":
      return item.newTab ? (
        // A plain <a>: a new tab is always a full document load, so <Link>
        // would only add a prefetch that can never be used.
        <a
          role="menuitem"
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          className={ITEM}
          onClick={close}
        >
          {item.icon}
          {item.label}
        </a>
      ) : (
        <Link
          role="menuitem"
          href={item.href}
          aria-current={item.checked ? "true" : undefined}
          className={ITEM}
          onClick={close}
        >
          {item.icon}
          <ItemText label={item.label} description={item.description} />
          {item.checked ? <CheckIcon className="ml-auto text-foreground!" /> : null}
        </Link>
      );
    case "copy-link":
      return <CopyLinkItem item={item} close={close} />;
    case "disabled":
      return (
        <div
          role="menuitem"
          aria-disabled="true"
          tabIndex={-1}
          className={cn(ITEM, "cursor-default text-foreground/45 hover:bg-transparent")}
        >
          {item.icon}
          {item.label}
          <span className="ml-auto shrink-0 pl-3 text-foreground/55 text-xs">{item.reason}</span>
        </div>
      );
    case "button":
      return (
        <button
          type="button"
          role="menuitem"
          className={cn(ITEM, item.destructive && "text-destructive [&_svg]:text-destructive")}
          onClick={() => {
            close();
            item.onSelect();
          }}
        >
          {item.icon}
          {item.label}
        </button>
      );
  }
}

function ItemText({ label, description }: { label: string; description?: string }) {
  if (!description) return label;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="font-medium">{label}</span>
      <span className="text-xs opacity-70">{description}</span>
    </span>
  );
}

// Copying keeps the menu open for a beat so "Copied!" is seen, then closes it.
function CopyLinkItem({
  item,
  close,
}: {
  item: Extract<ActionMenuItem, { kind: "copy-link" }>;
  close: () => void;
}) {
  const { copied, copy } = useCopyToClipboard({
    onFail: (text) => window.prompt("Copy the link:", text),
  });
  return (
    <button
      type="button"
      role="menuitem"
      className={ITEM}
      onClick={async () => {
        await copy(`${window.location.origin}${item.path}`);
        setTimeout(close, 600);
      }}
    >
      {copied ? <CheckIcon /> : item.icon}
      {copied ? "Copied!" : item.label}
    </button>
  );
}
