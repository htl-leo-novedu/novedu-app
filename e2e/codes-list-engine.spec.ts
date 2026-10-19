import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { mintCode, VALID_QUIZ_URL } from "./code.utils";
import { watchErrors } from "./page.utils";

// `/codes` on both list engines (see `docs/filtered-lists.md`, "The new list
// engine"): each opens error-free, the Classic/New switch round-trips through
// its cookie, and — against the real database — the new list's filter panel
// (applied on Apply or Enter), sort header and pager drive ONE URL the server
// filters on, the summary line names the applied filters, its bulk bar deletes,
// the view picker switches to the Models view (each code's YAML model, its
// override and the reasoning level that runs), and a wide screen shows the row
// actions inline. Minted codes belong to the e2e creator, hence `owner=all`.

test.use({ storageState: TEACHER_STORAGE_STATE });

const ENGINE_COOKIE = "novedu-list-engine";

async function useNewEngine(context: BrowserContext, baseURL: string | undefined) {
  await context.addCookies([{ name: ENGINE_COOKIE, value: "new", url: baseURL }]);
}

const newEngine = (page: Page) => page.getByRole("button", { name: /^Filters/ });
// A click that lands before hydration only focuses the button, so click until the panel is open.
async function openFilters(page: Page) {
  await expect(async () => {
    await newEngine(page).click();
    await expect(newEngine(page)).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
  }).toPass();
}
const classicEngine = (page: Page) => page.getByRole("button", { name: "Apply" });
const codeRows = (page: Page, tag: string) => page.getByRole("row").filter({ hasText: tag });
// The line under the toolbar: the row count, then the applied filters.
const summary = (page: Page) => page.getByText(/^\d+ codes?$/).locator("..");

