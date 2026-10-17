import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { mastra } from "@/app/mastra";
import { EVAL_TUTOR_TOOLS } from "@/app/mastra/eval-agents";
import { ApiAuthError, requireBearerTeacher } from "@/lib/api-auth";
import { readBoundedJson } from "@/lib/bounded-json";
import { providerUnavailableReason } from "@/lib/llm/availability";
import { DEFAULT_PROVIDER, parseLenientProvider, REASONING_LEVELS } from "@/lib/llm/provider";
import { classifyUpstreamLlmError } from "@/lib/llm/upstream-error";
import { EVAL_TUTOR_CONTEXT, setLlmContext } from "@/lib/llm-context";
import { recordError } from "@/lib/telemetry";
import { TUTOR_TOOL_NAMES } from "@/lib/tutor-tools/names";
import { setUsageContext } from "@/lib/usage-context-keys";
import { authErrorResponse, json } from "../../shared";
import { llmCallUsage } from "../shared";

// CLI/API bearer route backing the TUTOR kind of `novedu-cli eval` (docs/cli-eval.md):
// generate ONE tutor turn for a scripted conversation. Sibling of `/api/eval/grade` and
// `/api/eval/judge` in every respect — stateless (one request = one generated response,
// nothing queued, nothing persisted), the CLI owns the fan-out and the retries.
//
// The whole conversation arrives in the body — the teacher scripted the student turns AND
// any prior tutor turns — so the memory-less `evalTutor` agent needs no thread and no
// storage: it answers the LAST message and forgets everything. That is what makes a tutor
// eval deterministic and fan-out-able.
//
// SECURITY (same trust argument as the grade and judge routes — AGENTS.md,
// docs/codes.md): `evalTutor` is registered but NEVER web-reachable by students (the
// CopilotKit runtime route only accepts the one agent id a code's module declares, so
// every other id 404s); the gate here is `requireBearerTeacher`, which has no student
// mode; the `system` prompt comes from the CLIENT (the CLI assembled it offline from the
// teacher's own YAML), so no server-held prompt is involved; and the agent is memory-less
// while this route writes nothing. Real tool calls DO execute — harmless by construction:
// the catalog's executors are pure / injected-effect and the run is teacher-initiated.
//
// Stated plainly: a teacher-scoped LLM pass-through, deliberate and acceptable under this
// repo's trust model exactly as the grade route argues.

export const dynamic = "force-dynamic";

// A tutor system prompt plus a scripted conversation. The same cap as its siblings: far
// above any real case, while bounding worst-case memory on a buffered body.
const MAX_BODY_BYTES = 256 * 1024;

/** Generations are metered under the same pseudo-code as gradings (`docs/cli-eval.md`). */
const EVAL_USAGE_CODE = "cli-eval";

/** The usage module label for eval runs (its own group in the dashboard). */
const EVAL_USAGE_MODULE = "eval";

const RespondBodySchema = z.strictObject({
  llm: z.strictObject({
    provider: z.string().optional(),
    model: z.string().min(1).max(256),
    // The tutor's optional reasoning effort, enum-checked here for the same reason as on
    // the judge route: an unknown level is terminal, never worth a retry.
    reasoning: z.enum(REASONING_LEVELS).optional(),
  }),
  system: z.string().min(1),
  // The tutor's `tools:` grant, as the catalog names the CLI read out of the prompt dump.
  // Bounded to the catalog's size; an unknown NAME is checked below so the message can
  // name it (the schema would only say "invalid enum value").
  tools: z.array(z.string()).max(32),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant"]),
        text: z.string().min(1),
      }),
    )
    .min(1)
    .max(200),
});

/**
 * The tool NAMES one generate result invoked, in call order and with duplicates kept —
 * Mastra 1.x reports tool calls as CHUNKS (`{ type: "tool-call", payload: { toolName, … } }`)
 * on the result's top-level `toolCalls`, which accumulates across every step of the run.
 * Names only, deliberately: arguments and results can be large and nothing downstream
 * needs them.
 *
 * Defensive by construction — a result shape that carries no usable chunk yields `[]`
 * rather than throwing, because a tool-less tutor and a provider that reports nothing must
 * both simply produce an empty list.
 */
function toolCallNames(result: unknown): string[] {
  const calls = (result as { toolCalls?: unknown } | null | undefined)?.toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call) => {
    const name = (call as { payload?: { toolName?: unknown } } | null)?.payload?.toolName;
    return typeof name === "string" && name !== "" ? [name] : [];
  });
}

