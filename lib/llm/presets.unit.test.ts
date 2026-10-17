import { describe, expect, it } from "vitest";
import { LLM_OVERRIDE_PRESETS } from "@/lib/llm/presets";

// The code form's quick picks (docs/codes.md): the order is the dropdown's, the
// first entry is the recommended default, and every GPT pick carries `medium`
// while the SCCH picks leave the level to the provider.

describe("LLM_OVERRIDE_PRESETS", () => {
  it("lists the OpenRouter GPT models first, then SCCH", () => {
    expect(LLM_OVERRIDE_PRESETS.map((p) => [p.provider, p.model])).toEqual([
      ["OpenRouter", "openai/gpt-6-luna"],
      ["OpenRouter", "openai/gpt-6.1-sol"],
      ["SCCH", "RedHatAI/gemma-4-31B-it-FP8-Dynamic"],
      ["SCCH", "Qwen/Qwen3.8-27B-FP8"],
    ]);
  });

  it("sets medium on every OpenRouter pick and no level on an SCCH pick", () => {
    for (const preset of LLM_OVERRIDE_PRESETS) {
      expect(preset.reasoning).toBe(preset.provider === "OpenRouter" ? "medium" : undefined);
    }
  });

  it("has unique labels (the dropdown's option values)", () => {
    const labels = LLM_OVERRIDE_PRESETS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("offers no Azure Foundry pick", () => {
    expect(LLM_OVERRIDE_PRESETS.some((p) => p.provider === "Azure Foundry")).toBe(false);
  });
});
