import { describe, expect, test } from "vitest";
import { isSaveShortcut, isSubmitShortcut } from "@/lib/keyboard-shortcuts";

// The shortcut predicates: either modifier matches on every platform; a held
// key, an IME confirmation, or an extra Shift/Alt never does. The DOM wiring
// (`onModEnter`, `useSaveShortcut`) is covered in keyboard-shortcuts.browser.test.tsx.

function key(k: string, mods: Partial<Omit<KeyboardEventInit, "key">> = {}) {
  return {
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    ...mods,
  };
}

describe.each([
  ["isSubmitShortcut", isSubmitShortcut, "Enter"],
  ["isSaveShortcut", isSaveShortcut, "s"],
] as const)("%s", (_, matches, k) => {
  test("matches with Ctrl or Meta", () => {
    expect(matches(key(k, { ctrlKey: true }))).toBe(true);
    expect(matches(key(k, { metaKey: true }))).toBe(true);
  });

  test("does not match without a modifier", () => {
    expect(matches(key(k))).toBe(false);
  });

  test.each([
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["a composing IME", { isComposing: true }],
    ["an auto-repeat", { repeat: true }],
  ])("does not match with %s", (_, extra) => {
    expect(matches(key(k, { ctrlKey: true, ...extra }))).toBe(false);
  });
});

test("isSaveShortcut matches an upper-case S (Caps Lock)", () => {
  expect(isSaveShortcut(key("S", { ctrlKey: true }))).toBe(true);
});

test("the predicates do not cross-match", () => {
  expect(isSubmitShortcut(key("s", { ctrlKey: true }))).toBe(false);
  expect(isSaveShortcut(key("Enter", { ctrlKey: true }))).toBe(false);
});
