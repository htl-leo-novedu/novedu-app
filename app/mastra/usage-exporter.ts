import {
  type AnyExportedSpan,
  type ModelGenerationAttributes,
  type ObservabilityExporter,
  SpanType,
  type TracingEvent,
} from "@mastra/core/observability";
import { providerFromModelProviderId } from "@/lib/llm/provider";
import { recordError } from "@/lib/telemetry";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";
import { recordLlmUsage } from "@/lib/usage-store";

// A Mastra ObservabilityExporter that meters token usage + tool calls for every
// agent run (tutor, quiz discussion, writing, and the server-only quiz grader).
// Registered on the Mastra instance (app/mastra/index.ts) via `@mastra/observability`
// with `requestContextKeys: [usageCode, usageUserId, usageModule]`, so the three
// attribution keys the seams set (`built.context` in the CopilotKit route; the
// grader RequestContext in lib/quiz-actions.ts) are snapshotted onto each span.
//
// This is the Mastra-native capture path: `@ag-ui/mastra` drops `usage` from the
// AG-UI event stream, so tapping the outgoing SSE would miss tokens. The coding
// proxy (no Mastra) is metered separately (lib/coding-proxy.ts + its route).
//
// PRIVACY: reads ONLY ids + token counts off the span — never `input`/`output`
// (prompt/message content). Consistent with the telemetry no-PII invariant. Never
// throws: any failure goes to `recordError`, so metering can't break a run.

const TOOL_SPAN_TYPES: ReadonlySet<SpanType> = new Set([
  SpanType.TOOL_CALL,
  SpanType.CLIENT_TOOL_CALL,
  SpanType.MCP_TOOL_CALL,
]);

/** The metered payload a span maps to (mirrors `LlmUsageInput` minus the fixed fields). */
export interface MappedUsage {
  code: string;
  module: string;
  userId?: string;
  /** From the span's `attributes.provider` (see `llmAttribution`). Generation spans only. */
  provider?: string;
  /** From the span's `attributes.model` — the activity YAML's `llm.model`. */
  model?: string;
  inputNew: number;
  inputCached: number;
  output: number;
  toolCalls: number;
  at?: Date;
}

// Which LLM served the generation, read off the MODEL_GENERATION span's typed
// attributes: Mastra stamps `model` (the ai-sdk modelId = the YAML's `llm.model`)
// and `provider` (the ai-sdk provider name, e.g. "scch.chat" — set via
// `createOpenAI({ name })`, the metering contract in lib/llm/provider.ts). The
// mapped app-level label ("SCCH"/"Azure Foundry") is stored; an unmapped id falls
// through raw rather than being dropped, so a naming regression stays visible.
function llmAttribution(attrs: ModelGenerationAttributes | undefined): {
  provider?: string;
  model?: string;
} {
  return {
    provider: providerFromModelProviderId(attrs?.provider) ?? attrs?.provider,
    model: attrs?.model,
  };
}

// Reads the usage-attribution keys off a span. `requestContextKeys` snapshots them
// onto `span.requestContext`; some Mastra paths surface extracted keys as
// `span.metadata` instead, so read both. Empty/non-string ⇒ undefined.
function attribution(span: AnyExportedSpan): {
  code?: string;
  module?: string;
  userId?: string;
} {
  const rc = span.requestContext ?? {};
  const md = span.metadata ?? {};
  const read = (k: string): string | undefined => {
    const v = rc[k] ?? md[k];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  return { code: read(USAGE_CODE), module: read(USAGE_MODULE), userId: read(USAGE_USER_ID) };
}

/**
 * Maps an ENDED span to a usage record, or `null` when it carries nothing we meter
 * or lacks the attribution keys. Pure (no I/O) so it unit-tests over fake spans.
 *
 * - `MODEL_GENERATION`: the per-generation token aggregate. `UsageStats` in
 *   @mastra/core → `inputCached = inputDetails.cacheRead`, `inputNew =
 *   inputTokens - cached`, `output = outputTokens` (already includes reasoning).
 *   We use `MODEL_GENERATION` ONLY (never `MODEL_STEP`) to avoid double-counting.
 * - `TOOL_CALL` / `CLIENT_TOOL_CALL` / `MCP_TOOL_CALL`: one tool call, no tokens.
 */
export function mapSpanToUsage(span: AnyExportedSpan): MappedUsage | null {
  const { code, module, userId } = attribution(span);
  // `usage_by_code` needs both a code and its module; without them we can't attribute.
  if (!code || !module) return null;
  const at = span.endTime ?? undefined;

  if (span.type === SpanType.MODEL_GENERATION) {
    const attrs = span.attributes as ModelGenerationAttributes | undefined;
    const usage = attrs?.usage;
    if (!usage) return null;
    const inputCached = usage.inputDetails?.cacheRead ?? 0;
    const inputNew = Math.max(0, (usage.inputTokens ?? 0) - inputCached);
    const output = usage.outputTokens ?? 0;
    if (inputNew === 0 && inputCached === 0 && output === 0) return null;
    const { provider, model } = llmAttribution(attrs);
    return {
      code,
      module,
      userId,
      provider,
      model,
      inputNew,
      inputCached,
      output,
      toolCalls: 0,
      at,
    };
  }

  if (TOOL_SPAN_TYPES.has(span.type)) {
    return { code, module, userId, inputNew: 0, inputCached: 0, output: 0, toolCalls: 1, at };
  }

  return null;
}

/** The exporter registered on the Mastra instance. */
export const usageExporter: ObservabilityExporter = {
  name: "novedu-usage",
  async exportTracingEvent(event: TracingEvent): Promise<void> {
    try {
      if (event.type !== "span_ended") return;
      const mapped = mapSpanToUsage(event.exportedSpan);
      if (!mapped) return;
      await recordLlmUsage(mapped);
    } catch (error) {
      recordError(error, { exporter: "novedu-usage" });
    }
  },
  async flush(): Promise<void> {},
  async shutdown(): Promise<void> {},
};
