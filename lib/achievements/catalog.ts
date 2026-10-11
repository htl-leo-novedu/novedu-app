// The achievement catalog (docs/home.md). Every rule is a pure, lifetime
// predicate over the user's facts: it either names the Vienna-local date on
// which its evidence was first complete, or reports progress. A stored grant
// stays earned whatever the current facts say.
//
// SERVER-ONLY: hidden achievements' names and criteria must never reach a client
// bundle — import this only from server modules (guard-tested in
// catalog.unit.test.ts). The page receives plain data built by lib/home-data.ts.

import {
  allKindsInAWeek,
  streakReached,
  totalReaching,
  USAGE_KIND_COUNT,
  type UsageDay,
  activeDays as usageActiveDays,
  weekDaysReached,
} from "./derive";
import {
  goldsReached,
  improvedOn,
  type QuizAttempt,
  quizSummaries,
  refreshedOn,
  resultsReached,
} from "./quiz";
import {
  busyReached,
  CROWD_MAX,
  crowdReached,
  EVERGREEN_WEEKS,
  HOMEWORK_MIN,
  homeworkReached,
  ITERATOR_VERSIONS,
  KIND_COUNT,
  kindsReached,
  LISTENER_REPORTS,
  type Reach,
  type TeacherFactGroup,
  type TeacherFacts,
  weeksReached,
} from "./teacher";
import type { LocalDate } from "./time";

/** A fact group: loaded by one statement, failing independently of the others. */
export const FACT_GROUPS = ["usage", "keys", "quiz", "reports"] as const;
export type FactGroup = (typeof FACT_GROUPS)[number];

/** A student's facts; a group is `undefined` when its load failed (never read as zero). */
export interface StudentFacts {
  usage: UsageDay[] | undefined;
  /** The Vienna-local dates the user's coding keys were issued, ascending. */
  keys: LocalDate[] | undefined;
  /** The user's saved quiz results. */
  quiz: QuizAttempt[] | undefined;
  /** The Vienna-local dates the user's own reports were resolved, ascending. */
  reports: LocalDate[] | undefined;
}

/** The groups of `facts` that loaded. */
export function availableGroups(facts: StudentFacts): Set<FactGroup> {
  const groups = new Set<FactGroup>();
  if (facts.usage) groups.add("usage");
  if (facts.keys) groups.add("keys");
  if (facts.quiz) groups.add("quiz");
  if (facts.reports) groups.add("reports");
  return groups;
}

/** Keys into the page's badge icon set (app/_home/badge-disc.tsx). */
export type BadgeIcon =
  | "flame"
  | "calendar"
  | "check"
  | "pen"
  | "key"
  | "send"
  | "code"
  | "tool"
  | "layers"
  | "zap"
  | "award"
  | "star"
  | "trend"
  | "rotate"
  | "bug"
  | "share"
  | "users"
  | "activity"
  | "moon"
  | "inbox";

export type Outcome =
  | { earned: true; qualifiedOn: LocalDate }
  | { earned: false; current: number; target: number };

export interface Achievement<F, G extends string = FactGroup> {
  /** Stable and stored. Never contains a code; a tier ladder is `<ladder>-<n>`. */
  id: string;
  audience: "student" | "teacher";
  /** Grouping on the page; see FAMILIES. */
  family: string;
  /** Position within the family. */
  order: number;
  icon: BadgeIcon;
  name: string;
  /** One line, shown for listed achievements. */
  criterion: string;
  /** Not listed until earned (students only). */
  hidden: boolean;
  /** 0 for teacher achievements: teachers have no XP. */
  xp: number;
  /** The fact groups the rule reads; evaluated only when all are available. */
  needs: readonly G[];
  evaluate(facts: F): Outcome;
}

export type StudentAchievement = Achievement<StudentFacts>;
export type TeacherAchievement = Achievement<TeacherFacts, TeacherFactGroup>;

