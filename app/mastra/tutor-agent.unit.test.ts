import { beforeEach, describe, expect, it, vi } from "vitest";

// The tutor agent's per-request configuration: both resolvers (instructions +
// model) share one request-scoped build of the tutor YAML, and the MODEL resolver
// applies the code's LLM override pair from the request context over the YAML's
// llm values, gating availability on the EFFECTIVE provider. The Mastra classes
// and the tutor loader are mocked; the availability gate
// (providerUnavailableReason) stays real, driven via the env.

const loadAndBuildTutorPrompt = vi.hoisted(() => vi.fn());
// The server's YAML fetcher (app-hosted URLs from the DB) as a sentinel: its own
// resolution is lib/app-hosted-fetcher.unit.test.ts's; here only that the agent
// loads through it — never a plain network fetch.
const serverFetcher = vi.hoisted(() => vi.fn());
const resolveLanguageModel = vi.hoisted(() => vi.fn());
// The providerOptions KEY is @ai-sdk package trivia owned by lib/llm/model.ts (and
// asserted there); a sentinel keeps these tests about which LEVEL won.
const reasoningOptionsKey = vi.hoisted(() => vi.fn(() => "provider-key"));

// Capture the Agent config instead of building a real Mastra agent.
vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
    }
  },
}));
vi.mock("@mastra/memory", () => ({ Memory: class {} }));
vi.mock("@/lib/tutors", () => ({ loadAndBuildTutorPrompt }));
vi.mock("@/lib/app-hosted-fetcher", () => ({ serverYamlFetcher: async () => serverFetcher }));
vi.mock("@/lib/llm/model", () => ({ resolveLanguageModel, reasoningOptionsKey }));

import {
  TUTOR_MODEL_OVERRIDE,
  TUTOR_PROVIDER_OVERRIDE,
  TUTOR_REASONING_OVERRIDE,
  TUTOR_URL,
  tutorAgent,
} from "@/app/mastra/tutor-agent";

// The resolver returns Mastra's ModelWithRetries ARRAY form — the only shape that
// carries `providerOptions` (the reasoning-effort seam) into a run.
type ModelEntry = { model: unknown; providerOptions?: Record<string, unknown> };
type Resolver<T> = (args: { requestContext: unknown }) => Promise<T>;
const config = (tutorAgent as unknown as { config: Record<string, unknown> }).config;
const instructions = config.instructions as Resolver<string>;
const model = config.model as Resolver<ModelEntry[]>;
const tools = config.tools as Resolver<Record<string, { execute: unknown }>>;

// A fresh per-request context object (the real one is a RequestContext; the agent
// only calls get(), and uses the OBJECT IDENTITY as the WeakMap build-cache key).
/**
 * The reasoning level that reached `modelEntry`, read back off the entry WITHOUT
 * naming the providerOptions key — which key each provider needs, and that the
 * level lands under it, are `modelEntry`'s own contract
 * (app/mastra/model-entry.unit.test.ts). Here only "which level won" matters.
 */
function reasoningLevel(entries: ModelEntry[]): unknown {
  const options = Object.values(entries[0]?.providerOptions ?? {})[0] as
    | { reasoningEffort?: unknown }
    | undefined;
  return options?.reasoningEffort;
}

function requestContext(values: Record<string, unknown>) {
  const m = new Map(Object.entries(values));
  return { get: (key: string) => m.get(key) };
}

beforeEach(() => {
  loadAndBuildTutorPrompt.mockResolvedValue({
    ok: true,
    prompt: "YAML PROMPT",
    model: "yaml-model",
    provider: "SCCH",
    tools: [],
  });
  resolveLanguageModel.mockReturnValue("resolved-model");
});

