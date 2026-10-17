import { Agent } from "@mastra/core/agent";
import { WRITING_CONTEXT } from "@/lib/llm-context";
import { chatMemory, contextInstructions, contextModel } from "./agent-context";
import { reasoningStrippingProcessor } from "./reasoning-processor";

// The agent that backs the Writing feature's feedback chat. It is configured
// ENTIRELY per request from values the caller places on the `RequestContext` (the
// activity's provider + model, and the teacher's system prompt) under
// `WRITING_CONTEXT` (lib/llm-context.ts).
//
// The agent has NO write/edit tool — it is read-only BY CONSTRUCTION. The only
// tool it can call is the browser-side `getCurrentText` (a frontend tool forwarded
// by @ag-ui/mastra), which returns the student's live editor buffer; there is no
// server-side capability that can mutate the student's text.
//
// SERVER-ONLY: resolves models through the `lib/llm` seam.

// The feedback chat. Memory-backed exactly like `tutorAgent` and the quiz
// discussion agent (recent-message window, no semantic recall) so a thread
// persists and earlier turns reach the model through the recalled window. The
// runtime route sets the system prompt (the activity's `instructions`) and
// model, and scopes memory to `resourceId = the code`.
export const writingAgent = new Agent({
  id: "writing",
  name: "Writing",
  instructions: contextInstructions(WRITING_CONTEXT),
  model: contextModel(WRITING_CONTEXT),
  memory: chatMemory(),
  // Reasoning is a live-only artefact: this drops it after the response has
  // streamed and before memory persists the turn (app/mastra/reasoning-processor.ts).
  outputProcessors: [reasoningStrippingProcessor],
});
