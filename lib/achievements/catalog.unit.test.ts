import { describe, expect, it } from "vitest";
import {
  importSpecifiers,
  readModule,
  resolveImport,
  sourceFiles,
  walkClosure,
} from "@/tests/import-graph";
import {
  STUDENT_CATALOG,
  type StudentAchievement,
  TEACHER_CATALOG,
  TEACHER_FAMILIES,
  type TeacherAchievement,
} from "./catalog";
import type { UsageDay } from "./derive";
import type { QuizAttempt } from "./quiz";
import type { CodeDay, TeacherCode, TeacherFacts } from "./teacher";

const day = (date: string, extra: Partial<UsageDay> = {}): UsageDay => ({
  date,
  activeHours: 1,
  userMessages: 0,
  quizAnswers: 0,
  writingSaves: 0,
  codingRequests: 0,
  clozeSubmissions: 0,
  codingHours: 0,
  ...extra,
});

function rule(id: string): StudentAchievement {
  const achievement = STUDENT_CATALOG.find((a) => a.id === id);
  if (!achievement) throw new Error(`no catalog entry ${id}`);
  return achievement;
}

const run = (id: string, usage: UsageDay[]) =>
  rule(id).evaluate({ usage, keys: [], quiz: [], reports: [] });
const runKeys = (id: string, keys: string[]) =>
  rule(id).evaluate({ usage: [], keys, quiz: [], reports: [] });

/** Consecutive Mondays starting at `first`, one active day each. */
function weeks(first: string, n: number): UsageDay[] {
  const start = Date.UTC(
    Number(first.slice(0, 4)),
    Number(first.slice(5, 7)) - 1,
    Number(first.slice(8, 10)),
  );
  return Array.from({ length: n }, (_, i) =>
    day(new Date(start + i * 7 * 86_400_000).toISOString().slice(0, 10)),
  );
}

/** `n` consecutive days starting at `first`. */
function consecutiveDays(first: string, n: number, extra: Partial<UsageDay> = {}): UsageDay[] {
  const start = Date.UTC(
    Number(first.slice(0, 4)),
    Number(first.slice(5, 7)) - 1,
    Number(first.slice(8, 10)),
  );
  return Array.from({ length: n }, (_, i) =>
    day(new Date(start + i * 86_400_000).toISOString().slice(0, 10), extra),
  );
}

describe("catalog shape", () => {
  it("has unique ids that fit the column, contain no code and follow the ladder pattern", () => {
    const ids = STUDENT_CATALOG.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(64);
      expect(id).toMatch(/^[a-z]+(-[a-z]+)*(-\d+)?$/);
    }
  });

  it("ships the Rhythm, Practice, Quiz mastery, Coding and Secret families, all for students", () => {
    expect(new Set(STUDENT_CATALOG.map((a) => a.family))).toEqual(
      new Set(["rhythm", "practice", "quiz", "coding", "secret"]),
    );
    expect(STUDENT_CATALOG.every((a) => a.audience === "student")).toBe(true);
    expect(STUDENT_CATALOG.every((a) => a.needs.length === 1)).toBe(true);
    expect(
      STUDENT_CATALOG.filter((a) => a.needs[0] === "keys")
        .map((a) => a.id)
        .sort(),
    ).toEqual(["coding-connected", "coding-toolbelt"]);
    expect(
      STUDENT_CATALOG.filter((a) => a.family === "quiz").every((a) => a.needs[0] === "quiz"),
    ).toBe(true);
    expect(STUDENT_CATALOG.filter((a) => a.needs[0] === "reports").map((a) => a.id)).toEqual([
      "bug-hunter",
    ]);
  });

  it("hides exactly the Secret family", () => {
    expect(STUDENT_CATALOG.filter((a) => a.hidden).map((a) => a.id)).toEqual([
      "full-stack",
      "in-the-zone",
      "bug-hunter",
    ]);
    expect(STUDENT_CATALOG.every((a) => a.hidden === (a.family === "secret"))).toBe(true);
  });

  it("has no chat-message tiers and no time-of-day badges", () => {
    expect(STUDENT_CATALOG.some((a) => /message|night|early/i.test(a.id))).toBe(false);
  });

  it("ids are literal: the source spells every ladder name, no interpolation from facts", () => {
    const source = readModule("lib/achievements/catalog.ts");
    for (const ladder of [
      "weekly-streak",
      "week-days",
      "active-days",
      "quiz-answers",
      "writing-saves",
      "quiz-golds",
      "coding-days",
    ]) {
      expect(source).toContain(`"${ladder}"`);
    }
  });
});

