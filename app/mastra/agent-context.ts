import type { RequestContext } from "@mastra/core/request-context";
import { Memory } from "@mastra/memory";
import {
  DEFAULT_PROVIDER,
  parseLenientProvider,
  parseLenientReasoningLevel,
} from "@/lib/llm/provider";
import type { LlmContextKeys } from "@/lib/llm-context";
import { modelEntry } from "./model-entry";

// The agent side of the context-configured agents (writing, quiz grader + discussion,
// eval judge + eval tutor): `instructions:` and `model:` resolvers that read the four
// keys the caller set (`lib/llm-context.ts`), plus the chat memory every memory-backed
// agent shares.
//
// SERVER-ONLY: resolves models through the `lib/llm` seam.

type ResolverArgs = { requestContext: RequestContext };

function requiredString(requestContext: RequestContext, key: string): string {
  const value = requestContext.get(key);
  if (typeof value !== "string" || value === "") {
    throw new Error(`Missing "${key}" on the request context.`);
  }
  return value;
}

/** The agent's `instructions:` resolver: the system prompt the caller set. */
export function contextInstructions(keys: LlmContextKeys) {
  return ({ requestContext }: ResolverArgs) => requiredString(requestContext, keys.instructions);
}

/**
 * The agent's `model:` resolver. An absent provider key means SCCH (the YAML default);
 * an invalid value was already rejected where the caller loaded it, so lenient reading
 * is safe — and the reasoning key likewise: absent (or unparseable) pins no effort.
 */
export function contextModel(keys: LlmContextKeys) {
  return ({ requestContext }: ResolverArgs) =>
    modelEntry(
      parseLenientProvider(requestContext.get(keys.provider)) ?? DEFAULT_PROVIDER,
      requiredString(requestContext, keys.model),
      parseLenientReasoningLevel(requestContext.get(keys.reasoning)),
    );
}

/**
 * The memory of every student-facing chat agent (tutor, quiz discussion, writing): a
 * recent-message window, no semantic recall. The runtime hands the agent only the
 * messages the thread's memory does not hold yet (the new turn), so prior turns reach
 * the model ONLY through this recalled window; 40 ≈ 20 exchanges. `Memory` REQUIRES a
 * storage provider — without `DATABASE_URL` a chat fails ("Memory requires a storage
 * provider"), which is acceptable: storage is required to chat. A memory-backed agent
 * also needs `reasoningStrippingProcessor` in its `outputProcessors` (docs/chat.md).
 */
export function chatMemory(): Memory {
  return new Memory({
    options: {
      lastMessages: 40,
      semanticRecall: false,
    },
  });
}
