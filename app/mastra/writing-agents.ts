import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { Memory } from "@mastra/memory";
import {
  DEFAULT_PROVIDER,
  type LlmProvider,
  parseLenientProvider,
  parseLenientReasoningLevel,
} from "@/lib/llm/provider";
import { modelEntry } from "./model-entry";
import { reasoningStrippingProcessor } from "./reasoning-processor";

// The agent that backs the Writing feature's feedback chat. It is configured
// ENTIRELY per request from values the caller places on the `RequestContext` (the
// activity's provider + model, and the teacher's system prompt) — mirroring how
// `tutorAgent` and the quiz discussion agent resolve their prompt/model per
// request, but without the tutor-YAML coupling.
//
// The agent has NO write/edit tool — it is read-only BY CONSTRUCTION. The only
// tool it can call is the browser-side `getCurrentText` (a frontend tool forwarded
// by @ag-ui/mastra), which returns the student's live editor buffer; there is no
// server-side capability that can mutate the student's text.
//
// SERVER-ONLY: resolves models through the `lib/llm` seam.

// RequestContext keys. Distinct from the other agents' keys so a request for one
// can never satisfy another (defense in depth on top of the runtime route's agent
// gating).
export const WRITING_INSTRUCTIONS = "writing-instructions";
export const WRITING_MODEL = "writing-model";
export const WRITING_PROVIDER = "writing-provider";
/** Optional reasoning effort for the feedback chat; absent = the model's default. */
export const WRITING_REASONING = "writing-reasoning";

function requiredString(requestContext: RequestContext, key: string): string {
  const value = requestContext.get(key);
  if (typeof value !== "string" || value === "") {
    throw new Error(`Missing "${key}" on the request context for the writing agent.`);
  }
  return value;
}

// An absent provider key means SCCH (matching the YAML default); an invalid value
// was already rejected by the writing load, so lenient reading here is safe. The
// reasoning key is read the same way at the resolver: absent pins no effort.
function providerFrom(requestContext: RequestContext): LlmProvider {
  return parseLenientProvider(requestContext.get(WRITING_PROVIDER)) ?? DEFAULT_PROVIDER;
}

// The feedback chat. Memory-backed exactly like `tutorAgent` and the quiz
// discussion agent (recent-message window, no semantic recall) so a thread
// persists and earlier turns reach the model through the recalled window. The
// runtime route sets the system prompt (the activity's `instructions`) and
// model, and scopes memory to `resourceId = the code`.
export const writingAgent = new Agent({
  id: "writing",
  name: "Writing",
  instructions: ({ requestContext }) => requiredString(requestContext, WRITING_INSTRUCTIONS),
  model: ({ requestContext }) =>
    modelEntry(
      providerFrom(requestContext),
      requiredString(requestContext, WRITING_MODEL),
      parseLenientReasoningLevel(requestContext.get(WRITING_REASONING)),
    ),
  memory: new Memory({
    options: {
      lastMessages: 40,
      semanticRecall: false,
    },
  }),
  // Reasoning is a live-only artefact: this drops it after the response has
  // streamed and before memory persists the turn (app/mastra/reasoning-processor.ts).
  outputProcessors: [reasoningStrippingProcessor],
});
