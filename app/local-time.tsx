"use client";

// Renders a unix timestamp (seconds) in the VIEWER's local time. Must be a
// client component — the server doesn't know the user's timezone. The server
// render uses the server's zone; suppressHydrationWarning lets the client
// correct it without a hydration error. A `null` timestamp (e.g. an open-ended
// code's missing window bound) renders the `fallback` text instead. `dateOnly`
// drops the time of day (the folded phone list's short facts).
export function LocalTime({
  seconds,
  fallback = "—",
  dateOnly = false,
}: {
  seconds: number | null;
  fallback?: string;
  dateOnly?: boolean;
}) {
  if (seconds === null) return <span>{fallback}</span>;
  const date = new Date(seconds * 1000);
  return (
    <time dateTime={date.toISOString()} suppressHydrationWarning>
      {dateOnly ? date.toLocaleDateString() : date.toLocaleString()}
    </time>
  );
}
