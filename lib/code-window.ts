// Where "now" falls relative to a code's availability window — the status the
// codes list shows as a badge and filters on. Pure (no DB import), so the list's
// URL parsing and the badge share it; the SQL twin that filters on the same
// three states is `windowStatusCondition` in `lib/code-store.ts`.
//
// Both bounds are inclusive and a missing bound is open on that side, so an
// open-ended code is never "upcoming" / "expired" on that side. "Upcoming" wins
// over "expired" for a (never stored) inverted window, in both halves.

export const WINDOW_STATUSES = ["active", "upcoming", "expired"] as const;

export type WindowStatus = (typeof WINDOW_STATUSES)[number];

export function windowStatus(
  entry: { validFrom: Date | null; validUntil: Date | null },
  now: Date,
): WindowStatus {
  if (entry.validFrom && now < entry.validFrom) return "upcoming";
  if (entry.validUntil && now > entry.validUntil) return "expired";
  return "active";
}
