// Derived facts over a student's usage days: weekly streaks, per-week counts,
// running totals and the 26-week heatmap. Pure; every "first reached" date is the
// Vienna-local date on which the evidence was first complete (docs/home.md).

import { addDays, isoWeekKey, type LocalDate, monthOf } from "./time";

/** One Vienna-local day of a user's usage (only days with ≥ 1 active hour count). */
export interface UsageDay {
  date: LocalDate;
  /** UTC-hour buckets of that local day with any counted interaction. */
  activeHours: number;
  /** Chat messages of every kind (tutor, quiz discussion, writing coach). */
  userMessages: number;
  quizAnswers: number;
  writingSaves: number;
  /** Requests through the coding proxy. */
  codingRequests: number;
  /** Graded cloze submissions (practice rounds included). */
  clozeSubmissions: number;
  /** Distinct Vienna-local hours of the day with a coding request. */
  codingHours: number;
}

/** Weeks shown in the heatmap (the current ISO week and the 25 before it). */
export const HEATMAP_WEEKS = 26;

/** Active days, ascending, without days that had no active hour. */
export function activeDays(days: readonly UsageDay[]): UsageDay[] {
  return days.filter((d) => d.activeHours > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Active days grouped by ISO week (key = the week's Monday), weeks ascending. */
function byWeek(days: readonly UsageDay[]): [LocalDate, UsageDay[]][] {
  const weeks = new Map<LocalDate, UsageDay[]>();
  for (const day of activeDays(days)) {
    const key = isoWeekKey(day.date);
    const list = weeks.get(key);
    if (list) list.push(day);
    else weeks.set(key, [day]);
  }
  return [...weeks.entries()];
}

/**
 * The shown weekly streak: consecutive active weeks ending at the current week,
 * or at last week while the current week has no active day yet (an unfinished
 * week never breaks the streak).
 */
export function weeklyStreak(days: readonly UsageDay[], today: LocalDate): number {
  const active = new Set(byWeek(days).map(([week]) => week));
  let week = isoWeekKey(today);
  if (!active.has(week)) week = addDays(week, -7);
  let streak = 0;
  while (active.has(week)) {
    streak++;
    week = addDays(week, -7);
  }
  return streak;
}

/**
 * Lifetime streak milestones: entry `k − 1` is the date a run of `k` consecutive
 * active weeks was first complete — the first active day of the run's k-th
 * week. The array's length is the longest streak in the whole history.
 */
export function streakReached(days: readonly UsageDay[]): LocalDate[] {
  const reached: LocalDate[] = [];
  let run = 0;
  let previous: LocalDate | undefined;
  for (const [week, list] of byWeek(days)) {
    run = previous !== undefined && addDays(previous, 7) === week ? run + 1 : 1;
    previous = week;
    const first = list[0];
    if (first && run > reached.length) reached.push(first.date);
  }
  return reached;
}

/**
 * Lifetime per-week milestones: entry `k − 1` is the date some week first had
 * `k` active days. Weeks are disjoint and ascending, so the first week to reach
 * a count also reached it first.
 */
export function weekDaysReached(days: readonly UsageDay[]): LocalDate[] {
  const reached: LocalDate[] = [];
  for (const [, list] of byWeek(days)) {
    for (const day of list.slice(reached.length)) reached.push(day.date);
  }
  return reached;
}

/** The running total of a counter, and the date it first reached `target`. */
export function totalReaching(
  days: readonly UsageDay[],
  value: (day: UsageDay) => number,
  target: number,
): { total: number; reachedOn: LocalDate | undefined } {
  let total = 0;
  let reachedOn: LocalDate | undefined;
  for (const day of activeDays(days)) {
    total += value(day);
    if (reachedOn === undefined && total >= target) reachedOn = day.date;
  }
  return { total, reachedOn };
}

/** The kinds of activity a usage day can show. */
const KINDS: readonly ((day: UsageDay) => boolean)[] = [
  (d) => d.userMessages > 0,
  (d) => d.quizAnswers > 0,
  (d) => d.writingSaves > 0,
  (d) => d.codingRequests > 0,
  (d) => d.clozeSubmissions > 0,
];

/** How many kinds of activity {@link allKindsInAWeek} asks for. */
export const USAGE_KIND_COUNT = KINDS.length;

/**
 * All kinds of activity (chat, quiz, writing, coding, cloze) in one ISO week:
 * the date the first such week completed the set, and the most kinds any week
 * reached.
 */
export function allKindsInAWeek(days: readonly UsageDay[]): {
  qualifiedOn: LocalDate | undefined;
  best: number;
} {
  let best = 0;
  for (const [, list] of byWeek(days)) {
    const seen = new Set<number>();
    for (const day of list) {
      KINDS.forEach((kind, i) => {
        if (kind(day)) seen.add(i);
      });
      best = Math.max(best, seen.size);
      if (seen.size === KINDS.length) return { qualifiedOn: day.date, best };
    }
  }
  return { qualifiedOn: undefined, best };
}

/** Active-day count of the current ISO week. */
export function activeDaysThisWeek(days: readonly UsageDay[], today: LocalDate): number {
  const week = isoWeekKey(today);
  return activeDays(days).filter((d) => isoWeekKey(d.date) === week && d.date <= today).length;
}

/** Whether each of the last `n` weeks (oldest first, current week last) had an active day. */
export function recentWeeks(days: readonly UsageDay[], today: LocalDate, n: number): boolean[] {
  const active = new Set(byWeek(days).map(([week]) => week));
  const current = isoWeekKey(today);
  return Array.from({ length: n }, (_, i) => active.has(addDays(current, -7 * (n - 1 - i))));
}

/** Calendar intensity: 0 / 1 / 2–3 / 4+ active hours. */
export function heatLevel(activeHours: number): 0 | 1 | 2 | 3 {
  if (activeHours <= 0) return 0;
  if (activeHours === 1) return 1;
  if (activeHours <= 3) return 2;
  return 3;
}

export interface HeatCell {
  date: LocalDate;
  activeHours: number;
  level: 0 | 1 | 2 | 3;
  /** A day after today — not inactive, just not there yet. */
  future: boolean;
  today: boolean;
}

export interface Heatmap {
  /** The Monday of the first (oldest) week. */
  start: LocalDate;
  /** Column-major: week by week, Monday to Sunday — `HEATMAP_WEEKS × 7` cells. */
  cells: HeatCell[];
  /** Per week column, the month (0–11) when it starts a new month, else null. */
  monthStarts: (number | null)[];
}

/** The current ISO week and the 25 before it, one cell per Vienna-local day. */
export function heatmap(days: readonly UsageDay[], today: LocalDate): Heatmap {
  const hours = new Map(activeDays(days).map((d) => [d.date, d.activeHours]));
  const start = addDays(isoWeekKey(today), -7 * (HEATMAP_WEEKS - 1));
  const cells: HeatCell[] = [];
  for (let i = 0; i < HEATMAP_WEEKS * 7; i++) {
    const date = addDays(start, i);
    const future = date > today;
    const activeHours = future ? 0 : (hours.get(date) ?? 0);
    cells.push({
      date,
      activeHours,
      level: heatLevel(activeHours),
      future,
      today: date === today,
    });
  }
  const monthStarts: (number | null)[] = [];
  let lastMonth = -1;
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const month = monthOf(addDays(start, 7 * w));
    monthStarts.push(month === lastMonth ? null : month);
    lastMonth = month;
  }
  return { start, cells, monthStarts };
}

/** Whether a local date falls inside the heatmap window ending in today's week. */
export function inHeatmap(date: LocalDate, today: LocalDate): boolean {
  const start = addDays(isoWeekKey(today), -7 * (HEATMAP_WEEKS - 1));
  return date >= start && date <= today;
}
