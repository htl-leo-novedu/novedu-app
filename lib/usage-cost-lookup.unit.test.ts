import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBaseModel, fetchOpenRouterModels, priceModels } from "@/lib/usage-cost-lookup";

// The fetch layer of the cost estimate over a stubbed `fetch` — no live network.
// Asserts the URLs (incl. the e2e override), the one-day cache option, and that
// every failure degrades to `undefined` instead of throwing.

const fetchMock = vi.fn();

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

const OPENROUTER = {
  data: [
    {
      id: "google/gemma-4-31b-it",
      hugging_face_id: "google/gemma-4-31B-it",
      pricing: { prompt: "0.0000002", completion: "0.0000004" },
    },
  ],
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("fetchOpenRouterModels", () => {
  it("fetches the public list with a one-day cache and reads the fetch date", async () => {
    fetchMock.mockResolvedValue(
      json(OPENROUTER, { headers: { date: "Thu, 15 Oct 2026 08:00:00 GMT" } }),
    );
    const result = await fetchOpenRouterModels();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({ next: { revalidate: 86_400 } }),
    );
    expect(result?.json).toEqual(OPENROUTER);
    expect(result?.fetchedAt?.toISOString()).toBe("2026-10-15T08:00:00.000Z");
  });

  it("honours the URL override", async () => {
    vi.stubEnv("USAGE_COST_OPENROUTER_MODELS_URL", "http://127.0.0.1:1/prices/openrouter/models");
    fetchMock.mockResolvedValue(json(OPENROUTER));
    await fetchOpenRouterModels();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:1/prices/openrouter/models");
  });

  it("returns undefined on an HTTP error or a network failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    expect(await fetchOpenRouterModels()).toBeUndefined();
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    expect(await fetchOpenRouterModels()).toBeUndefined();
  });
});

describe("fetchBaseModel", () => {
  it("asks the Hugging Face model API and reads base_model", async () => {
    fetchMock.mockResolvedValue(json({ cardData: { base_model: "google/gemma-4-31B-it" } }));
    expect(await fetchBaseModel("RedHatAI/gemma-4-31B-it-FP8-Dynamic")).toBe(
      "google/gemma-4-31B-it",
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://huggingface.co/api/models/RedHatAI/gemma-4-31B-it-FP8-Dynamic",
    );
  });

  it("honours the base-URL override", async () => {
    vi.stubEnv("USAGE_COST_HF_API_BASE", "http://127.0.0.1:1/prices/hf/api/");
    fetchMock.mockResolvedValue(json({}));
    await fetchBaseModel("e2e/model");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:1/prices/hf/api/models/e2e/model");
  });

  it("never requests an id that is not owner/name", async () => {
    expect(await fetchBaseModel("../../etc")).toBeUndefined();
    expect(await fetchBaseModel("gpt-5.4-mini")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined when the lookup fails", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    expect(await fetchBaseModel("foo/Bar-7B-AWQ")).toBeUndefined();
  });
});

describe("priceModels", () => {
  it("prices the models that match both steps and leaves the others out", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/RedHatAI/gemma-4-31B-it-FP8-Dynamic")
        ? json({ cardData: { base_model: ["google/gemma-4-31B-it"] } })
        : new Response("nope", { status: 404 }),
    );
    const prices = await priceModels(
      [
        "RedHatAI/gemma-4-31B-it-FP8-Dynamic",
        "foo/Bar-7B-AWQ",
        "RedHatAI/gemma-4-31B-it-FP8-Dynamic",
      ],
      { json: OPENROUTER, fetchedAt: undefined },
    );
    expect([...prices.keys()]).toEqual(["RedHatAI/gemma-4-31B-it-FP8-Dynamic"]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // de-duplicated
  });
});
