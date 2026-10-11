import { beforeEach, describe, expect, it, vi } from "vitest";

// Behavior-level tests for the dashboard read seam. The one I/O seam — the Drizzle
// handle (`@/lib/db`) — is faked; the real logic under test is the row shaping
// (zero-fill, module/code folding, top-9) and the never-throws contract. The SQL
// text itself is left to the @live-db e2e (same split as code-stats-store).

const fake = vi.hoisted(() => {
  const state = { rows: [] as Record<string, unknown>[], executeError: undefined as unknown };
  const db = {
    execute: async () => {
      if (state.executeError) throw state.executeError;
      return { rows: state.rows };
    },
  };
  return { state, db };
});

vi.mock("@/lib/db", () => ({ getDb: () => fake.db }));

import { OTHER_KEY, resolveRange } from "@/lib/usage-range";
import {
  getDashboardKpis,
  getTokensByModel,
  getTokensByProvider,
  getTokenTimeSeries,
  getUsageBreakdown,
} from "@/lib/usage-stats-store";

const NOW = new Date("2026-07-04T14:30:00Z");

beforeEach(() => {
  fake.state.rows = [];
  fake.state.executeError = undefined;
});

describe("getTokenTimeSeries", () => {
  it("zero-fills the full bucket list and maps the matching bucket's sums", async () => {
    const { buckets } = resolveRange("24h", NOW);
    const lastKey = buckets[23]?.key ?? "";
    // The store re-keys each row's SQL Date via bucketKeyOf, so a Date at the
    // current hour lands on the last bucket. Numbers may arrive as strings (bigint).
    fake.state.rows = [{ bucket: new Date(lastKey), inputNew: "10", inputCached: 20, output: "5" }];
    const series = await getTokenTimeSeries({ range: "24h", now: NOW });
    expect(series).toHaveLength(24);
    expect(series?.[23]).toMatchObject({ inputNew: 10, inputCached: 20, output: 5 });
    expect(series?.[0]).toMatchObject({ inputNew: 0, inputCached: 0, output: 0 });
  });

  it("re-keys a non-floored day bucket onto its day and zero-fills the rest", async () => {
    // The day/month grains group in SQL, but the store re-floors each returned
    // bucket Date via `bucketKeyOf(new Date(row.bucket), grain)`. Feed a Date at a
    // non-midnight instant to prove it still lands on the right day bucket.
    fake.state.rows = [
      { bucket: new Date("2026-07-04T14:30:00Z"), inputNew: 7, inputCached: 0, output: 0 },
    ];
    const series = await getTokenTimeSeries({ range: "7d", now: NOW });
    expect(series).toHaveLength(7);
    expect(series?.[6]).toMatchObject({ inputNew: 7, label: "Jul 4" }); // today's bucket
    expect(series?.[0]).toMatchObject({ inputNew: 0, inputCached: 0, output: 0 });
  });

  it("returns undefined instead of throwing when the query fails", async () => {
    fake.state.executeError = new Error("connection lost");
    await expect(getTokenTimeSeries({ range: "24h", now: NOW })).resolves.toBeUndefined();
  });
});

describe("getUsageBreakdown", () => {
  it("sums by module and labels codes (note, falling back to the code)", async () => {
    fake.state.rows = [
      { code: "c1", module: "quiz", note: "Quiz One", total: 100 },
      { code: "c2", module: "quiz", note: null, total: 50 },
      { code: "c3", module: "tutor", note: "  ", total: 30 },
    ];
    const b = await getUsageBreakdown({ range: "7d", now: NOW });
    // Modules summed and sorted desc: quiz 150, tutor 30.
    expect(b?.byModule).toEqual([
      { key: "quiz", label: "quiz", total: 150 },
      { key: "tutor", label: "tutor", total: 30 },
    ]);
    // Codes: note used when present+non-blank, else the code; sorted desc.
    expect(b?.byCode.map((s) => [s.key, s.label, s.total])).toEqual([
      ["c1", "Quiz One", 100],
      ["c2", "c2", 50],
      ["c3", "c3", 30],
    ]);
  });

  it("drops modules and codes whose windowed token total is 0 (no phantom slices)", async () => {
    // A writing-save-only or quiz-answer-only code has a usage_by_code row with all
    // three token columns 0, so its windowed SUM is 0. Such categories must not
    // appear in a "tokens per module/code" pie, and must not fold into "Other: 0".
    fake.state.rows = [
      { code: "c1", module: "tutor", note: "T", total: 100 },
      { code: "c2", module: "writing", note: "W", total: 0 },
    ];
    const b = await getUsageBreakdown({ range: "7d", now: NOW });
    expect(b?.byModule).toEqual([{ key: "tutor", label: "tutor", total: 100 }]);
    expect(b?.byCode.map((s) => s.key)).toEqual(["c1"]); // c2 dropped, no OTHER_KEY
  });

  it("folds codes beyond the top 9 into Other", async () => {
    fake.state.rows = Array.from({ length: 11 }, (_, i) => ({
      code: `c${i}`,
      module: "tutor",
      note: null,
      total: 100 - i,
    }));
    const b = await getUsageBreakdown({ range: "30d", now: NOW });
    expect(b?.byCode).toHaveLength(10);
    expect(b?.byCode.at(-1)).toMatchObject({ key: OTHER_KEY, total: 91 + 90 }); // c9+c10
  });

  it("returns undefined instead of throwing when the query fails", async () => {
    fake.state.executeError = new Error("connection lost");
    await expect(getUsageBreakdown({ range: "7d", now: NOW })).resolves.toBeUndefined();
  });
});

