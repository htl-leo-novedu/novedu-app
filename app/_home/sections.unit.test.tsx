import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Each async server section, called directly with its data mocked and rendered
// to HTML (the app/usage/*-section.unit.test.tsx pattern). The page data is
// built by the REAL pure builder from hand-made facts, so the sections are
// tested against the shape the loader really produces.

const mocks = vi.hoisted(() => ({
  getStudentHome: vi.fn(),
  listRecentCodes: vi.fn(),
  markAchievementsSeen: vi.fn(),
}));
vi.mock("@/lib/home-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/home-data")>()),
  getStudentHome: mocks.getStudentHome,
}));
vi.mock("@/lib/recent-code-store", () => ({ listRecentCodes: mocks.listRecentCodes }));
vi.mock("@/lib/achievement-actions", () => ({ markAchievementsSeen: mocks.markAchievementsSeen }));
vi.mock("next/link", () => import("@/tests/mocks/next-link"));

import type { UsageDay } from "@/lib/achievements/derive";
import type { Grant } from "@/lib/achievements/evaluate";
import type { QuizAttempt } from "@/lib/achievements/quiz";
import { buildStudentHome, type StudentHome } from "@/lib/home-data";
import { AlmostThereSection } from "./almost-there-section";
import { BadgesSection } from "./badges-section";
import { CalendarSection } from "./calendar-section";
import { NewsStrip } from "./news-strip";
import { ProgressSection } from "./progress-section";
import { RecentList } from "./recent-list";
import { RefreshSection } from "./refresh-section";

const TODAY = "2026-10-04";

const day = (date: string, extra: Partial<UsageDay> = {}): UsageDay => ({
  date,
  activeHours: 2,
  userMessages: 0,
  quizAnswers: 0,
  writingSaves: 0,
  codingRequests: 0,
  clozeSubmissions: 0,
  codingHours: 0,
  ...extra,
});

/** Builds `n` consecutive active days ending at `last` (inclusive). */
function daysUntil(last: string, n: number, extra: Partial<UsageDay> = {}): UsageDay[] {
  const end = Date.UTC(
    Number(last.slice(0, 4)),
    Number(last.slice(5, 7)) - 1,
    Number(last.slice(8, 10)),
  );
  return Array.from({ length: n }, (_, i) =>
    day(new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10), extra),
  );
}

const USAGE = [...daysUntil("2026-10-01", 12, { quizAnswers: 2 })];
const GRANTS: Grant[] = [
  { id: "weekly-streak-2", qualifiedOn: "2026-09-21", seenAt: new Date() },
  { id: "week-days-3", qualifiedOn: "2026-09-22", seenAt: new Date() },
  { id: "week-days-5", qualifiedOn: "2026-09-24", seenAt: null },
  { id: "active-days-10", qualifiedOn: "2026-09-29", seenAt: null },
  { id: "quiz-answers-10", qualifiedOn: "2026-09-24", seenAt: new Date() },
];

/** The page data; pass `undefined` explicitly for a failed group. */
const home = (...args: [usage: UsageDay[] | undefined, grants: Grant[] | undefined] | []) =>
  args.length === 0
    ? buildStudentHome({ usage: USAGE, keys: [], quiz: [], reports: [] }, GRANTS, TODAY)
    : buildStudentHome({ usage: args[0], keys: [], quiz: [], reports: [] }, args[1], TODAY);

async function render(
  Section: (props: { userId: string }) => Promise<React.ReactElement | null>,
  data: StudentHome,
) {
  mocks.getStudentHome.mockResolvedValue(data);
  const element = await Section({ userId: "u1" });
  return element ? renderToStaticMarkup(element) : "";
}

const UNAVAILABLE = "could not be loaded";

describe("RecentList", () => {
  it("labels each code with its module and falls back to the code without a note", async () => {
    mocks.listRecentCodes.mockResolvedValue([
      { code: "a1b2c3d4e5", note: "Linked lists 3AHIF", module: "tutor", lastUsed: new Date() },
      { code: "f6g7h8i9j0", note: "", module: "quiz", lastUsed: new Date() },
      { code: "k1l2m3n4o5", note: "Essay", module: "writing", lastUsed: new Date() },
    ]);
    const html = renderToStaticMarkup(await RecentList({ userId: "u1" }));
    expect(html).toContain('href="/a1b2c3d4e5"');
    expect(html).toMatch(/Linked lists 3AHIF<\/span><span[^>]*>Tutor</);
    expect(html).toMatch(/>f6g7h8i9j0<\/span><span[^>]*>Quiz</);
    expect(html).toMatch(/>Essay<\/span><span[^>]*>Writing</);
  });

  it("explains the empty list", async () => {
    mocks.listRecentCodes.mockResolvedValue([]);
    const html = renderToStaticMarkup(await RecentList({ userId: "u1" }));
    expect(html).toContain("Recently used");
    expect(html).toContain("Activities you open show up here");
    expect(html).not.toContain("<li");
  });
});

