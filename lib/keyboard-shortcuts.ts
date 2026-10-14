"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";

// The app's keyboard shortcuts, in one place so every surface behaves alike
// (docs/styling.md, "Keyboard shortcuts"):
//
// - Ctrl/⌘+Enter submits a multi-line field (`onModEnter` on the textarea).
// - Ctrl/⌘+S saves an editor page (`useSaveShortcut`).
//
// Enter stays native everywhere else: single-line forms submit on it, and the
// CopilotKit chats send on Enter themselves. Both modifiers are accepted on
// every platform; only the hint text (`useShortcutHint`) differs.

type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "repeat" | "isComposing"
>;

/** `aria-keyshortcuts` for the control that owns Ctrl/⌘+Enter. */
export const SUBMIT_KEYSHORTCUTS = "Control+Enter Meta+Enter";
/** `aria-keyshortcuts` for the button that owns Ctrl/⌘+S. */
export const SAVE_KEYSHORTCUTS = "Control+S Meta+S";

function isModShortcut(e: ShortcutEvent): boolean {
  // An IME confirms its candidate with Enter (`isComposing`); a held key
  // auto-repeats (`repeat`) — neither is a deliberate submit.
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !e.isComposing && !e.repeat;
}

export function isSubmitShortcut(e: ShortcutEvent): boolean {
  return e.key === "Enter" && isModShortcut(e);
}

export function isSaveShortcut(e: ShortcutEvent): boolean {
  return e.key.toLowerCase() === "s" && isModShortcut(e);
}

/** An `onKeyDown` for a textarea: Ctrl/⌘+Enter runs `handler` instead of
 * inserting a newline. The handler applies the same guards as the button. */
export function onModEnter(handler: () => void) {
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!isSubmitShortcut(e.nativeEvent)) return;
    e.preventDefault();
    handler();
  };
}

/** Ctrl/⌘+S anywhere on the page runs `onSave` while mounted and `enabled`.
 * The browser's "Save page" never opens while a page owns the shortcut, even
 * when `onSave` has nothing to do — it applies the same guards as the button. */
export function useSaveShortcut(onSave: () => void, enabled = true) {
  const latest = useRef(onSave);
  useEffect(() => {
    latest.current = onSave;
  });
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!isSaveShortcut(e)) return;
      e.preventDefault();
      latest.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

function isApple(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

const noSubscribe = () => () => {};

/** The shortcut's name for a button `title`: `Ctrl+Enter` / `Ctrl+S`, or
 * `⌘+Enter` / `⌘+S` on Apple devices. The server renders the non-Apple form,
 * so hydration agrees and an Apple client switches after it. */
export function useShortcutHint(kind: "submit" | "save"): string {
  const apple = useSyncExternalStore(noSubscribe, isApple, () => false);
  return `${apple ? "⌘" : "Ctrl"}+${kind === "submit" ? "Enter" : "S"}`;
}
