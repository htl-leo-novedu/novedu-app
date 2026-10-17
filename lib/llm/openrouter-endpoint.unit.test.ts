import { describe, expect, it, vi } from "vitest";
import {
  openrouterAuthHeader,
  openrouterBase,
  openrouterChatCompletionsUrl,
  openrouterConfigured,
  openrouterKeyUrl,
  openrouterModelsUrl,
} from "@/lib/llm/openrouter-endpoint";

// Pure env reading — no mocks needed (the module imports nothing), so the whole
// surface is exercised against stubbed environment variables.

describe("openrouterConfigured", () => {
  it("is the API key alone — the base URL has a default", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(openrouterConfigured()).toBe(false);
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    expect(openrouterConfigured()).toBe(true);
  });
});

describe("openrouter URL builders", () => {
  it("defaults to the public OpenRouter v1 host", () => {
    vi.stubEnv("OPENROUTER_BASE_URL", "");
    expect(openrouterBase()).toBe("https://openrouter.ai/api/v1");
    expect(openrouterChatCompletionsUrl()).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(openrouterModelsUrl()).toBe("https://openrouter.ai/api/v1/models");
    expect(openrouterKeyUrl()).toBe("https://openrouter.ai/api/v1/key");
  });

  it("honors an OPENROUTER_BASE_URL override (a proxy or self-hosted gateway)", () => {
    vi.stubEnv("OPENROUTER_BASE_URL", "https://gateway.test/v1");
    expect(openrouterChatCompletionsUrl()).toBe("https://gateway.test/v1/chat/completions");
    expect(openrouterModelsUrl()).toBe("https://gateway.test/v1/models");
  });

  it("tolerates trailing slashes on the override", () => {
    vi.stubEnv("OPENROUTER_BASE_URL", "https://gateway.test/v1//");
    expect(openrouterBase()).toBe("https://gateway.test/v1");
  });

  it("never throws on a missing base URL — unlike SCCH, it has a default", () => {
    vi.stubEnv("OPENROUTER_BASE_URL", "");
    expect(() => openrouterChatCompletionsUrl()).not.toThrow();
  });
});

describe("openrouterAuthHeader", () => {
  it("is the static Bearer key", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    expect(openrouterAuthHeader()).toBe("Bearer sk-or-test");
  });

  it("throws a clear error when OPENROUTER_API_KEY is not set", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(() => openrouterAuthHeader()).toThrow("OPENROUTER_API_KEY is not set");
  });
});
