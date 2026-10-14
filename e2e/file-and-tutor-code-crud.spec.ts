import { expect, type Page, test } from "@playwright/test";
import { unixSecondsToDatetimeLocal } from "../lib/datetime-local";
import { mintSessionToken } from "./api-auth.utils";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { VALID_CODING_URL, VALID_TUTOR_URL } from "./code.utils";
import { setEditorContent } from "./page.utils";

// @live end-to-end CRUD over BOTH a hosted YAML file and a tutor link ("tutor
// code"), as a teacher, against the real database (the dev server authenticates
// with the local `az login` identity). Writes real rows, so it is excluded from
// CI like the other live specs. The tutor link shares the canonical fixture
// tutor YAML (VALID_TUTOR_URL → the local fixtures server's test-tutor.yaml).
// Covers the DB-side filtering (Apply → ?q=) on both list pages.

test.use({ storageState: TEACHER_STORAGE_STATE });

const FRAGMENT_V1 = `id: e2e_crud_fragments
fragments:
  - id: greeting
    version: 1
    content: "Hello from version one"
`;
const FRAGMENT_V2 = `id: e2e_crud_fragments
fragments:
  - id: greeting
    version: 2
    content: "Hello from version two"
`;

// The raw-YAML GET is teacher-bearer only (the CLI's channel), never the
// browser's cookie session — so read a file the way `novedu-cli` does.
async function getRawFile(page: Page, path: string) {
  const token = await mintSessionToken({ teacher: true });
  return page.request.get(path, { headers: { authorization: `Bearer ${token}` } });
}

async function applyFilter(page: Page, label: string, term: string): Promise<void> {
  await page.getByLabel(label).fill(term);
  await page.getByRole("button", { name: "Apply" }).click();
}

// Remove a single list row via the shared "Delete Selected" multi-delete — the only
// delete affordance the codes/files/images lists expose (per-row delete lives on the
// edit page). Filters to the row, ticks it, confirms. The filter term doubles as
// the checkbox's accessible-name suffix ("Select <term>").
async function bulkDeleteRow(
  page: Page,
  listPath: string,
  filterLabel: string,
  term: string,
): Promise<void> {
  await page.goto(listPath);
  await applyFilter(page, filterLabel, term);
  await page.getByRole("checkbox", { name: `Select ${term}` }).check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /Delete .*selected/i }).click();
  await expect(page.getByRole("row").filter({ hasText: term })).toHaveCount(0);
}