describe("Rhythm rules", () => {
  it("weekly streak tiers: below, at and above the threshold, dated to the k-th week", () => {
    expect(run("weekly-streak-2", weeks("2026-09-07", 1))).toEqual({
      earned: false,
      current: 1,
      target: 2,
    });
    expect(run("weekly-streak-2", weeks("2026-09-07", 2))).toEqual({
      earned: true,
      qualifiedOn: "2026-09-14",
    });
    expect(run("weekly-streak-4", weeks("2026-09-07", 5))).toEqual({
      earned: true,
      qualifiedOn: "2026-09-28",
    });
  });

  it("a streak reached before a break stays earned (lifetime predicate)", () => {
    const usage = [...weeks("2026-01-05", 4), day("2026-09-30")];
    expect(run("weekly-streak-4", usage)).toEqual({ earned: true, qualifiedOn: "2026-01-26" });
    expect(run("weekly-streak-8", usage)).toEqual({ earned: false, current: 4, target: 8 });
  });

  it("days in one week", () => {
    const usage = consecutiveDays("2026-09-07", 3); // Mon–Wed
    expect(run("week-days-3", usage)).toEqual({ earned: true, qualifiedOn: "2026-09-09" });
    expect(run("week-days-5", usage)).toEqual({ earned: false, current: 3, target: 5 });
  });

  it("active days in total", () => {
    expect(run("active-days-10", consecutiveDays("2026-09-01", 9))).toEqual({
      earned: false,
      current: 9,
      target: 10,
    });
    expect(run("active-days-10", consecutiveDays("2026-09-01", 10))).toEqual({
      earned: true,
      qualifiedOn: "2026-09-10",
    });
    expect(run("active-days-10", consecutiveDays("2026-09-01", 11))).toEqual({
      earned: true,
      qualifiedOn: "2026-09-10",
    });
  });
});

describe("Practice rules", () => {
  it("quiz answers: dated to the day the running total crossed the tier", () => {
    const usage = [day("2026-09-01", { quizAnswers: 9 }), day("2026-09-02", { quizAnswers: 1 })];
    expect(run("quiz-answers-10", usage)).toEqual({ earned: true, qualifiedOn: "2026-09-02" });
    expect(run("quiz-answers-100", usage)).toEqual({ earned: false, current: 10, target: 100 });
    expect(run("quiz-answers-10", [day("2026-09-01", { quizAnswers: 9 })])).toEqual({
      earned: false,
      current: 9,
      target: 10,
    });
  });

  it("writing saves", () => {
    const usage = [day("2026-09-01", { writingSaves: 7 })];
    expect(run("writing-saves-5", usage)).toEqual({ earned: true, qualifiedOn: "2026-09-01" });
    expect(run("writing-saves-25", usage)).toEqual({ earned: false, current: 7, target: 25 });
  });
});

describe("Coding rules", () => {
  const coded = (date: string, hours = 1) =>
    day(date, { codingRequests: hours * 2, codingHours: hours });

  it("Connected and Toolbelt: dated to the first and third key's issue day", () => {
    expect(runKeys("coding-connected", [])).toEqual({ earned: false, current: 0, target: 1 });
    expect(runKeys("coding-connected", ["2026-09-02"])).toEqual({
      earned: true,
      qualifiedOn: "2026-09-02",
    });
    expect(runKeys("coding-toolbelt", ["2026-09-02", "2026-09-05"])).toEqual({
      earned: false,
      current: 2,
      target: 3,
    });
    const three = ["2026-09-02", "2026-09-05", "2026-09-09"];
    expect(runKeys("coding-toolbelt", three)).toEqual({ earned: true, qualifiedOn: "2026-09-09" });
    expect(runKeys("coding-toolbelt", [...three, "2026-09-20"])).toEqual({
      earned: true,
      qualifiedOn: "2026-09-09",
    });
  });

  it("First Request: the first day with a coding request, not any active day", () => {
    const usage = [day("2026-09-01", { quizAnswers: 3 }), coded("2026-09-04")];
    expect(run("coding-first-request", usage)).toEqual({ earned: true, qualifiedOn: "2026-09-04" });
    expect(run("coding-first-request", [day("2026-09-01")])).toEqual({
      earned: false,
      current: 0,
      target: 1,
    });
  });

  it("coding days: below, at and above the threshold", () => {
    const four = ["2026-09-01", "2026-09-02", "2026-09-08", "2026-09-09"].map((d) => coded(d));
    expect(run("coding-days-5", four)).toEqual({ earned: false, current: 4, target: 5 });
    const five = [...four, coded("2026-09-15")];
    expect(run("coding-days-5", five)).toEqual({ earned: true, qualifiedOn: "2026-09-15" });
    expect(run("coding-days-5", [...five, coded("2026-09-16")])).toEqual({
      earned: true,
      qualifiedOn: "2026-09-15",
    });
  });
});

