import { RequestContext } from "@mastra/core/request-context";
import { type CodeEntry, effectiveLlm } from "@/lib/code-store";
import { providerUnavailableReason } from "@/lib/llm/availability";
import type { LlmProvider, ReasoningLevel } from "@/lib/llm/provider";

// The RequestContext contract of the CONTEXT-CONFIGURED agents — the ones that read
// their whole configuration per request instead of loading a YAML themselves: the
// writing agent, the quiz grader and discussion agent, the eval judge and eval tutor.
// The caller sets the system prompt + the provider/model pair (+ reasoning effort) under
// the agent's own four keys; the agent reads them back (`app/mastra/agent-context.ts`).
// The tutor agent is not one of them: it gets the tutor URL and loads its YAML itself.
//
// Each agent has its OWN key set, so a request for one can never satisfy another
// (defense in depth on top of the runtime route's agent gating).
//
// SERVER-ONLY (reads the code row's LLM override and the server's provider config).

export interface LlmContextKeys {
  instructions: string;
  model: string;
  provider: string;
  /** Optional: absent ⇒ no reasoning effort is pinned (the model's own default). */
  reasoning: string;
}

function llmContextKeys(prefix: string): LlmContextKeys {
  return {
    instructions: `${prefix}-instructions`,
    model: `${prefix}-model`,
    provider: `${prefix}-provider`,
    reasoning: `${prefix}-reasoning`,
  };
}

export const WRITING_CONTEXT = llmContextKeys("writing");
export const QUIZ_EVAL_CONTEXT = llmContextKeys("quiz-eval");
export const QUIZ_DISCUSSION_CONTEXT = llmContextKeys("quiz-discussion");
export const EVAL_JUDGE_CONTEXT = llmContextKeys("eval-judge");
export const EVAL_TUTOR_CONTEXT = llmContextKeys("eval-tutor");

export interface ContextLlm {
  provider: LlmProvider;
  model: string;
  reasoning?: ReasoningLevel;
}

/** Put an agent's system prompt and model on the context; reasoning only when pinned. */
export function setLlmContext(
  context: RequestContext,
  keys: LlmContextKeys,
  instructions: string,
  llm: ContextLlm,
): void {
  context.set(keys.instructions, instructions);
  context.set(keys.model, llm.model);
  context.set(keys.provider, llm.provider);
  if (llm.reasoning) context.set(keys.reasoning, llm.reasoning);
}

/**
 * The per-request context of a code module's chat agent (writing, quiz discussion): the
 * code's LLM override pair, when set, replaces the activity YAML's llm values; a
 * provider this server cannot serve fails with a 502 the runtime route forwards. (The
 * authoring gate blocks saving such a file, but externally hosted YAML or an env change
 * can still name one.)
 */
export function llmRequestContext(
  entry: Pick<CodeEntry, "llm">,
  activityLlm: ContextLlm,
  keys: LlmContextKeys,
  instructions: string,
): { ok: true; context: RequestContext } | { ok: false; status: number; message: string } {
  const llm = effectiveLlm(entry, activityLlm);
  const unavailable = providerUnavailableReason(llm.provider);
  if (unavailable) return { ok: false, status: 502, message: unavailable };
  const context = new RequestContext();
  setLlmContext(context, keys, instructions, llm);
  return { ok: true, context };
}
