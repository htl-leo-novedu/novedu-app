import { z } from "zod";

// The SINGLE definition of the app's LLM providers. Every other module — the four
// activity schemas, the lenient runtime parsers, the two resolvers in this folder,
// and the usage exporter — imports these literals from here; the provider names
// never appear as string literals anywhere else. Pure and client-safe (no I/O, no
// server-only imports).

// The literals themselves, as a tuple, so schemas that need an *enum* (rather than
// `providerSchema`, which carries a default) can be built from them without restating
// the names — `lib/registry-schema.ts` is one such consumer.
export const LLM_PROVIDERS = ["SCCH", "Azure Foundry", "OpenRouter"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const DEFAULT_PROVIDER: LlmProvider = "SCCH";

// The `llm.provider` field of every activity YAML: optional, defaulting to SCCH,
// so all existing YAML keeps its meaning without migration. The `.meta()` teacher
// prose is emitted into every generated activity JSON Schema (all four `llm` blocks).
export const providerSchema = z.enum(LLM_PROVIDERS).default(DEFAULT_PROVIDER).meta({
  description:
    "The LLM provider serving the model. For Azure Foundry, model is the deployment name.",
});

// The reasoning-effort levels a reasoning model may be driven at, as a tuple, so
// schemas that need an *enum* can be built from them without restating the names
// (`lib/registry-schema.ts` is one such consumer). Provider-agnostic on purpose:
// every provider speaks the OpenAI `reasoning_effort` parameter, and a model that
// rejects a level fails at runtime like a wrong model name.
//
// The tuple is the UNION of the vocabularies our models speak, NOT a set every
// model accepts, and the models disagree in both directions (measured against
// SCCH, `docs/ai-models.md`): Qwen 3.8 takes `none`/`low`/`medium`/`xhigh` and
// answers `minimal`/`high`/`max` with a 400, while Gemma 4 takes every level but
// acts on only `none` — the rest are byte-identical to each other. Nothing here
// can narrow it per model (`model` is free text with no discovery), so the
// upstream call is the only validator. Order is the code form's select order
// (ascending effort).
//
// `"none"` is NOT the same as omitting the field: it SENDS `reasoning_effort:
// "none"` and so turns a reasoning model off, where an absent level sends no
// parameter and leaves the model's own default in place.
export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

// The `llm.reasoning` field of every activity YAML: OPTIONAL with no default —
// absent means the parameter is not sent at all, so the model's own default
// applies. The `.meta()` teacher prose is emitted into every generated activity
// JSON Schema (all four `llm` blocks).
export const reasoningLevelSchema = z.enum(REASONING_LEVELS).optional().meta({
  description:
    'Optional reasoning effort for reasoning models. Not every model accepts every level. Omit to let the model decide (the parameter is then not sent); "none" instead turns a reasoning model off.',
});

// ai-sdk provider names, passed as `createOpenAI({ name })` / `createOpenAICompatible({ name })`.
// They are the METERING contract: Mastra stamps `<name>.chat` as
// `attributes.provider` on every MODEL_GENERATION span, and the usage exporter maps
// it back via `providerFromModelProviderId`. Renaming one silently breaks that
// attribution.
export const SCCH_PROVIDER_NAME = "scch";
export const FOUNDRY_PROVIDER_NAME = "azure-foundry";
export const OPENROUTER_PROVIDER_NAME = "openrouter";

// Maps an ai-sdk model's `provider` id (e.g. "scch.chat") back to the LlmProvider
// it was created from; `undefined` for anything this app didn't name.
export function providerFromModelProviderId(id: string | undefined): LlmProvider | undefined {
  const name = id?.split(".")[0];
  if (name === SCCH_PROVIDER_NAME) return "SCCH";
  if (name === FOUNDRY_PROVIDER_NAME) return "Azure Foundry";
  if (name === OPENROUTER_PROVIDER_NAME) return "OpenRouter";
  return undefined;
}

// For the lenient runtime parsers: a valid literal passes through, anything else —
// including a non-string — is `undefined`. The CALLER decides how to treat a
// missing value (`?? DEFAULT_PROVIDER`) vs. a present-but-invalid one (reject, so
// a Foundry-intended activity never silently runs against SCCH).
//
// The comparisons are spelled out rather than derived from `LLM_PROVIDERS`: a
// `.includes()` over the tuple does NOT narrow `unknown` to `LlmProvider`, so every
// literal added above must be added here too.
export function parseLenientProvider(value: unknown): LlmProvider | undefined {
  return value === "SCCH" || value === "Azure Foundry" || value === "OpenRouter"
    ? value
    : undefined;
}

// The `parseLenientProvider` counterpart for the reasoning level: a valid literal
// passes through, anything else — including a non-string — is `undefined`. The
// CALLER decides how to treat a missing value (no `reasoning_effort` is sent) vs.
// a present-but-invalid one (reject, so an activity never silently runs at the
// model's default effort).
export function parseLenientReasoningLevel(value: unknown): ReasoningLevel | undefined {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value)
    ? (value as ReasoningLevel)
    : undefined;
}