describe("Secret rules", () => {
  it("Full Stack: chat, quiz, writing, coding and cloze inside ONE ISO week", () => {
    // Mon 7 – Sun 13 Sep: chat Mon, quiz Tue, cloze Thu, writing Sat, coding Sun → dated Sunday.
    const week = [
      day("2026-09-07", { userMessages: 2 }),
      day("2026-09-08", { quizAnswers: 1 }),
      day("2026-09-10", { clozeSubmissions: 1 }),
      day("2026-09-12", { writingSaves: 1 }),
      day("2026-09-13", { codingRequests: 1, codingHours: 1 }),
    ];
    expect(run("full-stack", week)).toEqual({ earned: true, qualifiedOn: "2026-09-13" });
    // The same five kinds spread over two weeks never count.
    const split = [...week.slice(0, 4), day("2026-09-14", { codingRequests: 1, codingHours: 1 })];
    expect(run("full-stack", split)).toEqual({ earned: false, current: 4, target: 5 });
  });

  it("In the Zone: coding in 3 different local hours of one day", () => {
    expect(run("in-the-zone", [day("2026-09-01", { codingRequests: 9, codingHours: 2 })])).toEqual({
      earned: false,
      current: 2,
      target: 3,
    });
    const usage = [
      day("2026-09-01", { codingRequests: 9, codingHours: 2 }),
      day("2026-09-03", { codingRequests: 3, codingHours: 3 }),
      day("2026-09-04", { codingRequests: 3, codingHours: 5 }),
    ];
    expect(run("in-the-zone", usage)).toEqual({ earned: true, qualifiedOn: "2026-09-03" });
  });
});

describe("Quiz mastery rules", () => {
  let seq = 0;
  const result = (code: string, date: string, correct: number, total: number): QuizAttempt => {
    seq += 1;
    return {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      code,
      correct,
      partial: 0,
      incorrect: total - correct,
      unanswered: 0,
      total,
      finishedAt: new Date(`${date}T10:00:00Z`),
      finishedOn: date,
      note: "",
      open: true,
    };
  };
  const runQuiz = (id: string, quiz: QuizAttempt[]) =>
    rule(id).evaluate({ usage: [], keys: [], quiz, reports: [] });

  it("First Result: the first saved result's day", () => {
    expect(runQuiz("quiz-first-result", [])).toEqual({ earned: false, current: 0, target: 1 });
    expect(
      runQuiz("quiz-first-result", [
        result("b", "2026-09-05", 0, 2),
        result("a", "2026-09-02", 0, 2),
      ]),
    ).toEqual({ earned: true, qualifiedOn: "2026-09-02" });
  });

  it("golds: 1 / 3 / 10 distinct quizzes, below, at and above", () => {
    const golds = ["a", "b", "c", "d"].map((code, i) => result(code, `2026-09-0${i + 1}`, 3, 3));
    expect(runQuiz("quiz-golds-1", [result("a", "2026-09-01", 2, 3)])).toEqual({
      earned: false,
      current: 0,
      target: 1,
    });
    expect(runQuiz("quiz-golds-1", golds)).toEqual({ earned: true, qualifiedOn: "2026-09-01" });
    expect(runQuiz("quiz-golds-3", golds.slice(0, 2))).toEqual({
      earned: false,
      current: 2,
      target: 3,
    });
    expect(runQuiz("quiz-golds-3", golds)).toEqual({ earned: true, qualifiedOn: "2026-09-03" });
    expect(runQuiz("quiz-golds-10", golds)).toEqual({ earned: false, current: 4, target: 10 });
  });

  it("Improved and Refreshed: one-offs dated to the qualifying attempt", () => {
    const attempts = [
      result("q", "2026-09-01", 1, 4),
      result("q", "2026-09-03", 3, 4),
      result("q", "2026-09-10", 2, 4),
    ];
    expect(runQuiz("quiz-improved", attempts)).toEqual({ earned: true, qualifiedOn: "2026-09-03" });
    expect(runQuiz("quiz-refreshed", attempts)).toEqual({
      earned: true,
      qualifiedOn: "2026-09-10",
    });
    expect(runQuiz("quiz-refreshed", attempts.slice(0, 2))).toEqual({
      earned: false,
      current: 0,
      target: 1,
    });
  });

  it("Bug Hunter: the day an own report was first resolved", () => {
    const runReports = (reports: string[]) =>
      rule("bug-hunter").evaluate({ usage: [], keys: [], quiz: [], reports });
    expect(runReports([])).toEqual({ earned: false, current: 0, target: 1 });
    expect(runReports(["2026-09-12", "2026-09-20"])).toEqual({
      earned: true,
      qualifiedOn: "2026-09-12",
    });
  });
});

