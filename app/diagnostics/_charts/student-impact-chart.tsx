"use client";

import { Bar, CartesianGrid, ComposedChart, Legend, Line, Tooltip, XAxis, YAxis } from "recharts";
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
import { formatCount } from "@/components/charts/format";
import { formatDurationMs } from "@/lib/diagnostics-report";
import type { ImpactBin } from "@/lib/diagnostics-shape";
import { secondsTick, tickFormatter, tooltipLabel } from "./axes";

// What students experienced per bin (docs/diagnostics.md): failed chat turns as
// bars on the left axis, the p95 of a full chat turn as a line on the right axis.

const FAILED = "Failed chat turns";
const P95 = "Chat turn p95";

export function StudentImpactChart({ bins, spanMs }: { bins: ImpactBin[]; spanMs: number }) {
  const colors = useChartColors();
  return (
    <ChartFrame className="h-64">
      <ComposedChart data={bins} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
        <CartesianGrid {...GRID_PROPS} />
        <XAxis
          dataKey="t"
          {...X_AXIS_PROPS}
          tickFormatter={tickFormatter(spanMs)}
          minTickGap={24}
        />
        <YAxis yAxisId="failed" width={40} {...Y_AXIS_PROPS} allowDecimals={false} />
        <YAxis
          yAxisId="p95"
          orientation="right"
          width={48}
          {...Y_AXIS_PROPS}
          tickFormatter={secondsTick}
        />
        <Tooltip
          cursor={TOOLTIP_CURSOR}
          contentStyle={TOOLTIP_CONTENT_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          labelFormatter={tooltipLabel}
          formatter={(value, name) =>
            name === P95
              ? [formatDurationMs(value == null ? null : Number(value)), name]
              : [formatCount(Number(value)), name]
          }
        />
        <Legend
          formatter={legendText}
          itemSorter={(item) => (item.dataKey === "failedTurns" ? 0 : 1)}
          wrapperStyle={LEGEND_WRAPPER_STYLE}
        />
        <Bar
          yAxisId="failed"
          dataKey="failedTurns"
          name={FAILED}
          fill={colors.series[5]}
          maxBarSize={24}
          isAnimationActive={false}
        />
        <Line
          yAxisId="p95"
          dataKey="p95Ms"
          name={P95}
          stroke={colors.series[0]}
          strokeWidth={2}
          dot={{ r: 1.5 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartFrame>
  );
}
