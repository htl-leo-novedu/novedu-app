import { expect, test } from "@playwright/test";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { mintCode } from "./code.utils";
import { query } from "./db";
import { watchErrors } from "./page.utils";

// A REAL end-to-end check that the dashboard's aggregate queries run against the
// live schema and render. It seeds `novedu_usage_by_code` rows for the current UTC
// hour (so the default 24h window includes them) via the shared `e2e/db.ts` plain
// `pg` helper (kept independent of the app's query layer, same as the other
// @live specs) — then loads `/usage` as a teacher and asserts the
// charts/table/KPIs reflect the seed. Needs the DB but NOT the LLM, so it is
// `@live-db` and runs in CI against the ephemeral container. Cleans up its own
// rows in `finally`. See docs/dashboard.md + docs/testing.md.
//
// The cost card's price lookups are answered by the fixtures server
// (test-fixtures/serve.mjs, wired in playwright.config.ts): every `e2e/<name>` model
// is priced at $1 / $0.50 / $2 per 1M new / cached / output tokens, any other model
// stays unmatched — so the seeded model's dollars are exact even on a busy local DB.
// The spend card's OpenRouter seed uses `e2e/openrouter-model`, listed by id at the
// same rates plus $1.25 per 1M cache writes, the rate the card puts on new input.

test.use({ storageState: TEACHER_STORAGE_STATE });

// Seed generous per-code totals so the code lands in the pie's top 9 even when the
// DB already holds other codes (locally; in CI the container is clean).
const TOKENS_NEW = 9_000_000;
const TOKENS_CACHED = 3_000_000;
const TOKENS_OUTPUT = 2_000_000;
const QUIZ_ANSWERS = 7;