/** The student families, in page order. */
export const STUDENT_FAMILIES = [
  { id: "rhythm", label: "Rhythm" },
  { id: "practice", label: "Practice" },
  { id: "quiz", label: "Quiz mastery" },
  { id: "coding", label: "Coding" },
  { id: "secret", label: "Secret" },
] as const;

/** The teacher families, in page order. */
export const TEACHER_FAMILIES = [
  { id: "reach", label: "Reach" },
  { id: "authoring", label: "Authoring" },
] as const;

/** Reads a group the evaluator has already checked; reaching it unavailable is a bug. */
function need<T>(group: T | undefined, name: string): T {
  if (group === undefined)
    throw new Error(`achievement rule read the unavailable fact group "${name}"`);
  return group;
}

// Derived usage facts are computed once per usage array, not once per rule.
interface UsageStats {
  streaks: LocalDate[];
  weekDays: LocalDate[];
  activeDates: LocalDate[];
  codingDates: LocalDate[];
}
const statsCache = new WeakMap<UsageDay[], UsageStats>();
function usageStats(usage: UsageDay[]): UsageStats {
  let stats = statsCache.get(usage);
  if (!stats) {
    stats = {
      streaks: streakReached(usage),
      weekDays: weekDaysReached(usage),
      activeDates: usageActiveDays(usage).map((d) => d.date),
      codingDates: usageActiveDays(usage)
        .filter((d) => d.codingRequests > 0)
        .map((d) => d.date),
    };
    statsCache.set(usage, stats);
  }
  return stats;
}

// Derived quiz facts, likewise once per attempts array.
interface QuizStats {
  results: LocalDate[];
  golds: LocalDate[];
  improved: LocalDate | undefined;
  refreshed: LocalDate | undefined;
}
const quizStatsCache = new WeakMap<QuizAttempt[], QuizStats>();
function quizStats(attempts: QuizAttempt[]): QuizStats {
  let stats = quizStatsCache.get(attempts);
  if (!stats) {
    const quizzes = quizSummaries(attempts);
    stats = {
      results: resultsReached(attempts),
      golds: goldsReached(quizzes),
      improved: improvedOn(quizzes),
      refreshed: refreshedOn(quizzes),
    };
    quizStatsCache.set(attempts, stats);
  }
  return stats;
}

/** A one-off earned on the first date of a "first reached" check. */
function once(date: LocalDate | undefined): Outcome {
  return date !== undefined
    ? { earned: true, qualifiedOn: date }
    : { earned: false, current: 0, target: 1 };
}

/** A tier earned when the k-th milestone of a "first reached" list exists. */
function milestone(reached: LocalDate[], target: number): Outcome {
  const qualifiedOn = reached[target - 1];
  return qualifiedOn !== undefined
    ? { earned: true, qualifiedOn }
    : { earned: false, current: reached.length, target };
}

function counter(usage: UsageDay[], value: (d: UsageDay) => number, target: number): Outcome {
  const { total, reachedOn } = totalReaching(usage, value, target);
  return reachedOn !== undefined
    ? { earned: true, qualifiedOn: reachedOn }
    : { earned: false, current: total, target };
}

interface Tier {
  n: number;
  name: string;
  xp: number;
}

function ladder<F, G extends string>(
  base: Omit<Achievement<F, G>, "id" | "order" | "name" | "criterion" | "xp" | "evaluate">,
  ladderId: string,
  firstOrder: number,
  tiers: Tier[],
  criterion: (n: number) => string,
  rule: (facts: F, n: number) => Outcome,
): Achievement<F, G>[] {
  return tiers.map((tier, i) => ({
    ...base,
    id: `${ladderId}-${tier.n}`,
    order: firstOrder + i,
    name: tier.name,
    criterion: criterion(tier.n),
    xp: tier.xp,
    evaluate: (facts) => rule(facts, tier.n),
  }));
}

const studentLadder = ladder<StudentFacts, FactGroup>;
const teacherLadder = ladder<TeacherFacts, TeacherFactGroup>;