// ---------------------------------------------------------------------------
// Teacher achievements

function teacherRule(id: string): TeacherAchievement {
  const achievement = TEACHER_CATALOG.find((a) => a.id === id);
  if (!achievement) throw new Error(`no teacher catalog entry ${id}`);
  return achievement;
}

const EMPTY: Required<TeacherFacts> = {
  codes: [],
  usage: [],
  conversations: 0,
  students: { total: 0, perCode: [] },
  reports: { open: [], resolved: 0, resolvedOn: [] },
  files: { most: 0 },
};
const runTeacher = (id: string, facts: TeacherFacts) =>
  teacherRule(id).evaluate({ ...EMPTY, ...facts });

const teacherCode = (
  code: string,
  module: TeacherCode["module"],
  created: string,
): TeacherCode => ({
  code,
  module,
  note: "",
  validFrom: null,
  validUntil: null,
  createdAt: new Date(`${created}T10:00:00Z`),
});

const codeDay = (code: string, date: string, extra: Partial<CodeDay> = {}): CodeDay => ({
  code,
  date,
  interactions: 0,
  outsideSchool: 0,
  quizAnswers: 0,
  inputTokens: 0,
  outputTokens: 0,
  ...extra,
});

/** `n` consecutive local dates from `first`. */
function dates(first: string, n: number): string[] {
  return consecutiveDays(first, n).map((d) => d.date);
}

describe("teacher catalog shape", () => {
  it("has unique literal ids that fit the column and never collide with a student id", () => {
    const ids = TEACHER_CATALOG.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(64);
      expect(id).toMatch(/^[a-z]+(-[a-z]+)*(-\d+)?$/);
    }
    const studentIds = new Set(STUDENT_CATALOG.map((a) => a.id));
    expect(ids.filter((id) => studentIds.has(id))).toEqual([]);
    const source = readModule("lib/achievements/catalog.ts");
    for (const ladder of ["crowd", "busy"]) expect(source).toContain(`"${ladder}"`);
  });

  it("ships Reach and Authoring for teachers: no XP, none hidden, one fact group each", () => {
    expect(TEACHER_FAMILIES.map((f) => f.id)).toEqual(["reach", "authoring"]);
    expect(TEACHER_CATALOG.every((a) => a.audience === "teacher")).toBe(true);
    expect(TEACHER_CATALOG.every((a) => a.xp === 0 && !a.hidden)).toBe(true);
    expect(TEACHER_CATALOG.every((a) => a.needs.length === 1)).toBe(true);
    expect(TEACHER_CATALOG.map((a) => a.id)).toEqual([
      "first-code",
      "full-toolkit",
      "crowd-10",
      "crowd-30",
      "crowd-100",
      "busy-100",
      "busy-1000",
      "busy-5000",
      "evergreen",
      "iterator",
      "listener",
      "homework-hit",
    ]);
  });
});

describe("Reach rules", () => {
  it("First Code: the day the first code was created", () => {
    expect(runTeacher("first-code", {})).toEqual({ earned: false, current: 0, target: 1 });
    expect(
      runTeacher("first-code", {
        codes: [teacherCode("B", "quiz", "2026-09-12"), teacherCode("A", "tutor", "2026-09-10")],
      }),
    ).toEqual({ earned: true, qualifiedOn: "2026-09-10" });
  });

  it("Full Toolkit: dated to the day the fifth kind was first shared", () => {
    const three = [
      teacherCode("A", "tutor", "2026-09-01"),
      teacherCode("B", "quiz", "2026-09-02"),
      teacherCode("C", "quiz", "2026-09-03"),
      teacherCode("D", "writing", "2026-09-04"),
    ];
    expect(runTeacher("full-toolkit", { codes: three })).toEqual({
      earned: false,
      current: 3,
      target: 5,
    });
    const four = [...three, teacherCode("E", "coding", "2026-09-20")];
    expect(runTeacher("full-toolkit", { codes: four })).toEqual({
      earned: false,
      current: 4,
      target: 5,
    });
    expect(
      runTeacher("full-toolkit", { codes: [...four, teacherCode("F", "cloze", "2026-09-25")] }),
    ).toEqual({ earned: true, qualifiedOn: "2026-09-25" });
  });

  it("Crowd: below, at and above the tier on one activity, dated to the n-th student", () => {
    const students = (count: number) => ({
      total: count,
      perCode: [{ code: "A", count, firstSeen: dates("2026-09-01", Math.min(count, 100)) }],
    });
    expect(runTeacher("crowd-10", { students: students(9) })).toEqual({
      earned: false,
      current: 9,
      target: 10,
    });
    expect(runTeacher("crowd-10", { students: students(10) })).toEqual({
      earned: true,
      qualifiedOn: "2026-09-10",
    });
    expect(runTeacher("crowd-30", { students: students(31) })).toEqual({
      earned: true,
      qualifiedOn: "2026-09-30",
    });
    // Beyond the stored first 100 dates, the 100th is still known.
    expect(runTeacher("crowd-100", { students: students(250) })).toMatchObject({ earned: true });
  });

  it("Busy: the running total of one activity, dated to the crossing day", () => {
    const usage = [
      codeDay("A", "2026-09-01", { interactions: 600 }),
      codeDay("A", "2026-09-08", { interactions: 400 }),
    ];
    expect(runTeacher("busy-100", { usage })).toEqual({ earned: true, qualifiedOn: "2026-09-01" });
    expect(runTeacher("busy-1000", { usage })).toEqual({ earned: true, qualifiedOn: "2026-09-08" });
    expect(runTeacher("busy-5000", { usage })).toEqual({
      earned: false,
      current: 1000,
      target: 5000,
    });
  });
});

