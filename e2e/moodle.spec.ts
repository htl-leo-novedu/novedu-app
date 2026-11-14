import { expect, test } from "@playwright/test";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { FAKE_MOODLE_ISSUER } from "./moodle.constants";

// Hermetic smokes of the Moodle surfaces (docs/moodle.md). The e2e server runs
// with a throwaway tool key and a connection pointing at the fake platform's
// address (playwright.config.ts), so the feature is available; nothing here
// talks to that platform. The full round trip is e2e/moodle-roundtrip.live.spec.ts.

test("the public key set answers without a session", async ({ request }) => {
  const response = await request.get("/api/lti/jwks", {
    headers: { cookie: "" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { keys: Record<string, unknown>[] };
  expect(body.keys).toHaveLength(1);
  expect(body.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
  expect(body.keys[0]).not.toHaveProperty("d");
});

test("/lti/arrive without an arrival ends on the expired message", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/lti/arrive");
  await expect(page).toHaveURL(/\/lti\/done\?state=expired$/);
  await expect(
    page.getByRole("heading", { name: "This link from Moodle has expired" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe("without a session", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("/lti/pick without a token shows its expired message", async ({ page }) => {
    await page.goto("/lti/pick");
    await expect(page.getByRole("heading", { name: "This page has expired" })).toBeVisible();
  });
});

test("a student's Settings page opens without the teacher's Moodle section", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Quiz results" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Moodle connection" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe("as a teacher", () => {
  test.use({ storageState: TEACHER_STORAGE_STATE });

  test("Settings shows the Moodle connection with Novedu's addresses", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Moodle connection" })).toBeVisible();
    await expect(page.getByTestId("moodle-connection-state")).toHaveText(
      `Connected to ${FAKE_MOODLE_ISSUER}.`,
    );
    await expect(page.getByText("http://localhost:3000/api/lti/launch")).toBeVisible();
    await expect(page.getByText(/-----BEGIN PUBLIC KEY-----/)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