/** A ladder rule over the usage group. */
const onUsage =
  (rule: (usage: UsageDay[], n: number) => Outcome) =>
  (facts: StudentFacts, n: number): Outcome =>
    rule(need(facts.usage, "usage"), n);

/** A rule over one day's value: the first day reaching `target`, else the best day. */
function bestDay(usage: UsageDay[], value: (d: UsageDay) => number, target: number): Outcome {
  let best = 0;
  for (const day of usageActiveDays(usage)) {
    if (value(day) >= target) return { earned: true, qualifiedOn: day.date };
    best = Math.max(best, value(day));
  }
  return { earned: false, current: best, target };
}

const rhythm = { audience: "student", family: "rhythm", hidden: false, needs: ["usage"] } as const;
const practice = {
  audience: "student",
  family: "practice",
  hidden: false,
  needs: ["usage"],
} as const;
const coding = { audience: "student", family: "coding", hidden: false } as const;
const quiz = { audience: "student", family: "quiz", hidden: false, needs: ["quiz"] } as const;
// Hidden until earned: never listed, never in Almost there, and their names stay
// on the server until the grant exists.
const secret = { audience: "student", family: "secret", hidden: true } as const;

/** Every student achievement, in page order. */
export const STUDENT_CATALOG: readonly StudentAchievement[] = [
  ...studentLadder(
    { ...rhythm, icon: "flame" },
    "weekly-streak",
    0,
    [
      { n: 2, name: "Two in a Row", xp: 20 },
      { n: 4, name: "Four Weeks Strong", xp: 50 },
      { n: 8, name: "Eight-Week Run", xp: 100 },
      { n: 16, name: "A Whole Season", xp: 200 },
    ],
    (n) => `Active ${n} weeks in a row`,
    onUsage((usage, n) => milestone(usageStats(usage).streaks, n)),
  ),
  ...studentLadder(
    { ...rhythm, icon: "calendar" },
    "week-days",
    10,
    [
      { n: 3, name: "Three-Day Week", xp: 20 },
      { n: 5, name: "Five-Day Week", xp: 50 },
    ],
    (n) => `Active on ${n} days of one week`,
    onUsage((usage, n) => milestone(usageStats(usage).weekDays, n)),
  ),
  ...studentLadder(
    { ...rhythm, icon: "calendar" },
    "active-days",
    20,
    [
      { n: 10, name: "Ten Days In", xp: 20 },
      { n: 30, name: "Thirty Days In", xp: 50 },
      { n: 100, name: "A Hundred Days", xp: 100 },
    ],
    (n) => `${n} active days`,
    onUsage((usage, n) => milestone(usageStats(usage).activeDates, n)),
  ),
  ...studentLadder(
    { ...practice, icon: "check" },
    "quiz-answers",
    0,
    [
      { n: 10, name: "First Ten Answers", xp: 20 },
      { n: 100, name: "A Hundred Answers", xp: 50 },
      { n: 500, name: "Answer Machine", xp: 100 },
    ],
    (n) => `Submit ${n} quiz answers`,
    onUsage((usage, n) => counter(usage, (d) => d.quizAnswers, n)),
  ),
  ...studentLadder(
    { ...practice, icon: "pen" },
    "writing-saves",
    10,
    [
      { n: 5, name: "First Drafts", xp: 20 },
      { n: 25, name: "Rewriter", xp: 50 },
      { n: 100, name: "Hundred Saves", xp: 100 },
    ],
    (n) => `Save your writing ${n} times`,
    onUsage((usage, n) => counter(usage, (d) => d.writingSaves, n)),
  ),
  {
    ...quiz,
    id: "quiz-first-result",
    order: 0,
    icon: "award",
    name: "First Result",
    criterion: "Save a quiz or exercise result",
    xp: 20,
    evaluate: (facts) => milestone(quizStats(need(facts.quiz, "quiz")).results, 1),
  },
  ...studentLadder(
    { ...quiz, icon: "star" },
    "quiz-golds",
    10,
    [
      { n: 1, name: "Gold", xp: 50 },
      { n: 3, name: "Three Golds", xp: 50 },
      { n: 10, name: "Ten Golds", xp: 100 },
    ],
    (n) =>
      n === 1
        ? "Every answer of a quiz or exercise fully correct"
        : `Gold in ${n} different quizzes or exercises`,
    (facts, n) => milestone(quizStats(need(facts.quiz, "quiz")).golds, n),
  ),
  {
    ...quiz,
    id: "quiz-improved",
    order: 20,
    icon: "trend",
    name: "Improved",
    criterion: "Beat your best score on a retake",
    xp: 50,
    evaluate: (facts) => once(quizStats(need(facts.quiz, "quiz")).improved),
  },
  {
    ...quiz,
    id: "quiz-refreshed",
    order: 21,
    icon: "rotate",
    name: "Refreshed",
    criterion: "Retake a quiz or exercise 5 or more days later",
    xp: 50,
    evaluate: (facts) => once(quizStats(need(facts.quiz, "quiz")).refreshed),
  },
  {
    ...coding,
    id: "coding-connected",
    order: 0,
    icon: "key",
    name: "Connected",
    criterion: "Get your first coding key",
    xp: 20,
    needs: ["keys"],
    evaluate: (facts) => milestone(need(facts.keys, "keys"), 1),
  },
  {
    ...coding,
    id: "coding-first-request",
    order: 1,
    icon: "send",
    name: "First Request",
    criterion: "Send a first request from your editor",
    xp: 20,
    needs: ["usage"],
    evaluate: (facts) => milestone(usageStats(need(facts.usage, "usage")).codingDates, 1),
  },
  ...studentLadder(
    { ...coding, icon: "code", needs: ["usage"] },
    "coding-days",
    10,
    [
      { n: 5, name: "Five Coding Days", xp: 50 },
      { n: 20, name: "Twenty Coding Days", xp: 100 },
    ],
    (n) => `Code with Novedu on ${n} days`,
    onUsage((usage, n) => milestone(usageStats(usage).codingDates, n)),
  ),
  {
    ...coding,
    id: "coding-toolbelt",
    order: 20,
    icon: "tool",
    name: "Toolbelt",
    criterion: "Join 3 coding activities",
    xp: 50,
    needs: ["keys"],
    evaluate: (facts) => milestone(need(facts.keys, "keys"), 3),
  },
  {
    ...secret,
    id: "full-stack",
    order: 0,
    icon: "layers",
    name: "Full Stack",
    criterion: "Chat, quiz, writing, coding and cloze in one week",
    xp: 100,
    needs: ["usage"],
    evaluate: (facts) => {
      const { qualifiedOn, best } = allKindsInAWeek(need(facts.usage, "usage"));
      return qualifiedOn !== undefined
        ? { earned: true, qualifiedOn }
        : { earned: false, current: best, target: USAGE_KIND_COUNT };
    },
  },
  {
    ...secret,
    id: "in-the-zone",
    order: 1,
    icon: "zap",
    name: "In the Zone",
    criterion: "Code in 3 different hours of one day",
    xp: 50,
    needs: ["usage"],
    evaluate: (facts) => bestDay(need(facts.usage, "usage"), (d) => d.codingHours, 3),
  },
  {
    ...secret,
    id: "bug-hunter",
    order: 2,
    icon: "bug",
    name: "Bug Hunter",
    criterion: "A problem you reported was fixed",
    xp: 50,
    needs: ["reports"],
    evaluate: (facts) => milestone(need(facts.reports, "reports"), 1),
  },
];

