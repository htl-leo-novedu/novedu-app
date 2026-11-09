import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { expect, type Page, test } from "@playwright/test";
import { BRAND } from "../lib/brand";
import { mintSessionToken } from "./api-auth.utils";
import { E2E_STUDENT, TEACHER_STORAGE_STATE } from "./auth.constants";
import { mintCode } from "./code.utils";
import { query } from "./db";
import { E2E_IMAGE_ROOT } from "./image-root.constants";
import { assertServerImageRoot } from "./image-root.utils";

// @live @live-db: the app-hosted image lifecycle end to end, against the LOCAL
// filesystem storage root (e2e/.image-root, provisioned by the `image-root`
// setup project — no real Azure Files needed here) and the real database
// (novedu_images / novedu_codes / novedu_user_chats). It needs no Azure
// credentials, so it runs in CI (test:e2e:ci) — see docs/testing.md.
//
// Exercises BOTH image routes over real HTTP, never bypassing them by
// importing lib/image-store or lib/image-fs directly: the bearer multipart upload (POST /api/images/<name>), the
// cookie-session byte route (GET /api/image-content/<id>), and the web upload
// form + delete UI. The "student" phase runs on the project's DEFAULT storage
// state (a real student, not a teacher in view-as-student mode).

loadEnvConfig(process.cwd());

const RED_PNG = path.join(process.cwd(), "e2e", "fixtures", "red.png");
const EVIL_SVG = path.join(process.cwd(), "e2e", "fixtures", "evil.svg");

// The quiz runner shows ONE question at a time and only advances past it once
// it is GRADED (a real LLM call, deliberately out of scope for an @live-db
// spec) — so each hosted image gets its OWN single-question quiz code rather
// than two questions riding one code. The image name to reference rides in as
// `?image=<name>`.
let quizServer: http.Server;

test.beforeAll(async () => {
  quizServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const imageName = url.searchParams.get("image") ?? "";
    res.writeHead(200, { "content-type": "application/yaml" });
    res.end(buildQuizYaml(imageName));
  });
  await new Promise<void>((resolve) => quizServer.listen(0, "127.0.0.1", resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => quizServer.close(() => resolve()));
});

function buildQuizYaml(imageName: string): string {
  return `id: e2e_image_lifecycle_quiz
llm:
  model: test-model
shuffle: false
questions:
  - id: q1
    title: Image question
    question: "What do you see in the image above?"
    evaluation: "Any answer is acceptable for this display-only e2e."
    image:
      hosted: true
      src: ${imageName}
`;
}

function quizUrlFor(port: number, imageName: string): string {
  return `http://127.0.0.1:${port}/quiz.yaml?image=${encodeURIComponent(imageName)}`;
}

async function filterImagesTo(page: Page, name: string): Promise<void> {
  await page.getByLabel("Filter images").fill(name);
  await page.getByRole("button", { name: "Apply" }).click();
}

async function deleteSelectedImage(page: Page, name: string): Promise<void> {
  // owner=all: the SVG was uploaded via the API as a DIFFERENT teacher
  // principal (mintSessionToken's default `e2e-api-teacher`) than this
  // browser session (`TEACHER_STORAGE_STATE` / `e2e-teacher`) — the list's
  // default owner scope is "my own uploads", which would hide it.
  await page.goto("/images?owner=all");
  await filterImagesTo(page, name);
  await page.getByRole("checkbox", { name: `Select ${name}` }).check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /Delete .*selected/i }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
}

