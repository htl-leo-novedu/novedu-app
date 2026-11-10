import type { Page } from "@playwright/test";

/** Collects uncaught page errors and console errors for the whole visit. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/**
 * `errors` without the console noise of an external resource that failed to
 * load — e.g. Excalidraw's font CDN being unreachable, which the board survives
 * (it falls back to a local font). Nothing a spec asserts depends on it.
 */
export function withoutNetworkNoise(errors: string[]): string[] {
  return errors.filter((e) => !/Failed to load (resource|font)/.test(e));
}

/**
 * Replaces the CodeMirror document with `text`. `insertText` inserts verbatim
 * (like a paste) so YAML indentation and newlines survive — unlike per-key
 * typing, which CodeMirror would auto-indent.
 */
export async function setEditorContent(page: Page, text: string): Promise<void> {
  const content = page.locator(".cm-content");
  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
}
