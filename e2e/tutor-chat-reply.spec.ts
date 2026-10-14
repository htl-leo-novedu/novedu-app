import { loadEnvConfig } from "@next/env";
import { expect, test } from "@playwright/test";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { sendAndExpectReply } from "./chat.utils";
import { LIVE_TOOLS_TUTOR_URL, LIVE_TUTOR_URL, mintTutorCode } from "./code.utils";
import { setEditorContent } from "./page.utils";

// A REAL end-to-end chat, run once per LLM PROVIDER (`@live-llm`, real mode
// only): open a tutor code, send "Hi!", and assert the tutor streams back a
// non-empty answer (content doesn't matter — only that it replies without
// error). Unlike `tutor-code-link.spec.ts`, this DOES hit the LLM; it also
// exercises the `tutor` agent's Mastra Memory (the turn is persisted to the
// configured database store, scoped to the tutor code as resourceId). The
// random_number tool test in between runs against the fake LLM instead.
//
// - SCCH: the local fixtures server's live-tutor.yaml (a real model).
// - Azure Foundry: proves Entra auth (Managed Identity / `az login` or the
//   Foundry service principal) + deployment-as-model
//   end-to-end through Mastra. Its tutor YAML is authored app-hosted through
//   /files/new (the quiz.spec pattern). Skipped when AZURE_FOUNDRY_ENDPOINT is
//   not set. The other module specs stay SCCH-only by design.
// - OpenRouter: proves the other auth shape — a STATIC API key (no token step,
//   no MI) — plus `vendor/model` id resolution end-to-end through Mastra, which
//   neither of the two other legs exercises. Same app-hosted authoring pass.
//   Skipped when OPENROUTER_API_KEY is not set.
//
// The send-and-await-reply sequence itself is shared with the other module chat
// specs — `sendAndExpectReply` in e2e/chat.utils.ts.

// Read the dev server's .env the way Next does, so the optional-provider skips
// (AZURE_FOUNDRY_ENDPOINT / OPENROUTER_API_KEY) mirror exactly what the server sees.
loadEnvConfig(process.cwd());

// Minimal valid tutor (no fragment files) pointing at a Foundry deployment. It
// stays inline and is authored through /files/new — NOT a served fixture —
// because (a) the authoring pass is deliberate coverage of the save-time strict
// validation of a `provider: Azure Foundry` tutor, and (b) a Foundry deployment
// name is environment-specific, so it has no place in the content-stable
// fixture tree (docs/testing.md's fixture-model taxonomy).
const FOUNDRY_TUTOR = `id: e2e-foundry-tutor
name: "E2E Foundry Tutor"
description: "A minimal tutor used to smoke-test the Azure Foundry provider."
llm:
  model: gpt-5.4-mini
  provider: Azure Foundry
prompt:
  tutor_instructions: |
    You are a friendly tutor. Answer briefly.
`;

// The OpenRouter counterpart, inline and authored through /files/new for the same
// two reasons: the save-time strict validation of a `provider: OpenRouter` tutor is
// deliberate coverage, and the `vendor/model` id is account-/catalog-specific, so it
// has no place in the content-stable fixture tree.
const OPENROUTER_TUTOR = `id: e2e-openrouter-tutor
name: "E2E OpenRouter Tutor"
description: "A minimal tutor used to smoke-test the OpenRouter provider."
llm:
  model: z-ai/glm-5.3-flash
  provider: OpenRouter
prompt:
  tutor_instructions: |
    You are a friendly tutor. Answer briefly.
`;

test.describe("via SCCH", () => {
  // @live: needs the real SCCH endpoint + the database — excluded in CI (test:e2e:ci).
  test("sending a message gets a non-empty reply from an SCCH tutor", {
    tag: ["@live", "@live-llm"],
  }, async ({ page }) => {
    await page.goto(`/${await mintTutorCode({ tutor: LIVE_TUTOR_URL })}`);
    await sendAndExpectReply(page);
  });
});

