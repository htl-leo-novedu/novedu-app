import { beforeEach, expect, it, vi } from "vitest";

// The Appearance choice: it stores the picked theme in the device's cookie for a
// year; an unknown value is stored as the default — never a raw client string.

const set = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ cookies: async () => ({ set }) }));

import { THEME_COOKIE } from "./theme";
import { setThemeAction } from "./theme-actions";

const OPTIONS = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 };

beforeEach(() => set.mockClear());

it.each(["light", "dark", "system"])("stores %s for a year", async (theme) => {
  await expect(setThemeAction(theme)).resolves.toEqual({ ok: true });
  expect(set).toHaveBeenCalledExactlyOnceWith(THEME_COOKIE, theme, OPTIONS);
});

it.each([["sepia"], [undefined], [{ theme: "dark" }], ['dark"><script>']])(
  "stores the default for %j",
  async (value) => {
    await setThemeAction(value);
    expect(set).toHaveBeenCalledExactlyOnceWith(THEME_COOKIE, "system", OPTIONS);
  },
);
