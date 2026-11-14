// Playwright helpers for driving a LOCAL Moodle's UI (the novedu-moodle-test skill).
// Not product code and not a test suite: an agent runs these by hand.
import * as pw from "playwright";

export const MOODLE = process.env.MOODLE_URL ?? "http://127.0.0.1:8091";
export const NOVEDU = process.env.NOVEDU_URL ?? "http://localhost:3000";

/** The local Moodle accounts' password — from the environment, never from a tracked file. */
export function moodlePassword() {
  const password = process.env.MOODLE_DEV_PASSWORD;
  if (!password) {
    console.error("Set MOODLE_DEV_PASSWORD to the local Moodle accounts' password.");
    process.exit(2);
  }
  return password;
}

export async function open(browserName = "chromium", contextOptions = {}) {
  const browser = await pw[browserName].launch();
  const context = await browser.newContext({
    locale: "de-AT",
    viewport: { width: 1400, height: 1000 },
    ...contextOptions,
  });
  return { browser, context, page: await context.newPage() };
}

export async function login(page, username) {
  await page.goto(`${MOODLE}/login/index.php`);
  await page.fill("#username", username);
  await page.fill("#password", moodlePassword());
  await page.click("#loginbtn");
  await page.waitForLoadState("networkidle");
}

export const mainText = async (page) =>
  (await page.locator("#region-main").innerText()).replace(/\n{2,}/g, "\n");