test("the classic list opens without errors and offers the switch", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/codes");
  await expect(classicEngine(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the new list opens without errors, on a desktop and a phone", async ({
  page,
  context,
  baseURL,
}) => {
  await useNewEngine(context, baseURL);
  const errors = watchErrors(page);
  await page.goto("/codes?owner=all");
  await expect(newEngine(page)).toBeVisible();
  await expect(page.getByText(/^\d+ codes?$/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Sort", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the switch flips the engine for this device and back", async ({ page, context }) => {
  await page.goto("/codes?q=leftover");
  await page.getByRole("button", { name: "New", exact: true }).click();
  // The switch lands on the bare list: the classic filter does not carry over.
  await expect(page).toHaveURL(/\/codes$/);
  await expect(newEngine(page)).toBeVisible();
  const cookie = (await context.cookies()).find((c) => c.name === ENGINE_COOKIE);
  expect(cookie).toMatchObject({ value: "new", httpOnly: true });

  await page.reload();
  await expect(newEngine(page)).toBeVisible();

  await page.getByRole("button", { name: "Classic", exact: true }).click();
  await expect(classicEngine(page)).toBeVisible();
});

test("the filter panel, sort and pager build one URL the database filters on", {
  tag: ["@live", "@live-db"],
}, async ({ page, context, baseURL }) => {
  const tag = `e2e-list-${Date.now()}`;
  await mintCode({ note: `${tag} b` });
  await mintCode({ note: `${tag} a` });
  await mintCode({ note: `${tag} quiz`, module: "quiz", file: VALID_QUIZ_URL });
  await mintCode({ note: `${tag} gone`, startOffset: -7200, endOffset: -3600 });
  await useNewEngine(context, baseURL);

  await page.goto("/codes?owner=all&size=1");
  // The panel is a draft: Enter in its search field applies it...
  await openFilters(page);
  await page.getByRole("searchbox", { name: "Search codes" }).fill(tag);
  await page.keyboard.press("Enter");
  await expect(page.getByText("4 codes", { exact: true })).toBeVisible();

  // ...and pill clicks load nothing until Apply.
  await openFilters(page);
  await page.getByRole("button", { name: "Tutor", exact: true }).click();
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByText("4 codes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("2 codes", { exact: true })).toBeVisible();
  await expect(summary(page)).toContainText(
    `Owner: all owners·Activity: Tutor·Status: Active·Search: “${tag}”`,
  );

  await page.getByRole("columnheader", { name: /Note/ }).getByRole("link").click();
  await expect(page).toHaveURL(/sort=note/);
  const url = new URL(page.url());
  expect(Object.fromEntries(url.searchParams)).toEqual({
    owner: "all",
    size: "1",
    q: tag,
    module: "tutor",
    status: "active",
    sort: "note",
  });
  await expect(page.getByText("Showing 1–1 of 2")).toBeVisible();
  await expect(codeRows(page, tag)).toHaveText([new RegExp(`${tag} a`)]);

  await page.getByRole("link", { name: "Next ›" }).click();
  await expect(page.getByText("Showing 2–2 of 2")).toBeVisible();
  await expect(codeRows(page, tag)).toHaveText([new RegExp(`${tag} b`)]);
  await expect(page).toHaveURL(/page=2/);

  // Dropping a filter in the panel keeps the sort and drops the page.
  await openFilters(page);
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("3 codes", { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/page=/);
  await expect(page).toHaveURL(/sort=note/);
  await expect(page.getByText("Showing 1–1 of 3")).toBeVisible();
});

test("the Models view shows each code's YAML model, its override and the reasoning that runs", {
  tag: ["@live", "@live-db"],
}, async ({ page, context, baseURL }) => {
  const tag = `e2e-models-${Date.now()}`;
  await mintCode({
    note: `${tag} override`,
    llm: { provider: "OpenRouter", model: "e2e/openrouter-model", reasoning: "high" },
  });
  await mintCode({ note: `${tag} yaml`, module: "quiz", file: VALID_QUIZ_URL });
  await useNewEngine(context, baseURL);
  const errors = watchErrors(page);

  await page.goto(`/codes?owner=all&q=${tag}`);
  await page.getByRole("button", { name: /^View/ }).click();
  await page.getByRole("menuitem", { name: /^Models/ }).click();
  await expect(page).toHaveURL(/view=models/);
  await expect(page.getByRole("columnheader", { name: /Override model/ })).toBeVisible();

  // Newest first; both fixture YAMLs name `test-model`, read from the file.
  await expect(codeRows(page, tag)).toHaveText([
    new RegExp(`${tag} yaml`),
    new RegExp(`${tag} override`),
  ]);
  const overrideRow = codeRows(page, `${tag} override`);
  await expect(overrideRow).toContainText("SCCH · test-model");
  await expect(overrideRow).toContainText("OpenRouter · e2e/openrouter-model");
  await expect(overrideRow.getByTitle("Replaced by this code's override")).toBeVisible();
  const yamlRow = codeRows(page, `${tag} yaml`);
  await expect(yamlRow).toContainText("SCCH · test-model");
  await expect(yamlRow).not.toContainText("OpenRouter");
  // Reasoning: the override's level; the fixture YAMLs pin none.
  await expect(page.getByRole("columnheader", { name: "Reasoning" })).toBeVisible();
  await expect(overrideRow.getByRole("cell", { name: "high", exact: true })).toBeVisible();
  await expect(yamlRow.getByRole("cell", { name: "provider default" })).toBeVisible();

  // Desktop Chrome is 1280px wide, so `xl`: the row actions are inline, no "…" menu.
  const actions = yamlRow.getByRole("group", { name: /^Actions for/ });
  await expect(actions.getByRole("link", { name: "View stats" })).toBeVisible();
  await expect(actions.getByRole("link", { name: "Edit code" })).toBeVisible();
  await expect(yamlRow.getByRole("button", { name: /^Actions for/ })).toBeHidden();

  // Applying a filter keeps the view...
  await openFilters(page);
  await page.getByRole("button", { name: "Quiz", exact: true }).click();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("1 code", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=models/);

  // ...and switching back drops it, the sort with it.
  await page.getByRole("button", { name: /^View/ }).click();
  await page.getByRole("menuitem", { name: /Overview/ }).click();
  await expect(page.getByRole("columnheader", { name: /Owner/ })).toBeVisible();
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
    owner: "all",
    q: tag,
    module: "quiz",
  });
  expect(errors).toEqual([]);
});

test("the bulk bar deletes exactly the ticked codes", {
  tag: ["@live", "@live-db"],
}, async ({ page, context, baseURL }) => {
  const tag = `e2e-bulk-${Date.now()}`;
  await mintCode({ note: `${tag} keep` });
  await mintCode({ note: `${tag} drop` });
  await useNewEngine(context, baseURL);

  await page.goto(`/codes?owner=all&q=${tag}`);
  await expect(codeRows(page, tag)).toHaveCount(2);
  await page.getByRole("checkbox", { name: `Select ${tag} drop` }).check();
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await expect(bar).toContainText("1 selected");

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toMatch(/^Delete 1 code\?/);
    void dialog.accept();
  });
  await bar.getByRole("button", { name: "Delete" }).click();
  await expect(codeRows(page, `${tag} drop`)).toHaveCount(0);
  await expect(codeRows(page, `${tag} keep`)).toHaveCount(1);
  await expect(bar).toHaveCount(0);
  await expect(page.getByText("1 code", { exact: true })).toBeVisible();
});
