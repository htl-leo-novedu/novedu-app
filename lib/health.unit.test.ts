import { afterEach, describe, expect, it, vi } from "vitest";

// The probes' heavy imports (the Mastra instance, the pool, the image adapter)
// are irrelevant to the OpenRouter and Foundry probes, which only read env and
// fetch. The Foundry token is mocked; credential selection stays real.
vi.mock("@/app/mastra", () => ({ mastra: {} }));
vi.mock("@/lib/db/pool", () => ({ databaseHost: () => null }));
vi.mock("@/lib/image-fs", () => ({ verifyImageRoot: vi.fn() }));

const foundry = vi.hoisted(() => ({ foundryBearerToken: vi.fn() }));
vi.mock("@/lib/llm/foundry-endpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/foundry-endpoint")>()),
  foundryBearerToken: foundry.foundryBearerToken,
}));

const { checkFoundry, checkOpenRouter } = await import("@/lib/health");

function stubFetch(byUrl: Record<string, Response>) {
  const fetchMock = vi.fn(async (url: string) => {
    const res = byUrl[url];
    if (!res) throw new Error(`unexpected fetch ${url}`);
    return res;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("checkOpenRouter", () => {
  it("reports a missing key without fetching", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const fetchMock = stubFetch({});
    expect(await checkOpenRouter()).toEqual({
      ok: false,
      detail: "Not configured (OPENROUTER_API_KEY is missing).",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails on a rejected key even though the public model listing would answer", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-invalid");
    vi.stubEnv("OPENROUTER_BASE_URL", "");
    stubFetch({
      "https://openrouter.ai/api/v1/key": new Response("{}", { status: 401 }),
      "https://openrouter.ai/api/v1/models": Response.json({ data: [{ id: "a" }] }),
    });
    expect(await checkOpenRouter()).toEqual({
      ok: false,
      detail: "API key rejected (HTTP 401).",
    });
  });

  it("proves the key, then counts the models", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-valid");
    vi.stubEnv("OPENROUTER_BASE_URL", "");
    const fetchMock = stubFetch({
      "https://openrouter.ai/api/v1/key": Response.json({ data: {} }),
      "https://openrouter.ai/api/v1/models": Response.json({ data: [{ id: "a" }, { id: "b" }] }),
    });
    expect(await checkOpenRouter()).toEqual({ ok: true, detail: "2 models available." });
    for (const call of fetchMock.mock.calls) {
      expect((call as unknown as [string, RequestInit])[1].headers).toEqual({
        Authorization: "Bearer sk-or-valid",
      });
    }
  });
});

describe("checkFoundry", () => {
  const MODELS_URL = "https://res.openai.azure.com/openai/v1/models";

  function stubFoundryEnv(env: Record<string, string>) {
    vi.stubEnv("AZURE_FOUNDRY_ENDPOINT", "https://res.openai.azure.com");
    for (const name of [
      "AZURE_FOUNDRY_TENANT_ID",
      "AZURE_FOUNDRY_CLIENT_ID",
      "AZURE_FOUNDRY_CLIENT_SECRET",
      "AZURE_FOUNDRY_CLIENT_CERTIFICATE",
    ]) {
      vi.stubEnv(name, env[name] ?? "");
    }
  }

  const SERVICE_PRINCIPAL = {
    AZURE_FOUNDRY_TENANT_ID: "11111111-tenant",
    AZURE_FOUNDRY_CLIENT_ID: "22222222-client",
    AZURE_FOUNDRY_CLIENT_SECRET: "s3cr3t-value",
  };

  it("names the managed identity / az chain on success", async () => {
    stubFoundryEnv({});
    foundry.foundryBearerToken.mockResolvedValue("token");
    stubFetch({ [MODELS_URL]: Response.json({ data: [{ id: "a" }] }) });
    expect(await checkFoundry()).toEqual({
      ok: true,
      detail: "1 models available (managed identity / az login).",
    });
  });

  it("names the service principal's credential kind, never its id", async () => {
    stubFoundryEnv(SERVICE_PRINCIPAL);
    foundry.foundryBearerToken.mockResolvedValue("token");
    stubFetch({ [MODELS_URL]: Response.json({ data: [{ id: "a" }, { id: "b" }] }) });
    expect(await checkFoundry()).toEqual({
      ok: true,
      detail: "2 models available (service principal, secret).",
    });
  });

  it("masks the configured identifiers in a token failure", async () => {
    stubFoundryEnv(SERVICE_PRINCIPAL);
    foundry.foundryBearerToken.mockRejectedValue(
      new Error(
        "AADSTS7000215: Invalid client secret provided (s3cr3t-value) for app '22222222-client' in tenant 11111111-tenant.",
      ),
    );
    const fetchMock = stubFetch({});
    const result = await checkFoundry();
    expect(result).toEqual({
      ok: false,
      detail:
        "Entra token acquisition (service principal, secret) failed: AADSTS7000215: Invalid client secret provided (<secret>) for app '<client id>' in tenant <tenant id>.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a misconfigured service principal without fetching a token", async () => {
    stubFoundryEnv({ AZURE_FOUNDRY_CLIENT_ID: "22222222-client" });
    const fetchMock = stubFetch({});
    const result = await checkFoundry();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Foundry service principal is misconfigured");
    expect(result.detail).not.toContain("22222222-client");
    expect(foundry.foundryBearerToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
