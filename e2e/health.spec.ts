import { loadEnvConfig } from "@next/env";
import { expect, test } from "@playwright/test";
import { E2E_TEACHER, TEACHER_STORAGE_STATE } from "./auth.constants";
import { E2E_IMAGE_ROOT } from "./image-root.constants";
import { assertServerImageRoot } from "./image-root.utils";

// Read the dev server's .env the way Next does, so the optional-provider
// assertions below mirror exactly what the server sees (AZURE_FOUNDRY_ENDPOINT /
// OPENROUTER_API_KEY set or not).
loadEnvConfig(process.cwd());

// The /health page renders its shell immediately (the server only gates access
// and supplies session facts); the connectivity probes are fetched by the
// client from the teacher-only /api/health endpoint and each indicator updates
// as its own result arrives. The student block runs on the project-default
// storage state (no isTeacher claim); the teacher block opts into the teacher
// state, mirroring permissions.spec.ts.

test.describe("as a student", () => {
  test("the Health page is denied", async ({ page }) => {
    await page.goto("/health");

    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    // None of the indicators are rendered.
    await expect(page.getByTestId("health-db")).toHaveCount(0);
  });

  test("the health API responds 403", async ({ page }) => {
    // The API is the enforcement point (the page check is only UX) — hit it
    // directly with the student's session cookie.
    const res = await page.request.get("/api/health?probe=db");

    expect(res.status()).toBe(403);
  });
});

test.describe("as a teacher", () => {
  test.use({ storageState: TEACHER_STORAGE_STATE });

  // Untagged/hermetic: the image storage root is local filesystem state the
  // `image-root` setup project provisions on every run (in CI too), unlike the
  // DB/SCCH probes below. Also doubles as the harness's own sanity check that
  // the dev server under test booted with e2e/.image-root, not some other root
  // (the actionable failure mode assertServerImageRoot exists for).
  test("resolves the image storage root probe against the harness root", async ({ request }) => {
    // Asserts the root itself AND (via the detail text it checks) that the
    // probe reports OK — a mismatched or unprovisioned root fails this first,
    // with the actionable message, before the plain OK assertion below runs.
    await assertServerImageRoot(request, E2E_IMAGE_ROOT);

    const res = await request.get("/api/health?probe=images");
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  // @live: probes hit the real database + SCCH endpoint — excluded in CI (test:e2e:ci).
  test("renders the shell immediately and resolves all probes", {
    tag: ["@live", "@live-llm"],
  }, async ({ page }) => {
    await page.goto("/health");

    // Shell facts (session-derived, no probe round-trip) are correct at once.
    await expect(page.getByRole("heading", { name: "Health" })).toBeVisible();
    await expect(page.getByTestId("health-user")).toHaveText(
      `${E2E_TEACHER.name} — ${E2E_TEACHER.email}`,
    );
    await expect(page.getByTestId("health-teacher")).toHaveText("Yes");

    // Probe rows resolve asynchronously. DB and SCCH hit the real dependencies
    // configured in .env — both must be reachable from the dev machine. The
    // image storage root is local (provisioned by the `image-root` setup
    // project), so it resolves OK here too, same as the dedicated test above.
    await expect(page.getByTestId("health-db")).toContainText("OK");
    await expect(page.getByTestId("health-images")).toContainText("OK");
    await expect(page.getByTestId("health-scch")).toContainText("OK");
    await expect(page.getByTestId("health-scch")).toContainText("models available");

    // Host + at least one resolved IP for both dependency hosts. The hosts
    // come from .env — an FQDN, or a single label such as `localhost` or a
    // Compose service name — so assert shape (host — address), not values.
    const hostPattern = /\S+ — \d+\.\d+\.\d+\.\d+|\S+ — [0-9a-f:]+/i;
    await expect(page.getByTestId("health-db-host")).toHaveText(hostPattern);
    await expect(page.getByTestId("health-scch-host")).toHaveText(hostPattern);

    // Azure Foundry is optional: when configured, its probe must pass (Entra
    // token + a model listing) and name the credential kind the env selects;
    // when not, its rows must not exist.
    if (process.env.AZURE_FOUNDRY_ENDPOINT) {
      const credential = process.env.AZURE_FOUNDRY_CLIENT_CERTIFICATE
        ? "service principal, certificate"
        : process.env.AZURE_FOUNDRY_CLIENT_SECRET
          ? "service principal, secret"
          : "managed identity / az login";
      await expect(page.getByTestId("health-foundry")).toContainText("OK");
      await expect(page.getByTestId("health-foundry")).toContainText("models available");
      await expect(page.getByTestId("health-foundry")).toContainText(`(${credential})`);
      await expect(page.getByTestId("health-foundry-host")).toHaveText(hostPattern);
    } else {
      await expect(page.getByTestId("health-foundry")).toHaveCount(0);
      await expect(page.getByTestId("health-foundry-host")).toHaveCount(0);
    }

    // OpenRouter is optional too: the API key alone makes it configured, and a
    // single authenticated model listing proves the key (no token step).
    if (process.env.OPENROUTER_API_KEY) {
      await expect(page.getByTestId("health-openrouter")).toContainText("OK");
      await expect(page.getByTestId("health-openrouter")).toContainText("models available");
      await expect(page.getByTestId("health-openrouter-host")).toHaveText(hostPattern);
    } else {
      await expect(page.getByTestId("health-openrouter")).toHaveCount(0);
      await expect(page.getByTestId("health-openrouter-host")).toHaveCount(0);
    }
  });

  test("the nav menu links to the Health page", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await page.getByRole("link", { name: "Health" }).click();

    // App-router client navigation updates the URL only once the RSC payload
    // arrives — the first dev compile of /health can take a while.
    await expect(page).toHaveURL("/health");
    await expect(page.getByRole("heading", { name: "Health" })).toBeVisible();
  });
});
