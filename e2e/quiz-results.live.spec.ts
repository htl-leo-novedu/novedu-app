import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { addDays, todayLocal } from "@/lib/achievements/time";
import {
  countOwnQuizResults,
  deleteOwnQuizResults,
  listOwnQuizResults,
  saveQuizResult,
} from "@/lib/quiz-result-store";
import { getUserSettings, updateUserSettings } from "@/lib/user-settings-store";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { mintCode } from "./code.utils";
import { getPool, query } from "./db";
import { deletePrincipal, signInFreshStudent } from "./principal.utils";

// Saved quiz results against the real database (docs/home.md → Saving a quiz
// result): the retention bound under concurrent saves, a save racing a code
// delete, `always` rolling back as a whole, an automatic save racing the
// switch-off — the locks the store's transaction relies on, which no fake can
// prove — then the start page and the Settings page over seeded results. Every
// test uses its own user id and quiz code and removes its rows afterwards.

test.use({ storageState: { cookies: [], origins: [] } });

const RESULT = { correct: 1, partial: 0, incorrect: 1, unanswered: 0, total: 2 };

async function rowsOf(userId: string): Promise<{ id: string; correct: number }[]> {
  return query(`SELECT id, correct FROM novedu_quiz_results WHERE user_id = $1`, [userId]);
}

/**
 * Waits until some backend is blocked by `blocker` — proof that the save
 * reached the contested lock, so the race is really exercised (a fixed sleep
 * would let a slow start pass as a sequential run).
 */
async function untilBlockedBy(blocker: number) {
  await expect
    .poll(
      async () =>
        (
          await query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
            [blocker],
          )
        )[0]?.n,
    )
    .toBe("1");
}

async function cleanup(userId: string, code: string) {
  await query(`DELETE FROM novedu_quiz_results WHERE user_id = $1`, [userId]).catch(() => {});
  await query(`DELETE FROM novedu_user_settings WHERE user_id = $1`, [userId]).catch(() => {});
  await query(`DELETE FROM novedu_codes WHERE code = $1`, [code]).catch(() => {});
}

test("two concurrent saves keep exactly the newest 50 plus the best", {
  tag: ["@live", "@live-db"],
}, async () => {
  const userId = `e2e-${randomUUID()}`;
  const code = await mintCode({ module: "quiz" });
  try {
    // The best (a gold) is the OLDEST row; 49 weaker ones follow it.
    const best = randomUUID();
    await query(
      `INSERT INTO novedu_quiz_results (id, user_id, code, correct, partial, incorrect, unanswered, total, finished_at)
       VALUES ($1, $2, $3, 2, 0, 0, 0, 2, now() - interval '60 days')`,
      [best, userId, code],
    );
    const seeded: string[] = [];
    for (let i = 0; i < 49; i++) {
      const id = randomUUID();
      seeded.push(id);
      await query(
        `INSERT INTO novedu_quiz_results (id, user_id, code, correct, partial, incorrect, unanswered, total, finished_at)
         VALUES ($1, $2, $3, 0, 1, 1, 0, 2, now() - make_interval(days => $4))`,
        [id, userId, code, 50 - i],
      );
    }

    const outcomes = await Promise.all([
      saveQuizResult(userId, { id: randomUUID(), code, ...RESULT }, "this-time"),
      saveQuizResult(userId, { id: randomUUID(), code, ...RESULT }, "this-time"),
    ]);
    expect(outcomes).toEqual(["saved", "saved"]);

    const ids = (await rowsOf(userId)).map((r) => r.id);
    expect(ids).toHaveLength(51);
    expect(ids).toContain(best);
    // The oldest weak row fell out of the newest 50; the next one survived.
    expect(ids).not.toContain(seeded[0]);
    expect(ids).toContain(seeded[1]);

    // A repeated save of the same attempt is a no-op.
    const again = {
      id: ids.find((id) => id !== best && !seeded.includes(id)) ?? "",
      code,
      ...RESULT,
    };
    await expect(saveQuizResult(userId, again, "this-time")).resolves.toBe("saved");
    expect(await rowsOf(userId)).toHaveLength(51);
  } finally {
    await cleanup(userId, code);
  }
});

