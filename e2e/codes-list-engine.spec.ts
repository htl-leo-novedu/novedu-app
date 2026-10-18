import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { mintCode, VALID_QUIZ_URL } from "./code.utils";
import { watchErrors } from "./page.utils";

// `/codes` on both list engines (see `docs/filtered-lists.md`, "The new list
// engine"): each opens error-free, the Classic/New switch round-trips through
// its cookie, and — against the real database — the new list's filter panel
// (applied on Apply or Enter), sort header and pager drive ONE URL the server
// filters on, the summary line names the applied filters, and its bulk bar
// deletes. Minted codes belong to the e2e creator, hence `owner=all`.

test.use({ storageState: TEACHER_STORAGE_STATE });

const ENGINE_COOKIE = "novedu-list-engine";

async function useNewEngine(context: BrowserContext, baseURL: string | undefined) {
  await context.addCookies([{ name: ENGINE_COOKIE, value: "new", url: baseURL }]);
}

const newEngine = (page: Page) => page.getByRole("button", { name: /^Filters/ });
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
  await newEngine(page).click();
  await page.getByRole("searchbox", { name: "Search codes" }).fill(tag);
  await page.keyboard.press("Enter");
  await expect(page.getByText("4 codes")).toBeVisible();

  // ...and pill clicks load nothing until Apply.
  await newEngine(page).click();
  await page.getByRole("button", { name: "Tutor", exact: true }).click();
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByText("4 codes")).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("2 codes")).toBeVisible();
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
  await newEngine(page).click();
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("3 codes")).toBeVisible();
  await expect(page).not.toHaveURL(/page=/);
  await expect(page).toHaveURL(/sort=note/);
  await expect(page.getByText("Showing 1–1 of 3")).toBeVisible();
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
