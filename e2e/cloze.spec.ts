import { expect, type Page, test } from "@playwright/test";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { LIVE_CLOZE_URL, mintCode, VALID_CLOZE_URL } from "./code.utils";

// End-to-end coverage for the Cloze module ("Fill the gaps", docs/cloze.md), reached
// as a CODE (`module: "cloze"`) at `/<code>`. Grading and feedback run through the fake
// LLM (docs/testing.md, "Fake LLM"): a `[grade:<verdict>]` marker in an answer picks
// the model's verdict for that gap (unmarked → `incorrect`), and the feedback call
// returns one "Fake LLM pattern" over the non-correct gaps plus a note per gap. The
// fixture (test-fixtures/activities/cloze/test-cloze.yaml) has three gaps: 1 "is going
// to", 2 "starts" (hint "start"), 3 "" (nothing belongs there). Minting a code writes
// the DB directly, hence @live-db (runs in CI); the teacher detail page then shows the
// per-gap counts of the first round only. The last spec is @live-llm: a REAL
// model must honour both structured outputs (local only, `npm run test:e2e:live-llm`).

test.use({ storageState: TEACHER_STORAGE_STATE });

/** Collects uncaught page errors and console errors from here on. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test.describe("cloze", { tag: ["@live", "@live-db"] }, () => {
  test("the student page and the teacher detail page open error-free", async ({ page }) => {
    const code = await mintCode({ module: "cloze", file: VALID_CLOZE_URL });
    const errors = trackErrors(page);

    await page.goto(`/${code}`);
    await expect(page.getByRole("heading", { name: "Test Cloze" })).toBeVisible();
    for (const n of [1, 2, 3]) await expect(page.getByLabel(`Gap ${n}`)).toBeVisible();
    await expect(page.getByText("(start)")).toBeVisible();
    await expect(page.getByText("0 / 3")).toBeVisible();

    await page.goto(`/codes/${code}`);
    await expect(page.getByText(code)).toBeVisible();
    await expect(page.getByTestId("cloze-first-submissions")).toContainText("0");
    await expect(page.getByTestId("cloze-key-gap-2")).toContainText("starts");
    const html = await page.content();
    expect(html).not.toContain('class="function');

    expect(errors).toEqual([]);
  });

  test("fill → submit → verdicts → patterns → Try again → the detail counts round one", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const code = await mintCode({ module: "cloze", file: VALID_CLOZE_URL });
    await page.goto(`/${code}`);

    // Gap 1 goes to the model (unmarked → wrong), gap 2 is marked partial, gap 3 stays
    // empty — the pre-pass decides it correct, since nothing belongs there.
    await page.getByLabel("Gap 1").fill("will");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Gap 2")).toBeFocused();
    await page.keyboard.type("start [grade:partial]");
    await expect(page.getByText("2 / 3")).toBeVisible();

    await page.getByRole("button", { name: "Submit exercise" }).click();
    await expect(page.getByText("1 gap is empty — submit anyway?")).toBeVisible();
    await page.getByRole("button", { name: "Submit anyway" }).click();

    // Step 1: one chip per gap, coloured by verdict, and the counts.
    await expect(page.getByTestId("cloze-chip-1")).toHaveAttribute("data-verdict", "incorrect", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("cloze-chip-2")).toHaveAttribute("data-verdict", "partial");
    await expect(page.getByTestId("cloze-chip-3")).toHaveAttribute("data-verdict", "correct");
    await expect(page.getByTestId("cloze-counts")).toHaveText(
      /1\s*correct.*1\s*partial.*1\s*wrong/,
    );
    await expect(page.getByText("Submitted · 3 gaps")).toBeVisible();

    // Step 2: the fake's pattern over gaps 1 and 2; its chip selects gap 2.
    const pattern = page.getByTestId("cloze-pattern");
    await expect(pattern).toContainText("Fake LLM pattern", { timeout: 60_000 });
    await pattern.getByRole("button", { name: "Gap 2" }).click();
    const panel = page.getByTestId("cloze-gap-panel");
    await expect(panel.getByRole("heading", { name: "Gap 2" })).toBeVisible();
    await expect(panel).toContainText("Partly correct");
    await expect(panel).toContainText("starts");
    await expect(panel).toContainText("Fake LLM note for gap 2.");

    // Try again: a practice round with every gap cleared.
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Practice round")).toBeVisible();
    await expect(page.getByLabel("Gap 1")).toHaveValue("");
    await expect(page.getByLabel("Gap 1")).toBeFocused();
    await expect(page.getByText("0 / 3")).toBeVisible();

    // The references themselves: all correct by the pre-pass, no feedback call.
    await page.getByLabel("Gap 1").fill("is going to");
    await page.getByLabel("Gap 2").fill("starts");
    await page.getByRole("button", { name: "Submit exercise" }).click();
    await page.getByRole("button", { name: "Submit anyway" }).click();
    await expect(page.getByText("All 3 gaps correct.")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Practice round")).toBeVisible();

    // The teacher detail counts the first submission only — the all-correct practice
    // round would have turned gap 1 correct. The counts land off the response path.
    const rows = page.getByTestId("cloze-gap-table").locator("tbody tr");
    await expect(async () => {
      await page.goto(`/codes/${code}`);
      await expect(page.getByTestId("cloze-first-submissions")).toContainText("1", {
        timeout: 2_000,
      });
    }).toPass({ timeout: 30_000 });
    await expect(rows.nth(0)).toContainText("0 · 0%");
    await expect(rows.nth(0).locator("td").nth(4)).toHaveText("1 · 100%");
    await expect(rows.nth(1).locator("td").nth(3)).toHaveText("1 · 100%");
    await expect(rows.nth(2).locator("td").nth(2)).toHaveText("1 · 100%");
    await expect(page.getByTestId("cloze-key-gap-1").getByRole("img")).toHaveAccessibleName(
      "0 correct, 0 partial, 1 wrong of 1",
    );

    // The /codes list shows the same number in its count column.
    await page.goto(`/codes?owner=all&module=cloze&q=${code}`);
    await expect(page.getByRole("columnheader", { name: "Submissions" })).toBeVisible();
    await expect(page.getByTitle("First submissions")).toHaveText("1");
  });
});

// A REAL model returns both structured outputs the server accepts: the grading call
// covers every gap the pre-pass left open (no answer below matches its reference
// exactly), and the feedback call yields a feedback the grounding filter can show —
// patterns or not, but never the failure notice. @live-llm only (excluded from CI).
test("a real model honours the grading and the feedback schema", {
  tag: ["@live", "@live-llm"],
}, async ({ page }) => {
  test.setTimeout(180_000);
  const code = await mintCode({ module: "cloze", file: LIVE_CLOZE_URL });
  await page.goto(`/${code}`);

  const answers = ["will", "start", "will meet", "'s going to"];
  for (const [i, answer] of answers.entries()) await page.getByLabel(`Gap ${i + 1}`).fill(answer);
  await page.getByRole("button", { name: "Submit exercise" }).click();

  for (const n of [1, 2, 3, 4]) {
    await expect(page.getByTestId(`cloze-chip-${n}`)).toHaveAttribute(
      "data-verdict",
      /^(correct|partial|incorrect)$/,
      { timeout: 90_000 },
    );
  }
  // "will" for a plan already decided is wrong under any reading of the evaluation.
  await expect(page.getByTestId("cloze-chip-1")).toHaveAttribute("data-verdict", "incorrect");

  const pattern = page.getByTestId("cloze-pattern").first();
  const noPattern = page.getByText(
    /Your mistakes don't share a common cause|Select the marked gap below|gaps correct\./,
  );
  await expect(pattern.or(noPattern)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("Couldn't load the feedback")).toHaveCount(0);
});