// ---------------------------------------------------------------------------
// Teacher achievements: no XP, none hidden. Every rule reads the teacher's OWN
// codes' facts and names the local date its evidence was first complete.

/** A reach (lib/achievements/teacher.ts) as an outcome toward `target`. */
function reached({ reachedOn, best }: Reach, target: number): Outcome {
  return reachedOn !== undefined
    ? { earned: true, qualifiedOn: reachedOn }
    : { earned: false, current: best, target };
}

const reach = { audience: "teacher", family: "reach", hidden: false, xp: 0 } as const;
const authoring = { audience: "teacher", family: "authoring", hidden: false, xp: 0 } as const;

/** Every teacher achievement, in page order. */
export const TEACHER_CATALOG: readonly TeacherAchievement[] = [
  {
    ...reach,
    id: "first-code",
    order: 0,
    icon: "share",
    name: "First Code",
    criterion: "Share your first activity",
    needs: ["codes"],
    evaluate: (facts) => milestone(kindsReached(need(facts.codes, "codes")), 1),
  },
  {
    ...reach,
    id: "full-toolkit",
    order: 1,
    icon: "layers",
    name: "Full Toolkit",
    criterion: "Share a tutor, a quiz, a writing, a coding and a cloze activity",
    needs: ["codes"],
    evaluate: (facts) => milestone(kindsReached(need(facts.codes, "codes")), KIND_COUNT),
  },
  ...teacherLadder(
    { ...reach, icon: "users", needs: ["students"] },
    "crowd",
    10,
    [
      { n: 10, name: "Small Crowd", xp: 0 },
      { n: 30, name: "Full Class", xp: 0 },
      { n: CROWD_MAX, name: "Packed House", xp: 0 },
    ],
    (n) => `${n} identified students on one activity`,
    (facts, n) => reached(crowdReached(need(facts.students, "students"), n), n),
  ),
  ...teacherLadder(
    { ...reach, icon: "activity", needs: ["usage"] },
    "busy",
    20,
    [
      { n: 100, name: "Busy", xp: 0 },
      { n: 1000, name: "Buzzing", xp: 0 },
      { n: 5000, name: "Hive of Activity", xp: 0 },
    ],
    (n) => `${n.toLocaleString("en")} interactions on one activity`,
    (facts, n) => reached(busyReached(need(facts.usage, "usage"), n), n),
  ),
  {
    ...authoring,
    id: "evergreen",
    order: 0,
    icon: "calendar",
    name: "Evergreen",
    criterion: `One activity used in ${EVERGREEN_WEEKS} different weeks`,
    needs: ["usage"],
    evaluate: (facts) =>
      reached(weeksReached(need(facts.usage, "usage"), EVERGREEN_WEEKS), EVERGREEN_WEEKS),
  },
  {
    ...authoring,
    id: "iterator",
    order: 1,
    icon: "pen",
    name: "Iterator",
    criterion: `Write ${ITERATOR_VERSIONS} versions of one file`,
    needs: ["files"],
    evaluate: (facts) => {
      const files = need(facts.files, "files");
      return reached({ reachedOn: files.reachedOn, best: files.most }, ITERATOR_VERSIONS);
    },
  },
  {
    ...authoring,
    id: "listener",
    order: 2,
    icon: "inbox",
    name: "Listener",
    criterion: `Resolve ${LISTENER_REPORTS} reports`,
    needs: ["reports"],
    evaluate: (facts) => {
      const reports = need(facts.reports, "reports");
      return reached(
        { reachedOn: reports.resolvedOn[LISTENER_REPORTS - 1], best: reports.resolved },
        LISTENER_REPORTS,
      );
    },
  },
  {
    ...authoring,
    id: "homework-hit",
    order: 3,
    icon: "moon",
    name: "Homework Hit",
    criterion: `Half of one activity's interactions outside school hours (at least ${HOMEWORK_MIN})`,
    needs: ["usage"],
    evaluate: (facts) => reached(homeworkReached(need(facts.usage, "usage")), 1),
  },
];

/** The ladder an id belongs to (`weekly-streak-4` → `weekly-streak`); a one-off is its own ladder. */
export function ladderOf(id: string): string {
  return id.replace(/-\d+$/, "");
}
