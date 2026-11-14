import { randomUUID } from "node:crypto";
import http from "node:http";
import { expect, test } from "@playwright/test";
import { fakeMoodle } from "@/tests/fake-moodle";
import { mintCode, purgeCodes, VALID_QUIZ_URL } from "./code.utils";
import { query } from "./db";
import {
  FAKE_MOODLE_CLIENT_ID,
  FAKE_MOODLE_DEPLOYMENT_ID,
  FAKE_MOODLE_ISSUER,
  FAKE_MOODLE_PORT,
} from "./moodle.constants";
import { deletePrincipal, signInFreshStudent } from "./principal.utils";

// The Moodle round trip against a FAKE platform (docs/testing.md, "Moodle"): a
// small HTTP server started here on the fixed port the e2e server's connection
// points at (playwright.config.ts) serves Moodle's key set, its authorization
// endpoint (which answers the login with a signed id_token, posted by the
// browser like Moodle's own page), the token endpoint and the score endpoint.
// The browser runs the real flow: login → launch → the arrival cookie →
// confirmation → the quiz (graded by the fake LLM) → "Hand in" → the fake
// receives score and comment. Then a second Novedu account with the same Moodle
// user is refused, and unlink removes the rows. The fake's issuer is never a
// real Moodle's, and the spec removes its users' rows afterwards.

test.use({ storageState: { cookies: [], origins: [] } });

const platform = fakeMoodle({
  issuer: FAKE_MOODLE_ISSUER,
  clientId: FAKE_MOODLE_CLIENT_ID,
  deploymentId: FAKE_MOODLE_DEPLOYMENT_ID,
});

/** What the fake's authorization endpoint signs into the next launch. */
let nextLaunch: { sub: string; code: string } | undefined;
const scores: Record<string, unknown>[] = [];
let server: http.Server;

function html(res: http.ServerResponse, body: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8">${body}`);
}

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

test.beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", FAKE_MOODLE_ISSUER);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");

    if (url.pathname === "/mod/lti/certs.php") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await platform.jwks()));
    } else if (url.pathname === "/mod/lti/auth.php" && nextLaunch) {
      const idToken = await platform.sign(
        platform.resourceClaims({
          nonce: url.searchParams.get("nonce") ?? "",
          code: nextLaunch.code,
          sub: nextLaunch.sub,
          name: "Mia Moodle",
          username: "mmoodle",
        }),
      );
      html(
        res,
        `<form id="f" method="post" action="${escape(url.searchParams.get("redirect_uri") ?? "")}">
          <input type="hidden" name="id_token" value="${escape(idToken)}">
          <input type="hidden" name="state" value="${escape(url.searchParams.get("state") ?? "")}">
        </form><script>document.getElementById("f").submit()</script>`,
      );
    } else if (url.pathname === "/mod/lti/token.php" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "fake-access-token", expires_in: 3600 }));
    } else if (url.pathname.endsWith("/lineitem/scores") && req.method === "POST") {
      scores.push(JSON.parse(body));
      res.writeHead(200);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(FAKE_MOODLE_PORT, "127.0.0.1", resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const loginUrl = () =>
  `/api/lti/login?${new URLSearchParams({
    iss: FAKE_MOODLE_ISSUER,
    client_id: FAKE_MOODLE_CLIENT_ID,
    login_hint: "2",
    lti_message_hint: "e2e",
  })}`;

const linkRows = (userId: string) =>
  query<{ moodle_user_id: string }>(
    `SELECT moodle_user_id FROM novedu_moodle_links WHERE user_id = $1 AND issuer = $2`,
    [userId, FAKE_MOODLE_ISSUER],
  );

test("login → launch → link → hand-in reaches the platform; a second account is refused; unlink", {
  tag: ["@live", "@live-db"],
}, async ({ page, browser }) => {
  test.setTimeout(180_000);
  const code = await mintCode({ module: "quiz", file: VALID_QUIZ_URL, moodle: true });
  const sub = `e2e-moodle-${randomUUID()}`;
  const student = await signInFreshStudent(page.context(), "Mia Novedu");
  const otherContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const other = await signInFreshStudent(otherContext, "Max Other");
  try {
    // 1. Arriving from Moodle: the confirmation page names both accounts.
    nextLaunch = { sub, code };
    await page.goto(loginUrl());
    await expect(page).toHaveURL(/\/lti\/link$/);
    await expect(page.getByTestId("link-moodle")).toHaveText("Mia Moodle (mmoodle)");
    await expect(page.getByTestId("link-novedu")).toContainText("Mia Novedu");

    // 2. Confirm → the quiz page, with the link and the target stored.
    await page.getByRole("button", { name: "Yes, these are both me" }).click();
    await expect(page).toHaveURL(new RegExp(`/${code}$`));
    expect(await linkRows(student.id)).toEqual([{ moodle_user_id: sub }]);

    // 3. Answer (graded by the fake LLM), finish and hand in.
    await page.getByRole("textbox").fill("4");
    await page.getByRole("button", { name: "Submit answer" }).click();
    await expect(page.getByRole("heading", { name: /^correct$/i })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "Finish" }).click();
    const box = page.getByTestId("moodle-hand-in");
    await expect(box).toContainText("Moodle receives: 1 question — 1 correct (100 %).");
    await box.getByRole("button", { name: "Hand in" }).click();
    await expect(box).toContainText("Handed in to Moodle on");
    expect(scores).toEqual([
      expect.objectContaining({
        userId: sub,
        scoreGiven: 1,
        scoreMaximum: 1,
        comment: "Novedu quiz: 1 question — 1 correct.",
        activityProgress: "Completed",
        gradingProgress: "FullyGraded",
      }),
    ]);

    // 4. Another Novedu account arriving as the same Moodle user is refused.
    const otherPage = await otherContext.newPage();
    nextLaunch = { sub, code };
    await otherPage.goto(loginUrl());
    await expect(otherPage).toHaveURL(/\/lti\/done\?state=mismatch-moodle/);
    await expect(
      otherPage.getByRole("heading", { name: "This Moodle account can't be used here" }),
    ).toBeVisible();
    expect(await linkRows(other.id)).toEqual([]);

    // 5. Unlink in Settings removes the link and every target.
    await page.goto("/settings");
    await page.getByRole("button", { name: "Unlink my Moodle account" }).click();
    await page.getByRole("button", { name: "Unlink", exact: true }).click();
    await expect(page.getByText("Your Moodle account is no longer linked.")).toBeVisible();
    expect(await linkRows(student.id)).toEqual([]);
    expect(
      await query(`SELECT 1 FROM novedu_moodle_targets WHERE user_id = $1`, [student.id]),
    ).toEqual([]);
  } finally {
    nextLaunch = undefined;
    await otherContext.close();
    await deletePrincipal(student.id);
    await deletePrincipal(other.id);
    await purgeCodes([code]);
  }
});