describe("tutorAgent per-request resolution", () => {
  it("resolves prompt + model from the YAML when the code has no override", async () => {
    const ctx = requestContext({ [TUTOR_URL]: "https://example.com/t.yaml" });
    await expect(instructions({ requestContext: ctx })).resolves.toBe("YAML PROMPT");
    const entries = await model({ requestContext: ctx });
    expect(resolveLanguageModel).toHaveBeenCalledWith("SCCH", "yaml-model");
    // The array form, and — with no reasoning level anywhere — NO providerOptions
    // key at all, so the model's own default effort applies.
    expect(entries).toEqual([{ model: "resolved-model" }]);
    expect(entries[0]).not.toHaveProperty("providerOptions");
    // Both resolvers share ONE request-scoped build, read through the server fetcher.
    expect(loadAndBuildTutorPrompt).toHaveBeenCalledTimes(1);
    expect(loadAndBuildTutorPrompt).toHaveBeenCalledWith(
      "https://example.com/t.yaml",
      serverFetcher,
    );
  });

  it("carries the YAML's reasoning level as providerOptions on the model entry", async () => {
    loadAndBuildTutorPrompt.mockResolvedValue({
      ok: true,
      prompt: "YAML PROMPT",
      model: "yaml-model",
      provider: "SCCH",
      reasoning: "medium",
      tools: [],
    });
    const ctx = requestContext({ [TUTOR_URL]: "https://example.com/t.yaml" });
    expect(reasoningLevel(await model({ requestContext: ctx }))).toBe("medium");
  });

  it("applies the override's reasoning level over the YAML's", async () => {
    loadAndBuildTutorPrompt.mockResolvedValue({
      ok: true,
      prompt: "YAML PROMPT",
      model: "yaml-model",
      provider: "SCCH",
      reasoning: "medium",
      tools: [],
    });
    const ctx = requestContext({
      [TUTOR_URL]: "https://example.com/t.yaml",
      [TUTOR_PROVIDER_OVERRIDE]: "SCCH",
      [TUTOR_MODEL_OVERRIDE]: "override-model",
      [TUTOR_REASONING_OVERRIDE]: "high",
    });
    expect(reasoningLevel(await model({ requestContext: ctx }))).toBe("high");
    expect(resolveLanguageModel).toHaveBeenCalledWith("SCCH", "override-model");
  });

  it("an override WITHOUT a level suppresses the YAML's (the override is wholesale)", async () => {
    loadAndBuildTutorPrompt.mockResolvedValue({
      ok: true,
      prompt: "YAML PROMPT",
      model: "yaml-model",
      provider: "SCCH",
      reasoning: "medium",
      tools: [],
    });
    const ctx = requestContext({
      [TUTOR_URL]: "https://example.com/t.yaml",
      [TUTOR_PROVIDER_OVERRIDE]: "SCCH",
      [TUTOR_MODEL_OVERRIDE]: "override-model",
    });
    const entries = await model({ requestContext: ctx });
    expect(entries).toEqual([{ model: "resolved-model" }]);
    expect(entries[0]).not.toHaveProperty("providerOptions");
  });

  it("fails loud on a present-but-invalid reasoning override (wiring bug)", async () => {
    const ctx = requestContext({
      [TUTOR_URL]: "https://example.com/t.yaml",
      [TUTOR_PROVIDER_OVERRIDE]: "SCCH",
      [TUTOR_MODEL_OVERRIDE]: "override-model",
      [TUTOR_REASONING_OVERRIDE]: "extreme",
    });
    await expect(model({ requestContext: ctx })).rejects.toThrow(/override is invalid/);
  });

  it("applies the code's LLM override pair over the YAML's llm values", async () => {
    const ctx = requestContext({
      [TUTOR_URL]: "https://example.com/t.yaml",
      [TUTOR_PROVIDER_OVERRIDE]: "SCCH",
      [TUTOR_MODEL_OVERRIDE]: "override-model",
    });
    // The prompt is untouched — the override swaps only the LLM.
    await expect(instructions({ requestContext: ctx })).resolves.toBe("YAML PROMPT");
    await model({ requestContext: ctx });
    expect(resolveLanguageModel).toHaveBeenCalledWith("SCCH", "override-model");
  });

  it("gates availability on the EFFECTIVE provider (a Foundry override on an SCCH-only server fails)", async () => {
    vi.stubEnv("AZURE_FOUNDRY_ENDPOINT", "");
    const ctx = requestContext({
      [TUTOR_URL]: "https://example.com/t.yaml",
      [TUTOR_PROVIDER_OVERRIDE]: "Azure Foundry",
      [TUTOR_MODEL_OVERRIDE]: "gpt-5.4-mini",
    });
    await expect(model({ requestContext: ctx })).rejects.toThrow(/Azure Foundry/);
    expect(resolveLanguageModel).not.toHaveBeenCalled();
  });

  it("fails loud on a half/invalid override pair instead of silently picking a provider", async () => {
    const ctx = requestContext({
      [TUTOR_URL]: "https://example.com/t.yaml",
      [TUTOR_PROVIDER_OVERRIDE]: "OpenAI",
      [TUTOR_MODEL_OVERRIDE]: "gpt-4o",
    });
    await expect(model({ requestContext: ctx })).rejects.toThrow(/override is invalid/);
  });
});

describe("tutorAgent tools resolution", () => {
  it("exposes NO tools for a tutor without a tools opt-in", async () => {
    const ctx = requestContext({ [TUTOR_URL]: "https://example.com/t.yaml" });
    await expect(tools({ requestContext: ctx })).resolves.toEqual({});
  });

  it("exposes exactly the opted-in tools, sharing the request-scoped build", async () => {
    loadAndBuildTutorPrompt.mockResolvedValue({
      ok: true,
      prompt: "YAML PROMPT",
      model: "yaml-model",
      provider: "SCCH",
      tools: ["random_number"],
    });
    const ctx = requestContext({ [TUTOR_URL]: "https://example.com/t.yaml" });
    await instructions({ requestContext: ctx });
    const toolset = await tools({ requestContext: ctx });
    expect(Object.keys(toolset)).toEqual(["random_number"]);
    // All three resolvers (instructions/model/tools) share ONE build per request.
    expect(loadAndBuildTutorPrompt).toHaveBeenCalledTimes(1);
  });

  it("the resolved random_number tool actually executes the catalog logic", async () => {
    loadAndBuildTutorPrompt.mockResolvedValue({
      ok: true,
      prompt: "YAML PROMPT",
      model: "yaml-model",
      provider: "SCCH",
      tools: ["random_number"],
    });
    const ctx = requestContext({ [TUTOR_URL]: "https://example.com/t.yaml" });
    const toolset = await tools({ requestContext: ctx });
    const randomNumber = toolset.random_number;
    expect(randomNumber).toBeDefined();
    const execute = randomNumber?.execute as (input: {
      min: number;
      max: number;
    }) => Promise<{ value: number }>;
    // min === max pins the crypto RNG's only possible answer.
    await expect(execute({ min: 7, max: 7 })).resolves.toEqual({ value: 7 });
  });

  it("throws on a selection the catalog does not know (wiring bug guard)", async () => {
    loadAndBuildTutorPrompt.mockResolvedValue({
      ok: true,
      prompt: "YAML PROMPT",
      model: "yaml-model",
      provider: "SCCH",
      tools: ["radix_conversion"],
    });
    const ctx = requestContext({ [TUTOR_URL]: "https://example.com/t.yaml" });
    await expect(tools({ requestContext: ctx })).rejects.toThrow(/Unknown tutor tool/);
  });
});
