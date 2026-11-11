"use client";

import { useSyncExternalStore } from "react";

// True while <html> carries the `dark` class, which only the pre-paint script
// (lib/theme.ts) sets. For the widgets whose colours are JS, not CSS: CodeMirror,
// the Prism code blocks and the Recharts charts. The server snapshot is light;
// the first client render after hydration corrects it.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

export function useIsDark(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
}
