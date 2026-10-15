// Fixed en-US number formatting for the chart pages (usage, diagnostics) so axes,
// tooltips, and tables read the same regardless of the viewer's locale. Pure;
// client + server safe.

/** Full grouped integer, e.g. `1,234,567`. */
export const formatCount = (n: number): string => n.toLocaleString("en-US");

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Compact form for tight axis ticks, e.g. `1.2M`. */
export const formatCompact = (n: number): string => compact.format(n);

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** US dollars with cents, e.g. `$1,234.56`. */
export const formatUsd = (n: number): string => usd.format(n);

const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** A 0–1 share as a percentage with one decimal, e.g. `17.9%`. */
export const formatPercent = (share: number): string => percent.format(share);