describe("Authoring rules", () => {
  it("Evergreen: one activity in 8 different weeks", () => {
    const usage = weeks("2026-06-01", 8).map((d) => codeDay("A", d.date, { interactions: 1 }));
    expect(runTeacher("evergreen", { usage: usage.slice(0, 7) })).toEqual({
      earned: false,
      current: 7,
      target: 8,
    });
    expect(runTeacher("evergreen", { usage })).toEqual({ earned: true, qualifiedOn: "2026-07-20" });
  });

  it("Iterator: the date some file first had 5 of the teacher's versions", () => {
    expect(runTeacher("iterator", { files: { most: 4 } })).toEqual({
      earned: false,
      current: 4,
      target: 5,
    });
    expect(runTeacher("iterator", { files: { most: 7, reachedOn: "2026-09-02" } })).toEqual({
      earned: true,
      qualifiedOn: "2026-09-02",
    });
  });

  it("Listener: dated to the tenth report resolved", () => {
    const reports = (resolved: number) => ({
      open: [],
      resolved,
      resolvedOn: dates("2026-09-01", Math.min(resolved, 10)),
    });
    expect(runTeacher("listener", { reports: reports(9) })).toEqual({
      earned: false,
      current: 9,
      target: 10,
    });
    expect(runTeacher("listener", { reports: reports(12) })).toEqual({
      earned: true,
      qualifiedOn: "2026-09-10",
    });
  });

  it("Homework Hit: half of one activity outside school hours, at least 50 — no count shown", () => {
    expect(
      runTeacher("homework-hit", {
        usage: [codeDay("A", "2026-09-01", { interactions: 80, outsideSchool: 39 })],
      }),
    ).toEqual({ earned: false, current: 0, target: 1 });
    expect(
      runTeacher("homework-hit", {
        usage: [codeDay("A", "2026-09-01", { interactions: 80, outsideSchool: 40 })],
      }),
    ).toEqual({ earned: true, qualifiedOn: "2026-09-01" });
  });
});

describe("guard: the catalog never reaches a client bundle", () => {
  // Type-only imports are erased at build time and carry nothing to the browser, so
  // their statements are dropped before the specifiers are read — a later value
  // import of the same path still counts.
  const valueSpecifiers = (source: string): string[] =>
    importSpecifiers(source.replace(/^\s*import\s+type\s[^;]*?from\s+["'][^"']+["']/gm, ""));

  it("no 'use client' module's value-import closure includes lib/achievements/catalog.ts", () => {
    const clientRoots = sourceFiles("app", "components", "lib").filter((rel) =>
      /^\s*["']use client["']/.test(readModule(rel)),
    );
    expect(clientRoots).toContain("app/_home/season-calendar.tsx"); // not vacuous

    for (const root of clientRoots) {
      // A "use server" module reaches the client only as action references, so
      // the walk stops there.
      const reached = walkClosure([root], ({ rel, source }) =>
        (rel !== root && /^\s*["']use server["']/.test(source) ? [] : valueSpecifiers(source))
          .map((s) => resolveImport(rel, s))
          .filter((r) => r.exists && r.rel !== null)
          .map((r) => r.rel as string),
      );
      expect([root, reached.has("lib/achievements/catalog.ts")]).toEqual([root, false]);
    }
  });
});
