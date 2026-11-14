// Registers Novedu in the local Moodle as an LTI 1.3 tool, the way the admin chapter
// describes it, with the PASTED public key (so Moodle's server never has to reach the
// host) and name sharing on, email off. Prints Moodle's tool details — Plattform-ID,
// Client-ID, Deployment-ID — for Novedu's three connection variables.
//
// Usage: node register-tool.mjs <public-key.pem> [name]
import { readFileSync } from "node:fs";
import { MOODLE, NOVEDU, login, mainText, open } from "./mdl.mjs";

const [pemFile, name = "Novedu"] = process.argv.slice(2);
if (!pemFile) {
  console.error("Usage: node register-tool.mjs <public-key.pem> [name]");
  process.exit(2);
}
const { browser, page } = await open();
await login(page, "admin");
await page.goto(`${MOODLE}/mod/lti/toolconfigure.php`);
await page.click("text=manuell konfigurieren");
await page.waitForLoadState("networkidle");
await page.locator(".collapsible-actions a").first().click();
for (const toggle of await page.locator("a.moreless-toggler").all()) await toggle.click().catch(() => {});
await page.fill("#id_lti_typename", name);
await page.fill("#id_lti_toolurl", `${NOVEDU}/api/lti/launch`);
await page.selectOption("#id_lti_ltiversion", "1.3.0");
await page.selectOption("#id_lti_keytype", "RSA_KEY");
await page.fill("#id_lti_publickey", readFileSync(pemFile, "utf8"));
await page.fill("#id_lti_initiatelogin", `${NOVEDU}/api/lti/login`);
await page.fill("#id_lti_redirectionuris", `${NOVEDU}/api/lti/launch`);
await page.selectOption("#id_lti_coursevisible", "2"); // shown in the activity chooser
await page.selectOption("#id_lti_launchcontainer", "4"); // new window
await page.check("#id_lti_contentitem"); // deep linking ("Inhalt auswählen")
await page.selectOption("#id_ltiservice_gradesynchronization", "1");
await page.selectOption("#id_lti_sendname", "1"); // always
await page.selectOption("#id_lti_sendemailaddr", "0"); // never
await page.selectOption("#id_lti_acceptgrades", "1");
await page.click("#id_submitbutton");
await page.waitForLoadState("networkidle");
console.log((await mainText(page)).slice(0, 300));
const card = page.locator(".tool-card", { hasText: name }).last();
await card
  .locator("a.tool-card-icon.view, a[title*='Konfigurationsdetails'], a[title*='details' i]")
  .first()
  .click();
await page.waitForTimeout(1500);
console.log(await page.locator(".modal.show, .moodle-dialogue").last().innerText());
await browser.close();
