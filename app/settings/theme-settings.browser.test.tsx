import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

// The Settings page's "Appearance" section: three radios, the device's current
// theme preselected; a pick switches the page at once (`<html data-theme>`) and
// stores it; a failed store says so and keeps the pick. The action is mocked;
// its cookie handling lives in lib/theme-actions.unit.test.ts.

const setThemeAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/theme-actions", () => ({ setThemeAction }));

import { ThemeSettings } from "./theme-settings";

beforeEach(() => {
  setThemeAction.mockResolvedValue({ ok: true });
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  setThemeAction.mockReset();
});

test("preselects the device's theme and offers all three", async () => {
  const screen = await render(<ThemeSettings initialTheme="system" />);
  await expect.element(screen.getByRole("radio", { name: "Same as device" })).toBeChecked();
  await expect.element(screen.getByRole("radio", { name: "Light" })).not.toBeChecked();
  await expect.element(screen.getByRole("radio", { name: "Dark" })).not.toBeChecked();
  await expect.element(screen.getByRole("group", { name: "Colour theme" })).toBeVisible();
});

test("a pick applies at once and is stored", async () => {
  const screen = await render(<ThemeSettings initialTheme="light" />);
  await screen.getByRole("radio", { name: "Dark" }).click();
  await expect.element(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(setThemeAction).toHaveBeenCalledExactlyOnceWith("dark");
});

test("a failed store keeps the pick and says so", async () => {
  setThemeAction.mockRejectedValue(new Error("offline"));
  const screen = await render(<ThemeSettings initialTheme="light" />);
  await screen.getByRole("radio", { name: "Same as device" }).click();
  await expect.element(screen.getByText(/could not be saved right now/)).toBeVisible();
  await expect.element(screen.getByRole("radio", { name: "Same as device" })).toBeChecked();
  expect(document.documentElement.dataset.theme).toBe("system");
});
