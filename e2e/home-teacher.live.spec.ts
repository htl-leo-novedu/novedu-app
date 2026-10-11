import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  addDays,
  isSchoolHour,
  localDateOf,
  startOfLocalDay,
  todayLocal,
  weekdayOf,
} from "@/lib/achievements/time";
import { loadTeacherUsage } from "@/lib/teacher-facts-store";
import { purgeCodes } from "./code.utils";
import { query } from "./db";
import { deletePrincipal, signInFreshTeacher } from "./principal.utils";

// The teacher start page against real rows (docs/home.md → Teacher dashboard,
// Teacher achievements): a FRESH teacher with seeded codes, hourly usage,
// reports, attributed students, keys, file versions and Mastra threads — plus a
// second teacher whose rows must never count. Covers the attention counters, the
// six KPIs, the top activities with their share outside school hours (checked
// against the pure `isSchoolHour` rule, also across both clock changes),
// and the badges granted from those rows with their dates and the strip.

test.use({ storageState: { cookies: [], origins: [] } });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

/** The UTC instant of a local hour on the local date `daysAgo` before today. */
function localBucket(daysAgo: number, localHour: number): Date {
  const date = addDays(todayLocal(new Date()), -daysAgo);
  return new Date(startOfLocalDay(date).getTime() + localHour * HOUR);
}

interface Seeded {
  teacherId: string;
  otherTeacherId: string;
  codes: string[];
  students: string[];
}

async function insertCode(
  code: string,
  module: string,
  createdBy: string,
  opts: { note?: string; until?: number | null; created?: number; anonymous?: boolean } = {},
) {
  await query(
    `INSERT INTO novedu_codes (code, module, created_by, file_url, valid_until, note, anonymous, created_at)
     VALUES ($1, $2, $3, 'https://example.com/activity.yaml', $4, $5, $6, $7)`,
    [
      code,
      module,
      createdBy,
      opts.until ? iso(opts.until) : null,
      opts.note ?? "",
      opts.anonymous ?? true,
      iso(opts.created ?? Date.now() - 30 * DAY),
    ],
  );
}

async function insertUsage(
  code: string,
  module: string,
  hour: Date,
  counts: { messages?: number; answers?: number; saves?: number; requests?: number },
) {
  await query(
    `INSERT INTO novedu_usage_by_code
       (code, hour, module, user_messages, quiz_answers, writing_saves, coding_requests,
        input_tokens_new, input_tokens_cached, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 100, 50, 10)`,
    [
      code,
      hour.toISOString(),
      module,
      counts.messages ?? 0,
      counts.answers ?? 0,
      counts.saves ?? 0,
      counts.requests ?? 0,
    ],
  );
}

async function insertThread(code: string, role: string, at: number) {
  const id = randomUUID();
  const stamp = iso(at);
  await query(
    `INSERT INTO mastra.mastra_threads (id, "resourceId", title, "createdAt", "updatedAt", "createdAtZ", "updatedAtZ")
     VALUES ($1, $2, '', $3, $3, $4, $4)`,
    [id, code, stamp.replace("Z", ""), stamp],
  );
  await query(
    `INSERT INTO mastra.mastra_messages (id, thread_id, content, role, type, "createdAt", "createdAtZ")
     VALUES ($1, $2, '{}', $3, 'v2', $4, $5)`,
    [randomUUID(), id, role, stamp.replace("Z", ""), stamp],
  );
}

// The seeded teacher's activities. Interactions in the window, by construction:
// A 50, B 24, D 12, C 9, G 2, E 1 — so the board ranks A, B, D, C, G and drops E.
const A_HOURS = [9, 20, 10, 6, 14, 18, 11, 22, 8, 16];

