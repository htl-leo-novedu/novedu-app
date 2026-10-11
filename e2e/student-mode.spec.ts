import { expect, test } from "@playwright/test";
import { E2E_TEACHER, STORAGE_STATE, TEACHER_STORAGE_STATE } from "./auth.constants";
import { mintSession, sessionCookie, studentModeCookie } from "./principal.utils";

// "Student mode": a teacher temporarily experiences the app as a student. While
// active, every teacher surface must deny them exactly like a real student —
// with one exception: the visible "Student mode" pill whose Exit control
// restores their rights.

test.use({ storageState: TEACHER_STORAGE_STATE });

test("a teacher can enter student mode, is treated as a student, and can exit again", async ({
  page,
}) => {
  // Before: full teacher experience.
  await page.goto("/codes/new");
  await expect(page.getByRole("button", { name: "Create code" })).toBeVisible();

  // Enter student mode via the user menu.
  await page.getByRole("button", { name: /E2E Teacher/ }).click();
  await page.getByRole("menuitem", { name: "View as student" }).click();
  await expect(page.getByText("Student mode")).toBeVisible();

  // The current page re-renders as the student version (access denied)...
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create code" })).toHaveCount(0);

  // ...the teacher badge is gone (the nav's hidden entries are asserted in
  // permissions.spec.ts)...
  await expect(page.getByRole("img", { name: "Teacher" })).toHaveCount(0);

  // ...and another teacher page's server-side gate denies like for a real student.
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();

  // Exit via the pill — rights come back immediately.
  await page.getByRole("button", { name: "Exit" }).click();
  await expect(page.getByText("Student mode")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Teacher" })).toBeVisible();
  await expect(page.getByRole("link", { name: "New file" })).toBeVisible(); // /files again
});

test("a student gains nothing by setting the student-mode cookie", async ({ browser }) => {
  // Defense check: the cookie only restricts, it must never grant. Use the
  // STUDENT state plus a hand-set cookie and confirm no teacher surface opens
  // and no pill appears (the pill is teacher-only chrome).
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  await context.addCookies([await studentModeCookie(context)]);
  const page = await context.newPage();

  await page.goto("/");
  await expect(page.getByText("Student mode")).toHaveCount(0);
  await page.goto("/codes/new");
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();

  await context.close();
});

test("a new sign-in never inherits student mode from an earlier session", async ({ browser }) => {
  // The cookie names the session that entered the mode. A cookie left behind
  // (no sign-out: an expired session, a reset database, a restored browser)
  // must not put the next session of a teacher into student mode.
  const context = await browser.newContext({ storageState: TEACHER_STORAGE_STATE });
  await context.addCookies([await studentModeCookie(context)]);
  const page = await context.newPage();
  await page.goto("/codes/new");
  await expect(page.getByText("Student mode")).toBeVisible();

  // A new sign-in: a fresh session for the same teacher, the stale cookie kept.
  await context.addCookies([await sessionCookie(await mintSession(E2E_TEACHER, true))]);
  await page.goto("/codes/new");
  await expect(page.getByRole("button", { name: "Create code" })).toBeVisible();
  await expect(page.getByText("Student mode")).toHaveCount(0);

  await context.close();
});