describe("getTokensByModel", () => {
  it("labels rows by model, renders NULL as (unknown) and drops zero totals", async () => {
    fake.state.rows = [
      { model: "gpt-5.4-mini", total: "500" },
      { model: null, total: 200 },
      { model: "idle-model", total: 0 },
    ];
    const slices = await getTokensByModel({ range: "7d", now: NOW });
    expect(slices).toEqual([
      { key: "gpt-5.4-mini", label: "gpt-5.4-mini", total: 500 },
      { key: "(unknown)", label: "(unknown)", total: 200 },
    ]);
  });

  it("folds models beyond the top 9 into Other", async () => {
    fake.state.rows = Array.from({ length: 11 }, (_, i) => ({
      model: `m${i}`,
      total: 100 - i,
    }));
    const slices = await getTokensByModel({ range: "30d", now: NOW });
    expect(slices).toHaveLength(10);
    expect(slices?.at(-1)).toMatchObject({ key: OTHER_KEY, total: 91 + 90 });
  });

  it("returns undefined instead of throwing when the query fails", async () => {
    fake.state.executeError = new Error("connection lost");
    await expect(getTokensByModel({ range: "7d", now: NOW })).resolves.toBeUndefined();
  });
});

describe("getTokensByProvider", () => {
  it("labels rows by provider, renders NULL as (unknown), and drops zero totals", async () => {
    // The provider split is its own GROUP BY, not a re-reading of the model pie:
    // two providers may serve the same model id, so only this column is the cost
    // split (docs/usage-metering.md).
    fake.state.rows = [
      { provider: "SCCH", total: "500" },
      { provider: "Azure Foundry", total: 200 },
      { provider: null, total: 40 },
      { provider: "OpenRouter", total: 0 },
    ];
    const slices = await getTokensByProvider({ range: "7d", now: NOW });
    expect(slices).toEqual([
      { key: "SCCH", label: "SCCH", total: 500 },
      { key: "Azure Foundry", label: "Azure Foundry", total: 200 },
      { key: "(unknown)", label: "(unknown)", total: 40 },
    ]);
  });

  it("folds providers beyond the top 9 into Other", async () => {
    fake.state.rows = Array.from({ length: 11 }, (_, i) => ({
      provider: `p${i}`,
      total: 100 - i,
    }));
    const slices = await getTokensByProvider({ range: "30d", now: NOW });
    expect(slices).toHaveLength(10);
    expect(slices?.at(-1)).toMatchObject({ key: OTHER_KEY, total: 91 + 90 });
  });

  it("returns undefined instead of throwing when the query fails", async () => {
    fake.state.executeError = new Error("connection lost");
    await expect(getTokensByProvider({ range: "7d", now: NOW })).resolves.toBeUndefined();
  });
});

describe("getDashboardKpis", () => {
  it("maps the single aggregate row, coercing string counts", async () => {
    fake.state.rows = [{ chats: "3", quizAnswers: 12, clozeSubmissions: "4" }];
    await expect(getDashboardKpis({ range: "24h", now: NOW })).resolves.toEqual({
      chats: 3,
      quizAnswers: 12,
      clozeSubmissions: 4,
    });
  });

  it("defaults to zero when the row is absent", async () => {
    fake.state.rows = [];
    await expect(getDashboardKpis({ range: "24h", now: NOW })).resolves.toEqual({
      chats: 0,
      quizAnswers: 0,
      clozeSubmissions: 0,
    });
  });

  it("returns undefined instead of throwing when the query fails", async () => {
    fake.state.executeError = new Error("connection lost");
    await expect(getDashboardKpis({ range: "24h", now: NOW })).resolves.toBeUndefined();
  });
});