async function seed(teacherId: string): Promise<Seeded> {
  const tag = randomUUID().slice(0, 8);
  const c = (letter: string) => `${letter}${tag}`;
  const otherTeacherId = `e2e-other-${randomUUID()}`;
  const now = Date.now();
  const seeded: Seeded = {
    teacherId,
    otherTeacherId,
    codes: ["A", "B", "C", "D", "E", "F", "G", "X"].map(c),
    students: [1, 2, 3, 4, 5, 6, 7].map((i) => `e2e-student-${tag}-${i}`),
  };
  const [s1, s2, s3, s4, s5, s6, s7] = seeded.students;

  await insertCode(c("A"), "quiz", teacherId, { note: "SQL joins quiz", until: now + 2 * DAY });
  await insertCode(c("B"), "tutor", teacherId, { note: "Recursion tutor" });
  await insertCode(c("C"), "writing", teacherId, { note: "Abstract coach", anonymous: false });
  await insertCode(c("D"), "coding", teacherId, { note: "REST API" });
  await insertCode(c("E"), "quiz", teacherId, { note: "Networking quiz", until: now + 20 * HOUR });
  await insertCode(c("F"), "tutor", teacherId, { note: "Loops warm-up", created: now - 16 * DAY });
  await insertCode(c("G"), "tutor", teacherId, { note: "Old exam prep", until: now - DAY });
  // Another teacher's busy code: none of it may show on this teacher's page.
  await insertCode(c("X"), "quiz", otherTeacherId, { note: "Not mine", anonymous: false });

  for (const [i, hour] of A_HOURS.entries()) {
    await insertUsage(c("A"), "quiz", localBucket(i + 2, hour), { answers: 5 });
  }
  // Older than the window: makes A "used" but adds nothing to the KPIs.
  await insertUsage(c("A"), "quiz", localBucket(40, 10), { answers: 1000 });
  for (let i = 0; i < 6; i++) {
    await insertUsage(c("B"), "tutor", localBucket(i + 1, 19), { messages: 4 });
  }
  for (let i = 0; i < 3; i++) {
    await insertUsage(c("C"), "writing", localBucket(i + 3, 10), { messages: 1, saves: 2 });
  }
  for (let i = 0; i < 4; i++) {
    await insertUsage(c("D"), "coding", localBucket(i + 5, 13), { requests: 3 });
  }
  await insertUsage(c("E"), "quiz", localBucket(1, 12), { answers: 1 });
  await insertUsage(c("G"), "tutor", localBucket(10, 21), { messages: 2 });
  await insertUsage(c("X"), "quiz", localBucket(1, 10), { answers: 999 });

  // Reports: 2 open on A, 1 open + 1 resolved on B; 3 open on the other teacher's X.
  for (const [code, resolved] of [
    ["A", false],
    ["A", false],
    ["B", false],
    ["B", true],
    ["X", false],
    ["X", false],
    ["X", false],
  ] as const) {
    await query(
      `INSERT INTO novedu_reports (id, kind, code, user_id, reaction, created_at, resolved_at)
       VALUES ($1, 'chat', $2, $3, 'meh', now(), $4)`,
      [randomUUID(), c(code), s1, resolved ? new Date().toISOString() : null],
    );
  }

  // Identified students: s1–s3 saved texts on C, s4 chatted on C, s6 and s1
  // hold keys on D → five distinct. Not counted: s5 on the anonymous B, the
  // teacher's own key, s7 on the other teacher's code.
  for (const student of [s1, s2, s3]) {
    await query(
      `INSERT INTO novedu_writing_submissions (code, user_id, text, text_updated_at)
       VALUES ($1, $2, 'draft', now())`,
      [c("C"), student],
    );
  }
  for (const [code, student] of [
    ["C", s4],
    ["B", s5],
    ["X", s7],
  ] as const) {
    await query(
      `INSERT INTO novedu_user_chats (thread_id, code, user_id, created_at) VALUES ($1, $2, $3, now())`,
      [randomUUID(), c(code), student],
    );
  }
  for (const holder of [s6, s1, teacherId]) {
    await query(
      `INSERT INTO novedu_coding_keys (code, user_id, api_key, created_at) VALUES ($1, $2, $3, now())`,
      [c("D"), holder, `nvk_${randomUUID().replaceAll("-", "")}`],
    );
  }

  // Conversations: only A's thread has a user message in the window.
  await insertThread(c("A"), "user", now - 2 * DAY);
  await insertThread(c("B"), "assistant", now - DAY);
  await insertThread(c("B"), "user", now - 40 * DAY);
  await insertThread(c("X"), "user", now - HOUR);
  return seeded;
}

