import { expect, test } from "@playwright/test";

// The security property this whole feature exists for: an unauthenticated
// visitor must never reach the app. The other specs run with a minted session
// cookie (see auth.setup.ts); here we override storageState to empty so the
// browser arrives logged out, overriding the chromium project's default. If the
// proxy matcher ever stops gating a protected path, this test fails.
//
// The redirect carries the wanted path as `callbackURL`, which is what makes a
// bounced visitor land where they were going after signing in — so each case
// asserts the exact query string, not merely that /sign-in was reached.
test.use({ storageState: { cookies: [], origins: [] } });

const GATED_PATHS = [
  "/",
  "/files",
  "/codes/new",
  "/codes",
  // Anonymous users cannot use the app even with a genuine code (any module) —
  // the code only authorizes the activity + window, never the user.
  "/a1b2c3d4e5",
  // The Moodle arrival needs a session; Moodle's own routes do not (docs/moodle.md).
  "/lti/arrive",
] as const;

for (const path of GATED_PATHS) {
  test(`unauthenticated users are redirected to sign in from ${path}`, async ({ page }) => {
    await page.goto(path);

    await expect(page).toHaveURL(`/sign-in?callbackURL=${encodeURIComponent(path)}`);
  });
}
