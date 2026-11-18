"use client";

import { useSyncExternalStore } from "react";

// Hourly usage buckets shown in the VIEWER's time zone (docs/dashboard.md, "Time
// model"). Everything on the server stays UTC — the buckets, their ISO keys and
// their UTC labels; only the browser relabels an hourly bucket from its key, which
// it can do exactly because a whole UTC hour is a whole local hour. Day and month
// buckets keep their UTC labels (a UTC day is not a local day). The server
// snapshot is UTC, so the server render and hydration agree and the first client
// render after hydration switches to local time.

const noSubscribe = () => () => {};

/** False on the server and during hydration, true from the first client render after. */
export function useLocalTime(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const HOUR_MS = 3_600_000;

const wallClock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The local offset from UTC at an instant, e.g. `UTC+2`, `UTC+5:30`, `UTC-3`. */
function utcOffset(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  const abs = Math.abs(minutes);
  const sign = minutes < 0 ? "-" : "+";
  const rest = abs % 60 ? `:${pad(abs % 60)}` : "";
  return `UTC${sign}${Math.floor(abs / 60)}${rest}`;
}

/**
 * The viewer's local `HH:MM` for an hourly bucket, from its UTC start (ISO key).
 * When the clocks go back, one local hour happens twice (two UTC buckets share a
 * wall-clock label), so such a label carries its UTC offset to tell them apart:
 * `02:00 (UTC+2)`, then `02:00 (UTC+1)`.
 */
export function localHourLabel(bucketKey: string): string {
  const d = new Date(bucketKey);
  const label = wallClock(d);
  const repeated =
    wallClock(new Date(d.getTime() - HOUR_MS)) === label ||
    wallClock(new Date(d.getTime() + HOUR_MS)) === label;
  return repeated ? `${label} (${utcOffset(d)})` : label;
}

/** An hourly bucket's label: its UTC label until hydrated, the viewer's local time after. */
export function LocalHour({ bucketKey, utcLabel }: { bucketKey: string; utcLabel: string }) {
  return useLocalTime() ? localHourLabel(bucketKey) : utcLabel;
}

/** The hourly table's time column header, naming the zone its labels are in. */
export function HourHeader() {
  return useLocalTime() ? "Time (local)" : "Time (UTC)";
}
