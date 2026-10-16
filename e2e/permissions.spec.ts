import { expect, test } from "@playwright/test";
import { TEACHER_GUIDE_URL } from "../lib/teacher-guide";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { watchErrors } from "./page.utils";

// Authorization (not authentication) enforcement: signed-in students must be
// kept out of the teacher-only surfaces, and teachers must get in. The two nav
// tests are the ONE home for the menu's teacher-only entries — every such entry
// is asserted hidden here and visible there, rather than each feature's spec
// re-opening the same menu for its own link. The student
// runs on the project-default storage state (minted without the isTeacher
// claim); the teacher block opts into the teacher state.

test.describe("as a student", () => {
  test("the YAML Files page is denied", async ({ page }) => {
    await page.goto("/files");

    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    // No file list is rendered.
    await expect(page.getByRole("table")).toHaveCount(0);
  });

  test("the New Code page is denied", async ({ page }) => {
    await page.goto("/codes/new");

    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create code" })).toHaveCount(0);
  });

  test("the Codes page is denied", async ({ page }) => {
    await page.goto("/codes");

    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
  });

  test("the chat backend rejects DATA requests without a valid code", async ({ page }) => {
    // The code gate protects the DATA endpoints (run/connect/stop); GET /info is
    // auth-only metadata and intentionally needs no code (the read-only
    // conversation viewer relies on that). Probe a `run` with a malformed code —
    // it must be rejected before any thread/runtime work (pattern-rejected, so
    // this stays hermetic: no DB round-trip).
    const res = await page.request.post("/api/copilotkit/agent/tutor/run", {
      headers: { "x-code": "zzzzzzzzz!", "content-type": "application/json" },
      data: { threadId: "t", runId: "r", messages: [], tools: [], context: [], state: {} },
    });

    expect(res.status()).toBe(403);
  });

  test("the nav menu hides teacher-only entries", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation menu" }).click();

    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Teacher Guide" })).toHaveAttribute(
      "href",
      TEACHER_GUIDE_URL,
    );
    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("link").last(),
    ).toHaveText("Teacher Guide");
    await expect(page.getByRole("link", { name: "YAML Files" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Codes", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Health" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Usage" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Diagnostics" })).toHaveCount(0);
  });
});

test.describe("as a teacher", () => {
  test.use({ storageState: TEACHER_STORAGE_STATE });

  test("the YAML Files page is accessible", async ({ page }) => {
    await page.goto("/files");

    await expect(page.getByRole("link", { name: "New file" })).toBeVisible();
  });

  // Also the create page's smoke: it renders without errors, LLM quick picks included.
  test("the New Code page is accessible", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/codes/new");

    await expect(page.getByLabel("Activity YAML URL")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create code" })).toBeVisible();
    await expect(page.getByLabel("LLM quick pick")).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test("the nav menu shows the teacher-only entries", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation menu" }).click();

    // The menu's own entries: the teacher start page links the guide and Usage too.
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Teacher Guide" })).toHaveAttribute(
      "href",
      TEACHER_GUIDE_URL,
    );
    await expect(nav.getByRole("link").last()).toHaveText("Teacher Guide");
    await expect(nav.getByRole("link", { name: "YAML Files" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Codes", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Health" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Usage" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Diagnostics" })).toBeVisible();
  });
});
