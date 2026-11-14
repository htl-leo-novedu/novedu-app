// teacher1 adds the Novedu activity to a course, either through Novedu's code picker
// ("Inhalt auswählen") or by typing the custom parameter. Prints the new activity's
// view link (its `id=` is the course module id student-launch.mjs needs).
//
// Usage: node teacher-add.mjs <courseId> <typeId> <code> picker|custom [name]
import { MOODLE, login, open } from "./mdl.mjs";

const [courseId, typeId, code, mode = "picker", name] = process.argv.slice(2);
if (!courseId || !typeId || !code) {
  console.error("Usage: node teacher-add.mjs <courseId> <typeId> <code> picker|custom [name]");
  process.exit(2);
}
const { browser, page } = await open();
await login(page, "teacher1");
await page.goto(
  `${MOODLE}/course/modedit.php?add=lti&course=${courseId}&section=1&return=0&typeid=${typeId}`,
);
await page.waitForLoadState("networkidle");
await page.locator(".collapsible-actions a").first().click().catch(() => {});
for (const toggle of await page.locator("a.moreless-toggler").all()) await toggle.click().catch(() => {});
if (mode === "picker") {
  await page.locator("button[name=selectcontent]:visible").first().click();
  const frame = page.frameLocator("iframe#contentframe, .modal iframe, iframe").last();
  await frame.locator("#lti-pick-code").waitFor({ timeout: 20_000 });
  await frame.locator("#lti-pick-code").fill(code);
  await frame.getByRole("button", { name: "Use this quiz" }).click();
  await page.waitForTimeout(4000);
  const error = await frame.locator("[role=alert]").innerText().catch(() => "");
  if (error) {
    console.log("picker refused:", error);
    await browser.close();
    process.exit(1);
  }
  console.log(
    "after picker — name:",
    await page.inputValue("#id_name"),
    "| max:",
    await page.inputValue("#id_grade_modgrade_point").catch(() => "?"),
  );
} else {
  await page.fill("#id_instructorcustomparameters", `novedu_code=${code}`);
}
if (name) await page.fill("#id_name", name);
await page.click("#id_submitbutton2");
await page.waitForLoadState("networkidle");
const links = await page
  .locator('a[href*="/mod/lti/view.php"]')
  .evaluateAll((as) => as.map((a) => `${a.innerText.trim().split("\n")[0]} ${a.href}`));
console.log([...new Set(links)].join("\n"));
await browser.close();
