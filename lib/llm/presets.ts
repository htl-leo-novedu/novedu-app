import type { LlmProvider, ReasoningLevel } from "@/lib/llm/provider";

// The built-in LLM-override quick picks the code create/edit form offers in a
// dropdown; the form's Apply button copies the chosen one into its free-text
// provider/model fields and the reasoning select (docs/codes.md). Pure and
// CLIENT-SAFE (the form is a client component). These are conveniences, not an
// allowlist — the form fields stay free text and the server validates the
// provider against `parseLenientProvider`; a quick pick going stale (a model
// retired upstream) only makes the entry less useful, it gates nothing.

export interface LlmOverridePreset {
  /** Option label in the code form's quick-pick dropdown. */
  label: string;
  provider: LlmProvider;
  model: string;
  /**
   * Reasoning effort to fill in with the pair. Absent on a quick pick that
   * leaves the level to the provider — Apply then clears the level, so it always
   * fills the WHOLE override (docs/codes.md).
   */
  reasoning?: ReasoningLevel;
}

export const LLM_OVERRIDE_PRESETS: readonly LlmOverridePreset[] = [
  // OpenRouter models are namespaced `<vendor>/<model>` — the id is the routing
  // key. The GPT models are reasoning models: "medium" is the classroom default.
  {
    label: "OpenRouter · GPT-6 Luna (medium)",
    provider: "OpenRouter",
    model: "openai/gpt-6-luna",
    reasoning: "medium",
  },
  {
    label: "OpenRouter · GPT-6.1 Sol (medium)",
    provider: "OpenRouter",
    model: "openai/gpt-6.1-sol",
    reasoning: "medium",
  },
  { label: "SCCH · Gemma 4", provider: "SCCH", model: "RedHatAI/gemma-4-31B-it-FP8-Dynamic" },
  // The reasoning variant; SCCH also serves a "… - Reasoning OFF" sibling.
  { label: "SCCH · Qwen 3.8 27B", provider: "SCCH", model: "Qwen/Qwen3.8-27B-FP8" },
];
