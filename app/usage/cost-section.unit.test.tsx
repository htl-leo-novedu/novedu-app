import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPrice, ModelTokens } from "@/lib/usage-cost";

// The two cost cards' states over a stubbed store read and stubbed price lookups
// (the pure matching and price math run for real). `CostSection` (SCCH): the donut
// with its figures, the unmatched warning, nothing priced, an empty range and both
// failure paths. `SpendSection` (OpenRouter): the same states over the real
// id match against a canned OpenRouter list. The client donut is stubbed so this
// stays a hermetic node render. No DB, no network.

const getModelTokensForProvider = vi.hoisted(() => vi.fn());
const fetchOpenRouterModels = vi.hoisted(() => vi.fn());
const priceModels = vi.hoisted(() => vi.fn());

vi.mock("@/lib/usage-stats-store", () => ({ getModelTokensForProvider }));
vi.mock("@/lib/usage-cost-lookup", () => ({ fetchOpenRouterModels, priceModels }));
vi.mock("./cost-donut-chart", () => ({
  CostDonutChart: ({ cost, rangeLabel }: { cost: { total: number }; rangeLabel: string }) => (
    <div data-testid="donut">
      {cost.total.toFixed(2)} {rangeLabel}
    </div>
  ),
}));

import { CostSection, SpendSection } from "./cost-section";

const GEMMA: ModelPrice = { prompt: 0.0000002, cacheRead: 0.0000002, completion: 0.0000004 };

async function render(rows: ModelTokens[] | undefined, prices: Record<string, ModelPrice> = {}) {
  getModelTokensForProvider.mockResolvedValue(rows);
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
  expect(getModelTokensForProvider).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "SCCH" }),
  );
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

describe("SpendSection (OpenRouter)", () => {
  const LUNA = "openai/gpt-6-luna";

  async function renderSpend(rows: ModelTokens[] | undefined) {
    getModelTokensForProvider.mockResolvedValue(rows);
    return renderToStaticMarkup(
      await SpendSection({ range: "7d", now: new Date("2026-10-15T12:00:00Z") }),
    );
  }

  beforeEach(() => {
    fetchOpenRouterModels.mockResolvedValue({
      json: {
        data: [
          {
            id: LUNA,
            pricing: {
              // $0.10 / $0.50 / $0.01 / $0.125 per 1M: input / output / read / write.
              prompt: "0.0000001",
              completion: "0.0000005",
              input_cache_read: "0.00000001",
              input_cache_write: "0.000000125",
            },
          },
        ],
      },
      fetchedAt: new Date("2026-10-15T08:00:00Z"),
    });
  });

  it("prices OpenRouter tokens by id, new input at the cache-write rate", async () => {
    const html = await renderSpend([
      { model: LUNA, inputNew: 8_000_000, inputCached: 100_000_000, output: 2_000_000 },
    ]);
    expect(getModelTokensForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "OpenRouter" }),
    );
    expect(priceModels).not.toHaveBeenCalled(); // no Hugging Face step
    // $1.00 new input (8M × $0.125) + $1.00 cached + $1.00 output.
    expect(html).toContain("3.00 Last 7 days");
    expect(html).toContain("OpenRouter spend (estimate)");
    expect(html).toContain("These tokens are billed.");
    expect(html).toContain('aria-label="About the spend estimate"');
    expect(html).toContain("cache-write rate");
    expect(html).toContain("fetched Oct 15, 2026");
    expect(html).not.toContain("Not priced");
  });

  it("names a model OpenRouter does not list", async () => {
    const html = await renderSpend([
      { model: LUNA, inputNew: 1_000, inputCached: 0, output: 0 },
      { model: "vendor/gone", inputNew: 2_500_000, inputCached: 0, output: 0 },
    ]);
    expect(html).toContain("donut");
    expect(html).toContain("vendor/gone</code> (2.5M tokens)");
  });

  it("shows the empty-range copy without OpenRouter usage", async () => {
    expect(await renderSpend([])).toContain("No OpenRouter usage in this range.");
  });

  it("degrades to the unavailable copy when the read or OpenRouter fails", async () => {
    expect(await renderSpend(undefined)).toContain("could not be loaded");
    fetchOpenRouterModels.mockResolvedValue(undefined);
    const html = await renderSpend([{ model: LUNA, inputNew: 10, inputCached: 0, output: 0 }]);
    expect(html).toContain("could not be loaded");
    expect(html).not.toContain("donut");
  });
});