test("CRUD on a hosted file and a tutor link, with DB-side filtering", {
  tag: ["@live", "@live-db"],
}, async ({ page }) => {
  // =========================================================================
  // FILE — create
  // =========================================================================
  const fileName = `e2e-crud-${Date.now()}`;
  const fileUrl = `/api/files/${fileName}`;
  await page.goto("/files/new");
  await page.getByLabel(/Name/).fill(fileName);
  await page.getByLabel("Kind").selectOption("fragment");
  await setEditorContent(page, FRAGMENT_V1);
  await page.getByRole("button", { name: "Validate & create" }).click();
  await expect(page).toHaveURL(new RegExp(`/files/edit/${fileName}$`));

  // FILE — read: it is in the list and filterable IN THE DB (Apply → ?q=).
  await page.goto("/files");
  await applyFilter(page, "Filter files", fileName);
  await expect(page).toHaveURL(/[?&]q=/);
  const fileRow = page.getByRole("row").filter({ hasText: fileName });
  await expect(fileRow).toHaveCount(1);
  await expect(fileRow.getByText("fragment")).toBeVisible();

  // A non-matching filter returns nothing.
  await applyFilter(page, "Filter files", "no-such-file-xyz");
  await expect(page.getByText("No files match your filter.")).toBeVisible();

  // FILE — update: edit to v2, the raw GET then serves v2.
  await applyFilter(page, "Filter files", fileName);
  await page
    .getByRole("row")
    .filter({ hasText: fileName })
    .getByRole("link", { name: `Edit ${fileName}` })
    .click();
  await expect(page.locator(".cm-content")).toContainText("Hello from version one");
  await setEditorContent(page, FRAGMENT_V2);
  // Ctrl/⌘+S from inside the editor = "Validate & save" (lib/keyboard-shortcuts.ts).
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByText("Saved")).toBeVisible();
  const fileRes = await getRawFile(page, fileUrl);
  expect(await fileRes.text()).toContain("Hello from version two");

  // FILE — delete (via the list's "Delete Selected" — the only list delete path).
  await bulkDeleteRow(page, "/files", "Filter files", fileName);
  expect((await getRawFile(page, fileUrl)).status()).toBe(404);

  // =========================================================================
  // TUTOR LINK — create (sharing the fixture tutor YAML, VALID_TUTOR_URL)
  // =========================================================================
  const note = `e2e tutor link ${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  await page.goto("/codes/new");
  await page.getByLabel("Activity YAML URL").fill(VALID_TUTOR_URL);
  await page.getByLabel(/Note/).fill(note);
  await page.getByLabel(/Available from/).fill(unixSecondsToDatetimeLocal(now - 3600));
  await page.getByLabel(/Available until/).fill(unixSecondsToDatetimeLocal(now + 3600));
  // The LLM override: the preset button fills both free-text fields at once.
  await page.getByRole("button", { name: "SCCH · Gemma 4" }).click();
  await expect(page.getByLabel(/LLM provider override/)).toHaveValue("SCCH");
  await page.getByRole("button", { name: "Create code" }).click();

  // Lands on the new code's edit page, which shows the shareable chat URL.
  await expect(page).toHaveURL(/\/codes\/edit\/[a-z0-9]{10}$/, { timeout: 60_000 });
  const link = page.getByLabel("Share link", { exact: true });
  await expect(link).toBeVisible();
  const linkValue = await link.inputValue();
  expect(linkValue).toMatch(/^http:\/\/localhost:3000\/[a-z0-9]{10}$/);

  // The stored override pair round-trips into the edit form.
  await expect(page.getByLabel(/LLM provider override/)).toHaveValue("SCCH");
  await expect(page.getByLabel(/LLM model override/)).toHaveValue(
    "RedHatAI/gemma-4-31B-it-FP8-Dynamic",
  );

  // TUTOR LINK — stats detail: opening /codes/<code> renders ConversationStats,
  // which runs getCodeStats' RAW SQL (the `LEFT JOIN novedu_user` + `GROUP BY
  // un.name` added for name resolution — untyped, so unit tests can't catch
  // a malformed query). A freshly created code has no conversations, so the page
  // must show the empty state — NOT the "stats temporarily unavailable" notice that
  // getCodeStats returns when the query throws — which proves the join is valid SQL.
  const codeId = linkValue.split("/").pop() as string;
  await page.goto(`/codes/${codeId}`);
  await expect(
    page.getByText(/a conversation counts once a student sends at least one message/i),
  ).toBeVisible();
  await expect(page.getByText(/Stats temporarily unavailable/i)).toHaveCount(0);
  // The detail chrome surfaces the code's LLM override.
  await expect(page.getByText(/LLM override:/)).toBeVisible();

  // TUTOR LINK — update: change the note (the URL field is read-only) and CLEAR
  // the LLM override (editable in edit mode, cleared as a whole pair).
  await page.goto(`/codes/edit/${codeId}`);
  await expect(page.getByLabel(/Activity YAML URL/)).toHaveAttribute("readonly", "");
  const editedNote = `${note} edited`;
  await page.getByLabel(/Note/).fill(editedNote);
  await page.getByRole("button", { name: "Clear LLM override" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  // The cleared override is gone from the form and the detail chrome.
  await page.reload();
  await expect(page.getByLabel(/LLM provider override/)).toHaveValue("");
  await expect(page.getByLabel(/LLM model override/)).toHaveValue("");
  await page.goto(`/codes/${codeId}`);
  await expect(page.getByText(/LLM override:/)).toHaveCount(0);

  // TUTOR LINK — read: the edited note is findable via the DB-side filter.
  await page.goto("/codes");
  await applyFilter(page, "Filter codes", editedNote);
  await expect(page).toHaveURL(/[?&]q=/);
  await expect(page.getByRole("row").filter({ hasText: editedNote })).toHaveCount(1);

  // TUTOR LINK — open: the chat opens within the window.
  await page.goto(linkValue);
  await expect(page.getByPlaceholder("Type a message...")).toBeVisible({ timeout: 60_000 });

  // TUTOR LINK — delete (via the shared "Delete Selected" multi-delete; the codes
  // list has no per-row delete button — see app/codes/page.tsx).
  await page.goto("/codes");
  await applyFilter(page, "Filter codes", editedNote);
  const codeRow = page.getByRole("row").filter({ hasText: editedNote });
  await expect(codeRow).toHaveCount(1);
  await page.getByRole("checkbox", { name: `Select ${editedNote}` }).check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /Delete .*selected/i }).click();
  await expect(page.getByRole("row").filter({ hasText: editedNote })).toHaveCount(0);
});

