import { loadEnvConfig } from "@next/env";
import { expect, test } from "@playwright/test";
import { LIVE_CODING_URL, mintCode, mintCodingKey } from "./code.utils";
import { fetchServedModel, type PiAgentResult, runPiAgent } from "./pi-agent.utils";

// A REAL external coding agent (pi, the engine under little-coder) talking to
// the coding module's public OpenAI-compatible endpoint, once per LLM PROVIDER:
// mint a coding code, mint a per-user API key for it (`novedu_coding_keys`,
// exactly like a student's `/{code}` visit would), point pi at the proxy with
// that key, and assert a non-empty answer comes back. Then ask the endpoint which model
// actually served the completion (the upstream's own `model` field, piped back
// unparsed) — so a silently failed per-code LLM override FAILS the test instead
// of passing with the wrong upstream's reply. This is the only e2e coverage of
// the override pair on the public coding route.
//
// Chat smoke only (`--no-tools`): SCCH models have produced malformed tool-call
// markup before, and the acceptance criterion is "non-empty response" —
// tool-call passthrough stays covered by the route integration test
// (app/api/coding/v1/chat/completions/route.unit.test.ts).
//
// The provider legs:
//
// - SCCH: the fixture's own pinned model, no override. Runs against the fake LLM
//   (docs/testing.md, "Fake LLM"), which answers any model id and echoes it back,
//   so the served-model check still proves the proxy forwarded the pinned model.
//   `@live-db` (it mints the code and the key through e2e/db.ts) — runs in CI.
// - Azure Foundry: the code's LLM override pair switches the upstream, proving
//   Entra auth (Managed Identity / `az login` or the Foundry service principal)
//   + deployment-as-model on the proxy path.
//   Skipped when AZURE_FOUNDRY_ENDPOINT is not set.
// - OpenRouter: the same override mechanism against the other auth shape — a
//   STATIC API key (no token step, no MI) — plus `vendor/model` id resolution.
//   Skipped when OPENROUTER_API_KEY is not set.
//
// No browser page is used — the Playwright webServer entries (dev server +
// fixtures server) provide everything.

// Read the dev server's .env the way Next does, so the optional-provider skips
// (AZURE_FOUNDRY_ENDPOINT / OPENROUTER_API_KEY) mirror exactly what the server sees.
loadEnvConfig(process.cwd());

// On a failed run the report must show WHY (a 401 from a bad mint, a 403
// window, a 502 fixture fetch, a provider error) — attach pi's full output.
async function attachPiOutput(result: PiAgentResult): Promise<void> {
  await test.info().attach("pi-stdout", { body: result.stdout, contentType: "text/plain" });
  await test.info().attach("pi-stderr", { body: result.stderr, contentType: "text/plain" });
}

// The raw completion JSON behind the model-identity check, for the same reason.
async function attachServedCompletion(raw: string): Promise<void> {
  await test
    .info()
    .attach("served-model-completion", { body: raw, contentType: "application/json" });
}

test("pi gets a non-empty reply through the coding proxy", {
  tag: ["@live", "@live-db"],
}, async () => {
  const code = await mintCode({
    module: "coding",
    file: LIVE_CODING_URL,
    note: "e2e pi agent (SCCH)",
  });
  const apiKey = await mintCodingKey({ code });

  const result = await runPiAgent({ apiKey, prompt: "Reply with exactly one word." });
  await attachPiOutput(result);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim().length).toBeGreaterThan(0);

  // The upstream must be the fixture's pinned SCCH model, not some fallback.
  const served = await fetchServedModel(apiKey);
  await attachServedCompletion(served.raw);
  expect(served.model.toLowerCase()).toContain("gemma");
});

test.describe("via Azure Foundry", () => {
  // The SAME SCCH fixture — the code's LLM override pair does the provider
  // switching, keeping the environment-specific Foundry deployment name out of
  // the content-stable fixture tree (the tutor-chat-reply.spec.ts reasoning).

  // @live: needs the Foundry endpoint (an identity with the Cognitive Services
  // OpenAI User role — MI / `az login`, or the AZURE_FOUNDRY_* service principal)
  // + the database — excluded in CI (test:e2e:ci).
  test("pi gets a non-empty reply from the overridden Foundry model", {
    tag: ["@live", "@live-llm"],
  }, async () => {
    test.skip(!process.env.AZURE_FOUNDRY_ENDPOINT, "AZURE_FOUNDRY_ENDPOINT is not set");

    const code = await mintCode({
      module: "coding",
      file: LIVE_CODING_URL,
      llm: { provider: "Azure Foundry", model: "gpt-5.4-mini" },
      note: "e2e pi agent (Foundry)",
    });
    const apiKey = await mintCodingKey({ code });

    const result = await runPiAgent({ apiKey, prompt: "Reply with exactly one word." });
    await attachPiOutput(result);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);

    // If the override silently fell back to the YAML default this reports
    // `gemma…` — the test must fail loudly, not pass on the wrong upstream.
    const served = await fetchServedModel(apiKey);
    await attachServedCompletion(served.raw);
    expect(served.model.toLowerCase()).toContain("gpt-5.4-mini");
  });
});

test.describe("via OpenRouter", () => {
  // The SAME SCCH fixture — the code's LLM override pair does the provider
  // switching, keeping the account-specific `vendor/model` id out of the
  // content-stable fixture tree (the tutor-chat-reply.spec.ts reasoning).

  // @live: needs OPENROUTER_API_KEY (a static key — no Entra token, no MI) +
  // the database — excluded in CI (test:e2e:ci).
  test("pi gets a non-empty reply from the overridden OpenRouter model", {
    tag: ["@live", "@live-llm"],
  }, async () => {
    test.skip(!process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY is not set");

    const code = await mintCode({
      module: "coding",
      file: LIVE_CODING_URL,
      llm: { provider: "OpenRouter", model: "z-ai/glm-5.3-flash" },
      note: "e2e pi agent (OpenRouter)",
    });
    const apiKey = await mintCodingKey({ code });

    const result = await runPiAgent({ apiKey, prompt: "Reply with exactly one word." });
    await attachPiOutput(result);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);

    // If the override silently fell back to the YAML default this reports
    // `gemma…` — the test must fail loudly, not pass on the wrong upstream.
    const served = await fetchServedModel(apiKey);
    await attachServedCompletion(served.raw);
    expect(served.model.toLowerCase()).toContain("glm-5.3-flash");
  });
});
