// A Moodle student opens the Novedu activity (new window), signed in to Novedu with
// a minted session cookie (novedu-session.mts), and walks the flow as far as asked:
//   link   — stop on the page Novedu shows first (confirmation, refusal, quiz)
//   confirm — click "Yes, these are both me" and stop on the quiz
//   handin — confirm if asked, answer every question with ANSWER, finish, hand in
//
// Usage: NOVEDU_COOKIE=<value> node student-launch.mjs <user> <cmid> [chromium|firefox] [link|confirm|handin]
import { MOODLE, NOVEDU, login, open } from "./mdl.mjs";

const [user, cmid, browserName = "chromium", until = "handin"] = process.argv.slice(2);
const cookie = process.env.NOVEDU_COOKIE;
if (!user || !cmid || !cookie) {
  console.error(
    "Usage: NOVEDU_COOKIE=<value> node student-launch.mjs <user> <cmid> [browser] [link|confirm|handin]",
  );
  process.exit(2);
}
const { browser, context, page } = await open(browserName);
const novedu = new URL(NOVEDU);
await context.addCookies([
  {
    name: "novedu.session_token",
    value: cookie,
    domain: novedu.hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  },
]);
await login(page, user);
const popup = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
await page.goto(`${MOODLE}/mod/lti/view.php?id=${cmid}`);
const target = await popup;
if (!target) {
  console.log("NO NEW WINDOW. Moodle shows:", (await page.locator("#region-main").innerText()).slice(0, 300));
  await browser.close();
  process.exit(1);
}
await target.waitForLoadState("networkidle");
const say = async (label) =>
  console.log(`[${browserName}] ${label}: ${target.url()}\n${(await target.locator("main").innerText()).slice(0, 700)}\n`);
await say("arrived");
if (until === "link") process.exit((await browser.close(), 0));

const confirm = target.getByRole("button", { name: "Yes, these are both me" });
if (await confirm.isVisible().catch(() => false)) {
  await confirm.click();
  await target.waitForURL((url) => !url.pathname.startsWith("/lti/link"), { timeout: 30_000 });
  await target.waitForLoadState("networkidle");
  await say("after confirm");
}
if (until === "confirm") process.exit((await browser.close(), 0));

const answer = process.env.ANSWER ?? "4";
await target.getByRole("textbox").waitFor({ timeout: 30_000 });
for (let i = 0; i < 50; i++) {
  const box = target.getByRole("textbox");
  if (!(await box.isVisible().catch(() => false))) break;
  await box.fill(answer);
  await target.getByRole("button", { name: "Submit answer" }).click();
  const next = target.getByRole("button", { name: /^(Next question|Finish)$/ });
  await next.waitFor({ timeout: 90_000 });
  await next.click();
}
const handIn = target.getByTestId("moodle-hand-in");
await handIn.waitFor({ timeout: 20_000 });
await handIn.getByRole("button", { name: /Hand in|Try again/ }).click();
await target.waitForTimeout(5000);
console.log(`[${browserName}] hand-in box:\n${await handIn.innerText()}`);
await browser.close();