// CODING CODE — creating a CODING code lands on the same edit screen as any other
// module and shows the same `/<code>` share-link result: a coding code is a regular
// activity URL (the student visits it, signs in, and mints their personal API key).
// The URL must point at a VALID coding YAML: coding has a strict authoring gate, so a
// non-coding file (e.g. a tutor URL) would be rejected with a CODING_SCHEMA_ERROR
// before the code is created.
test("creating a coding code shows the share link like every other module", {
  tag: ["@live", "@live-db"],
}, async ({ page }) => {
  const note = `e2e coding ${Date.now()}`;
  await page.goto("/codes/new");
  await page.getByLabel("Activity", { exact: true }).selectOption("coding");
  await page.getByLabel("Activity YAML URL").fill(VALID_CODING_URL);
  await page.getByLabel(/Note/).fill(note);
  await page.getByRole("button", { name: "Create code" }).click();

  // Lands on the new code's edit screen.
  await expect(page).toHaveURL(/\/codes\/edit\/[a-z0-9]{10}$/, { timeout: 60_000 });

  // The share-link box is shown, exactly like tutor/quiz/writing…
  await expect(page.getByLabel("Share link", { exact: true })).toBeVisible();
  // …and the little-coder connection config is NOT — that lives on the student page
  // and the teacher detail page, keyed to the visitor's personal key.
  await expect(page.getByRole("button", { name: "Copy models.json" })).toHaveCount(0);
});

