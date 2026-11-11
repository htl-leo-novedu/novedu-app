import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { BRAND } from "../lib/brand";
import { THEME_COOKIE } from "../lib/theme";
import { mintTutorCode } from "./code.utils";
import { deletePrincipal, signInFreshStudent } from "./principal.utils";

// The Settings page (docs/home.md → Settings page): reachable from the user menu
// for every signed-in user, its quiz-results switch persists, and with nothing
// saved the delete action is disabled. `@live-db`: the switch drives a real
// `novedu_user_settings` row through the server and back (docs/testing.md). A
// fresh student, so no other spec's rows interfere; its settings row is removed
// with it. Saving and deleting real results: e2e/quiz-results.live.spec.ts.
// The Appearance section stores this device's colour theme in a cookie
// (lib/theme.ts); the pre-paint script turns it into `<html class="dark">`.

test.use({ storageState: { cookies: [], origins: [] } });

test("reached from the user menu; the quiz-results switch persists", {
  tag: ["@live", "@live-db"],
}, async ({ page, context }) => {
  const principal = await signInFreshStudent(context, "Sasha Settings");
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await page.getByRole("button", { name: /Sasha Settings/ }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByText(`${BRAND} / Settings`, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Quiz results" })).toBeVisible();

    const toggle = page.getByRole("switch", {
      name: "Save my quiz results for my personal statistics",
    });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText(/Only you can see them — your teacher cannot\./)).toBeVisible();
    await expect(page.getByText("You have no saved quiz results.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete my saved results" })).toBeDisabled();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toBeEnabled();
    await page.reload();
    await expect(
      page.getByRole("switch", { name: "Save my quiz results for my personal statistics" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(errors).toEqual([]);
  } finally {
    await deletePrincipal(principal.id);
  }
});

const storedTheme = async (context: BrowserContext) =>
  (await context.cookies()).find((cookie) => cookie.name === THEME_COOKIE)?.value;

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

test("the Appearance choice switches the theme at once and persists on this device", {
  tag: ["@live", "@live-db"],
}, async ({ page, context }) => {
  const principal = await signInFreshStudent(context, "Dana Dark");
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    // No cookie yet: "Same as device", following the emulated OS scheme live.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/settings");
    await expect(page.getByRole("radio", { name: "Same as device" })).toBeChecked();
    expect(await isDark(page)).toBe(true);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => isDark(page)).toBe(false);

    // Dark holds under a light OS, at once and after a reload.
    await page.getByText("Dark", { exact: true }).click();
    await expect.poll(() => isDark(page)).toBe(true);
    await expect.poll(() => storedTheme(context)).toBe("dark");
    await page.reload();
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(await isDark(page)).toBe(true);

    // Light holds under a dark OS.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByText("Light", { exact: true }).click();
    await expect.poll(() => isDark(page)).toBe(false);
    await expect.poll(() => storedTheme(context)).toBe("light");
    await page.reload();
    expect(await isDark(page)).toBe(false);

    expect(errors).toEqual([]);
  } finally {
    await deletePrincipal(principal.id);
  }
});

test("the CopilotKit chat follows the dark theme", {
  tag: ["@live", "@live-db"],
}, async ({ page, context }) => {
  // Guards an undocumented CopilotKit behaviour (docs/styling.md, "Theme"): its
  // stylesheet switches its own palette under a `.dark` ancestor. A CopilotKit
  // bump that drops it leaves a white chat on a dark page.
  const principal = await signInFreshStudent(context, "Chen Chat");
  try {
    await context.addCookies([{ name: THEME_COOKIE, value: "dark", url: "http://localhost:3000" }]);
    const code = await mintTutorCode();
    await page.goto(`/${code}`);
    await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
    const lightness = await page
      .locator("[data-copilotkit]")
      .first()
      .evaluate((el) => {
        const [r = 255, g = 255, b = 255] = (
          getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? []
        ).map(Number);
        return (r + g + b) / 3;
      });
    expect(lightness).toBeLessThan(60);
  } finally {
    await deletePrincipal(principal.id);
  }
});
