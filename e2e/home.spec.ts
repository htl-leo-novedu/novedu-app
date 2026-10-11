import { expect, type Page, test } from "@playwright/test";
import { BRAND } from "../lib/brand";
import { STORAGE_STATE, TEACHER_STORAGE_STATE } from "./auth.constants";
import { watchErrors } from "./page.utils";
import {
  deletePrincipal,
  signInFreshStudent,
  signInFreshTeacher,
  studentModeCookie,
} from "./principal.utils";

// Smoke: the start page opens without an error for every kind of visitor — a
// student, a teacher (the dashboard), a teacher viewing as a student (the
// student page), and a brand-new student and teacher with no history at all
// (the empty states). Hermetic: the fresh principals' auth rows are the only
// writes, removed again afterwards.

/** No Next.js error overlay (dev) and no error boundary. */
async function expectNoErrorScreen(page: Page) {
  await expect(page.locator("[data-nextjs-dialog-root]")).toHaveCount(0);
  await expect(page.getByText(/Application error|Something went wrong/)).toHaveCount(0);
}

/**
 * The teacher dashboard: the greeting and the Teacher Guide, then either every
 * section (rendered, or showing its "unavailable" note) or — for a teacher
 * without any code — the one getting-started line. The shared teacher principal
 * may or may not own codes, depending on which specs ran before.
 */
async function expectTeacherHomeRendered(page: Page): Promise<"dashboard" | "no-codes"> {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: /^Welcome back/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Teacher Guide/ })).toHaveAttribute(
    "href",
    "https://docs.novedu.at",
  );
  await expect(page.getByText(`${BRAND} / Home`, { exact: true })).toBeVisible();
  // No student parts: no code field, no progress.
  await expect(page.getByLabel("Code")).toHaveCount(0);
  await expect(page.getByText("Your progress here is only visible to you.")).toHaveCount(0);

  const intro = page.getByText("You haven't shared an activity yet.", { exact: false });
  const attention = page.getByRole("heading", { level: 2, name: "Needs you" });
  await expect(intro.or(attention)).toBeVisible();
  const state = (await intro.isVisible()) ? "no-codes" : "dashboard";
  if (state === "dashboard") {
    for (const title of ["Last 30 days", "Top activities"]) {
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    }
  }
  // The badges, with or without codes: the teacher's families, or the unavailable note.
  const badges = page.getByRole("region", { name: "Badges" });
  await expect(badges).toBeVisible();
  await expect(
    badges.locator('[data-family="reach"]').or(badges.getByText(/could not be loaded/)),
  ).toBeVisible();
  await expect(badges.locator('[data-family="rhythm"]')).toHaveCount(0);
  await expectNoErrorScreen(page);
  return state;
}

/** Every section rendered, or showing its "unavailable" note — never an error boundary. */
async function expectHomeRendered(page: Page) {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  // Continue comes first, with the code field.
  const headings = page.getByRole("heading", { level: 2 });
  await expect(page.getByRole("heading", { level: 1, name: /^Welcome back/ })).toBeVisible();
  await expect(page.getByLabel("Code")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();

  for (const title of [
    "Recently used",
    "Your progress",
    "Your last 26 weeks",
    "Time to refresh",
    "Almost there",
    "Badges",
  ]) {
    await expect(headings.filter({ hasText: title })).toBeVisible();
  }
  // The status bar names the page; the burger menu's first item is Home.
  await expect(page.getByText(`${BRAND} / Home`, { exact: true })).toBeVisible();
  // The privacy promise is part of the page, not a detail.
  await expect(page.getByText("Your progress here is only visible to you.")).toBeVisible();

  await expectNoErrorScreen(page);
}

test.describe("as the student principal", () => {
  test.use({ storageState: STORAGE_STATE });

  test("the start page opens without errors", async ({ page }) => {
    const errors = watchErrors(page);
    await expectHomeRendered(page);
    expect(errors).toEqual([]);
  });
});

test.describe("as the teacher principal", () => {
  test.use({ storageState: TEACHER_STORAGE_STATE });

  test("the start page is the teacher dashboard and opens without errors", async ({ page }) => {
    const errors = watchErrors(page);
    await expectTeacherHomeRendered(page);
    expect(errors).toEqual([]);
  });

  test("in view-as-student mode the start page is the student page", async ({ page, context }) => {
    await context.addCookies([await studentModeCookie(context)]);
    const errors = watchErrors(page);
    await expectHomeRendered(page);
    await expect(page.getByText("Student mode")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("as a brand-new student", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the empty state: level 1, no streak, an empty calendar, no strip", async ({
    page,
    context,
  }) => {
    // Surname first, like the school's directory: the greeting uses the given name.
    const principal = await signInFreshStudent(context, "Newcomer Nova", "Nova");
    try {
      const errors = watchErrors(page);
      await expectHomeRendered(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome back, Nova");

      const progress = page.getByRole("region", { name: "Your progress" });
      await expect(progress.getByRole("progressbar")).toHaveAttribute(
        "aria-valuetext",
        "0 XP, level 1, 100 XP to level 2",
      );
      await expect(progress).toContainText("0weeks in a row");
      await expect(progress.getByText("Be active this week to start a streak.")).toBeVisible();

      await expect(page.getByText("Your first active day will show up here.")).toBeVisible();
      await expect(
        page.locator('[data-level="1"], [data-level="2"], [data-level="3"]'),
      ).toHaveCount(0);
      await expect(
        page.getByRole("group", { name: /^Activity calendar: 0 active days/ }),
      ).toBeVisible();

      await expect(page.getByText(/new badges? since your last visit/)).toHaveCount(0);
      await expect(page.getByText("Badges you're close to will show up here.")).toBeVisible();
      await expect(page.getByText(/^Save a result on a quiz's summary page/)).toBeVisible();
      await expect(page.getByText("Activities you open show up here")).toBeVisible();
      await expect(page.getByText("0 earned")).toBeVisible();
      // Coding is listed like every family; the Secret column only says more exist.
      await expect(page.locator('[data-family="coding"]')).toContainText("Connected");
      await expect(page.locator('[data-family="quiz"]')).toContainText("First Result");
      await expect(page.locator('[data-family="secret"]')).toHaveText(
        "SecretSecret badges show up here once you earn them.",
      );
      expect(errors).toEqual([]);
    } finally {
      await deletePrincipal(principal.id);
    }
  });
});

test.describe("as a brand-new teacher", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("without any code: the greeting, the Teacher Guide, one line and the badges to earn", async ({
    page,
    context,
  }) => {
    const principal = await signInFreshTeacher(context, "Newteacher Tina", "Tina");
    try {
      const errors = watchErrors(page);
      expect(await expectTeacherHomeRendered(page)).toBe("no-codes");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome back, Tina");
      // No dashboard sections — only the badges, nothing earned, First Code first.
      await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Badges"]);
      const badges = page.getByRole("region", { name: "Badges" });
      await expect(badges.getByText("0 earned")).toBeVisible();
      await expect(badges.locator("li[data-badge]").first()).toHaveAttribute(
        "data-badge",
        "first-code",
      );
      await expect(page.getByText(/new badges? since your last visit/)).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await deletePrincipal(principal.id);
    }
  });
});

test.describe("navigation", () => {
  test.use({ storageState: STORAGE_STATE });

  test("the burger menu's Home item leads back to the start page", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByText(`${BRAND} / Settings`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await page.getByRole("link", { name: "Home" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1, name: /^Welcome back/ })).toBeVisible();
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(page.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  });
});
