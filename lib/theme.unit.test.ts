import { expect, it, vi } from "vitest";

// The theme cookie's parser and its server read: anything but the three themes
// — a missing cookie included — reads as the default, "system".

const get = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ cookies: async () => ({ get }) }));

import { DEFAULT_THEME, parseTheme, THEME_COOKIE, THEME_SCRIPT, THEMES } from "./theme";
import { getTheme } from "./theme-server";

it("parses the three themes and defaults everything else to system", () => {
  expect(DEFAULT_THEME).toBe("system");
  for (const theme of THEMES) expect(parseTheme(theme)).toBe(theme);
  for (const junk of ["", "Dark", "sepia", null, undefined, 1]) {
    expect(parseTheme(junk)).toBe("system");
  }
});

it("reads the device's cookie", async () => {
  get.mockReturnValueOnce({ value: "dark" });
  await expect(getTheme()).resolves.toBe("dark");
  expect(get).toHaveBeenCalledWith(THEME_COOKIE);
  get.mockReturnValueOnce(undefined);
  await expect(getTheme()).resolves.toBe("system");
  get.mockReturnValueOnce({ value: "nonsense" });
  await expect(getTheme()).resolves.toBe("system");
});

it("the pre-paint script is a static constant with no interpolation hole", () => {
  expect(THEME_SCRIPT).not.toMatch(/\$\{|<\/script/i);
});
