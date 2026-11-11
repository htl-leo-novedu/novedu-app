"use client";

import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import {
  GRID_PROPS,
  LEGEND_WRAPPER_STYLE,
  legendText,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
  X_AXIS_PROPS,
  Y_AXIS_PROPS,
} from "@/components/charts/chart-chrome";
import { useChartColors } from "@/components/charts/chart-colors";
import { ChartFrame } from "@/components/charts/chart-frame";
import { formatDurationMs } from "@/lib/diagnostics-report";
import type { ProviderSeries } from "@/lib/diagnostics-shape";
import { secondsTick, tickFormatter, tooltipLabel } from "./axes";

// Header wait per bin — p50 solid, p95 dashed, one color per provider
// (docs/diagnostics.md). A bin without calls has no percentile and leaves a gap
// (`connectNulls={false}`) rather than a misleading zero; small dots keep isolated
// points visible. The series share the bin list, so they are merged into one row
// per bin with index-based keys (a provider name with a space or dot would be read
// as a path by Recharts' `dataKey`).

type Row = { t: number } & Record<string, number | null>;

export function WaitPercentilesChart({
  series,
  spanMs,
}: {
  series: ProviderSeries[];
  spanMs: number;
}) {
  const colors = useChartColors();
  const rows: Row[] = (series[0]?.bins ?? []).map((bin, i) => {
    const row: Row = { t: bin.t };
    series.forEach((s, j) => {
      row[`p50_${j}`] = s.bins[i]?.p50Ms ?? null;
      row[`p95_${j}`] = s.bins[i]?.p95Ms ?? null;
    });
    return row;
  });
  return (
    <ChartFrame className="h-64">
      <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid {...GRID_PROPS} />
        <XAxis
          dataKey="t"
          {...X_AXIS_PROPS}
          tickFormatter={tickFormatter(spanMs)}
          minTickGap={24}
        />
        <YAxis width={48} {...Y_AXIS_PROPS} tickFormatter={secondsTick} />
        <Tooltip
          contentStyle={TOOLTIP_CONTENT_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          labelFormatter={tooltipLabel}
          formatter={(value, name) => [
            formatDurationMs(value == null ? null : Number(value)),
            name,
          ]}
        />
        <Legend
          formatter={legendText}
          // Group by provider: `p50_0, p95_0, p50_1, …`.
          itemSorter={(item) => String(item.dataKey).split("_").reverse().join("_")}
          wrapperStyle={LEGEND_WRAPPER_STYLE}
        />
        {series.flatMap((s, j) => {
          // Keyed by provider: the series list is sorted and unique per provider.
          const stroke = colors.series[j % colors.series.length];
          return [
            <Line
              key={`${s.provider}-p50`}
              dataKey={`p50_${j}`}
              name={`${s.provider} p50`}
              stroke={stroke}
              strokeWidth={2}
              dot={{ r: 1.5 }}
              connectNulls={false}
              isAnimationActive={false}
            />,
            <Line
              key={`${s.provider}-p95`}
              dataKey={`p95_${j}`}
              name={`${s.provider} p95`}
              stroke={stroke}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={{ r: 1.5 }}
              connectNulls={false}
              isAnimationActive={false}
            />,
          ];
        })}
      </LineChart>
    </ChartFrame>
  );
}
