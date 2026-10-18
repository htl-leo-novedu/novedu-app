import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The `/codes` "Model" page column: an override is taken as stored (no YAML load),
// every other code reads its YAML's `llm:` block — each distinct file once — and
// anything that goes wrong (HTTP, YAML, a host that never answers) is `null`.

const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-hosted-fetcher", () => ({ serverYamlFetcher: async () => fetcher }));

import { effectiveModels, loadActivityLlm, MODEL_LOAD_TIMEOUT_MS } from "./models";

const TUTOR_URL = "https://example.test/tutor.yaml";
const yaml = (text: string) => ({ ok: true, status: 200, text: async () => text });

beforeEach(() => {
  fetcher
    .mockReset()
    .mockResolvedValue(yaml("llm:\n  provider: OpenRouter\n  model: openai/gpt-6-luna\n"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("loadActivityLlm", () => {
  it("reads the YAML's llm block, SCCH when it names no provider", async () => {
    await expect(loadActivityLlm(TUTOR_URL)).resolves.toEqual({
      provider: "OpenRouter",
      model: "openai/gpt-6-luna",
      reasoning: undefined,
    });
    fetcher.mockResolvedValue(yaml("llm:\n  model: qwen3-coder\n  reasoning: low\n"));
    await expect(loadActivityLlm(TUTOR_URL)).resolves.toEqual({
      provider: "SCCH",
      model: "qwen3-coder",
      reasoning: "low",
    });
  });

  it("is null for an HTTP error, unreadable YAML, a missing model or a failed fetch", async () => {
    fetcher.mockResolvedValue({ ok: false, status: 404, text: async () => "" });
    await expect(loadActivityLlm(TUTOR_URL)).resolves.toBeNull();
    fetcher.mockResolvedValue(yaml("llm: [unclosed"));
    await expect(loadActivityLlm(TUTOR_URL)).resolves.toBeNull();
    fetcher.mockResolvedValue(yaml("title: no model here\n"));
    await expect(loadActivityLlm(TUTOR_URL)).resolves.toBeNull();
    fetcher.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(loadActivityLlm(TUTOR_URL)).resolves.toBeNull();
  });

  it("gives up on a host that never answers", async () => {
    vi.useFakeTimers();
    fetcher.mockReturnValue(new Promise(() => {}));
    const loading = loadActivityLlm(TUTOR_URL);
    await vi.advanceTimersByTimeAsync(MODEL_LOAD_TIMEOUT_MS);
    await expect(loading).resolves.toBeNull();
  });

  it("gives up on a body that never ends", async () => {
    vi.useFakeTimers();
    fetcher.mockResolvedValue({ ok: true, status: 200, text: () => new Promise(() => {}) });
    const loading = loadActivityLlm(TUTOR_URL);
    await vi.advanceTimersByTimeAsync(MODEL_LOAD_TIMEOUT_MS);
    await expect(loading).resolves.toBeNull();
  });
});

describe("effectiveModels", () => {
  const override = { provider: "SCCH" as const, model: "override-model" };

  it("takes an override as stored and loads each other file once", async () => {
    const models = await effectiveModels([
      { code: "a", fileUrl: TUTOR_URL, llm: override },
      { code: "b", fileUrl: TUTOR_URL, llm: null },
      { code: "c", fileUrl: TUTOR_URL, llm: null },
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(models.get("a")).toBe(override);
    expect(models.get("b")).toMatchObject({ model: "openai/gpt-6-luna" });
    expect(models.get("c")).toMatchObject({ model: "openai/gpt-6-luna" });
  });

  it("loads nothing when every code overrides", async () => {
    await effectiveModels([{ code: "a", fileUrl: TUTOR_URL, llm: override }]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is null for a code whose file can't be read", async () => {
    fetcher.mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    const models = await effectiveModels([{ code: "b", fileUrl: TUTOR_URL, llm: null }]);
    expect(models.get("b")).toBeNull();
  });
});
