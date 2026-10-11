import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { insertGrants } from "@/lib/achievement-store";
import { addDays, todayLocal } from "@/lib/achievements/time";
import { loadStudentUsage } from "@/lib/student-facts-store";
import { query } from "./db";
import { deletePrincipal, signInFreshStudent } from "./principal.utils";

// The start page against real rows (docs/home.md): seeded hourly usage and one
// unseen badge for a FRESH student, so nothing another spec wrote can interfere.
// Covers the calendar's intensity, the pin on its `qualified_on` day, the strip,
// and that the strip is gone once the badges were marked seen — plus the facts
// store against the real database: the Vienna-day grouping across the autumn
// clock change and the idempotent grant insert. The second test covers coding:
// requests, a key, the two coding badges that read them, and a secret badge.

test.use({ storageState: { cookies: [], origins: [] } });

/** A UTC hour bucket on a Vienna-local date (10:00Z is 11:00/12:00 local, same day). */
const bucket = (date: string, hourUtc: number) =>
  `${date}T${String(hourUtc).padStart(2, "0")}:00:00Z`;

test("the start page shows seeded activity, pins a badge on its day, and clears the strip once seen", {
  tag: ["@live", "@live-db"],
}, async ({ page, context }) => {
  const principal = await signInFreshStudent(context, "Seeded Student");
  const today = todayLocal(new Date());
  const busyDay = addDays(today, -1);
  const quietDay = addDays(today, -8);
  const pinDay = addDays(today, -2);

  try {
    const rows: [string, number, number][] = [
      // busyDay: 3 active hours → intensity 2 (2–3 hours).
      [bucket(busyDay, 8), 2, 0],
      [bucket(busyDay, 9), 0, 4],
      [bucket(busyDay, 10), 1, 0],
      // pinDay and quietDay: 1 active hour each → intensity 1.
      [bucket(pinDay, 10), 1, 0],
      [bucket(quietDay, 10), 1, 0],
      // The autumn clock change of 2025: both buckets are local 02:00 on 26 Oct.
      ["2025-10-26T00:00:00Z", 1, 0],
      ["2025-10-26T01:00:00Z", 1, 0],
    ];
    for (const [hour, messages, answers] of rows) {
      await query(
        `INSERT INTO novedu_usage_by_user (user_id, hour, user_messages, quiz_answers)
         VALUES ($1, $2, $3, $4)`,
        [principal.id, hour, messages, answers],
      );
    }
    // A token-only bucket is not an active hour.
    await query(
      `INSERT INTO novedu_usage_by_user (user_id, hour, output_tokens) VALUES ($1, $2, 500)`,
      [principal.id, bucket(addDays(today, -3), 10)],
    );
    // One badge, not yet seen, pinned to pinDay.
    await query(
      `INSERT INTO novedu_achievements (user_id, achievement_id, qualified_on) VALUES ($1, 'week-days-3', $2)`,
      [principal.id, pinDay],
    );

    await page.goto("/");

    // The strip announces the new badges (the seeded one, plus any the visit granted).
    await expect(
      page.getByText(/You earned \d+ new badges? since your last visit\./),
    ).toBeVisible();

    // Calendar intensity per Vienna-local day; the token-only day stays empty.
    await expect(page.locator(`[data-date="${busyDay}"]`)).toHaveAttribute("data-level", "2");
    await expect(page.locator(`[data-date="${quietDay}"]`)).toHaveAttribute("data-level", "1");
    await expect(page.locator(`[data-date="${addDays(today, -3)}"]`)).toHaveAttribute(
      "data-level",
      "0",
    );

    // The pin sits on its qualified_on day, marked new.
    const pin = page.locator(`[data-date="${pinDay}"] button`);
    await expect(pin).toHaveAccessibleName(/Three-Day Week, earned .*, new since your last visit/);

    // The client marks every announced badge as seen…
    await expect
      .poll(
        async () =>
          (
            await query<{ unseen: string }>(
              `SELECT count(*) AS unseen FROM novedu_achievements WHERE user_id = $1 AND seen_at IS NULL`,
              [principal.id],
            )
          )[0]?.unseen,
      )
      .toBe("0");
    // …so the next visit (past the action's cache invalidation) shows no strip.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your last 26 weeks" })).toBeVisible();
    await expect(page.getByText(/new badges? since your last visit/)).toHaveCount(0);
    // (Other badges this visit granted may share the day; none is new any more.)
    const pinName = await page.locator(`[data-date="${pinDay}"] button`).getAttribute("aria-label");
    expect(pinName).toContain("Three-Day Week, earned");
    expect(pinName).not.toContain("new since your last visit");

    // The facts store: both autumn 02:00 buckets are two active hours of one day.
    const usage = await loadStudentUsage(principal.id);
    expect(usage?.find((d) => d.date === "2025-10-26")).toEqual({
      date: "2025-10-26",
      activeHours: 2,
      userMessages: 2,
      quizAnswers: 0,
      writingSaves: 0,
      codingRequests: 0,
      clozeSubmissions: 0,
      codingHours: 0,
    });
    expect(usage?.some((d) => d.date === addDays(today, -3))).toBe(false);

    // A repeated grant insert is a no-op: the stored date is never overwritten.
    const grants = await insertGrants(
      principal.id,
      [{ id: "week-days-3", qualifiedOn: "2020-01-01" }],
      [],
    );
    expect(grants?.find((g) => g.id === "week-days-3")?.qualifiedOn).toBe(pinDay);
  } finally {
    await query(`DELETE FROM novedu_usage_by_user WHERE user_id = $1`, [principal.id]).catch(
      () => {},
    );
    await query(`DELETE FROM novedu_achievements WHERE user_id = $1`, [principal.id]).catch(
      () => {},
    );
    await deletePrincipal(principal.id).catch(() => {});
  }
});

