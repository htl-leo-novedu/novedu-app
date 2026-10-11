import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import {
  DEFAULT_PROVIDER,
  type LlmProvider,
  parseLenientProvider,
  parseLenientReasoningLevel,
} from "@/lib/llm/provider";
import { modelEntry } from "./model-entry";

// The agent behind the cloze activity ("Fill the gaps", docs/cloze.md). ONE memory-less
// agent serves both calls of the pipeline — the grading call and the feedback call —
// configured ENTIRELY per request from the RequestContext: the caller builds the system
// prompt (lib/cloze-grading-prompt.ts or lib/cloze-feedback-prompt.ts) and passes the
// effective provider + model, and picks the step's output schema
// (lib/cloze-output-schemas.ts) on `generate()`.
//
// SERVER-ONLY: resolves models through the `lib/llm` seam.
//
// SECURITY: like `quizEvaluator`, `clozeEvaluator` is registered in `app/mastra/index.ts`
// but NEVER web-reachable by students — the cloze module has no `runtime` at all, and no
// module's `runtime.agentId` names it, so the CopilotKit runtime route 404s it and `/info`
// never lists it. Its only callers are the `gradeCloze` / `explainCloze` server actions
// (lib/cloze-actions.ts), which build the prompts from the server-held references and
// `evaluation` (AGENTS.md, docs/codes.md).

// RequestContext keys, distinct from every other agent's so a request for one can never
// satisfy another (defense in depth on top of the runtime route's agent gating).
export const CLOZE_EVAL_INSTRUCTIONS = "cloze-eval-instructions";
export const CLOZE_EVAL_MODEL = "cloze-eval-model";
export const CLOZE_EVAL_PROVIDER = "cloze-eval-provider";
/** Optional reasoning effort; absent = the model's own default. */
export const CLOZE_EVAL_REASONING = "cloze-eval-reasoning";

function requiredString(requestContext: RequestContext, key: string): string {
  const value = requestContext.get(key);
  if (typeof value !== "string" || value === "") {
    throw new Error(`Missing "${key}" on the request context for the cloze agent.`);
  }
  return value;
}

// An absent provider key means SCCH (matching the YAML default); an invalid value was
// already rejected by the exercise load, so lenient reading here is safe. Reasoning is
// read the same way: absent (or unparseable) pins no effort.
function providerFrom(requestContext: RequestContext): LlmProvider {
  return parseLenientProvider(requestContext.get(CLOZE_EVAL_PROVIDER)) ?? DEFAULT_PROVIDER;
}

// STATELESS: no `Memory`, so a `generate()` call persists nothing — no answer text is
// stored anywhere (docs/cloze.md). With no memory there is nothing for the
// reasoning-stripping output processor to protect.
export const clozeEvaluatorAgent = new Agent({
  id: "clozeEvaluator",
  name: "Cloze Evaluator",
  instructions: ({ requestContext }) => requiredString(requestContext, CLOZE_EVAL_INSTRUCTIONS),
  model: ({ requestContext }) =>
    modelEntry(
      providerFrom(requestContext),
      requiredString(requestContext, CLOZE_EVAL_MODEL),
      parseLenientReasoningLevel(requestContext.get(CLOZE_EVAL_REASONING)),
    ),
});