describe("NewsStrip", () => {
  it("is absent when nothing is new", async () => {
    expect(
      await render(
        NewsStrip,
        home(
          USAGE,
          GRANTS.map((g) => ({ ...g, seenAt: new Date() })),
        ),
      ),
    ).toBe("");
  });

  it("is absent when the grants are unavailable", async () => {
    expect(await render(NewsStrip, home(USAGE, undefined))).toBe("");
  });

  it("counts the new badges, singular and plural", async () => {
    expect(await render(NewsStrip, home())).toContain('<b class="font-semibold">2 new badges</b>');
    const one = GRANTS.map((g) => (g.id === "week-days-5" ? g : { ...g, seenAt: new Date() }));
    const html = await render(NewsStrip, home(USAGE, one));
    expect(html).toContain("1 new badge<");
    expect(html).toContain('role="status"');
  });
});

describe("ProgressSection", () => {
  it("shows level, XP, the distance to the next level and an accessible progress bar", async () => {
    // 12 active days × 10 + 20 + 20 + 50 + 20 + 20 = 250 XP → level 2 (100–300).
    const html = await render(ProgressSection, home());
    expect(html).toContain("Your progress here is only visible to you.");
    expect(html).toMatch(/>Level<\/span><b[^>]*>2</);
    expect(html).toContain(">250</b> XP");
    expect(html).toContain("50 XP to level 3");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="200"');
    expect(html).toContain('aria-valuenow="150"');
    expect(html).toContain('aria-valuetext="250 XP, level 2, 50 XP to level 3"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("How XP works");
  });

  it("a student exactly on a level boundary starts the new level at zero", async () => {
    // 10 active days, no grants → 100 XP = the start of level 2.
    const data = buildStudentHome(
      { usage: daysUntil("2026-10-01", 10), keys: [], quiz: [], reports: [] },
      [],
      TODAY,
    );
    data.level = { level: 2, xp: 100, levelStart: 100, nextLevelStart: 300 };
    const html = await render(ProgressSection, data);
    expect(html).toMatch(/>Level<\/span><b[^>]*>2</);
    expect(html).toContain('aria-valuenow="0"');
    expect(html).toContain('aria-valuemax="200"');
    expect(html).toContain("200 XP to level 3");
  });

  it("shows the weekly streak and this week's note", async () => {
    const html = await render(ProgressSection, home());
    expect(html).toMatch(/>3<\/b><span[^>]*>weeks in a row</);
    expect(html).toContain("This week counts already: active on 4 days.");
  });

  it("degrades the level half alone when the grants failed — never a level of 0", async () => {
    const html = await render(ProgressSection, home(USAGE, undefined));
    expect(html).toContain(UNAVAILABLE);
    expect(html).not.toContain(">Level<");
    expect(html).toContain("weeks in a row");
  });

  it("degrades both halves when the usage failed — never 0 weeks", async () => {
    const html = await render(ProgressSection, home(undefined, GRANTS));
    expect(html.match(new RegExp(UNAVAILABLE, "g"))).toHaveLength(2);
    expect(html).not.toContain("in a row");
    expect(html).not.toContain(">Level<");
  });

  it("invites a brand-new student to start a streak", async () => {
    const html = await render(ProgressSection, home([], []));
    expect(html).toMatch(/>Level<\/span><b[^>]*>1</);
    expect(html).toMatch(/>0<\/b><span[^>]*>weeks in a row</);
    expect(html).toContain("Be active this week to start a streak.");
  });
});

describe("CalendarSection", () => {
  it("renders 26 × 7 day cells with today and the future marked", async () => {
    const html = await render(CalendarSection, home());
    expect(html.match(/data-date="/g)).toHaveLength(182);
    expect(html).toMatch(/data-date="2026-10-04"[^>]*data-today="true"/);
    expect(html.match(/data-level="future"/g)).toBeNull(); // today is the last day (Sunday)
    expect(html).toContain('data-date="2026-04-06"');
  });

  it("marks the days after today as future", async () => {
    const data = buildStudentHome(
      { usage: USAGE, keys: [], quiz: [], reports: [] },
      GRANTS,
      "2026-10-01",
    );
    const html = await render(CalendarSection, data);
    expect(html.match(/data-level="future"/g)).toHaveLength(3);
  });

  it("pins each badge to its qualified_on day, stacking two on one day", async () => {
    const stacked = [
      ...GRANTS,
      { id: "quiz-answers-100", qualifiedOn: "2026-09-29", seenAt: null },
    ];
    const html = await render(CalendarSection, home(USAGE, stacked));
    const cell = (date: string) =>
      html.match(new RegExp(`data-date="${date}"[^]*?</div>`))?.[0] ?? "";
    expect(cell("2026-09-21")).toContain("Two in a Row, earned Mon 21 Sep");
    expect(cell("2026-09-29")).toContain(
      "Ten Days In, earned Tue 29 Sep, new since your last visit",
    );
    expect(cell("2026-09-29")).toContain("A Hundred Answers, earned Tue 29 Sep");
    expect(cell("2026-09-29")).toMatch(/>2<\/span><\/button>/);
    expect(cell("2026-09-30")).not.toContain("<button");
    expect(html).toContain(
      "Activity calendar: 12 active days in the last 26 weeks, 6 badges earned.",
    );
  });

  it("keeps the cells without pins when the grants failed", async () => {
    const html = await render(CalendarSection, home(USAGE, undefined));
    expect(html.match(/data-date="/g)).toHaveLength(182);
    expect(html).not.toContain("<button");
    expect(html).toContain("Badges could not be loaded");
  });

  it("is unavailable when the usage failed — never an empty calendar", async () => {
    const html = await render(CalendarSection, home(undefined, GRANTS));
    expect(html).toContain(UNAVAILABLE);
    expect(html).not.toContain("data-date=");
  });

  it("an empty history shows empty cells and a hint", async () => {
    const html = await render(CalendarSection, home([], []));
    expect(html.match(/data-level="0"/g)).toHaveLength(182);
    expect(html).toContain("Your first active day will show up here.");
  });
});

describe("AlmostThereSection", () => {
  it("lists the next unearned tier per ladder, closest first, never earned ones", async () => {
    const html = await render(AlmostThereSection, home());
    const names = [...html.matchAll(/<b class="font-semibold">([^<]+)<\/b>/g)].map((m) => m[1]);
    // Ratios: Four Weeks Strong 3/4, Thirty Days In 12/30, A Hundred Answers 24/100;
    // Week-days has no tier left, First Drafts has no progress, and higher tiers
    // (Eight-Week Run, A Hundred Days, …) wait behind their ladder's next tier.
    expect(names).toEqual(["Four Weeks Strong", "Thirty Days In", "A Hundred Answers"]);
    expect(html).toContain("+50 XP");
  });

  it("shows a hint with nothing in progress, and 'unavailable' when the grants failed", async () => {
    expect(await render(AlmostThereSection, home([], []))).toContain(
      "Badges you&#x27;re close to will show up here.",
    );
    expect(await render(AlmostThereSection, home(USAGE, undefined))).toContain(UNAVAILABLE);
  });
});

describe("RefreshSection", () => {
  let seq = 0;
  const saved = (code: string, date: string, correct: number, total: number, note = "") => {
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
      note,
      open: true,
    } satisfies QuizAttempt;
  };
  const withQuiz = (quiz: QuizAttempt[] | undefined) =>
    buildStudentHome({ usage: USAGE, keys: [], quiz, reports: [] }, GRANTS, TODAY);

  it("lists the nudges with their medal, last and best score, and a Retake link", async () => {
    const html = await render(
      RefreshSection,
      withQuiz([
        saved("a1b2c3d4e5", "2026-09-18", 4, 5, "Linked lists"),
        saved("a1b2c3d4e5", "2026-09-25", 3, 5, "Linked lists"),
        saved("f6g7h8i9j0", "2026-10-03", 5, 5, "Recursion"), // gold, yesterday: no nudge
      ]),
    );
    expect(html).toContain("Time to refresh");
    expect(html).toContain("Your practice results, not grades. Gold = every answer fully correct.");
    expect(html).toContain("Linked lists");
    expect(html).toContain("silver medal. ");
    expect(html).toContain("Last 60 %, 9 days ago · best 80 %");
    expect(html).toContain('href="/a1b2c3d4e5"');
    expect(html).toContain('aria-label="Retake Linked lists"');
    expect(html).not.toContain("Retake Recursion");
    expect(html).toMatch(/1 gold.*1 silver.*0 bronze/);
  });

  it("explains how to start when nothing is saved, and says when nothing is due", async () => {
    const empty = await render(RefreshSection, withQuiz([]));
    expect(empty).toContain("Save a result on a quiz");
    expect(empty).not.toContain("0 gold");
    const fresh = await render(RefreshSection, withQuiz([saved("q1q1q1q1q1", "2026-10-03", 1, 2)]));
    expect(fresh).toContain("Nothing to refresh right now.");
    expect(fresh).toMatch(/0 gold.*0 silver.*1 bronze/);
  });

  it("a failed quiz group shows 'unavailable', never zeros, while Almost there renders", async () => {
    const data = withQuiz(undefined);
    const html = await render(RefreshSection, data);
    expect(html).toContain(UNAVAILABLE);
    expect(html).not.toContain("0 gold");
    expect(await render(AlmostThereSection, data)).not.toContain(UNAVAILABLE);
  });
});

describe("BadgesSection", () => {
  it("shows earned badges plus the next tier per ladder, the rest behind 'Show all'", async () => {
    const html = await render(BadgesSection, home());
    expect(html).toContain("5 earned");
    // Five families spread over up to five columns.
    expect(html).toMatch(/data-columns="5" class="[^"]*xl:grid-cols-5/);
    const shown = [...html.matchAll(/<li data-badge="([^"]+)" class="(?![^"]*hidden)/g)].map(
      (m) => m[1],
    );
    // Earned first, then the next tier of each ladder.
    expect(shown).toEqual([
      "weekly-streak-2",
      "week-days-3",
      "week-days-5",
      "active-days-10",
      "weekly-streak-4",
      "active-days-30",
      "quiz-answers-10",
      "quiz-answers-100",
      "writing-saves-5",
      "quiz-first-result",
      "quiz-golds-1",
      "quiz-improved",
      "quiz-refreshed",
      "coding-connected",
      "coding-first-request",
      "coding-days-5",
      "coding-toolbelt",
    ]);
    const more = [...html.matchAll(/<li data-badge="([^"]+)" class="[^"]*hidden/g)].map(
      (m) => m[1],
    );
    expect(more).toEqual([
      "weekly-streak-8",
      "weekly-streak-16",
      "active-days-100",
      "quiz-answers-500",
      "writing-saves-25",
      "writing-saves-100",
      "quiz-golds-3",
      "quiz-golds-10",
      "coding-days-20",
    ]);
    expect(html).toContain(`Show all badges (${more.length} more)`);
    expect(html).toContain('aria-controls="home-badge-families"');
  });

  it("an unearned secret badge appears nowhere; the Secret column only says more exist", async () => {
    const html = await render(BadgesSection, home());
    for (const leak of [
      "Full Stack",
      "full-stack",
      "In the Zone",
      "in-the-zone",
      "3 different hours",
      "Bug Hunter",
      "bug-hunter",
      "you reported",
    ]) {
      expect(html).not.toContain(leak);
    }
    expect(html).toMatch(
      /data-family="secret">.*Secret<\/h3><p[^>]*>.*Secret badges show up here once you earn them\.<\/p>/,
    );
  });

  it("an earned secret badge is listed in the Secret column, dated", async () => {
    const html = await render(
      BadgesSection,
      home(USAGE, [...GRANTS, { id: "in-the-zone", qualifiedOn: "2026-09-30", seenAt: null }]),
    );
    expect(html).toMatch(/data-family="secret">.*data-badge="in-the-zone".*In the Zone/);
    expect(html).toContain("Earned 30 Sep · +50 XP");
    expect(html).not.toContain("Full Stack");
  });

  it("marks new badges and dates earned ones", async () => {
    const html = await render(BadgesSection, home());
    expect(html).toMatch(/Ten Days In<span[^>]*>New<\/span>/);
    expect(html).toContain("Earned 29 Sep · +20 XP");
  });

  it("is unavailable when the grants failed", async () => {
    const html = await render(BadgesSection, home(USAGE, undefined));
    expect(html).toContain(UNAVAILABLE);
    expect(html).not.toContain("earned");
  });
});
