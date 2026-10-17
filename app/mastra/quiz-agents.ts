import { Agent } from "@mastra/core/agent";
import { QUIZ_DISCUSSION_CONTEXT, QUIZ_EVAL_CONTEXT } from "@/lib/llm-context";
import { chatMemory, contextInstructions, contextModel } from "./agent-context";
import { reasoningStrippingProcessor } from "./reasoning-processor";

// Two agents that back the Quizzes feature. Both are configured ENTIRELY per
// request from values the caller places on the `RequestContext` (the quiz's
// provider + model, and the system prompt the caller built), each under its own key
// set (`QUIZ_EVAL_CONTEXT` / `QUIZ_DISCUSSION_CONTEXT`, lib/llm-context.ts).
//
// SERVER-ONLY: resolves models through the `lib/llm` seam.

// The grader's structured verdict. The zod source of truth lives in the PURE
// `lib/quiz-verdict-schema.ts` so the CLI's prompt dump can emit it as JSON Schema
// without importing anything under `app/mastra/` (whose graph does a top-level-await
// network call at import time). Re-exported here so agent-adjacent code keeps finding
// it next to the agents that use it.
export { QUIZ_VERDICT_SCHEMA } from "@/lib/quiz-verdict-schema";

// STATELESS grader: no `Memory`, so a `generate()` call persists nothing (the
// privacy promise — "we do NOT record quiz sessions"). The caller (the
// `submitAnswer` action) builds the full grading system prompt (frame + the
// question's server-only `evaluation` prompt) and passes the student's answer as
// the input message, then reads the structured `{ result, feedback }`.
export const quizEvaluatorAgent = new Agent({
  id: "quizEvaluator",
  name: "Quiz Evaluator",
  instructions: contextInstructions(QUIZ_EVAL_CONTEXT),
  model: contextModel(QUIZ_EVAL_CONTEXT),
});

// The per-question discussion chat. Memory-backed exactly like `tutorAgent`
// (recent-message window, no semantic recall) so a thread persists and earlier
// turns reach the model through the recalled window. The runtime route sets the
// system prompt (the quiz's `discussion.instructions`) and model, and scopes
// memory to `resourceId = the quiz URL`.
export const quizDiscussionAgent = new Agent({
  id: "quizDiscussion",
  name: "Quiz Discussion",
  instructions: contextInstructions(QUIZ_DISCUSSION_CONTEXT),
  model: contextModel(QUIZ_DISCUSSION_CONTEXT),
  memory: chatMemory(),
  // Reasoning is a live-only artefact: this drops it after the response has
  // streamed and before memory persists the turn (app/mastra/reasoning-processor.ts).
  outputProcessors: [reasoningStrippingProcessor],
});
