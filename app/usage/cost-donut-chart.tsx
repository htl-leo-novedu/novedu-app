"use client";

import { Cell, Pie, PieChart } from "recharts";
import { resolveChartColors } from "@/components/charts/chart-colors";
import { ChartFrame } from "@/components/charts/chart-frame";
import { formatPercent, formatUsd } from "@/components/charts/format";
import { cn } from "@/lib/utils";

// The cost card's donut (docs/dashboard.md, "Cost estimate"): the estimate split
// into new input, cached input and output, the total in the centre, and a legend
// table beside it with each category's $ amount and share. The categories keep
// the hues of the token bar chart's series (`--chart-1`, `-2`, `-8`), so a colour
// means the same token kind across the page. The legend is the dataviz "relief"
// for the sub-3:1 hues, so the ring needs no tooltip or on-slice labels.

const CATEGORIES = [
  { key: "inputNew", label: "New input", slot: 0, swatch: "bg-chart-1" },
  { key: "inputCached", label: "Cached input", slot: 1, swatch: "bg-chart-2" },
  { key: "output", label: "Output", slot: 7, swatch: "bg-chart-8" },
] as const;

export interface CostSplit {
  inputNew: number;
  inputCached: number;
  output: number;
  total: number;
}

export function CostDonutChart({ cost, rangeLabel }: { cost: CostSplit; rangeLabel: string }) {
  // Read the CSS tokens on every render, like the other charts: an empty SSR read
  // self-corrects on the client.
  const colors = resolveChartColors();
  const share = (value: number) => (cost.total > 0 ? value / cost.total : 0);
  const slices = CATEGORIES.map((c) => ({ ...c, value: cost[c.key] }));

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="relative size-44 shrink-0">
        <ChartFrame className="h-44">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius="62%"
              outerRadius="96%"
              // No paddingAngle (a lone slice would render as an open ring); the
              // surface stroke separates the slices instead, as in the pies.
              stroke={colors.surface || undefined}
              strokeWidth={2}
            >
              {slices.map((s) => (
                <Cell key={s.key} fill={colors.series[s.slot] ?? colors.other} />
              ))}
            </Pie>
          </PieChart>
        </ChartFrame>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="font-bold text-xl tabular-nums leading-none">
            {formatUsd(cost.total)}
          </span>
          <span className="mt-1 text-foreground/60 text-xs">{rangeLabel}</span>
        </div>
      </div>
      <table className="min-w-52 flex-1 text-sm">
        <caption className="sr-only">Estimated cost by token category</caption>
        <tbody>
          {slices.map((s) => (
            <tr key={s.key} className="border-foreground/15 border-b last:border-b-0">
              <th scope="row" className="py-1.5 text-left font-normal">
                <span
                  aria-hidden="true"
                  className={cn("mr-2 inline-block size-2.5 rounded-xs align-[-1px]", s.swatch)}
                />
                {s.label}
              </th>
              <td className="py-1.5 text-right font-semibold tabular-nums">{formatUsd(s.value)}</td>
              <td className="w-16 py-1.5 text-right text-foreground/60 tabular-nums">
                {formatPercent(share(s.value))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