// The shared multi-delete layer end-to-end: tick several rows and remove them all
// in ONE "Delete Selected" action. Files only — no LLM — so it runs in CI against
// the SQL container.
test("the files list pages, sorts and multi-deletes — all DB-side", {
  tag: ["@live", "@live-db"],
}, async ({ page }) => {
  const stamp = Date.now();
  const prefix = `e2e-multi-${stamp}`;
  const names = [`${prefix}-a`, `${prefix}-b`];
  const fragmentYaml = (id: string) =>
    `id: ${id}\nfragments:\n  - id: greeting\n    version: 1\n    content: "Hi"\n`;

  // Create two hosted fragment files (distinct YAML ids).
  for (const [i, name] of names.entries()) {
    await page.goto("/files/new");
    await page.getByLabel(/Name/).fill(name);
    await page.getByLabel("Kind").selectOption("fragment");
    await setEditorContent(page, fragmentYaml(`e2e_multi_${stamp}_${i}`));
    await page.getByRole("button", { name: "Validate & create" }).click();
    await expect(page).toHaveURL(new RegExp(`/files/edit/${name}$`));
  }

  // Both are listed under the shared prefix.
  await page.goto("/files");
  await applyFilter(page, "Filter files", prefix);
  for (const name of names) {
    await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(1);
  }

  // DB-side paging over the same two files: `size=1` makes the filtered list two
  // pages, so prev/next, the range label and the ?page= round trip are all exercised
  // without seeding 21 rows (docs/filtered-lists.md).
  await page.goto(`/files?q=${prefix}&size=1`);
  const previous = page.getByRole("link", { name: /Previous/ });
  const next = page.getByRole("link", { name: /Next/ });
  await expect(page.getByText("Showing 1–1 of 2")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: prefix })).toHaveCount(1);
  await expect(previous).toHaveCount(0); // page 1: rendered as a disabled <span>
  await next.click();
  await expect(page).toHaveURL(/[?&]page=2/);
  await expect(page.getByText("Showing 2–2 of 2")).toBeVisible();
  await expect(next).toHaveCount(0); // last page
  await expect(previous).toHaveCount(1);
  // Applying a filter from page 2 goes back to page 1 but keeps the size override.
  await applyFilter(page, "Filter files", prefix);
  await expect(page).not.toHaveURL(/[?&]page=/);
  await expect(page).toHaveURL(/[?&]size=1/);

  // DB-side sorting over the same two files, still at `size=1` so the ORDER BY has
  // to reach the SQL — sorting only the rendered page could never show `-b` first.
  // The header cycles asc → desc → no sort (docs/filtered-lists.md).
  const nameHeader = page.getByRole("link", { name: "Name" });
  const firstRow = page.getByRole("row").filter({ hasText: prefix });
  await nameHeader.click();
  await expect(page).toHaveURL(/[?&]sort=name/);
  await expect(firstRow).toContainText(`${prefix}-a`);
  await nameHeader.click();
  await expect(page).toHaveURL(/[?&]sort=-name/);
  await expect(firstRow).toContainText(`${prefix}-b`);
  // Re-filtering keeps the sort — it is not a form control, it rides a hidden input.
  await applyFilter(page, "Filter files", prefix);
  await expect(page).toHaveURL(/[?&]sort=-name/);
  await expect(page).not.toHaveURL(/[?&]page=/);
  // The third click clears it, back to the list's default order.
  await nameHeader.click();
  await expect(page).not.toHaveURL(/[?&]sort=/);

  // DB-side OWNER filter (docs/filtered-lists.md). The signed-in teacher wrote both
  // files, so they own them: the column shows an owner and the default view needs no
  // `?owner=` at all — which is also what makes "Clear" return to my own items.
  await page.goto(`/files?q=${prefix}&size=1`);
  const ownerSelect = page.getByLabel("Filter by owner");
  await expect(ownerSelect).toHaveValue("");
  await expect(firstRow.getByRole("cell").nth(4)).not.toBeEmpty();
  // Widening to every owner is a URL param, and Apply still resets to page 1.
  await ownerSelect.selectOption("all");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/[?&]owner=all/);
  await expect(page).not.toHaveURL(/[?&]page=/);
  await expect(page.getByRole("row").filter({ hasText: prefix })).toHaveCount(1);
  // The owner column sorts in SQL like every other one.
  await page.getByRole("link", { name: "Owner" }).click();
  await expect(page).toHaveURL(/[?&]sort=owner/);
  await expect(page).toHaveURL(/[?&]owner=all/);
  // Clear drops every param — back to my own files, no `?owner=`.
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page).toHaveURL(/\/files$/);

  await page.goto("/files");
  await applyFilter(page, "Filter files", prefix);

  // "Delete Selected" is disabled until something is selected.
  const deleteSelected = page.getByRole("button", { name: /Delete .*selected/i });
  await expect(deleteSelected).toBeDisabled();

  // Tick the two specific rows, then delete them both in ONE action.
  for (const name of names) {
    await page.getByRole("checkbox", { name: `Select ${name}` }).check();
  }
  await expect(deleteSelected).toBeEnabled();
  // Capture + accept the confirm unconditionally (asserting inside the handler can
  // leave the dialog unhandled and hang the click); check the count afterwards.
  let dialogMessage = "";
  page.once("dialog", (dialog) => {
    dialogMessage = dialog.message();
    dialog.accept();
  });
  await deleteSelected.click();

  // Both rows are gone and neither file is served any more.
  for (const name of names) {
    await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
    expect((await getRawFile(page, `/api/files/${name}`)).status()).toBe(404);
  }
  expect(dialogMessage).toContain("2 files");
});
