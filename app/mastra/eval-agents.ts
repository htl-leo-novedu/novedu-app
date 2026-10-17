import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { EVAL_JUDGE_CONTEXT, EVAL_TUTOR_CONTEXT } from "@/lib/llm-context";
import { contextInstructions, contextModel } from "./agent-context";
import { selectTutorTools } from "./tutor-tools";

// The two agents behind the teacher-only eval endpoints (docs/cli-eval.md):
//
//   evalJudge  (`POST /api/eval/judge`)   — audits a piece of model output against the
//                                           very system prompt that produced it.
//   evalTutor  (`POST /api/eval/respond`) — generates ONE tutor turn for a scripted
//                                           conversation, so a tutor eval measures a
//                                           real response rather than a mock.
//
// Both are configured ENTIRELY per request from the RequestContext, exactly like the quiz
// agents: the caller brings the system prompt and the provider/model pair (and, for the
// tutor, the tool grant). `evalJudge` is deliberately KIND-AGNOSTIC — nothing here knows
// about quizzes or tutors — so a further eval kind reuses it with no change (the criteria
// travel in the route's request body and become the structured-output enum there).
//
// SERVER-ONLY: resolves models through the `lib/llm` seam.
//
// SECURITY: like `quizEvaluator`, `evalJudge` and `evalTutor` are registered in
// `app/mastra/index.ts` but are NEVER web-reachable by students — the CopilotKit runtime
// route only ever accepts the ONE agent id its code's module declares, so every other id
// 404s. Their only callers are the `requireBearerTeacher`-gated eval routes (AGENTS.md,
// docs/codes.md).

// The tutor-generation agent's tool grant: the catalog names the route validated. Its
// prompt/model keys are `EVAL_TUTOR_CONTEXT`, the judge's `EVAL_JUDGE_CONTEXT`
// (lib/llm-context.ts).
export const EVAL_TUTOR_TOOLS = "eval-tutor-tools";

// The tool grant off the context. The ROUTE already rejected an unknown name with a
// terminal 400, so anything arriving here is a catalog name; a non-array is a wiring bug
// and fails loud rather than silently running the tutor tool-less.
function toolNames(requestContext: RequestContext, key: string): string[] {
  const value = requestContext.get(key);
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new Error(`"${key}" on the request context must be a list of tool names.`);
  }
  return value as string[];
}

// STATELESS: no `Memory`, so a `generate()` call persists nothing — the same privacy
// property the grader has. Nothing about an eval run is ever stored.
export const evalJudgeAgent = new Agent({
  id: "evalJudge",
  name: "Eval Judge",
  instructions: contextInstructions(EVAL_JUDGE_CONTEXT),
  model: contextModel(EVAL_JUDGE_CONTEXT),
});

/**
 * The tutor under test, for `POST /api/eval/respond`. Memory-less on purpose: a tutor
 * eval scripts the WHOLE conversation and asks for exactly one more turn, so recalled
 * history would make the run non-deterministic and would persist a teacher's synthetic
 * dialogue into the `mastra_*` tables. The tools are the real catalog instances the
 * runtime binds (`selectTutorTools`), so a tool-using tutor is evaluated on the path it
 * actually runs — executors are pure / injected-effect, and the run is teacher-initiated.
 */
export const evalTutorAgent = new Agent({
  id: "evalTutor",
  name: "Eval Tutor",
  instructions: contextInstructions(EVAL_TUTOR_CONTEXT),
  model: contextModel(EVAL_TUTOR_CONTEXT),
  tools: ({ requestContext }) => selectTutorTools(toolNames(requestContext, EVAL_TUTOR_TOOLS)),
});
