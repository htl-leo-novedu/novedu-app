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
import type { TokenBucket } from "@/lib/usage-range";

// Reusable stacked token-usage bar chart (docs/dashboard.md). Presentation-only —
// the data (already bucketed + zero-filled by lib/usage-stats-store, UTC labels) is
// passed as props, so the same component serves the dashboard now and the future
// single-code stats pages. Series colors come from the `--chart-*` tokens; the
// chrome (grid/axis/legend) uses `currentColor` + opacity off the foreground ramp,
// so there is no bare hex here (docs/styling.md). The companion table below the
// chart is the dataviz "relief" for the two sub-3:1 hues.

// Stack order (bottom → top) and their token slots.
const SERIES = [
  { dataKey: "inputNew", name: "New input", slot: 0 },
  { dataKey: "inputCached", name: "Cached input", slot: 1 },
  { dataKey: "output", name: "Output", slot: 7 },
] as const;

export function TokenUsageBarChart({ data }: { data: TokenBucket[] }) {
  // Read the CSS tokens on every render (cheap) rather than freezing the first read
  // in a `useMemo([])` — a client render self-corrects an empty SSR read.
  const colors = useChartColors();
  return (
    <ChartFrame>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid {...GRID_PROPS} />
        <XAxis dataKey="label" {...X_AXIS_PROPS} minTickGap={16} />
        <YAxis width={48} {...Y_AXIS_PROPS} tickFormatter={formatCompact} />
        <Tooltip
          cursor={TOOLTIP_CURSOR}
          contentStyle={TOOLTIP_CONTENT_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          labelFormatter={(label) => `${label} UTC`}
          formatter={(value, name) => [formatCount(Number(value)), name]}
        />
        <Legend formatter={legendText} wrapperStyle={LEGEND_WRAPPER_STYLE} />
        {SERIES.map((s, i) => (
          <Bar
            key={s.dataKey}
            dataKey={s.dataKey}
            stackId="tokens"
            name={s.name}
            fill={colors.series[s.slot]}
            maxBarSize={56}
            // Round only the top segment of the stack.
            radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : undefined}
          />
        ))}
      </BarChart>
    </ChartFrame>
  );
}
