import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";
import type { CodeEntry } from "@/lib/code-store";
import {
  EVAL_JUDGE_CONTEXT,
  EVAL_TUTOR_CONTEXT,
  llmRequestContext,
  QUIZ_DISCUSSION_CONTEXT,
  QUIZ_EVAL_CONTEXT,
  setLlmContext,
  WRITING_CONTEXT,
} from "@/lib/llm-context";

// The RequestContext contract of the context-configured agents. The provider gate
// (`providerUnavailableReason`) stays REAL: its env sensitivity is part of what the
// code modules' runtime branch promises.

const KEYS = WRITING_CONTEXT;
const noOverride = { llm: null } as Pick<CodeEntry, "llm">;
const get = (context: RequestContext, key: string) => context.get(key);

describe("the agents' key sets", () => {
  it.each([
    ["writing", WRITING_CONTEXT],
    ["quiz-eval", QUIZ_EVAL_CONTEXT],
    ["quiz-discussion", QUIZ_DISCUSSION_CONTEXT],
    ["eval-judge", EVAL_JUDGE_CONTEXT],
    ["eval-tutor", EVAL_TUTOR_CONTEXT],
  ])("%s: the agent's own four keys", (prefix, keys) => {
    expect(keys).toEqual({
      instructions: `${prefix}-instructions`,
      model: `${prefix}-model`,
      provider: `${prefix}-provider`,
      reasoning: `${prefix}-reasoning`,
    });
  });

  it("are distinct per agent", () => {
    const all = [
      WRITING_CONTEXT,
      QUIZ_EVAL_CONTEXT,
      QUIZ_DISCUSSION_CONTEXT,
      EVAL_JUDGE_CONTEXT,
      EVAL_TUTOR_CONTEXT,
    ].flatMap((keys) => Object.values(keys));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("setLlmContext", () => {
  it("sets the system prompt, model and provider, and reasoning only when pinned", () => {
    const pinned = new RequestContext();
    setLlmContext(pinned, KEYS, "PROMPT", {
      provider: "OpenRouter",
      model: "m",
      reasoning: "high",
    });
    expect(get(pinned, KEYS.instructions)).toBe("PROMPT");
    expect(get(pinned, KEYS.model)).toBe("m");
    expect(get(pinned, KEYS.provider)).toBe("OpenRouter");
    expect(get(pinned, KEYS.reasoning)).toBe("high");

    const unpinned = new RequestContext();
    setLlmContext(unpinned, KEYS, "PROMPT", { provider: "SCCH", model: "m" });
    expect(unpinned.has(KEYS.reasoning)).toBe(false);
  });
});

describe("llmRequestContext", () => {
  const activity = {
    provider: "SCCH" as const,
    model: "yaml-model",
    reasoning: "minimal" as const,
  };

  it("runs the activity's own llm when the code has no override", () => {
    const result = llmRequestContext(noOverride, activity, KEYS, "PROMPT");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(get(result.context, KEYS.model)).toBe("yaml-model");
    expect(get(result.context, KEYS.reasoning)).toBe("minimal");
    expect(get(result.context, KEYS.instructions)).toBe("PROMPT");
  });

  it("replaces the llm WHOLESALE with the code's override pair (instructions stay)", () => {
    const entry = { llm: { provider: "SCCH", model: "override-model" } } as Pick<CodeEntry, "llm">;
    const result = llmRequestContext(entry, activity, KEYS, "PROMPT");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(get(result.context, KEYS.model)).toBe("override-model");
    // The override carries no level, so none is set — not the YAML's.
    expect(result.context.has(KEYS.reasoning)).toBe(false);
    expect(get(result.context, KEYS.instructions)).toBe("PROMPT");
  });

  it("502s when the EFFECTIVE provider is unavailable on this server", () => {
    vi.stubEnv("AZURE_FOUNDRY_ENDPOINT", "");
    const foundry = { provider: "Azure Foundry" as const, model: "gpt-5.4-mini" };
    expect(llmRequestContext(noOverride, foundry, KEYS, "PROMPT")).toMatchObject({
      ok: false,
      status: 502,
      message: expect.stringContaining("Azure Foundry"),
    });
    const entry = { llm: foundry } as Pick<CodeEntry, "llm">;
    expect(llmRequestContext(entry, activity, KEYS, "PROMPT")).toMatchObject({
      ok: false,
      status: 502,
    });
  });
});
