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

/** The viewer's local `HH:MM` for an hourly bucket, from its UTC start (ISO key). */
export function localHourLabel(bucketKey: string): string {
  const d = new Date(bucketKey);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** An hourly bucket's label: its UTC label until hydrated, the viewer's local time after. */
export function LocalHour({ bucketKey, utcLabel }: { bucketKey: string; utcLabel: string }) {
  return useLocalTime() ? localHourLabel(bucketKey) : utcLabel;
}

/** The hourly table's time column header, naming the zone its labels are in. */
export function HourHeader() {
  return useLocalTime() ? "Time (local)" : "Time (UTC)";
}
