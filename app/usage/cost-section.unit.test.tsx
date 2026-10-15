import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelPrice, ModelTokens } from "@/lib/usage-cost";

// `CostSection`'s states over a stubbed store read and stubbed price lookups (the
// pure matching and price math run for real): the donut with its figures, the
// unmatched warning, nothing priced, an empty range and both failure paths. The
// client donut is stubbed so this stays a hermetic node render. No DB, no network.

const getScchTokensByModel = vi.hoisted(() => vi.fn());
const fetchOpenRouterModels = vi.hoisted(() => vi.fn());
const priceModels = vi.hoisted(() => vi.fn());

vi.mock("@/lib/usage-stats-store", () => ({ getScchTokensByModel }));
vi.mock("@/lib/usage-cost-lookup", () => ({ fetchOpenRouterModels, priceModels }));
vi.mock("./cost-donut-chart", () => ({
  CostDonutChart: ({ cost, rangeLabel }: { cost: { total: number }; rangeLabel: string }) => (
    <div data-testid="donut">
      {cost.total.toFixed(2)} {rangeLabel}
    </div>
  ),
}));

import { CostSection } from "./cost-section";

const GEMMA: ModelPrice = { prompt: 0.0000002, cacheRead: 0.0000002, completion: 0.0000004 };

async function render(rows: ModelTokens[] | undefined, prices: Record<string, ModelPrice> = {}) {
  getScchTokensByModel.mockResolvedValue(rows);
  priceModels.mockResolvedValue(new Map(Object.entries(prices)));
  return renderToStaticMarkup(
    await CostSection({ range: "30d", now: new Date("2026-10-15T12:00:00Z") }),
  );
}

beforeEach(() => {
  fetchOpenRouterModels.mockResolvedValue({
    json: { data: [] },
    fetchedAt: new Date("2026-10-15T08:00:00Z"),
  });
});

it("renders the donut, the fetch date and the not-real-costs tip", async () => {
  const html = await render(
    [{ model: "RedHatAI/gemma", inputNew: 10_000_000, inputCached: 0, output: 5_000_000 }],
    { "RedHatAI/gemma": GEMMA },
  );
  expect(html).toContain("Estimated cost at OpenRouter prices");
  expect(html).toContain("SCCH provides them for free");
  expect(html).toContain("4.00 Last 30 days"); // $2 new input + $2 output
  expect(html).toContain("fetched Oct 15, 2026");
  expect(html).toContain('aria-label="About this estimate"');
  expect(html).toContain("These are not real costs");
  expect(html).not.toContain("Not priced");
});

it("names the models it had to leave out, incl. a NULL model", async () => {
  const html = await render(
    [
      { model: "RedHatAI/gemma", inputNew: 1_000, inputCached: 0, output: 0 },
      { model: "foo/Bar-7B-AWQ", inputNew: 1_200_000, inputCached: 0, output: 0 },
      { model: null, inputNew: 500, inputCached: 0, output: 0 },
    ],
    { "RedHatAI/gemma": GEMMA },
  );
  expect(html).toContain("donut");
  expect(html).toContain("Not priced");
  expect(html).toContain("foo/Bar-7B-AWQ</code> (1.2M tokens)");
  expect(html).toContain("(unknown model)");
});

it("shows only the warning when nothing could be priced", async () => {
  const html = await render([{ model: "foo/Bar-7B-AWQ", inputNew: 10, inputCached: 0, output: 0 }]);
  expect(html).not.toContain("donut");
  expect(html).toContain("foo/Bar-7B-AWQ");
});

it("shows the empty-range copy without SCCH usage", async () => {
  const html = await render([]);
  expect(html).toContain("No SCCH usage in this range.");
});

it("degrades to the unavailable copy when the read fails", async () => {
  const html = await render(undefined);
  expect(html).toContain("could not be loaded");
});

it("degrades to the unavailable copy when OpenRouter cannot be reached", async () => {
  fetchOpenRouterModels.mockResolvedValue(undefined);
  const html = await render([{ model: "RedHatAI/gemma", inputNew: 10, inputCached: 0, output: 0 }]);
  expect(html).toContain("could not be loaded");
  expect(html).not.toContain("donut");
});