/** The KPI tile's value text. */
const kpi = (page: Page, label: string) =>
  page.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd");

test("the teacher dashboard shows the seeded codes, usage and reports — and nothing of another teacher's", {
  tag: ["@live", "@live-db"],
}, async ({ page, context }) => {
  const principal = await signInFreshTeacher(context, "Seeded Teacher");
  const seeded = await seed(principal.id);
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");

    // Attention: Closing soon starts open, soonest first; then the other counters.
    const closing = page.getByRole("button", { name: /Closing soon/ });
    await expect(closing).toHaveAttribute("aria-expanded", "true");
    await expect(closing).toContainText("2");
    const panel = page.getByRole("region", { name: "Closing soon" });
    await expect(panel.getByRole("link")).toHaveText([/^Networking quiz/, /^SQL joins quiz/]);

    const reports = page.getByRole("button", { name: /Open reports/ });
    await expect(reports).toContainText("3");
    await reports.click();
    const reportsPanel = page.getByRole("region", { name: "Open reports" });
    await expect(reportsPanel.getByRole("link", { name: /SQL joins quiz/ })).toContainText(
      "2 open",
    );
    await expect(reportsPanel.getByRole("link", { name: /Recursion tutor/ })).toContainText(
      "1 open",
    );
    await expect(reportsPanel.getByRole("link", { name: /Not mine/ })).toHaveCount(0);

    const unused = page.getByRole("button", { name: /Never used/ });
    await expect(unused).toContainText("1");
    await unused.click();
    await expect(
      page.getByRole("region", { name: "Never used" }).getByRole("link", { name: /Loops warm-up/ }),
    ).toHaveAttribute("href", `/codes/${seeded.codes[5]}`);

    // KPIs over the window: the old bucket and the other teacher's rows add nothing.
    await expect(kpi(page, "Live codes")).toHaveText("6");
    await expect(kpi(page, "Identified students")).toHaveText("5*");
    await expect(kpi(page, "Conversations")).toHaveText("1");
    await expect(kpi(page, "Quiz answers")).toHaveText("51");
    // 25 in-window buckets (A 10, B 6, D 4, C 3, E 1, G 1) × 150 / × 10 tokens.
    await expect(kpi(page, "Input tokens")).toHaveText("3.8K");
    await expect(kpi(page, "Output tokens")).toHaveText("250");

    // Top activities: ranked, with the share outside school hours by the pure rule.
    const board = page.getByRole("region", { name: "Top activities" });
    const rows = board.locator("tbody tr");
    await expect(rows.locator("td:nth-child(2) a")).toHaveText([
      "SQL joins quiz",
      "Recursion tutor",
      "REST API",
      "Abstract coach",
      "Old exam prep",
    ]);
    const outsideA = A_HOURS.filter((hour, i) => !isSchoolHour(localBucket(i + 2, hour))).length;
    await expect(rows.first()).toContainText(`${Math.round((outsideA / A_HOURS.length) * 100)} %`);
    await expect(rows.first()).toContainText("50");
    await expect(board.getByRole("link", { name: "Usage dashboard" })).toHaveAttribute(
      "href",
      "/usage",
    );
    expect(errors).toEqual([]);
  } finally {
    await purgeCodes(seeded.codes);
    await deletePrincipal(principal.id);
  }
});

