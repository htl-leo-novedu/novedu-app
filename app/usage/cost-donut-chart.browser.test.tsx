import { describe, expect, test } from "vitest";
import { renderChart } from "@/tests/render-chart";
import { CostDonutChart } from "./cost-donut-chart";

// Pure-prop rendering of the cost card's donut: the total in the centre, and a
// legend row per token category with its $ amount and share. No infra.

const cost = { inputNew: 3.54, inputCached: 10.69, output: 5.51, total: 19.74 };

describe("CostDonutChart", () => {
  test("shows the total and the range in the centre", async () => {
    const screen = await renderChart(<CostDonutChart cost={cost} rangeLabel="Last 30 days" />, 560);
    await expect.element(screen.getByText("$19.74")).toBeVisible();
    await expect.element(screen.getByText("Last 30 days")).toBeVisible();
  });

  test("lists each category with its $ amount and share", async () => {
    const screen = await renderChart(<CostDonutChart cost={cost} rangeLabel="Last 30 days" />, 560);
    const row = (name: string) => screen.getByRole("row", { name: new RegExp(name) });
    await expect.element(row("New input")).toHaveTextContent(/\$3\.54\s*17\.9%/);
    await expect.element(row("Cached input")).toHaveTextContent(/\$10\.69\s*54\.2%/);
    await expect.element(row("Output")).toHaveTextContent(/\$5\.51\s*27\.9%/);
  });

  test("paints the three slices", async () => {
    const screen = await renderChart(<CostDonutChart cost={cost} rangeLabel="Last 30 days" />, 560);
    await expect
      .poll(() => screen.container.querySelectorAll(".recharts-pie-sector").length)
      .toBe(3);
  });
});
