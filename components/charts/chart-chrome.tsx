// Shared chart CHROME for every Recharts chart in the app (the usage dashboard,
// the LLM diagnostics page): grid, axes, tooltip, legend. SVG chrome uses
// `currentColor` + opacity off the foreground ramp (the chart frame sets
// `text-foreground`); Recharts renders the tooltip and legend as HTML, so CSS
// custom properties and color-mix() DO resolve there — token-based, no bare hex
// (docs/styling.md). Series colors are `useChartColors()` (chart-colors.ts).
// Plain props objects, spread onto the Recharts elements:
//
//   <CartesianGrid {...GRID_PROPS} />
//   <XAxis dataKey="t" {...X_AXIS_PROPS} />

/** Horizontal hairlines only. */
export const GRID_PROPS = { vertical: false, stroke: "currentColor", strokeOpacity: 0.12 } as const;

const AXIS_TICK = { fill: "currentColor", fillOpacity: 0.6, fontSize: 12 } as const;

/** The category/time axis along the bottom. */
export const X_AXIS_PROPS = {
  tickLine: false,
  axisLine: { stroke: "currentColor", strokeOpacity: 0.2 },
  tick: AXIS_TICK,
  interval: "preserveStartEnd",
} as const;

/** A value axis: no line, muted ticks. */
export const Y_AXIS_PROPS = { tickLine: false, axisLine: false, tick: AXIS_TICK } as const;

/** The hover band behind a bar group. */
export const TOOLTIP_CURSOR = { fill: "currentColor", fillOpacity: 0.05 } as const;

export const TOOLTIP_CONTENT_STYLE = {
  background: "var(--color-background)",
  border: "1px solid color-mix(in oklab, var(--color-foreground) 15%, transparent)",
  borderRadius: "0.5rem",
  fontSize: "0.75rem",
  color: "var(--color-foreground)",
} as const;

export const TOOLTIP_LABEL_STYLE = { color: "var(--color-foreground)", fontWeight: 600 } as const;

export const LEGEND_WRAPPER_STYLE = { fontSize: "0.75rem" } as const;

/** Legend label renderer: keeps the app foreground ink instead of Recharts' default. */
export const legendText = (value: string) => (
  <span style={{ color: "var(--color-foreground)" }}>{value}</span>
);