test.describe("app-hosted image lifecycle", () => {
  // Two uploads (form + API), several FIRST-TIME dev compiles (/images/new,
  // /images, two /<code> quiz pages, /), a real filesystem round trip, and
  // several access-control probes — a cold dev server needs real room here.
  test.setTimeout(240_000);

  test("upload, serve, expire, sandbox and delete", { tag: ["@live", "@live-db"] }, async ({
    page,
    browser,
    request,
  }) => {
    const run = Date.now();
    const pngName = `e2e-life-png-${run}`;
    const svgName = `e2e-life-svg-${run}`;
    const pngBytes = await readFile(RED_PNG);
    const svgBytes = await readFile(EVIL_SVG);

    const teacherContext = await browser.newContext({ storageState: TEACHER_STORAGE_STATE });
    const teacherPage = await teacherContext.newPage();

    let pngId = "";
    let svgId = "";
    let pngCode = "";
    let svgCode = "";
    let pngRowActive = false;
    let svgRowActive = false;

    try {
      // ---- 0. Harness sanity: the dev server under test uses the harness
      // root, not some other IMAGE_STORAGE_ROOT a reused server booted with.
      await assertServerImageRoot(teacherContext.request, E2E_IMAGE_ROOT);

      // ---- 1. TEACHER (web form): upload the PNG.
      await teacherPage.goto("/images/new");
      await teacherPage.getByLabel(/Name/).fill(pngName);
      await teacherPage.locator('input[type="file"]').setInputFiles(RED_PNG);
      await teacherPage.getByRole("button", { name: "Upload image" }).click();
      await expect(teacherPage).toHaveURL(/\/images$/);
      pngRowActive = true;

      await filterImagesTo(teacherPage, pngName);
      const pngRow = teacherPage.getByRole("row").filter({ hasText: pngName });
      await expect(pngRow).toHaveCount(1);
      await pngRow.getByRole("button", { name: `View image ${pngName}` }).click();
      const pngLightboxImg = teacherPage.getByRole("img", { name: pngName });
      await expect(pngLightboxImg).toBeVisible();
      await expect
        .poll(() => pngLightboxImg.evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(0);
      const pngUrl = await pngLightboxImg.getAttribute("src");
      expect(pngUrl).toMatch(/^\/api\/image-content\//);
      pngId = (pngUrl ?? "").split("/").pop() ?? "";
      await teacherPage.getByRole("button", { name: "Close" }).click();

      // ---- 2. API (bearer multipart): upload the evil SVG under a new name.
      const teacherToken = await mintSessionToken({ teacher: true });
      const uploadSvg = () =>
        request.post(`/api/images/${svgName}`, {
          headers: { authorization: `Bearer ${teacherToken}` },
          multipart: {
            file: { name: "evil.svg", mimeType: "image/svg+xml", buffer: svgBytes },
            mime: "image/svg+xml",
          },
        });

      const upload = await uploadSvg();
      expect(upload.status()).toBe(201);
      const uploaded = (await upload.json()) as { id: string; name: string };
      svgId = uploaded.id;
      svgRowActive = true;
      expect(uploaded.name).toBe(svgName);

      // Re-uploading the SAME name conflicts — create-only, immutable images.
      const conflict = await uploadSvg();
      expect(conflict.status()).toBe(409);

      // mine=0: the PNG was uploaded as the TEACHER_STORAGE_STATE principal
      // (e2e-teacher), the SVG as this API token's principal
      // (mintSessionToken defaults to e2e-api-teacher) — two different
      // owners, so the default owner-scoped list would miss one.
      const list = await request.get("/api/images?mine=0", {
        headers: { authorization: `Bearer ${teacherToken}` },
      });
      expect(list.status()).toBe(200);
      const rows = (await list.json()) as { name: string; url: string }[];
      expect(rows.find((r) => r.name === pngName)?.url).toMatch(
        /^https?:\/\/.+\/api\/image-content\//,
      );
      expect(rows.find((r) => r.name === svgName)?.url).toMatch(
        /^https?:\/\/.+\/api\/image-content\//,
      );

      // ---- 3. STUDENT (default project storage state): the quiz runner shows
      // one question at a time and only advances once it is GRADED (a real
      // LLM call, out of scope here) — so each hosted image gets its own
      // single-question quiz code.
      const port = (quizServer.address() as AddressInfo).port;
      pngCode = await mintCode({ module: "quiz", file: quizUrlFor(port, pngName) });
      svgCode = await mintCode({ module: "quiz", file: quizUrlFor(port, svgName) });

      const pngContentUrl = `/api/image-content/${pngId}`;
      const svgContentUrl = `/api/image-content/${svgId}`;

      await page.goto(`/${pngCode}`);
      const pngViewButton = page.getByRole("button", { name: "View larger image" });
      await expect(pngViewButton).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("Image could not be loaded")).toHaveCount(0);
      await expect
        .poll(() =>
          pngViewButton.locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth),
        )
        .toBeGreaterThan(0);

      await page.goto(`/${svgCode}`);
      const svgViewButton = page.getByRole("button", { name: "View larger image" });
      await expect(svgViewButton).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("Image could not be loaded")).toHaveCount(0);
      await expect
        .poll(() =>
          svgViewButton.locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth),
        )
        .toBeGreaterThan(0);

      const plain = await page.request.get(pngContentUrl);
      expect(plain.status()).toBe(200);
      const headers = plain.headers();
      expect(headers["content-type"]).toBe("image/png");
      expect(await plain.body()).toEqual(pngBytes);
      expect(headers["cache-control"]).toBe("private, no-cache");
      expect(headers.etag).toBe(`"${pngId}"`);
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["content-security-policy"]).toBe("sandbox; default-src 'none'");

      const conditional = await page.request.get(pngContentUrl, {
        headers: { "if-none-match": `"${pngId}"` },
      });
      expect(conditional.status()).toBe(304);

      // ---- 4. Code expiry: the route re-checks only the IMAGE row, never the
      // code — bytes stay reachable after the code expires, and this route
      // never writes a user↔code link either way.
      await query(
        `UPDATE novedu_codes SET valid_until = now() - interval '1 minute' WHERE code = $1`,
        [pngCode],
      );
      const afterExpiry = await page.request.get(pngContentUrl);
      expect(afterExpiry.status()).toBe(200);
      const chatLinks = await query<{ count: string }>(
        `SELECT count(*) FROM novedu_user_chats WHERE user_id = $1 AND code = $2`,
        [E2E_STUDENT.id, pngCode],
      );
      expect(Number(chatLinks[0]?.count)).toBe(0);

      // ---- 5. Access control on the byte route itself.
      const signedOutContext = await browser.newContext({
        storageState: { cookies: [], origins: [] },
      });
      const signedOut = await signedOutContext.request.get(pngContentUrl, {
        maxRedirects: 0,
      });
      expect(signedOut.status()).toBeGreaterThanOrEqual(300);
      expect(signedOut.status()).toBeLessThan(400);
      expect(signedOut.headers().location).toContain("/sign-in");
      await signedOutContext.close();

      const garbageContext = await browser.newContext({
        storageState: {
          cookies: [
            {
              name: "novedu.session_token",
              value: "garbage",
              domain: "localhost",
              path: "/",
              httpOnly: true,
              secure: false,
              sameSite: "Lax",
              expires: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
          origins: [],
        },
      });
      const garbage = await garbageContext.request.get(pngContentUrl, { maxRedirects: 0 });
      expect(garbage.status()).toBe(401);
      await garbageContext.close();

      const malformed = await page.request.get("/api/image-content/not-a-uuid");
      expect(malformed.status()).toBe(404);

      // ---- 6. SVG sandboxing: direct navigation cannot execute the payload
      // or reach the app's real storage/title.
      await page.goto(svgContentUrl);
      const storageOutcome = await page.evaluate(() => {
        try {
          window.localStorage.getItem("pwned");
          return "accessible";
        } catch {
          return "blocked";
        }
      });
      expect(storageOutcome).toBe("blocked");

      await page.goto("/");
      const pwned = await page.evaluate(() => window.localStorage.getItem("pwned"));
      expect(pwned).toBeNull();
      await expect(page).toHaveTitle(BRAND);

      // ---- 7. Delete both images (teacher UI) — old URLs 404, re-upload gets
      // a fresh id and the old URL stays dead.
      await deleteSelectedImage(teacherPage, pngName);
      pngRowActive = false;
      await deleteSelectedImage(teacherPage, svgName);
      svgRowActive = false;

      const pngGone = await page.request.get(pngContentUrl);
      expect(pngGone.status()).toBe(404);
      const pngGoneConditional = await page.request.get(pngContentUrl, {
        headers: { "if-none-match": `"${pngId}"` },
      });
      expect(pngGoneConditional.status()).toBe(404);

      const reupload = await request.post(`/api/images/${pngName}`, {
        headers: { authorization: `Bearer ${teacherToken}` },
        multipart: {
          file: { name: "red.png", mimeType: "image/png", buffer: pngBytes },
          mime: "image/png",
        },
      });
      expect(reupload.status()).toBe(201);
      const reuploaded = (await reupload.json()) as { id: string };
      expect(reuploaded.id).not.toBe(pngId);
      pngRowActive = true; // the re-upload is a fresh active row

      const stillGoneAtOldId = await page.request.get(pngContentUrl);
      expect(stillGoneAtOldId.status()).toBe(404);
    } finally {
      // Cleanup — best-effort, never throws past this block, and never wipes
      // the shared root: only THIS run's own rows/code are touched. Close
      // via a direct row update (not the UI) for whatever the flow above did
      // not already close through it, so a mid-test failure leaves no active
      // stray row behind.
      if (pngCode) {
        await query(`DELETE FROM novedu_codes WHERE code = $1`, [pngCode]).catch(() => {});
      }
      if (svgCode) {
        await query(`DELETE FROM novedu_codes WHERE code = $1`, [svgCode]).catch(() => {});
      }
      if (pngRowActive) {
        await query(
          `UPDATE novedu_images SET valid_until = now(), closed_by = 'e2e' WHERE name = $1 AND valid_until IS NULL`,
          [pngName],
        ).catch(() => {});
      }
      if (svgRowActive) {
        await query(
          `UPDATE novedu_images SET valid_until = now(), closed_by = 'e2e' WHERE name = $1 AND valid_until IS NULL`,
          [svgName],
        ).catch(() => {});
      }
      await teacherContext.close();
    }
  });
});