test("coding requests and a coding key earn the Coding badges and a secret one", {
  tag: ["@live", "@live-db"],
}, async ({ page, context }) => {
  const principal = await signInFreshStudent(context, "Coding Student");
  const today = todayLocal(new Date());
  const zoneDay = addDays(today, -1);
  const keyDay = addDays(today, -4);

  try {
    // zoneDay: coding in three different hours — In the Zone, and an active day
    // made of coding alone.
    for (const hour of [8, 9, 11]) {
      await query(
        `INSERT INTO novedu_usage_by_user (user_id, hour, coding_requests, output_tokens)
         VALUES ($1, $2, 2, 300)`,
        [principal.id, bucket(zoneDay, hour)],
      );
    }
    // The autumn clock change of 2025: two buckets, ONE local hour of coding.
    for (const hour of ["2025-10-26T00:00:00Z", "2025-10-26T01:00:00Z"]) {
      await query(
        `INSERT INTO novedu_usage_by_user (user_id, hour, coding_requests) VALUES ($1, $2, 1)`,
        [principal.id, hour],
      );
    }
    // One key, issued on keyDay (no code row needed: the table has no FK).
    await query(
      `INSERT INTO novedu_coding_keys (code, user_id, api_key, created_at)
       VALUES ($1, $2, $3, $4)`,
      [
        `e2e${randomUUID().slice(0, 8)}`,
        principal.id,
        `nvk-e2e-${randomUUID()}`,
        bucket(keyDay, 10),
      ],
    );

    await page.goto("/");

    await expect(page.locator(`[data-date="${zoneDay}"]`)).toHaveAttribute("data-level", "2");
    const coding = page.locator('[data-family="coding"]');
    await expect(coding.locator('[data-badge="coding-connected"]')).toContainText("Earned");
    await expect(coding.locator('[data-badge="coding-first-request"]')).toContainText("Earned");
    const secret = page.locator('[data-family="secret"]');
    await expect(secret.locator('[data-badge="in-the-zone"]')).toContainText("In the Zone");
    await expect(secret).not.toContainText("Full Stack");

    const stored = await query<{ achievement_id: string; qualified_on: string }>(
      `SELECT achievement_id, qualified_on::text AS qualified_on FROM novedu_achievements
       WHERE user_id = $1 AND achievement_id IN ('coding-connected', 'in-the-zone')
       ORDER BY achievement_id`,
      [principal.id],
    );
    expect(stored).toEqual([
      { achievement_id: "coding-connected", qualified_on: keyDay },
      { achievement_id: "in-the-zone", qualified_on: zoneDay },
    ]);

    // The facts store: the two autumn 02:00 buckets are one local coding hour.
    const usage = await loadStudentUsage(principal.id);
    expect(usage?.find((d) => d.date === "2025-10-26")).toMatchObject({
      activeHours: 2,
      codingRequests: 2,
      codingHours: 1,
    });
  } finally {
    await query(`DELETE FROM novedu_usage_by_user WHERE user_id = $1`, [principal.id]).catch(
      () => {},
    );
    await query(`DELETE FROM novedu_coding_keys WHERE user_id = $1`, [principal.id]).catch(
      () => {},
    );
    await query(`DELETE FROM novedu_achievements WHERE user_id = $1`, [principal.id]).catch(
      () => {},
    );
    await deletePrincipal(principal.id).catch(() => {});
  }
});
