import { describe, expect, test } from "vitest";
import type { TokenBucket } from "@/lib/usage-range";
import { renderChart } from "@/tests/render-chart";
import { localHourLabel } from "./local-hour";
import { TokenUsageBarChart } from "./token-usage-bar-chart";

// Pure-prop rendering of the reusable stacked bar chart — no infra, no @live tag.

const data: TokenBucket[] = [
  { key: "a", label: "Jul 2", inputNew: 100, inputCached: 200, output: 50 },
  { key: "b", label: "Jul 3", inputNew: 0, inputCached: 0, output: 0 },
  { key: "c", label: "Jul 4", inputNew: 300, inputCached: 100, output: 80 },
];

// Hourly buckets carry their UTC start as the key; the UTC labels here are
// deliberately unlike any clock time, so the test holds in every time zone.
const hourly: TokenBucket[] = [
  { key: "2026-07-04T12:00:00.000Z", label: "utc-12", inputNew: 100, inputCached: 0, output: 0 },
  { key: "2026-07-04T13:00:00.000Z", label: "utc-13", inputNew: 200, inputCached: 0, output: 0 },
];

describe("TokenUsageBarChart", () => {
  test("labels the three stacked series in the legend", async () => {
    const screen = await renderChart(<TokenUsageBarChart data={data} grain="day" />);
    await expect.element(screen.getByText("New input")).toBeVisible();
    await expect.element(screen.getByText("Cached input")).toBeVisible();
    await expect.element(screen.getByText("Output", { exact: true })).toBeVisible();
  });

  test("renders an x-axis tick for a bucket label", async () => {
    const screen = await renderChart(<TokenUsageBarChart data={data} grain="day" />);
    await expect.element(screen.getByText("Jul 4").first()).toBeVisible();
  });

  test("labels hourly buckets in the viewer's time zone", async () => {
    const screen = await renderChart(<TokenUsageBarChart data={hourly} grain="hour" />);
    const local = localHourLabel("2026-07-04T13:00:00.000Z");
    await expect.element(screen.getByText(local).first()).toBeVisible();
    expect(screen.container.textContent).not.toContain("utc-13");
  });
});
