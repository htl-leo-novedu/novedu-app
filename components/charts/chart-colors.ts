"use client";

// Resolves the `--chart-*` CSS tokens (defined in app/globals.css) to concrete
// color strings for Recharts, whose SVG `fill`/`stroke` attributes do NOT resolve
// CSS custom properties. The single source of truth stays the CSS tokens
// (docs/styling.md — no bare hex in a component); this only reads them.
//
// Returns empty strings during SSR (no `document`); that is harmless because
// Recharts' ResponsiveContainer paints nothing measurable server-side — the real
// paint happens on the client, where getComputedStyle resolves the tokens.
//
// `useChartColors` re-reads them whenever the colour theme changes (lib/theme.ts),
// so a chart repaints with the dark or light steps at once.

import { useIsDark } from "@/lib/use-is-dark";

function cssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface ChartColors {
  /** Categorical series colors, `--chart-1..9`. */
  series: string[];
  /** The muted "Other" slice color, `--chart-other`. */
  other: string;
  /** The chart surface (the card the chart sits on), used for the 2px ring between pie slices. */
  surface: string;
}

function resolveChartColors(): ChartColors {
  return {
    series: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => cssVar(`--chart-${i}`)),
    other: cssVar("--chart-other"),
    surface: cssVar("--card"),
  };
}

/** The chart tokens, re-read on every render and on every theme change. */
export function useChartColors(): ChartColors {
  useIsDark();
  return resolveChartColors();
}
