import { expect, test } from "@playwright/test";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { setEditorContent } from "./page.utils";

// End-to-end coverage for the YAML File hosting feature: the create-form
// validation behavior, which is hermetic (runs in CI). The full
// create → list → update → delete cycle is `@live` and lives in
// `file-and-tutor-code-crud.spec.ts` (which also covers the tutor-link CRUD).
// The authorization gate — /files denied for a student, the nav entry hidden —
// is asserted once for every teacher-only surface in `permissions.spec.ts`.

test.describe("as a teacher", () => {
  test.use({ storageState: TEACHER_STORAGE_STATE });

  // Hermetic: a fragment with invalid YAML fails validation locally (no DB, no
  // network), so this verifies the create form keeps the entered name and kind
  // when the save is rejected — React resets uncontrolled form fields after an
  // action, so they must be controlled.
  test("a rejected create keeps the entered name and kind", async ({ page }) => {
    await page.goto("/files/new");
    await page.getByLabel(/Name/).fill("keep-this-name");
    await page.getByLabel("Kind").selectOption("fragment");
    await setEditorContent(page, "id: incomplete\nfragments: []\n");
    // Ctrl/⌘+S from inside the editor submits like "Validate & create"
    // (lib/keyboard-shortcuts.ts).
    await page.keyboard.press("ControlOrMeta+s");

    // The detailed validator errors are shown (not just a generic message)…
    await expect(page.getByRole("heading", { name: /Validation failed/ })).toBeVisible();
    await expect(page.getByText("FRAGMENT_FILE_SCHEMA_ERROR")).toBeVisible();
    // …and the entered name and kind are preserved across the rejected submit.
    await expect(page.getByLabel(/Name/)).toHaveValue("keep-this-name");
    await expect(page.getByLabel("Kind")).toHaveValue("fragment");
  });

  // Hermetic: the standalone Validate button reports the same structured errors
  // WITHOUT storing — an invalid fragment needs no DB or network, and a failed
  // validate must not redirect (a successful CREATE would).
  test("the Validate button reports errors without creating", async ({ page }) => {
    await page.goto("/files/new");
    await page.getByLabel(/Name/).fill("validate-only");
    await page.getByLabel("Kind").selectOption("fragment");
    await setEditorContent(page, "id: incomplete\nfragments: []\n");
    await page.getByRole("button", { name: "Validate", exact: true }).click();

    await expect(page.getByText("FRAGMENT_FILE_SCHEMA_ERROR")).toBeVisible();
    // Validate never stores, so we stay on the create page (no redirect to edit).
    await expect(page).toHaveURL(/\/files\/new$/);
  });

  // Hermetic: a quiz is structurally validated exactly like a fragment — an
  // invalid quiz (no llm.model, no questions) reports QUIZ_SCHEMA_ERROR and is
  // never stored, so we stay on the create page. No DB or network.
  test("an invalid quiz reports QUIZ_SCHEMA_ERROR without creating", async ({ page }) => {
    await page.goto("/files/new");
    await page.getByLabel(/Name/).fill("validate-quiz");
    await page.getByLabel("Kind").selectOption("quiz");
    await setEditorContent(page, "id: incomplete\nquestions: []\n");
    await page.getByRole("button", { name: "Validate", exact: true }).click();

    await expect(page.getByText("QUIZ_SCHEMA_ERROR")).toBeVisible();
    await expect(page).toHaveURL(/\/files\/new$/);
  });

  // Hermetic: a writing activity is structurally validated exactly like a quiz —
  // an invalid activity (no llm.model, no instructions) reports
  // WRITING_SCHEMA_ERROR and is never stored. No DB or network.
  test("an invalid writing activity reports WRITING_SCHEMA_ERROR without creating", async ({
    page,
  }) => {
    await page.goto("/files/new");
    await page.getByLabel(/Name/).fill("validate-writing");
    await page.getByLabel("Kind").selectOption("writing");
    await setEditorContent(page, "id: incomplete\n");
    await page.getByRole("button", { name: "Validate", exact: true }).click();

    await expect(page.getByText("WRITING_SCHEMA_ERROR")).toBeVisible();
    await expect(page).toHaveURL(/\/files\/new$/);
  });
});
