"use client";

import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";
import {
  GRID_PROPS,
  LEGEND_WRAPPER_STYLE,
  legendText,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_CURSOR,
  TOOLTIP_LABEL_STYLE,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
} from "@/components/charts/chart-chrome";
import { useChartColors } from "@/components/charts/chart-colors";
import { ChartFrame } from "@/components/charts/chart-frame";
import { formatCompact, formatCount } from "@/components/charts/format";
import { type LlmBin, OUTCOME_LABELS, OUTCOMES, type Outcome } from "@/lib/diagnostics-shape";
import { tickFormatter, tooltipLabel } from "./axes";

// Upstream calls per bin, stacked by outcome (docs/diagnostics.md). One small
// chart per provider. The x-axis is the zero-filled bin list, so a category axis
// keyed by the bin start keeps every bin evenly spaced; labels are local time.
// Colors come from the `--chart-*` tokens (docs/styling.md).

// Token slot per outcome: blue OK, purple other 4xx, amber 429, red 5xx, gray none.
const SLOT: Record<Outcome, number | "other"> = {
  ok: 0,
  clientError: 4,
  rateLimited: 2,
  serverError: 5,
  noResponse: "other",
};

export function CallsByOutcomeChart({ bins, spanMs }: { bins: LlmBin[]; spanMs: number }) {
  const colors = useChartColors();
  return (
    <ChartFrame className="h-56">
      <BarChart data={bins} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid {...GRID_PROPS} />
        <XAxis
          dataKey="t"
          {...X_AXIS_PROPS}
          tickFormatter={tickFormatter(spanMs)}
          minTickGap={24}
        />
        <YAxis width={40} {...Y_AXIS_PROPS} allowDecimals={false} tickFormatter={formatCompact} />
        <Tooltip
          cursor={TOOLTIP_CURSOR}
          contentStyle={TOOLTIP_CONTENT_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          labelFormatter={tooltipLabel}
          formatter={(value, name) => [formatCount(Number(value)), name]}
        />
        <Legend
          formatter={legendText}
          itemSorter={(item) => OUTCOMES.indexOf(item.dataKey as Outcome)}
          wrapperStyle={LEGEND_WRAPPER_STYLE}
        />
        {OUTCOMES.map((outcome) => {
          const slot = SLOT[outcome];
          return (
            <Bar
              key={outcome}
              dataKey={outcome}
              stackId="calls"
              name={OUTCOME_LABELS[outcome]}
              fill={slot === "other" ? colors.other : colors.series[slot]}
              maxBarSize={24}
              isAnimationActive={false}
            />
          );
        })}
      </BarChart>
    </ChartFrame>
  );
}