test("a save racing a code delete leaves no row behind", {
  tag: ["@live", "@live-db"],
}, async () => {
  const userId = `e2e-${randomUUID()}`;
  const code = await mintCode({ module: "quiz" });
  const client = await getPool().connect();
  try {
    // The delete side, as deleteCodesAndData runs it: lock the code row FOR UPDATE,
    // drop its dependent rows, then the code.
    const blocker = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid as number;
    await client.query("BEGIN");
    await client.query(`SELECT code FROM novedu_codes WHERE code = $1 FOR UPDATE`, [code]);

    // The save blocks on its FOR SHARE until the delete commits…
    const save = saveQuizResult(userId, { id: randomUUID(), code, ...RESULT }, "this-time");
    await untilBlockedBy(blocker);
    await client.query(`DELETE FROM novedu_quiz_results WHERE code = $1`, [code]);
    await client.query(`DELETE FROM novedu_codes WHERE code = $1`, [code]);
    await client.query("COMMIT");

    // …then finds the code gone and writes nothing.
    await expect(save).resolves.toBe("code-gone");
    expect(await rowsOf(userId)).toEqual([]);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await cleanup(userId, code);
  }
});

test("always rolls back as a whole: a failed insert leaves the setting off", {
  tag: ["@live", "@live-db"],
}, async () => {
  const userId = `e2e-${randomUUID()}`;
  const code = await mintCode({ module: "quiz" });
  try {
    // Out of int4 range: the insert fails after the setting was upserted (the
    // action's validation would never let this through — the store's atomicity
    // is what is under test).
    const broken = { id: randomUUID(), code, ...RESULT, correct: 2 ** 31, total: 2 ** 31 + 1 };
    await expect(saveQuizResult(userId, broken, "always")).resolves.toBeUndefined();
    await expect(getUserSettings(userId)).resolves.toEqual({ saveQuizResults: false });
    expect(await rowsOf(userId)).toEqual([]);

    await expect(
      saveQuizResult(userId, { id: randomUUID(), code, ...RESULT }, "always"),
    ).resolves.toBe("saved");
    await expect(getUserSettings(userId)).resolves.toEqual({ saveQuizResults: true });
  } finally {
    await cleanup(userId, code);
  }
});

test("an automatic save racing the switch-off writes nothing", {
  tag: ["@live", "@live-db"],
}, async () => {
  const userId = `e2e-${randomUUID()}`;
  const code = await mintCode({ module: "quiz" });
  const client = await getPool().connect();
  try {
    expect(await updateUserSettings(userId, { saveQuizResults: true })).toBe(true);

    // The switch-off holds the row lock while the automatic save starts…
    const blocker = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid as number;
    await client.query("BEGIN");
    await client.query(
      `UPDATE novedu_user_settings SET save_quiz_results = false WHERE user_id = $1`,
      [userId],
    );
    const save = saveQuizResult(userId, { id: randomUUID(), code, ...RESULT }, "automatic");
    await untilBlockedBy(blocker);
    await client.query("COMMIT");

    // …so the save reads the committed "off".
    await expect(save).resolves.toBe("not-saved");
    expect(await rowsOf(userId)).toEqual([]);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await cleanup(userId, code);
  }
});

test("own results are only ever the session user's: list, count and delete", {
  tag: ["@live", "@live-db"],
}, async () => {
  const [a, b] = [`e2e-${randomUUID()}`, `e2e-${randomUUID()}`];
  const code = await mintCode({ module: "quiz" });
  try {
    for (const user of [a, b, b]) {
      expect(await saveQuizResult(user, { id: randomUUID(), code, ...RESULT }, "this-time")).toBe(
        "saved",
      );
    }
    expect((await listOwnQuizResults(a))?.map((r) => r.code)).toEqual([code]);
    await expect(countOwnQuizResults(b)).resolves.toBe(2);

    await expect(deleteOwnQuizResults(a)).resolves.toBe(1);
    expect(await rowsOf(a)).toEqual([]);
    expect(await rowsOf(b)).toHaveLength(2);
  } finally {
    await cleanup(a, code);
    await cleanup(b, code);
  }
});

