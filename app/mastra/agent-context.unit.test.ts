import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";
import { WRITING_CONTEXT as KEYS } from "@/lib/llm-context";

// The agent side of the context-configured agents. `modelEntry` is mocked to expose
// the (provider, model, reasoning) triple the resolver derived from the context.
vi.mock("./model-entry", () => ({
  modelEntry: (provider: string, model: string, reasoning?: string) => ({
    provider,
    model,
    reasoning,
  }),
}));

import { contextInstructions, contextModel } from "./agent-context";

function contextWith(values: Record<string, unknown>) {
  const requestContext = new RequestContext();
  for (const [key, value] of Object.entries(values)) requestContext.set(key, value);
  return { requestContext };
}

describe("contextInstructions", () => {
  it("returns the system prompt the caller set", () => {
    expect(contextInstructions(KEYS)(contextWith({ [KEYS.instructions]: "PROMPT" }))).toBe(
      "PROMPT",
    );
  });

  it("fails loud on a missing or empty prompt (a wiring bug)", () => {
    expect(() => contextInstructions(KEYS)(contextWith({}))).toThrow(KEYS.instructions);
    expect(() => contextInstructions(KEYS)(contextWith({ [KEYS.instructions]: "" }))).toThrow();
  });
});

describe("contextModel", () => {
  it("reads provider, model and reasoning", () => {
    const args = contextWith({
      [KEYS.model]: "m",
      [KEYS.provider]: "OpenRouter",
      [KEYS.reasoning]: "high",
    });
    expect(contextModel(KEYS)(args)).toEqual({
      provider: "OpenRouter",
      model: "m",
      reasoning: "high",
    });
  });

  it("defaults an absent provider to SCCH and pins no reasoning when absent", () => {
    expect(contextModel(KEYS)(contextWith({ [KEYS.model]: "m" }))).toEqual({
      provider: "SCCH",
      model: "m",
      reasoning: undefined,
    });
  });

  it("fails loud on a missing model", () => {
    expect(() => contextModel(KEYS)(contextWith({}))).toThrow(KEYS.model);
  });
});