// The tool round-trip: a tutor with `tools: [random_number]` is asked for a random
// number in a range. Asserts the full server-side tool path (per-request tools
// resolver → Mastra tool execution → the result fed back to the model): the fake
// LLM (docs/testing.md, "Fake LLM") calls the tool on the `[tool:…]` marker and
// then echoes the tool result, so the reply carries a number INSIDE the requested
// range only if the tool really ran. A broken tools path fails loudly (resolver
// throw = no reply; unknown tool = a failed run).
// @live-db: mints the code through e2e/db.ts — runs in CI.
test("a tutor with the random_number tool weaves a tool result into its reply", {
  tag: ["@live", "@live-db"],
}, async ({ page }) => {
  await page.goto(`/${await mintTutorCode({ tutor: LIVE_TOOLS_TUTOR_URL })}`);

  const composer = page.getByTestId("copilot-chat-textarea");
  await expect(composer).toBeVisible();
  await composer.fill(
    '[tool:random_number {"min":100000,"max":999999}] Give me a random number between 100000 and 999999.',
  );
  await page.getByTestId("copilot-send-button").click();

  // After a tool round-trip the reply renders as TWO nodes with this testid (a
  // hidden tool-call wrapper + the visible text message) — take the last one.
  const assistant = page.getByTestId("copilot-assistant-message").last();
  await expect(assistant).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () => {
        const text = (await assistant.innerText()).trim();
        const match = text.match(/\b(\d{6})\b/);
        return match ? Number(match[1]) : 0;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(100_000);
  await expect(page.getByText(/not found after runtime sync/i)).toHaveCount(0);
});

test.describe("via Azure Foundry", () => {
  // Authoring the app-hosted tutor file needs a teacher session (the chat at
  // /<code> works for any signed-in user, so the teacher session covers both).
  test.use({ storageState: TEACHER_STORAGE_STATE });

  // @live: needs the Foundry endpoint (an identity with the Cognitive Services
  // OpenAI User role — MI / `az login`, or the AZURE_FOUNDRY_* service principal)
  // + the database — excluded in CI (test:e2e:ci).
  test("sending a message gets a non-empty reply from a Foundry tutor", {
    tag: ["@live", "@live-llm"],
  }, async ({ page }) => {
    test.skip(!process.env.AZURE_FOUNDRY_ENDPOINT, "AZURE_FOUNDRY_ENDPOINT is not set");

    // 1. Author the tutor file (kind=tutor → strict-validated, then stored).
    const name = `e2e-foundry-tutor-${Date.now()}`;
    await page.goto("/files/new");
    await page.getByLabel(/Name/).fill(name);
    await page.getByLabel("Kind").selectOption("tutor");
    await setEditorContent(page, FOUNDRY_TUTOR);
    await page.getByRole("button", { name: "Validate & create" }).click();
    await expect(page).toHaveURL(new RegExp(`/files/edit/${name}$`), { timeout: 60_000 });

    // 2. Mint a tutor code pointing at the authored file's public URL and chat.
    const tutorUrl = `${new URL(page.url()).origin}/api/files/${name}`;
    await page.goto(`/${await mintTutorCode({ tutor: tutorUrl, note: "e2e foundry tutor" })}`);
    await sendAndExpectReply(page);
  });
});

test.describe("via OpenRouter", () => {
  // Authoring the app-hosted tutor file needs a teacher session (the chat at
  // /<code> works for any signed-in user, so the teacher session covers both).
  test.use({ storageState: TEACHER_STORAGE_STATE });

  // @live: needs OPENROUTER_API_KEY (a static key — no Entra token, no MI) +
  // the database — excluded in CI (test:e2e:ci).
  test("sending a message gets a non-empty reply from an OpenRouter tutor", {
    tag: ["@live", "@live-llm"],
  }, async ({ page }) => {
    test.skip(!process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY is not set");

    // 1. Author the tutor file (kind=tutor → strict-validated, then stored).
    const name = `e2e-openrouter-tutor-${Date.now()}`;
    await page.goto("/files/new");
    await page.getByLabel(/Name/).fill(name);
    await page.getByLabel("Kind").selectOption("tutor");
    await setEditorContent(page, OPENROUTER_TUTOR);
    await page.getByRole("button", { name: "Validate & create" }).click();
    await expect(page).toHaveURL(new RegExp(`/files/edit/${name}$`), { timeout: 60_000 });

    // 2. Mint a tutor code pointing at the authored file's public URL and chat.
    const tutorUrl = `${new URL(page.url()).origin}/api/files/${name}`;
    await page.goto(`/${await mintTutorCode({ tutor: tutorUrl, note: "e2e openrouter tutor" })}`);
    await sendAndExpectReply(page);
  });
});