test("seeded results show on the start page, the Settings page deletes them, badges stay", {
  tag: ["@live", "@live-db"],
}, async ({ page, context }) => {
  const principal = await signInFreshStudent(context, "Quinn Quizzer");
  const code = await mintCode({ module: "quiz", note: "Linked lists 3AHIF", endOffset: 86_400 });
  const reportId = randomUUID();
  const today = todayLocal(new Date());
  try {
    // Two attempts 9 and 16 days ago: silver best, the last one weaker → a nudge,
    // and Improved is NOT earned (the second is worse), Refreshed is (7 days apart).
    await query(
      `INSERT INTO novedu_quiz_results (id, user_id, code, correct, partial, incorrect, unanswered, total, finished_at)
       VALUES ($1, $3, $4, 4, 0, 1, 0, 5, $5), ($2, $3, $4, 3, 0, 1, 1, 5, $6)`,
      [
        randomUUID(),
        randomUUID(),
        principal.id,
        code,
        `${addDays(today, -16)}T10:00:00Z`,
        `${addDays(today, -9)}T10:00:00Z`,
      ],
    );
    // An own report, resolved two days ago: Bug Hunter.
    await query(
      `INSERT INTO novedu_reports (id, kind, code, user_id, reaction, created_at, resolved_at, resolved_by)
       VALUES ($1, 'chat', $2, $3, 'wrong', now() - interval '3 days', $4, 'e2e-teacher')`,
      [reportId, code, principal.id, `${addDays(today, -2)}T10:00:00Z`],
    );

    await page.goto("/");
    const refresh = page.getByRole("region", { name: "Time to refresh" });
    await expect(refresh).toContainText("Linked lists 3AHIF");
    await expect(refresh).toContainText("Last 60 %, 9 days ago · best 80 %");
    await expect(refresh.getByRole("link", { name: "Retake Linked lists 3AHIF" })).toHaveAttribute(
      "href",
      `/${code}`,
    );
    await expect(refresh).toContainText("0 gold1 silver0 bronze");

    const quiz = page.locator('[data-family="quiz"]');
    await expect(quiz.locator('[data-badge="quiz-first-result"]')).toContainText("Earned");
    await expect(quiz.locator('[data-badge="quiz-refreshed"]')).toContainText("Earned");
    await expect(quiz.locator('[data-badge="quiz-improved"]')).not.toContainText("Earned");
    await expect(page.locator('[data-family="secret"] [data-badge="bug-hunter"]')).toContainText(
      "Bug Hunter",
    );
    const stored = await query<{ achievement_id: string; qualified_on: string }>(
      `SELECT achievement_id, qualified_on::text AS qualified_on FROM novedu_achievements
       WHERE user_id = $1 AND achievement_id IN ('bug-hunter', 'quiz-first-result', 'quiz-refreshed')
       ORDER BY achievement_id`,
      [principal.id],
    );
    expect(stored).toEqual([
      { achievement_id: "bug-hunter", qualified_on: addDays(today, -2) },
      { achievement_id: "quiz-first-result", qualified_on: addDays(today, -16) },
      { achievement_id: "quiz-refreshed", qualified_on: addDays(today, -9) },
    ]);

    // The Settings page — reached by CLIENT navigation, so the start page sits in
    // the browser's router cache — counts and deletes them; the earned badges stay.
    await page.getByRole("button", { name: /Quinn Quizzer/ }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page.getByText("You have 2 saved results.")).toBeVisible();
    await page.getByRole("button", { name: "Delete my saved results" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("You have no saved results.")).toBeVisible();
    // Back (no reload) must not restore the deleted medals from that cache.
    await page.goBack();
    await expect(page.getByText(/^Save a result on a quiz's summary page/)).toBeVisible();
    await expect(page.getByText("Linked lists 3AHIF")).toHaveCount(0);
    expect(await rowsOf(principal.id)).toEqual([]);
    const kept = await query<{ n: string }>(
      `SELECT count(*) AS n FROM novedu_achievements WHERE user_id = $1 AND achievement_id LIKE 'quiz-%'`,
      [principal.id],
    );
    expect(kept[0]?.n).toBe("2");
  } finally {
    await query(`DELETE FROM novedu_reports WHERE id = $1`, [reportId]).catch(() => {});
    await query(`DELETE FROM novedu_codes WHERE code = $1`, [code]).catch(() => {});
    await deletePrincipal(principal.id).catch(() => {});
  }
});

// Through the teacher's real delete (the codes list's "Delete Selected"): the
// store's code-delete helper runs inside deleteCodesAndData's transaction.
test.describe("as the teacher principal", () => {
  test.use({ storageState: TEACHER_STORAGE_STATE });

  test("deleting a code drops its saved results", { tag: ["@live", "@live-db"] }, async ({
    page,
  }) => {
    const userId = `e2e-${randomUUID()}`;
    const note = `e2e quiz results ${randomUUID().slice(0, 8)}`;
    const code = await mintCode({ module: "quiz", note });
    try {
      await expect(
        saveQuizResult(userId, { id: randomUUID(), code, ...RESULT }, "this-time"),
      ).resolves.toBe("saved");

      await page.goto("/codes");
      await page.getByLabel("Filter codes").fill(note);
      // mintCode's rows belong to the e2e creator, not to the teacher principal.
      await page.getByLabel("Filter by owner").selectOption({ label: "All owners" });
      await page.getByRole("button", { name: "Apply" }).click();
      await page.getByRole("checkbox", { name: `Select ${note}` }).check();
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: /Delete .*selected/i }).click();
      await expect(page.getByRole("row").filter({ hasText: note })).toHaveCount(0);

      expect(await rowsOf(userId)).toEqual([]);
    } finally {
      await cleanup(userId, code);
    }
  });
});
