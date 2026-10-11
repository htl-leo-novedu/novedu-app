import { describe, expect, it } from "vitest";
import {
  activeDaysThisWeek,
  allKindsInAWeek,
  HEATMAP_WEEKS,
  heatLevel,
  heatmap,
  inHeatmap,
  recentWeeks,
  streakReached,
  totalReaching,
  type UsageDay,
  weekDaysReached,
  weeklyStreak,
} from "./derive";

const day = (date: string, activeHours = 1, extra: Partial<UsageDay> = {}): UsageDay => ({
  date,
  activeHours,
  userMessages: 0,
  quizAnswers: 0,
  writingSaves: 0,
  codingRequests: 0,
  clozeSubmissions: 0,
  codingHours: 0,
  ...extra,
});

// Mondays of consecutive weeks (Sun 4 Oct 2026 is "today" below).
const TODAY = "2026-10-04"; // Sunday of the week starting Mon 28 Sep

describe("weeklyStreak (shown)", () => {
  it("counts consecutive active weeks ending at the current week", () => {
    const days = [day("2026-09-14"), day("2026-09-22"), day("2026-10-01")];
    expect(weeklyStreak(days, TODAY)).toBe(3);
  });

  it("an unfinished current week without activity does not break the streak", () => {
    const days = [day("2026-09-15"), day("2026-09-23")];
    expect(weeklyStreak(days, TODAY)).toBe(2);
  });

  it("a gap week breaks it", () => {
    const days = [day("2026-09-08"), day("2026-09-23"), day("2026-10-02")];
    expect(weeklyStreak(days, TODAY)).toBe(2);
  });

  it("is 0 when neither this week nor last week was active", () => {
    expect(weeklyStreak([day("2026-09-08")], TODAY)).toBe(0);
    expect(weeklyStreak([], TODAY)).toBe(0);
  });

  it("ignores days without an active hour", () => {
    expect(weeklyStreak([day("2026-10-01", 0)], TODAY)).toBe(0);
  });
});

describe("streakReached (lifetime, granted)", () => {
  it("names the first active day of the run's k-th week, and keeps the longest run after a break", () => {
    const days = [
      day("2026-01-07"), // week of 5 Jan
      day("2026-01-14"), // week of 12 Jan
      day("2026-01-15"),
      day("2026-01-21"), // week of 19 Jan → run of 3
      // break
      day("2026-09-30"), // a new run of 1
    ];
    expect(streakReached(days)).toEqual(["2026-01-07", "2026-01-14", "2026-01-21"]);
  });

  it("treats a week crossing New Year as one week", () => {
    const days = [day("2026-12-22"), day("2027-01-02"), day("2027-01-05")];
    expect(streakReached(days)).toEqual(["2026-12-22", "2027-01-02", "2027-01-05"]);
  });

  it("is empty without activity", () => {
    expect(streakReached([])).toEqual([]);
  });
});

describe("weekDaysReached", () => {
  it("names the day a week first reached k active days", () => {
    const days = [
      day("2026-09-01"),
      day("2026-09-02"), // week of 31 Aug: 2 days
      day("2026-09-07"),
      day("2026-09-09"),
      day("2026-09-11"), // week of 7 Sep: 3 days
    ];
    expect(weekDaysReached(days)).toEqual(["2026-09-01", "2026-09-02", "2026-09-11"]);
  });
});

describe("totalReaching", () => {
  it("returns the running total and the day it first reached the target", () => {
    const days = [
      day("2026-09-01", 1, { quizAnswers: 4 }),
      day("2026-09-03", 1, { quizAnswers: 6 }),
      day("2026-09-05", 1, { quizAnswers: 1 }),
    ];
    expect(totalReaching(days, (d) => d.quizAnswers, 10)).toEqual({
      total: 11,
      reachedOn: "2026-09-03",
    });
    expect(totalReaching(days, (d) => d.quizAnswers, 12)).toEqual({
      total: 11,
      reachedOn: undefined,
    });
  });

  it("sorts unordered input before accumulating", () => {
    const days = [
      day("2026-09-05", 1, { writingSaves: 5 }),
      day("2026-09-01", 1, { writingSaves: 1 }),
    ];
    expect(totalReaching(days, (d) => d.writingSaves, 5).reachedOn).toBe("2026-09-05");
  });
});