test("the usage statement's school-hours cut matches isSchoolHour, across both clock changes", {
  tag: ["@live", "@live-db"],
}, async () => {
  const teacherId = `e2e-teacher-${randomUUID()}`;
  const instants = [
    "2025-10-26T00:00:00Z", // Sun 02:00 CEST — weekend
    "2025-10-26T01:00:00Z", // Sun 02:00 CET — weekend
    "2025-10-27T06:00:00Z", // Mon 07:00 CET — before school
    "2025-10-27T07:00:00Z", // Mon 08:00 CET — school
    "2025-10-27T15:00:00Z", // Mon 16:00 CET — school
    "2025-10-27T16:00:00Z", // Mon 17:00 CET — after school
    "2026-03-30T05:00:00Z", // Mon 07:00 CEST — before school
    "2026-03-30T06:00:00Z", // Mon 08:00 CEST — school
    "2026-03-30T14:00:00Z", // Mon 16:00 CEST — school
    "2026-03-30T15:00:00Z", // Mon 17:00 CEST — after school
    "2026-10-23T14:00:00Z", // Fri 16:00 CEST — school
    "2026-10-24T08:00:00Z", // Sat 10:00 CEST — weekend
  ].map((s) => new Date(s));
  const codes = instants.map((_, i) => `tz${randomUUID().slice(0, 8)}${i}`);
  try {
    for (const [i, instant] of instants.entries()) {
      await insertCode(codes[i] as string, "tutor", teacherId);
      await insertUsage(codes[i] as string, "tutor", instant, { messages: 1 });
    }
    const usage = await loadTeacherUsage(teacherId);
    expect(usage).toHaveLength(instants.length);
    for (const [i, instant] of instants.entries()) {
      const row = usage?.find((u) => u.code === codes[i]);
      expect(row?.date, instant.toISOString()).toBe(localDateOf(instant));
      expect(row?.interactions, instant.toISOString()).toBe(1);
      expect(row?.outsideSchool, instant.toISOString()).toBe(isSchoolHour(instant) ? 0 : 1);
    }
  } finally {
    await purgeCodes(codes);
  }
});

// ---------------------------------------------------------------------------
// Badges

/** Noon (local) on the local date `daysAgo` before today. */
const noon = (daysAgo: number) => localBucket(daysAgo, 12);

