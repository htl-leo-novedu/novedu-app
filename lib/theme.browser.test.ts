import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyTheme, THEME_SCRIPT } from "./theme";

// The pre-paint script in a real DOM: it turns `<html data-theme>` into the
// `dark` class — `dark` on, `light` off, `system` by the OS scheme — and keeps
// it current when the attribute or the OS scheme changes. `matchMedia` is
// stubbed so the OS scheme can be flipped.

const root = document.documentElement;
let osDark = false;
let listeners: Array<() => void> = [];

function setOs(dark: boolean) {
  osDark = dark;
  for (const listener of listeners) listener();
}

function run(theme: string) {
  root.setAttribute("data-theme", theme);
  new Function(THEME_SCRIPT)();
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  osDark = false;
  listeners = [];
  root.classList.remove("dark");
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return osDark;
    },
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  root.classList.remove("dark");
  root.removeAttribute("data-theme");
});

test("dark and light are fixed, whatever the OS says", () => {
  osDark = true;
  run("light");
  expect(root.classList.contains("dark")).toBe(false);
  osDark = false;
  root.classList.remove("dark");
  run("dark");
  expect(root.classList.contains("dark")).toBe(true);
  setOs(false);
  expect(root.classList.contains("dark")).toBe(true);
});

test("system follows the OS scheme, live", () => {
  run("system");
  expect(root.classList.contains("dark")).toBe(false);
  setOs(true);
  expect(root.classList.contains("dark")).toBe(true);
  setOs(false);
  expect(root.classList.contains("dark")).toBe(false);
});

test("a missing or unknown attribute follows the OS", () => {
  osDark = true;
  run("bogus");
  expect(root.classList.contains("dark")).toBe(true);
});

test("applyTheme switches the page at once", async () => {
  run("light");
  applyTheme("dark");
  await nextTick();
  expect(root.classList.contains("dark")).toBe(true);
  applyTheme("system");
  await nextTick();
  expect(root.classList.contains("dark")).toBe(false);
  setOs(true);
  expect(root.classList.contains("dark")).toBe(true);
});
