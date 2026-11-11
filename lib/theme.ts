// The colour theme (docs/styling.md, "Theme"). A per-device cookie holds the
// choice; the root layout reads it on the server (lib/theme-server.ts) and
// renders it as `<html data-theme>`. `THEME_SCRIPT`, inlined in the layout's
// <head>, turns that attribute into the `dark` class before the first paint and
// keeps it current — on an OS scheme change and on every later change of the
// attribute. The `dark` class is owned by that script alone: React renders only
// `data-theme`, so hydration and re-renders never fight over it. Client-safe
// (no `next/headers`): the Settings page imports it.

export const THEME_COOKIE = "novedu-theme";

/** `system` follows the device's colour scheme (`prefers-color-scheme`). */
export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

/** What a device without the cookie gets. */
export const DEFAULT_THEME: Theme = "system";

export function parseTheme(value: unknown): Theme {
  return THEMES.find((theme) => theme === value) ?? DEFAULT_THEME;
}

/**
 * The pre-paint script. A static constant — it reads the theme from the DOM and
 * never has a value interpolated into it. `dark` → dark, `light` → light,
 * anything else → the OS scheme.
 */
export const THEME_SCRIPT = `(function(){try{var d=document.documentElement,m=matchMedia("(prefers-color-scheme: dark)");function a(){var t=d.getAttribute("data-theme");d.classList.toggle("dark",t==="dark"||(t!=="light"&&m.matches))}a();m.addEventListener("change",a);new MutationObserver(a).observe(d,{attributes:true,attributeFilter:["data-theme"]})}catch(e){}})()`;

/** Switches this page to `theme` at once; `THEME_SCRIPT` updates the `dark` class. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
