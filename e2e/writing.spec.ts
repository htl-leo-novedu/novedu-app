import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { sendAndExpectReply } from "./chat.utils";
import { mintCode, VALID_WRITING_URL } from "./code.utils";
import { query } from "./db";
import { setEditorContent } from "./page.utils";
import { deletePrincipal, signInFreshTeacher } from "./principal.utils";

// End-to-end coverage for the Writing module: a `novedu_codes` row with
// `module: "writing"` reached at `/<code>`. The student writes Markdown on the
// left, SAVES it (one row per (code, student) in `novedu_writing_submissions`),
// and a teacher reviews WHO saved on /codes/[code] (the savers list), opening a
// student to read their text on /codes/[code]/s/[userId].
//
// Every test needs the DB (@live-db, run in CI against the ephemeral Postgres
// container). The two chat legs — the getCurrentText read and the full
// write→chat→save→review round-trip — talk to the fake LLM (docs/testing.md,
// "Fake LLM").
//
// CopilotKit v2 testids (shared with the tutor/quiz chats):
//   copilot-chat-textarea, copilot-send-button, copilot-assistant-message.

test.use({ storageState: TEACHER_STORAGE_STATE });

// The fixture writing activity (attributed — anonymous:false enables Save +
// prefill + the teacher review showing text). ONE source for both consumption
// paths: the /files authoring flow pastes this text, and the round-trip test
// mints a code straight at the same file's served URL (VALID_WRITING_URL) —
// so the coach's "state the EXACT first line" contract lives in one place.
const SAMPLE_WRITING = readFileSync(
  path.join(process.cwd(), "test-fixtures", "activities", "writings", "test-writing.yaml"),
  "utf8",
);

// Authors a writing file via the teacher /files flow and mints a writing code for
// it.
async function authorWritingCode(page: Page): Promise<string> {
  // A per-call unique name so tests authoring files in parallel never collide on
  // the active-name unique index (a collision keeps the page on /files/new).
  const name = `e2e-writing-${Date.now()}-${randomInt(1_000_000)}`;
  await page.goto("/files/new");
  await page.getByLabel(/Name/).fill(name);
  await page.getByLabel("Kind").selectOption("writing");
  await setEditorContent(page, SAMPLE_WRITING);
  await page.getByRole("button", { name: "Validate & create" }).click();
  await expect(page).toHaveURL(new RegExp(`/files/edit/${name}$`), { timeout: 60_000 });

  const fileUrl = `${new URL(page.url()).origin}/api/files/${name}`;
  // anonymous:false so Save + the savers review apply (the SAMPLE_WRITING YAML is
  // attributed too; the frozen flag must agree for the teacher review to dispatch
  // to the savers list rather than the anonymous conversation-stats fallback).
  return mintCode({ module: "writing", file: fileUrl, anonymous: false });
}

// write → save → reload restores → teacher review shows the saved text, with the
// student shown by display NAME (resolved from novedu_user). No LLM.
//
// A fresh teacher drives this spec, so it is the saver's user_id and its own name
// ("Reviewed E2E Student") resolves through the real `listSavers` LEFT JOIN end to
// end — without renaming a shared principal other specs assert on.
const SAVER_NAME = "Reviewed E2E Student";

test("write → save → reload restores → teacher review", {
  tag: ["@live", "@live-db"],
}, async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const saver = await signInFreshTeacher(context, SAVER_NAME);
  const page = await context.newPage();
  const DRAFT = `# My essay\n\nThis is my first draft about linked lists.`;

  try {
    const code = await authorWritingCode(page);

    // 1. Open the writing activity and write a draft.
    await page.goto(`/${code}`);
    await expect(page.locator(".cm-content")).toBeVisible();
    await setEditorContent(page, DRAFT);

    // 2. Save it with Ctrl/⌘+S from inside the editor (lib/keyboard-shortcuts.ts;
    //    the round-trip test below clicks the button). It flips Save → Saved.
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

    // 3. Reload: the saved draft is prefilled back into the editor.
    await page.goto(`/${code}`);
    await expect(page.locator(".cm-content")).toContainText("first draft about linked lists");

    // 4. Teacher review on /codes/[code] is the savers list — one student saved,
    //    shown by display name (NOT the raw user id). Scoped to the Student cell,
    //    whose tooltip carries the id: the header renders the same principal's
    //    name too, because it is the signed-in one.
    await page.goto(`/codes/${code}`);
    const saverLink = page.getByTestId("saver-link");
    await expect(saverLink).toBeVisible();
    await expect(page.getByTitle(saver.id)).toHaveText(SAVER_NAME);

    // 5. Opening that student's page shows the saved text (rendered markdown) and the
    //    resolved name in the header.
    await saverLink.click();
    await expect(page).toHaveURL(new RegExp(`/codes/${code}/s/`));
    await expect(page.getByTestId("student-text")).toContainText("first draft about linked lists");
    await expect(page.getByTitle(saver.id)).toHaveText(SAVER_NAME);
  } finally {
    await context.close();
    await deletePrincipal(saver.id);
  }
});