describe("current week and recent weeks", () => {
  it("counts this week's active days up to today", () => {
    const days = [day("2026-09-27"), day("2026-09-28"), day("2026-10-01")];
    expect(activeDaysThisWeek(days, TODAY)).toBe(2);
  });

  it("lists the last n weeks oldest first, the current week last", () => {
    const days = [day("2026-09-15"), day("2026-10-01")];
    expect(recentWeeks(days, TODAY, 4)).toEqual([false, true, false, true]);
  });
});

describe("heatmap", () => {
  it("buckets active hours as 0 / 1 / 2–3 / 4+", () => {
    expect([0, 1, 2, 3, 4, 9].map(heatLevel)).toEqual([0, 1, 2, 2, 3, 3]);
  });

  it("covers the current ISO week and the 25 before it, Monday-first, column-major", () => {
    const map = heatmap([day("2026-10-01", 3)], "2026-10-01"); // a Thursday
    expect(map.cells).toHaveLength(HEATMAP_WEEKS * 7);
    expect(map.start).toBe("2026-04-06");
    expect(map.cells[0]?.date).toBe("2026-04-06");
    expect(map.cells.at(-1)?.date).toBe("2026-10-04");

    const today = map.cells.find((c) => c.today);
    expect(today).toMatchObject({ date: "2026-10-01", activeHours: 3, level: 2, future: false });

    const future = map.cells.filter((c) => c.future).map((c) => c.date);
    expect(future).toEqual(["2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(map.cells.filter((c) => c.future).every((c) => c.level === 0)).toBe(true);
  });

  it("labels each week column that starts a new month", () => {
    const map = heatmap([], "2026-10-04");
    expect(map.monthStarts).toHaveLength(HEATMAP_WEEKS);
    expect(map.monthStarts[0]).toBe(3); // April
    expect(map.monthStarts.filter((m) => m !== null)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("inHeatmap bounds dates to the window up to today", () => {
    expect(inHeatmap("2026-04-06", "2026-10-04")).toBe(true);
    expect(inHeatmap("2026-04-05", "2026-10-04")).toBe(false);
    expect(inHeatmap("2026-10-05", "2026-10-04")).toBe(false);
  });
});

describe("allKindsInAWeek", () => {
  it("dates the first week that completed all five kinds, and reports the best week otherwise", () => {
    const days = [
      day("2026-09-07", 1, { userMessages: 1, quizAnswers: 1 }),
      day("2026-09-09", 1, { writingSaves: 1 }),
      // Next week: all five on one day.
      day("2026-09-15", 1, {
        userMessages: 1,
        quizAnswers: 1,
        writingSaves: 1,
        codingRequests: 1,
        clozeSubmissions: 1,
      }),
    ];
    expect(allKindsInAWeek(days)).toEqual({ qualifiedOn: "2026-09-15", best: 5 });
    expect(allKindsInAWeek(days.slice(0, 2))).toEqual({ qualifiedOn: undefined, best: 3 });
    expect(allKindsInAWeek([])).toEqual({ qualifiedOn: undefined, best: 0 });
  });

  it("a week crossing New Year is one week", () => {
    const days = [
      day("2026-12-30", 1, { userMessages: 1, quizAnswers: 1 }),
      day("2027-01-02", 1, { writingSaves: 1, codingRequests: 1, clozeSubmissions: 1 }),
    ];
    expect(allKindsInAWeek(days)).toEqual({ qualifiedOn: "2027-01-02", best: 5 });
  });
});
