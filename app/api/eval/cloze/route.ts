import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { mastra } from "@/app/mastra";
import {
  CLOZE_EVAL_INSTRUCTIONS,
  CLOZE_EVAL_MODEL,
  CLOZE_EVAL_PROVIDER,
  CLOZE_EVAL_REASONING,
} from "@/app/mastra/cloze-agents";
import { ApiAuthError, requireBearerTeacher } from "@/lib/api-auth";
import { readBoundedJson } from "@/lib/bounded-json";
import {
  CLOZE_FEEDBACK_SCHEMA,
  CLOZE_GRADING_SCHEMA,
  clozeFeedbackTexts,
  clozeGradingTexts,
} from "@/lib/cloze-output-schemas";
import { providerUnavailableReason } from "@/lib/llm/availability";
import { DEFAULT_PROVIDER, parseLenientProvider, REASONING_LEVELS } from "@/lib/llm/provider";
import { classifyUpstreamLlmError } from "@/lib/llm/upstream-error";
import { withTruncationRetry } from "@/lib/quiz-truncation-retry";
import { recordError } from "@/lib/telemetry";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";
import { authErrorResponse, json } from "../../shared";
import { llmCallUsage } from "../shared";

// CLI/API bearer route backing the CLOZE kind of `novedu-cli eval` (docs/cli-eval.md):
// run ONE call of the cloze pipeline — `step: "grade"` or `step: "explain"` — through the
// SAME memory-less `clozeEvaluator` agent, the same step schema and the same truncation
// retry `gradeCloze` / `explainCloze` use. The CLI assembled the system prompt and the
// user message offline (through `dumpPrompts` and the production message builders), runs
// the pre-pass and the grounding filter itself, and owns the fan-out and the retries.
// Stateless: one request = one call, nothing queued, nothing persisted.
//
// SECURITY (the grade route's argument — AGENTS.md, docs/codes.md): besides the two
// cloze server actions this is the ONE other caller of `clozeEvaluator`, which the
// CopilotKit runtime route 404s. The gate is `requireBearerTeacher` (no student mode);
// the prompts come from the CLIENT, so the server-held references and `evaluation` of a
// stored exercise are never involved; the agent is memory-less and this route writes
// nothing. A teacher-scoped, schema-constrained LLM pass-through — acceptable under
// this repo's trust model, where teachers author every activity prompt.

export const dynamic = "force-dynamic";

// A cloze prompt (the whole text with every reference) plus at most 40 answers of 200
// characters — the same cap as the sibling eval routes.
const MAX_BODY_BYTES = 256 * 1024;

/** Cloze eval calls are metered under the same pseudo-code as every eval call. */
const EVAL_USAGE_CODE = "cli-eval";

/** The usage module label for eval runs (its own group in the dashboard). */
const EVAL_USAGE_MODULE = "eval";

const ClozeBodySchema = z.strictObject({
  llm: z.strictObject({
    provider: z.string().optional(),
    model: z.string().min(1).max(256),
    reasoning: z.enum(REASONING_LEVELS).optional(),
  }),
  step: z.enum(["grade", "explain"]),
  system: z.string().min(1),
  user: z.string().min(1),
});

/**
 * Runs one cloze call. Body `{ llm: { provider?, model, reasoning? }, step, system, user }`
 * → `200 { output, usage? }`, where `output` is the step's structured object — grade:
 * `{ gaps: [{ gap, result, reason }] }`, explain: `{ patterns: [...], gap_notes: [...] }`
 * (lib/cloze-output-schemas.ts) — UNFILTERED: the coverage check and the grounding filter
 * are the caller's. `400` on a malformed body, an unknown or unavailable provider, or a
 * terminal upstream error (a deployment name that does not exist); `413` over 256 KB;
 * `401`/`403` from the gate; `502` when the model returns no structured object or fails
 * for a reason worth retrying.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireBearerTeacher(request);

    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ message: "Request body is too large." }, 413);
    }

    const read = await readBoundedJson(request, MAX_BODY_BYTES);
    if (!read.ok) return json({ message: read.message }, read.status);

    const parsed = ClozeBodySchema.safeParse(read.value);
    if (!parsed.success) {
      return json(
        {
          message:
            'Provide `llm: { provider?, model, reasoning? }`, `step` ("grade" or "explain"), `system` and `user`.',
        },
        400,
      );
    }
    const body = parsed.data;

    // An UNKNOWN provider is rejected rather than silently defaulted (the grade route's
    // rule); an unavailable one is TERMINAL so the CLI does not burn its retries on it.
    const provider =
      body.llm.provider === undefined ? DEFAULT_PROVIDER : parseLenientProvider(body.llm.provider);
    if (provider === undefined) {
      return json({ message: `Unknown LLM provider "${body.llm.provider}".` }, 400);
    }
    const unavailable = providerUnavailableReason(provider);
    if (unavailable) return json({ message: unavailable }, 400);

    const requestContext = new RequestContext();
    requestContext.set(CLOZE_EVAL_INSTRUCTIONS, body.system);
    requestContext.set(CLOZE_EVAL_MODEL, body.llm.model);
    requestContext.set(CLOZE_EVAL_PROVIDER, provider);
    if (body.llm.reasoning) requestContext.set(CLOZE_EVAL_REASONING, body.llm.reasoning);
    requestContext.set(USAGE_CODE, EVAL_USAGE_CODE);
    requestContext.set(USAGE_USER_ID, user.userId);
    requestContext.set(USAGE_MODULE, EVAL_USAGE_MODULE);

    try {
      const agent = mastra.getAgent("clozeEvaluator");
      // The step's schema and the student path's truncation retry — written out per step
      // so each keeps its own static output type.
      const { raw, object } =
        body.step === "grade"
          ? await withTruncationRetry(
              () =>
                agent.generate(body.user, {
                  structuredOutput: { schema: CLOZE_GRADING_SCHEMA },
                  requestContext,
                }),
              (res) => res.object as z.infer<typeof CLOZE_GRADING_SCHEMA> | undefined,
              clozeGradingTexts,
              "cloze.grading.truncated",
              { code: EVAL_USAGE_CODE },
            )
          : await withTruncationRetry(
              () =>
                agent.generate(body.user, {
                  structuredOutput: { schema: CLOZE_FEEDBACK_SCHEMA },
                  requestContext,
                }),
              (res) => res.object as z.infer<typeof CLOZE_FEEDBACK_SCHEMA> | undefined,
              clozeFeedbackTexts,
              "cloze.feedback.truncated",
              { code: EVAL_USAGE_CODE },
            );
      if (!object) return json({ message: "The model returned no structured answer." }, 502);
      const usage = llmCallUsage(raw);
      return json({ output: object, ...(usage ? { usage } : {}) }, 200);
    } catch (error) {
      const failure = classifyUpstreamLlmError(error, { provider, model: body.llm.model });
      recordError(error, { "novedu.area": "api-eval", ...failure.telemetry });
      return json({ message: failure.message }, failure.terminal ? 400 : 502);
    }
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error);
    recordError(error, { "novedu.area": "api-eval" });
    return json({ message: "Internal server error" }, 500);
  }
}