// The assistant reads the LIVE editor buffer through the read-only getCurrentText
// frontend tool: the fake LLM calls it on the `[tool:getCurrentText]` marker, the
// browser runs it, and the fake echoes the tool result — so the draft's sentinel
// appears in the reply only if the buffer really reached the model.
test("the assistant reads the draft via getCurrentText", {
  tag: ["@live", "@live-db"],
}, async ({ page }) => {
  test.setTimeout(180_000);
  const code = await authorWritingCode(page);

  await page.goto(`/${code}`);
  await expect(page.locator(".cm-content")).toBeVisible();
  await setEditorContent(page, "BANANAPHONE is my opening line.\n\nThen the essay continues.");

  // Ask the coach to read the draft; the fake calls getCurrentText and echoes the
  // tool result, so the unique sentinel must appear in its reply.
  const composer = page.getByTestId("copilot-chat-textarea");
  await expect(composer).toBeVisible();
  await composer.fill("[tool:getCurrentText] Read my draft and state my exact first line.");
  await page.getByTestId("copilot-send-button").click();

  // The agent emits an intermediate tool-status message before its final reply, so
  // assert on the LAST assistant message (the text answer), not the whole set —
  // toContainText over a multi-element locator would trip strict mode.
  const assistant = page.getByTestId("copilot-assistant-message").last();
  await expect(assistant).toBeVisible({ timeout: 60_000 });
  await expect(assistant).toContainText("BANANAPHONE", { timeout: 90_000 });
  await expect(page.getByText(/not found after runtime sync/i)).toHaveCount(0);
});

// The full round-trip a teacher cares about: create a writing code from the
// published YAML, the student writes, asks the coach a question and gets SOME reply
// (the reply's content is NOT evaluated — only that an answer arrives), saves, and
// the teacher then finds the student in the stats and reads the captured text.
test("writing round-trip: write → chat reply → save → teacher reads the saved text", {
  tag: ["@live", "@live-db"],
}, async ({ page }) => {
  test.setTimeout(180_000);
  // A code straight at the fixture writing YAML — anonymous:false so Save + the
  // savers review apply. No local file to author or clean up.
  const code = await mintCode({
    module: "writing",
    file: VALID_WRITING_URL,
    anonymous: false,
    note: "e2e writing round-trip",
  });
  const DRAFT = "# Bond\n\nA UNIQUEMARKER story about a girl and her old dog walking home.";

  // 1. Open the activity and write a draft.
  await page.goto(`/${code}`);
  await expect(page.locator(".cm-content")).toBeVisible();
  await setEditorContent(page, DRAFT);

  // 2. Ask the coach anything; assert only that SOME assistant answer comes back.
  await sendAndExpectReply(page, {
    message: "Can you give me brief feedback on my story so far?",
    timeout: 90_000,
  });

  // 3. Save — this is what makes the text retrievable in the teacher review.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

  // 4. Teacher statistics: the savers list shows this student.
  await page.goto(`/codes/${code}`);
  const saver = page.getByTestId("saver-link");
  await expect(saver).toBeVisible();

  // 5. The captured text is retrievable on the student's page.
  await saver.click();
  await expect(page.getByTestId("student-text")).toContainText("UNIQUEMARKER");
});

// The table's constraints against the real database, via hand-written SQL (the
// store itself is covered by lib/writing-store.unit.test.ts): the (code, user_id)
// upsert key, newest-first ordering and per-code row removal. Uses the shared
// `e2e/db.ts` plain `pg` helper. Needs the DB, no LLM. Shares the per-worker pool
// from `e2e/db.ts` — no `closePool()` here, since other specs in this file (and
// the suite) still use it.
test("novedu_writing_submissions upsert key, newest-first ordering and per-code delete", {
  tag: ["@live", "@live-db"],
}, async () => {
  const suffix = randomInt(1_000_000).toString().padStart(6, "0");
  const code = `e2ewr${suffix}`;
  const userA = `e2e-user-a-${suffix}`;
  const userB = `e2e-user-b-${suffix}`;

  const upsert = async (userId: string, text: string) => {
    await query(
      `INSERT INTO novedu_writing_submissions (code, user_id, text, text_updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code, user_id) DO UPDATE SET text = excluded.text, text_updated_at = excluded.text_updated_at`,
      [code, userId, text, new Date()],
    );
  };

  const list = () =>
    query<{ user_id: string; text: string }>(
      `SELECT user_id, text
       FROM novedu_writing_submissions
       WHERE code = $1
       ORDER BY text_updated_at DESC`,
      [code],
    );

  try {
    await upsert(userA, "first version");
    // Upsert again on the SAME (code, user) key: one row, updated text.
    await upsert(userA, "second version");
    const afterUpdate = await list();
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0]?.text).toBe("second version");

    // A second student adds a row; the per-code read returns newest first.
    await upsert(userB, "b's text");
    const both = await list();
    expect(both.map((r) => r.user_id)).toEqual([userB, userA]);

    // The code-delete path drops every row for the code.
    await query(`DELETE FROM novedu_writing_submissions WHERE code = $1`, [code]);
    expect(await list()).toHaveLength(0);
  } finally {
    await query(`DELETE FROM novedu_writing_submissions WHERE code = $1`, [code]).catch(() => {});
  }
});
