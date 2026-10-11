import { expect, test } from "@playwright/test";
import { BRAND } from "../lib/brand";
import { deletePrincipal, signInFreshStudent } from "./principal.utils";

// The Settings page (docs/home.md → Settings page): reachable from the user menu
// for every signed-in user, its quiz-results switch persists, and with nothing
// saved the delete action is disabled. `@live-db`: the switch drives a real
// `novedu_user_settings` row through the server and back (docs/testing.md). A
// fresh student, so no other spec's rows interfere; its settings row is removed
// with it. Saving and deleting real results: e2e/quiz-results.live.spec.ts.

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
    await expect(page.getByRole("heading", { name: "Quiz and exercise results" })).toBeVisible();

    const toggle = page.getByRole("switch", {
      name: "Save my quiz and exercise results for my personal statistics",
    });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText(/Only you can see them — your teacher cannot\./)).toBeVisible();
    await expect(page.getByText("You have no saved results.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete my saved results" })).toBeDisabled();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toBeEnabled();
    await page.reload();
    await expect(
      page.getByRole("switch", {
        name: "Save my quiz and exercise results for my personal statistics",
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(errors).toEqual([]);
  } finally {
    await deletePrincipal(principal.id);
  }
});
