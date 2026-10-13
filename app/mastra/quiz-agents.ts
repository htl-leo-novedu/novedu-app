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

// Two agents that back the Quizzes feature. Both are configured ENTIRELY per
// request from values the caller places on the `RequestContext` (the quiz's
// provider + model, and the system prompt the caller built) — mirroring how
// `tutorAgent` resolves its prompt/model per request, but without the tutor-YAML
// coupling.
//
// SERVER-ONLY: resolves models through the `lib/llm` seam.

// The grader's structured verdict. The zod source of truth lives in the PURE
// `lib/quiz-verdict-schema.ts` so the CLI's prompt dump can emit it as JSON Schema
// without importing anything under `app/mastra/` (whose graph does a top-level-await
// network call at import time). Re-exported here so agent-adjacent code keeps finding
// it next to the agents that use it.
export { QUIZ_VERDICT_SCHEMA } from "@/lib/quiz-verdict-schema";

// RequestContext keys. Distinct per agent so a request for one can never satisfy
// the other (defense in depth on top of the runtime route's agent gating).
export const QUIZ_EVAL_INSTRUCTIONS = "quiz-eval-instructions";
export const QUIZ_EVAL_MODEL = "quiz-eval-model";
export const QUIZ_EVAL_PROVIDER = "quiz-eval-provider";
/** Optional reasoning effort for the grader; absent = the model's own default. */
export const QUIZ_EVAL_REASONING = "quiz-eval-reasoning";
export const QUIZ_DISCUSSION_INSTRUCTIONS = "quiz-discussion-instructions";
export const QUIZ_DISCUSSION_MODEL = "quiz-discussion-model";
export const QUIZ_DISCUSSION_PROVIDER = "quiz-discussion-provider";
/** Optional reasoning effort for the discussion chat; absent = the model's default. */
export const QUIZ_DISCUSSION_REASONING = "quiz-discussion-reasoning";

function requiredString(requestContext: RequestContext, key: string): string {
  const value = requestContext.get(key);
  if (typeof value !== "string" || value === "") {
    throw new Error(`Missing "${key}" on the request context for the quiz agent.`);
  }
  return value;
}

// An absent provider key means SCCH (matching the YAML default); an invalid value
// was already rejected by the quiz load, so lenient reading here is safe. The
// reasoning key is read the same way, inline at each resolver: absent (or, by the
// same argument, unparseable) simply pins no effort.
function providerFrom(requestContext: RequestContext, key: string): LlmProvider {
  return parseLenientProvider(requestContext.get(key)) ?? DEFAULT_PROVIDER;
}

// STATELESS grader: no `Memory`, so a `generate()` call persists nothing (the
// privacy promise — "we do NOT record quiz sessions"). The caller (the
// `submitAnswer` action) builds the full grading system prompt (frame + the
// question's server-only `evaluation` prompt) and passes the student's answer as
// the input message, then reads the structured `{ result, feedback }`.
export const quizEvaluatorAgent = new Agent({
  id: "quizEvaluator",
  name: "Quiz Evaluator",
  instructions: ({ requestContext }) => requiredString(requestContext, QUIZ_EVAL_INSTRUCTIONS),
  model: ({ requestContext }) =>
    modelEntry(
      providerFrom(requestContext, QUIZ_EVAL_PROVIDER),
      requiredString(requestContext, QUIZ_EVAL_MODEL),
      parseLenientReasoningLevel(requestContext.get(QUIZ_EVAL_REASONING)),
    ),
});

// The per-question discussion chat. Memory-backed exactly like `tutorAgent`
// (recent-message window, no semantic recall) so a thread persists and earlier
// turns reach the model through the recalled window. The runtime route sets the
// system prompt (the quiz's `discussion.instructions`) and model, and scopes
// memory to `resourceId = the quiz URL`.
export const quizDiscussionAgent = new Agent({
  id: "quizDiscussion",
  name: "Quiz Discussion",
  instructions: ({ requestContext }) =>
    requiredString(requestContext, QUIZ_DISCUSSION_INSTRUCTIONS),
  model: ({ requestContext }) =>
    modelEntry(
      providerFrom(requestContext, QUIZ_DISCUSSION_PROVIDER),
      requiredString(requestContext, QUIZ_DISCUSSION_MODEL),
      parseLenientReasoningLevel(requestContext.get(QUIZ_DISCUSSION_REASONING)),
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