test("the usage dashboard renders seeded token metrics", { tag: ["@live", "@live-db"] }, async ({
  page,
}) => {
  // A unique note so it can be found unambiguously in the code-pie legend.
  const note = `E2E Usage ${Date.now()}`;
  const quizCode = await mintCode({
    module: "quiz",
    note,
    file: "https://example.com/api/files/q",
  });
  const tutorCode = await mintCode({ module: "tutor", note: `${note} tutor` });
  const spendCode = await mintCode({ module: "tutor", note: `${note} openrouter` });

  // A unique model id so the model-pie legend can be asserted unambiguously; the
  // provider/model columns are seeded like the LLM recorder writes them. The
  // `e2e/` owner makes the fixtures' price lookup match it.
  const model = `e2e/model-${Date.now()}`;
  const seedUsage = (code: string, module: string, quizAnswers: number) =>
    query(
      `INSERT INTO novedu_usage_by_code
           (code, hour, module, provider, model, input_tokens_new, input_tokens_cached,
            output_tokens, tool_calls, user_messages, quiz_answers, writing_saves)
         VALUES
           ($1, date_trunc('hour', now()), $2, 'SCCH', $3, $4, $5, $6, 0, 0, $7, 0)`,
      [code, module, model, TOKENS_NEW, TOKENS_CACHED, TOKENS_OUTPUT, quizAnswers],
    );

  const errors = watchErrors(page);
  try {
    await seedUsage(quizCode, "quiz", QUIZ_ANSWERS);
    await seedUsage(tutorCode, "tutor", 0);
    // One OpenRouter bucket for the spend card: 4M new, 2M cached, 1M output.
    await query(
      `INSERT INTO novedu_usage_by_code
           (code, hour, module, provider, model, input_tokens_new, input_tokens_cached,
            output_tokens, tool_calls, user_messages, quiz_answers, writing_saves)
         VALUES
           ($1, date_trunc('hour', now()), 'tutor', 'OpenRouter', 'e2e/openrouter-model',
            4000000, 2000000, 1000000, 0, 0, 0, 0)`,
      [spendCode],
    );

    await page.goto("/usage");

    // All sections render their headings.
    await expect(page.getByRole("heading", { name: "Token usage over time" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tokens by category" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tokens by code" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tokens by model" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tokens by provider" })).toBeVisible();

    // The time-series query ran and the shared table rendered.
    await expect(page.getByRole("columnheader", { name: "Total" })).toBeVisible();

    // The token AGGREGATE actually summed: both seeds land in the same UTC hour
    // bucket, so that bucket's cells (New input 18M, Total 28M, …) dwarf everything
    // else. Assert the largest numeric cell is at least the combined seed — this
    // catches a zeroed/swapped SUM or a broken bucket GROUP BY that renders 0s.
    // Robust on a busy local DB (other codes only ADD) and across an hour boundary
    // (the seed row stays inside the 24h window, just in an earlier bucket).
    const combinedSeed = (TOKENS_NEW + TOKENS_CACHED + TOKENS_OUTPUT) * 2;
    const cellTexts = await page.getByRole("cell").allInnerTexts();
    const maxCell = Math.max(0, ...cellTexts.map((t) => Number(t.replace(/[^0-9]/g, "")) || 0));
    expect(maxCell).toBeGreaterThanOrEqual(combinedSeed);

    // The table ends in a Total row whose Total column holds at least the seed.
    const footer = page.locator("tfoot");
    await expect(footer.getByRole("cell", { name: "Total", exact: true })).toBeVisible();
    const footerTotal = Number(
      (await footer.getByRole("cell").last().innerText()).replace(/[^0-9]/g, ""),
    );
    expect(footerTotal).toBeGreaterThanOrEqual(combinedSeed);

    // The cost card priced the seeded model: 2 rows × (9M new, 3M cached, 2M out)
    // = $18 new input + $3 cached input + $8 output = $29.
    const cost = page.getByTestId("usage-cost");
    await expect(
      cost.getByRole("heading", { name: "Estimated cost at OpenRouter prices" }),
    ).toBeVisible();
    await expect(cost.getByRole("row", { name: /New input/ })).toContainText("$18.00");
    await expect(cost.getByRole("row", { name: /Cached input/ })).toContainText("$3.00");
    await expect(cost.getByRole("row", { name: /Output/ })).toContainText("$8.00");
    await expect(cost.getByText("Prices from OpenRouter", { exact: false })).toBeVisible();

    // The spend card priced the OpenRouter seed by id, new input at the cache-write
    // rate: 4M × $1.25 = $5 new input + 2M × $0.50 = $1 cached + 1M × $2 = $2 output.
    const spend = page.getByTestId("usage-spend");
    await expect(spend.getByRole("heading", { name: "OpenRouter spend (estimate)" })).toBeVisible();
    await expect(spend.getByRole("row", { name: /New input/ })).toContainText("$5.00");
    await expect(spend.getByRole("row", { name: /Cached input/ })).toContainText("$1.00");
    await expect(spend.getByRole("row", { name: /Output/ })).toContainText("$2.00");

    // The breakdown query ran: the seeded code shows in the code-pie legend.
    await expect(page.getByText(note, { exact: true })).toBeVisible();

    // The by-model query ran: the seeded model id shows in the model-pie legend.
    await expect(page.getByText(model, { exact: true })).toBeVisible();

    // The KPI query ran and is windowed: quiz answers ≥ what we seeded (== in CI's
    // clean DB; ≥ locally where other codes may add to the bucket).
    const quizTile = page.getByTestId("usage-kpi-quiz");
    await expect(quizTile).toBeVisible();
    const quizValue = Number((await quizTile.innerText()).replace(/[^0-9]/g, ""));
    expect(quizValue).toBeGreaterThanOrEqual(QUIZ_ANSWERS);

    await expect(page.getByTestId("usage-kpi-chats")).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    const codes = [quizCode, tutorCode, spendCode];
    await query(`DELETE FROM novedu_usage_by_code WHERE code = ANY($1)`, [codes]).catch(() => {});
    await query(`DELETE FROM novedu_codes WHERE code = ANY($1)`, [codes]).catch(() => {});
  }
});
