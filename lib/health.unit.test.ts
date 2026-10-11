import { afterEach, describe, expect, it, vi } from "vitest";

// The probes' heavy imports (the Mastra instance, the pool, the image adapter)
// are irrelevant to the OpenRouter probe, which only reads env and fetches.
vi.mock("@/app/mastra", () => ({ mastra: {} }));
vi.mock("@/lib/db/pool", () => ({ databaseHost: () => null }));
vi.mock("@/lib/image-fs", () => ({ verifyImageRoot: vi.fn() }));

const { checkOpenRouter } = await import("@/lib/health");

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
