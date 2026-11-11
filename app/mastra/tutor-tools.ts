// Mastra bindings for the pure tutor-tool catalog (lib/tutor-tools). This is
// the ONLY place tool defs meet `createTool`: the catalog stays framework-free
// (and CLI-bundlable), while every Mastra `Tool` instance is created once at
// module load — tools are stateless, so instances are safely shared across
// requests and the per-request `tools` resolver just picks a subset.
//
// A stateful tool (`board`) gets the thread's earlier successful calls of the
// same tool injected per call (`priorCalls`, docs/tutor-board.md): every stored
// message of the thread (not only the agent's 40-message memory window) plus
// this run's calls Mastra has not stored yet, deduplicated by tool-call id. A run
// without a thread (the eval tutor) starts from its own calls only — an empty
// board per eval turn.
//
// A successful `board` call in a conversation is metered here
// (`meterBoardDrawing`, docs/usage-metering.md): the binding is the one place
// that sees both the tool's result and the request's usage attribution.

import { createTool, type ToolAction } from "@mastra/core/tools";
import { type BoardCall, boardCallsFromStored } from "@/lib/board/calls";
import { loadThreadBoardCalls } from "@/lib/tutor-board-store";
import {
  type AnyTutorToolDef,
  defaultTutorToolDeps,
  NO_PRIOR_CALLS,
  TUTOR_TOOL_NAMES,
  type TutorToolCallContext,
  type TutorToolName,
  tutorToolCatalog,
} from "@/lib/tutor-tools";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";
import { recordBoardDrawing } from "@/lib/usage-store";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool map — per-tool types live on each instance.
type AnyMastraTool = ToolAction<any, any, any, any, any>;

/** The part of Mastra's tool execution context this binding reads. */
export interface ToolCallAgentContext {
  agent?: {
    toolCallId: string;
    threadId?: string;
    resourceId?: string;
    getMessages?: () => readonly { role?: unknown; content?: unknown }[];
  };
  /** The request's context; carries the usage attribution (lib/usage-context-keys.ts). */
  requestContext?: { get(key: string): unknown };
}

/** The thread store seam, swappable in tests. */
export interface PriorCallsDeps {
  loadThreadCalls: (code: string, threadId: string) => Promise<BoardCall[]>;
}

const defaultPriorCallsDeps: PriorCallsDeps = { loadThreadCalls: loadThreadBoardCalls };

/**
 * The thread's earlier successful calls of a stateful tool: the stored ones
 * first (all of the thread's messages), then this run's not yet stored, minus
 * the call being executed.
 */
export async function priorCallsFor(
  context: ToolCallAgentContext | undefined,
  deps: PriorCallsDeps = defaultPriorCallsDeps,
): Promise<TutorToolCallContext> {
  const agent = context?.agent;
  if (!agent) return NO_PRIOR_CALLS;
  const { threadId, resourceId, toolCallId } = agent;
  const stored = threadId && resourceId ? await deps.loadThreadCalls(resourceId, threadId) : [];
  const live = boardCallsFromStored(agent.getMessages?.() ?? []);
  const seen = new Set<string>([toolCallId]);
  const calls: unknown[] = [];
  for (const call of [...stored, ...live]) {
    if (seen.has(call.id)) continue;
    seen.add(call.id);
    calls.push(call.input);
  }
  return { priorCalls: calls };
}

/**
 * Counts a successful `board` call of a conversation as one board drawing
 * (docs/usage-metering.md). A run without a thread (the eval tutor) or without
 * usage attribution counts nothing. Fire-and-forget: the recorder never throws.
 */
export function meterBoardDrawing(
  name: string,
  result: unknown,
  context: ToolCallAgentContext | undefined,
  record: typeof recordBoardDrawing = recordBoardDrawing,
): void {
  if (name !== "board" || (result as { ok?: unknown } | undefined)?.ok !== true) return;
  if (!context?.agent?.threadId) return;
  const code = context.requestContext?.get(USAGE_CODE);
  const userId = context.requestContext?.get(USAGE_USER_ID);
  const module = context.requestContext?.get(USAGE_MODULE);
  if (typeof code !== "string" || typeof userId !== "string" || typeof module !== "string") return;
  void record({ code, module, userId });
}

function bind(def: AnyTutorToolDef): AnyMastraTool {
  return createTool({
    id: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    execute: async (input, context) => {
      const result = await def.execute(
        input,
        defaultTutorToolDeps,
        def.stateful ? await priorCallsFor(context as ToolCallAgentContext) : NO_PRIOR_CALLS,
      );
      meterBoardDrawing(def.name, result, context as ToolCallAgentContext);
      return result;
    },
  });
}

const mastraTutorTools: Record<TutorToolName, AnyMastraTool> = Object.fromEntries(
  TUTOR_TOOL_NAMES.map((name) => [name, bind(tutorToolCatalog[name])]),
) as Record<TutorToolName, AnyMastraTool>;

/**
 * The Mastra toolset for a tutor's validated `tools:` selection. Takes plain
 * strings (the `BuildResult.tools` shape) and fails loud on an unknown name —
 * the schema already rejects those at load time, so hitting this throw means a
 * wiring bug, not bad authoring input.
 */
export function selectTutorTools(names: readonly string[]): Record<string, AnyMastraTool> {
  const toolset: Record<string, AnyMastraTool> = {};
  for (const name of names) {
    const tool = mastraTutorTools[name as TutorToolName];
    if (!tool) throw new Error(`Unknown tutor tool: ${name}`);
    toolset[name] = tool;
  }
  return toolset;
}