test("the teacher's badges are granted from real rows, dated by their evidence, and the strip clears once seen", {
  tag: ["@live", "@live-db"],
}, async ({ page, context }) => {
  const principal = await signInFreshTeacher(context, "Badge Teacher");
  const teacherId = principal.id;
  const tag = randomUUID().slice(0, 8);
  const code = `H${tag}`;
  const otherCode = `Y${tag}`;
  const fileName = `e2e-iter-${tag}`;
  const reportIds: string[] = [];
  const today = todayLocal(new Date());
  const dayOf = (daysAgo: number) => addDays(today, -daysAgo);
  // The latest Saturday at least two days back, and the Wednesday before it.
  let saturday = 2;
  while (weekdayOf(dayOf(saturday)) !== 5) saturday++;
  try {
    // First Code: one tutor code, created 20 days ago (no Full Toolkit).
    await insertCode(code, "tutor", teacherId, { anonymous: false, created: noon(20).getTime() });
    await insertCode(otherCode, "quiz", `e2e-other-${tag}`);

    // Small Crowd: ten students first seen on days 19 … 10 → the tenth on day 10.
    // The teacher's own (earlier) chat is never a student.
    for (const [i, user] of [
      teacherId,
      ...Array.from({ length: 10 }, (_, k) => `e2e-s-${tag}-${k}`),
    ].entries()) {
      await query(
        `INSERT INTO novedu_user_chats (thread_id, code, user_id, created_at) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), code, user, noon(20 - i).toISOString()],
      );
    }

    // Homework Hit: 30 messages on a Wednesday in school hours, then 30 on the
    // Saturday — 60 in total, exactly half outside → dated that Saturday.
    await insertUsage(code, "tutor", localBucket(saturday + 3, 10), { messages: 30 });
    await insertUsage(code, "tutor", localBucket(saturday, 10), { messages: 30 });

    // Iterator: versions of one file by the teacher on days 9, 8, 6, 5, 4 — and
    // one by someone else on day 7, which does not count → the fifth on day 4.
    const versions: [number, string][] = [
      [9, teacherId],
      [8, teacherId],
      [7, `e2e-other-${tag}`],
      [6, teacherId],
      [5, teacherId],
      [4, teacherId],
    ];
    for (const [i, [daysAgo, writer]] of versions.entries()) {
      const next = versions[i + 1];
      await query(
        `INSERT INTO novedu_files (id, name, kind, content, created_by, valid_from, valid_until, closed_by)
         VALUES ($1, $2, 'fragment', 'x: 1', $3, $4, $5, $6)`,
        [
          randomUUID(),
          fileName,
          writer,
          noon(daysAgo).toISOString(),
          next ? noon(next[0]).toISOString() : null,
          next ? next[1] : null,
        ],
      );
    }

    // Listener: ten reports on another teacher's code resolved by this teacher on
    // days 15 … 6 → the tenth on day 6; one resolved by someone else.
    for (const [daysAgo, resolver] of [
      ...Array.from({ length: 10 }, (_, k) => [15 - k, teacherId] as const),
      [16, `e2e-other-${tag}`] as const,
    ]) {
      const id = randomUUID();
      reportIds.push(id);
      await query(
        `INSERT INTO novedu_reports (id, kind, code, user_id, reaction, created_at, resolved_at, resolved_by)
         VALUES ($1, 'chat', $2, $3, 'meh', $4, $4, $5)`,
        [id, otherCode, `e2e-reporter-${tag}`, noon(daysAgo).toISOString(), resolver],
      );
    }

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");

    // Five badges, each stored with the day its evidence was first complete.
    await expect(page.getByText("You earned 5 new badges since your last visit.")).toBeVisible();
    const grants = await query<{ achievement_id: string; qualified_on: string }>(
      `SELECT achievement_id, qualified_on::text AS qualified_on FROM novedu_achievements
       WHERE user_id = $1 ORDER BY achievement_id`,
      [teacherId],
    );
    expect(grants).toEqual([
      { achievement_id: "crowd-10", qualified_on: dayOf(10) },
      { achievement_id: "first-code", qualified_on: dayOf(20) },
      { achievement_id: "homework-hit", qualified_on: dayOf(saturday) },
      { achievement_id: "iterator", qualified_on: dayOf(4) },
      { achievement_id: "listener", qualified_on: dayOf(6) },
    ]);

    // The student page's Badges section, with the teacher's families.
    const badges = page.getByRole("region", { name: "Badges" });
    await expect(badges.getByText("5 earned")).toBeVisible();
    await expect(badges.locator('[data-family="reach"] li[data-badge="first-code"]')).toContainText(
      "Earned",
    );
    await expect(badges.locator('li[data-badge="full-toolkit"]')).toContainText("1 / 5");
    await expect(badges.locator('li[data-badge="crowd-30"]')).toContainText("10 / 30");
    await expect(badges).not.toContainText("XP");

    // The strip's badges are marked seen; the next visit shows no strip and
    // grants nothing twice.
    await expect
      .poll(
        async () =>
          (
            await query<{ unseen: string }>(
              `SELECT count(*) AS unseen FROM novedu_achievements WHERE user_id = $1 AND seen_at IS NULL`,
              [teacherId],
            )
          )[0]?.unseen,
      )
      .toBe("0");
    await page.reload();
    await expect(page.getByRole("region", { name: "Badges" })).toBeVisible();
    await expect(page.getByText(/new badges? since your last visit/)).toHaveCount(0);
    const [{ count } = { count: "" }] = await query<{ count: string }>(
      `SELECT count(*) FROM novedu_achievements WHERE user_id = $1`,
      [teacherId],
    );
    expect(count).toBe("5");
    expect(errors).toEqual([]);
  } finally {
    await query(`DELETE FROM novedu_files WHERE name = $1`, [fileName]);
    await query(`DELETE FROM novedu_reports WHERE id = ANY($1)`, [reportIds]);
    await purgeCodes([code, otherCode]);
    await deletePrincipal(teacherId);
  }
});
