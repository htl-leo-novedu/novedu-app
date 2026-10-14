import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { mintTutorCode } from "./code.utils";

// @live-db end-to-end for the "report conversation" feature (GH issue #24): a
// student flags a chat conversation to their teacher, and the teacher works the
// report through its inbox lifecycle (open → resolved → reopened → deleted). It
// needs the real database (minted code row + the written `novedu_reports` row +
// the teacher inbox's DB-side filtering) but NEVER the LLM: a report can
// reference a ZERO-MESSAGE thread by design, so the chat page only has to render
// — no message is ever sent, nothing calls the model. Hence it is tagged
// `@live-db` (NOT `@live-llm`) and runs in CI against the SQL container.
//
// The chat path is the only one this spec covers. The QUIZ-answer report path
// cannot be reached without a graded answer, and grading calls the LLM (the
// `quizEvaluator` agent, answered by the fake LLM in e2e) — out of scope here.
//
// Roles: the default chromium project runs as the STUDENT (its storageState),
// which files the report. The teacher half opens a SEPARATE browser context with
// the TEACHER storageState (the same pattern student-mode.spec.ts uses). The code
// is minted with `created_by = "e2e-test-suite"` (mintTutorCode), which is NOT the
// signed-in teacher's id, so the inbox is always visited with `mine=0` to defeat
// the "Only my codes" default filter.

// Open the teacher inbox at a specific status, always with mine=0 (the code's
// creator is the e2e mint identity, not the signed-in teacher) and the run's
// unique marker as the DB-side text filter so only this run's row can match.
async function gotoInbox(
  page: Page,
  status: "open" | "resolved" | "all",
  marker: string,
): Promise<void> {
  await page.goto(`/reports?mine=0&status=${status}&q=${encodeURIComponent(marker)}`);
}

test("student reports a conversation and the teacher resolves, reopens, and deletes it", {
  tag: ["@live", "@live-db"],
}, async ({ page, browser }) => {
  const marker = `e2e-report-${Date.now()}`;
  // The default fixture tutor pins the fake `test-model`; a zero-message report
  // never touches it, so this is deliberately NOT the live-model tutor.
  const code = await mintTutorCode({ note: `e2e report code ${Date.now()}` });

  // ---------------------------------------------------------------------------
  // STUDENT — open the chat and file a report (no message is ever sent)
  // ---------------------------------------------------------------------------
  await page.goto(`/${code}`);
  // The chat surface renders; a report can reference this zero-message thread.
  await expect(page.getByPlaceholder("Type a message...")).toBeVisible({ timeout: 60_000 });

  // Open the report dialog.
  await page.getByRole("button", { name: "Report" }).click();

  // The MANDATORY attribution notice — reports waive anonymity — must be shown.
  await expect(page.getByText(/Reports are not anonymous/i)).toBeVisible();

  // Pick the urgent "Holy sh.." reaction, add a uniquely-markered description,
  // and submit.
  await page.getByRole("button", { name: "Holy sh.." }).click();
  await page.getByLabel(/What happened/i).fill(`${marker} the tutor said something wild`);
  // Ctrl/⌘+Enter in the description sends, like "Send report" (lib/keyboard-shortcuts.ts).
  await page.getByLabel(/What happened/i).press("ControlOrMeta+Enter");

  // Success / thank-you state.
  await expect(page.getByText(/your teacher will take a look/i)).toBeVisible();

  // ---------------------------------------------------------------------------
  // TEACHER — a separate context with the teacher session
  // ---------------------------------------------------------------------------
  const teacherContext: BrowserContext = await browser.newContext({
    storageState: TEACHER_STORAGE_STATE,
  });
  const teacher = await teacherContext.newPage();
  try {
    // The report is visible in the default OPEN view (mine=0 to see another
    // creator's code). The DB-side `q=` filter still matches on the description,
    // so the marker narrows the list to this run's row — even though the
    // description is not a visible list column.
    await gotoInbox(teacher, "open", marker);
    const row = teacher.getByRole("row").filter({ hasText: "Holy sh.." });
    await expect(row).toHaveCount(1);
    // The urgent reaction badge (its label is "Holy sh..").
    await expect(row).toContainText("Holy sh..");
    // The Code column links to the code's detail page (its visible text is the
    // code's note, so match the href, not the accessible name). The DataList
    // renders each row as both a table cell and a responsive card, so the link
    // appears twice within the one row element — scope to `.first()`.
    await expect(row.locator(`a[href="/codes/${code}"]`).first()).toBeVisible();

    // The transcript action carries `?from=reports` so the transcript page shows
    // "Back to reports" instead of "Back to stats".
    await expect(
      row.locator(`a[href^="/codes/${code}/c/"][href*="from=reports"]`).first(),
    ).toBeVisible();

    // The full description is not a list column — open the detail dialog
    // and assert the marker text is shown there instead.
    await row.getByRole("button", { name: "View report details" }).first().click();
    const dialog = teacher.getByRole("dialog");
    await expect(dialog).toContainText(marker);
    // The dialog's transcript link is likewise origin-tagged.
    await expect(
      dialog.locator(`a[href^="/codes/${code}/c/"][href*="from=reports"]`),
    ).toBeVisible();
    // Close the dialog before continuing the lifecycle.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // Select the row → "Mark resolved" → it leaves the OPEN working set. Checking
    // either of the row's paired checkboxes toggles the shared, id-keyed selection.
    await teacher.getByRole("checkbox", { name: "Select chat report" }).first().check();
    await teacher.getByRole("button", { name: /Mark resolved/i }).click();
    await expect(teacher.getByRole("row").filter({ hasText: marker })).toHaveCount(0);

    // It appears in the RESOLVED view instead.
    await gotoInbox(teacher, "resolved", marker);
    const resolvedRow = teacher.getByRole("row").filter({ hasText: marker });
    await expect(resolvedRow).toHaveCount(1);
    await expect(resolvedRow).toContainText(/resolved/i);

    // Reopen it → it leaves the RESOLVED view.
    await teacher.getByRole("checkbox", { name: "Select chat report" }).first().check();
    await teacher.getByRole("button", { name: /Reopen/i }).click();
    await expect(teacher.getByRole("row").filter({ hasText: marker })).toHaveCount(0);

    // Back in the OPEN view, delete it for good (confirm dialog).
    await gotoInbox(teacher, "open", marker);
    await expect(teacher.getByRole("row").filter({ hasText: marker })).toHaveCount(1);
    await teacher.getByRole("checkbox", { name: "Select chat report" }).first().check();
    teacher.once("dialog", (dialog) => dialog.accept());
    await teacher.getByRole("button", { name: /Delete .*selected/i }).click();
    await expect(teacher.getByRole("row").filter({ hasText: marker })).toHaveCount(0);

    // Gone everywhere: the ALL view does not show it either.
    await gotoInbox(teacher, "all", marker);
    await expect(teacher.getByRole("row").filter({ hasText: marker })).toHaveCount(0);
  } finally {
    await teacherContext.close();
  }
});