/**
 * Generates one tutor response. Body
 * `{ llm: { provider?, model, reasoning? }, system, tools, messages }` →
 * `200 { text, toolCalls, usage? }`, where `text` is the generated turn as plain text (no
 * structured output, hence no truncation-retry wrapper), `toolCalls` the names the
 * generation invoked (in call order, `[]` when none — ALWAYS present, so a CLI can tell a
 * tool-less run from a server that cannot report tool calls at all) and the OPTIONAL
 * `usage: { input, cachedInput, output }`
 * carries this call's tokens when the provider reported any (see {@link llmCallUsage}).
 * `400` on a malformed body, a tool name the catalog does not know, an unknown or
 * unavailable provider, or an upstream model call that can never succeed as sent (a
 * deployment name that does not exist — terminal, so the CLI does not retry it); `413`
 * over the 256 KB cap; `401`/`403` from the bearer gate; `502` when the tutor returns no
 * text or fails for a reason worth retrying (outage, rate limit, timeout, or the provider
 * refusing the server's own credentials — that one says so explicitly).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireBearerTeacher(request);

    // Fast reject for honest clients; the streaming read below is the real bound.
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ message: "Request body is too large." }, 413);
    }

    const read = await readBoundedJson(request, MAX_BODY_BYTES);
    if (!read.ok) return json({ message: read.message }, read.status);

    const parsed = RespondBodySchema.safeParse(read.value);
    if (!parsed.success) {
      return json(
        {
          message:
            "Provide `llm: { provider?, model, reasoning? }`, `system`, `tools` and `messages`.",
        },
        400,
      );
    }
    const body = parsed.data;

    // TERMINAL, and loud: the runtime throws on an unknown tool name because the tutor
    // schema already rejected it at load time, so a name arriving here means the caller
    // sent something the catalog never had. Name it instead of retrying it.
    const unknownTool = body.tools.find(
      (name) => !(TUTOR_TOOL_NAMES as readonly string[]).includes(name),
    );
    if (unknownTool !== undefined) {
      return json({ message: `Unknown tutor tool "${unknownTool}".` }, 400);
    }

    // An UNKNOWN provider string is rejected rather than silently defaulted — a
    // Foundry-intended run must never quietly generate on SCCH.
    const provider =
      body.llm.provider === undefined ? DEFAULT_PROVIDER : parseLenientProvider(body.llm.provider);
    if (provider === undefined) {
      return json({ message: `Unknown LLM provider "${body.llm.provider}".` }, 400);
    }

    // TERMINAL, not retryable — same reasoning as the grade route: a deployment without
    // the provider can never answer, so it must fail fast instead of burning retries.
    const unavailable = providerUnavailableReason(provider);
    if (unavailable) return json({ message: unavailable }, 400);

    const requestContext = new RequestContext();
    setLlmContext(requestContext, EVAL_TUTOR_CONTEXT, body.system, {
      provider,
      model: body.llm.model,
      // Absent unless the caller pinned one — "the model decides".
      reasoning: body.llm.reasoning,
    });
    requestContext.set(EVAL_TUTOR_TOOLS, body.tools);
    // Generation tokens land in the SAME buckets as the judgings that audit them — one
    // eval run is one cost (docs/usage-metering.md).
    setUsageContext(requestContext, {
      code: EVAL_USAGE_CODE,
      userId: user.userId,
      module: EVAL_USAGE_MODULE,
    });

    try {
      const res = await mastra.getAgent("evalTutor").generate(
        // The scripted turns verbatim, in order; the last one is the student message the
        // model answers.
        body.messages.map((message) =>
          message.role === "user"
            ? { role: "user" as const, content: message.text }
            : { role: "assistant" as const, content: message.text },
        ),
        { requestContext },
      );
      const text = typeof res.text === "string" ? res.text.trim() : "";
      if (!text) return json({ message: "The tutor returned no response." }, 502);
      const usage = llmCallUsage(res);
      return json({ text, toolCalls: toolCallNames(res), ...(usage ? { usage } : {}) }, 200);
    } catch (error) {
      // The same terminal-vs-retryable split as its siblings: a deployment name that does
      // not exist is the CALLER's and must not be retried; an outage is the
      // server's/provider's. See lib/llm/upstream-error.ts.
      const failure = classifyUpstreamLlmError(error, {
        provider,
        model: body.llm.model,
        opaqueMessage: "The tutor could not answer right now.",
      });
      recordError(error, { "novedu.area": "api-eval", ...failure.telemetry });
      return json({ message: failure.message }, failure.terminal ? 400 : 502);
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error);
    recordError(error, { "novedu.area": "api-eval" });
    return json({ message: "Internal server error" }, 500);
  }
}
