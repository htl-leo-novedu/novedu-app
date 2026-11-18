// Pure time-range helpers for the usage dashboard (docs/dashboard.md). No I/O and
// no `new Date()` inside — `now` is always injected, so every function is
// deterministic and unit-testable. EVERYTHING here is UTC: the `hour` column of
// `novedu_usage_by_code` is a top-of-hour UTC bucket, and the labels made here are
// UTC, so bucket boundaries and labels line up by construction. (The dashboard
// relabels HOURLY buckets in the viewer's time zone in the browser —
// `app/usage/local-hour.tsx`; day and month labels stay these UTC ones.) Safe to
// import from client or server (no DB, no secrets).

/** The four dashboard time windows. */
export type UsageRange = "24h" | "7d" | "30d" | "365d";

/** SQL/JS bucket granularity a range renders at. */
export type Grain = "hour" | "day" | "month";

export const USAGE_RANGES: readonly UsageRange[] = ["24h", "7d", "30d", "365d"] as const;

/** Human labels for the range tabs. */
export const USAGE_RANGE_LABELS: Record<UsageRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "365d": "Last 365 days",
};

export function isUsageRange(value: unknown): value is UsageRange {
  return typeof value === "string" && (USAGE_RANGES as readonly string[]).includes(value);
}

/** Parses a search-param value to a range, defaulting to `24h`. */
export function parseRange(value: unknown): UsageRange {
  return isUsageRange(value) ? value : "24h";
}

/** One x-axis bucket: a stable key (its UTC start, ISO) plus a UTC display label. */
export interface Bucket {
  key: string;
  label: string;
}

/** The token sums that ride on each bucket / breakdown row. */
export interface TokenSums {
  inputNew: number;
  inputCached: number;
  output: number;
}

/** A fully-resolved x-axis bucket ready for the chart + table. */
export interface TokenBucket extends Bucket, TokenSums {}

export interface ResolvedRange {
  /** Inclusive window start (UTC); the SQL filter is `hour >= start`. */
  start: Date;
  grain: Grain;
  /** The full ordered bucket list, oldest → newest, so gaps render as zero. */
  buckets: Bucket[];
}

// --- UTC bucket flooring -----------------------------------------------------

function floorHour(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0),
  );
}

function floorDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function floorMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function addHours(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 3_600_000);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 0, 0, 0, 0));
}

/** Floors an instant to the start of its bucket for the given grain (UTC). */
export function floorToGrain(d: Date, grain: Grain): Date {
  if (grain === "hour") return floorHour(d);
  if (grain === "day") return floorDay(d);
  return floorMonth(d);
}

/** The bucket key an arbitrary instant belongs to (matches `resolveRange` keys). */
export function bucketKeyOf(d: Date, grain: Grain): string {
  return floorToGrain(d, grain).toISOString();
}

// --- UTC labels (en-US, fixed so output is locale-independent) ---------------

const dayFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const monthFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function labelFor(bucketStart: Date, grain: Grain): string {
  if (grain === "hour") return `${String(bucketStart.getUTCHours()).padStart(2, "0")}:00`;
  if (grain === "day") return dayFmt.format(bucketStart);
  return monthFmt.format(bucketStart);
}

// --- Resolution --------------------------------------------------------------

// Each range: how many buckets, at which grain, floored from `now`.
const SPEC: Record<UsageRange, { grain: Grain; count: number }> = {
  "24h": { grain: "hour", count: 24 },
  "7d": { grain: "day", count: 7 },
  "30d": { grain: "day", count: 30 },
  "365d": { grain: "month", count: 12 },
};

/** The bucket grain a range renders at. */
export function grainOf(range: UsageRange): Grain {
  return SPEC[range].grain;
}

function step(d: Date, grain: Grain, n: number): Date {
  if (grain === "hour") return addHours(d, n);
  if (grain === "day") return addDays(d, n);
  return addMonths(d, n);
}

/**
 * The window start, grain, and full ordered bucket list for a range, anchored at
 * `now` (injected). The newest bucket is the one containing `now`; the list runs
 * back `count - 1` buckets, so `start` is the oldest bucket's start.
 */
export function resolveRange(range: UsageRange, now: Date): ResolvedRange {
  const { grain, count } = SPEC[range];
  const newest = floorToGrain(now, grain);
  const start = step(newest, grain, -(count - 1));
  const buckets: Bucket[] = [];
  for (let i = 0; i < count; i++) {
    const bucketStart = step(start, grain, i);
    buckets.push({ key: bucketStart.toISOString(), label: labelFor(bucketStart, grain) });
  }
  return { start, grain, buckets };
}

/**
 * Merges aggregated sums (keyed by bucket key) onto the full bucket list, so
 * buckets with no data render as an explicit zero rather than a gap.
 */
export function zeroFill(buckets: Bucket[], byKey: Map<string, TokenSums>): TokenBucket[] {
  return buckets.map((b) => {
    const sums = byKey.get(b.key);
    return {
      ...b,
      inputNew: sums?.inputNew ?? 0,
      inputCached: sums?.inputCached ?? 0,
      output: sums?.output ?? 0,
    };
  });
}

/** A pie slice: a stable key, a display label, and its total token count. */
export interface Slice {
  key: string;
  label: string;
  total: number;
}

/** The synthetic key/label the folded remainder uses. */
export const OTHER_KEY = "__other__";
export const OTHER_LABEL = "Other";

/**
 * Keeps the top `n` slices by total (descending) and folds the rest into a single
 * "Other" slice. Ties break by key for a stable order. The "Other" slice is
 * appended only when there is a remainder.
 */
export function foldTopN(slices: Slice[], n = 9): Slice[] {
  const sorted = [...slices].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  const top = sorted.slice(0, n);
  const rest = sorted.slice(n);
  if (rest.length === 0) return top;
  const otherTotal = rest.reduce((sum, s) => sum + s.total, 0);
  return [...top, { key: OTHER_KEY, label: OTHER_LABEL, total: otherTotal }];
}
