import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { mastra } from "@/app/mastra";
import {
  EVAL_JUDGE_INSTRUCTIONS,
  EVAL_JUDGE_MODEL,
  EVAL_JUDGE_PROVIDER,
  EVAL_JUDGE_REASONING,
} from "@/app/mastra/eval-agents";
import { ApiAuthError, requireBearerTeacher } from "@/lib/api-auth";
import { readBoundedJson } from "@/lib/bounded-json";
import { providerUnavailableReason } from "@/lib/llm/availability";
import { DEFAULT_PROVIDER, parseLenientProvider, REASONING_LEVELS } from "@/lib/llm/provider";
import { classifyUpstreamLlmError } from "@/lib/llm/upstream-error";
import { type FeedbackJudgeIssue, judgmentSchema } from "@/lib/quiz-feedback-judge";
import { recordError } from "@/lib/telemetry";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";
import { authErrorResponse, json } from "../../shared";
import { llmCallUsage } from "../shared";

// CLI/API bearer route backing the FEEDBACK JUDGE of `novedu-cli eval`
// (docs/cli-eval.md): audit ONE grader answer's textual feedback and report the
// violations found. Sibling of `/api/eval/grade` in every respect — stateless (one
// request = one judgment, nothing queued, nothing persisted), the CLI owns the fan-out
// and the retries.
//
// KIND-AGNOSTIC BY CONSTRUCTION: the judge system prompt, the assembled subject AND the
// criteria taxonomy all arrive in the request body, so the eval kinds still to come reuse
// this endpoint with zero server change — the same property that let `--llm-*` land on
// the grade route without touching it. The `criteria` become the structured-output enum,
// so the model can never name something the caller's report cannot render.
//
// SECURITY (same trust argument as the grade route — AGENTS.md, docs/codes.md): the
// `evalJudge` agent is registered but NEVER web-reachable by students (the CopilotKit
// runtime route only accepts the one agent id a code's module declares, so every other id
// 404s); the gate here is `requireBearerTeacher`, which has no student mode; both prompts
// come from the CLIENT, so no server-held quiz `evaluation` prompt is involved at all;
// and the agent is memory-less while this route writes nothing.

export const dynamic = "force-dynamic";

// A grading prompt, a golden answer and a feedback text, all inside one `subject`. The
// same cap as the grade route: far above any real case, while bounding worst-case memory
// on a buffered body.
const MAX_BODY_BYTES = 256 * 1024;

/** Judge calls are metered under the same pseudo-code as gradings (`docs/cli-eval.md`). */
const EVAL_USAGE_CODE = "cli-eval";

/** The usage module label for eval runs (its own group in the dashboard). */
const EVAL_USAGE_MODULE = "eval";

/**
 * Output-token cap per judgment. A judgment is a short `{ issues }` object, but a
 * schema-constrained model can get stuck emitting whitespace inside it (observed on
 * SCCH) and would otherwise run on until the model's own limit — minutes per call.
 * The cap also covers reasoning tokens (OpenAI-style providers count them against
 * the same budget), hence the headroom. A judgment cut off by it parses as no
 * judgment: a retryable 502.
 */
export const JUDGE_MAX_OUTPUT_TOKENS = 8192;

const JudgeBodySchema = z.strictObject({
  llm: z.strictObject({
    provider: z.string().optional(),
    model: z.string().min(1).max(256),
    // The judge's optional reasoning effort. Enum-checked right here (unlike the grade
    // route's hand-parsed `provider`), so an unknown level is the same terminal 400 a
    // malformed body gets — a retry could never turn it into a valid one.
    reasoning: z.enum(REASONING_LEVELS).optional(),
  }),
  system: z.string().min(1),
  subject: z.string().min(1),
  // The caller's taxonomy. Bounded and shaped so a body can never turn the enum into an
  // unbounded blob: 1–8 short snake_case names, the form every eval kind's criteria take.
  criteria: z
    .array(z.string().regex(/^[a-z_]{1,40}$/))
    .min(1)
    .max(8),
});

/**
 * Judges one grader feedback. Body
 * `{ llm: { provider?, model, reasoning? }, system, subject, criteria }` →
 * `200 { issues: [{ criterion, note }], usage? }`, where an EMPTY `issues` array means the
 * feedback is acceptable (there is deliberately no `ok` flag) and the OPTIONAL
 * `usage: { input, cachedInput, output }` carries this call's tokens when the provider
 * reported any (see {@link llmCallUsage}).
 * `400` on a malformed body, an unknown or unavailable provider, or an upstream model call
 * that can never succeed as sent (a deployment name that does not exist — terminal, so the
 * CLI does not retry it); `413` over the 256 KB cap; `401`/`403` from the bearer gate;
 * `502` when the judge returns no structured object or fails for a reason worth retrying.
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

    const parsed = JudgeBodySchema.safeParse(read.value);
    if (!parsed.success) {
      return json(
        {
          message:
            "Provide `llm: { provider?, model, reasoning? }`, `system`, `subject` and `criteria`.",
        },
        400,
      );
    }
    const body = parsed.data;

    // An UNKNOWN provider string is rejected rather than silently defaulted — a
    // Foundry-intended judge must never quietly run on SCCH.
    const provider =
      body.llm.provider === undefined ? DEFAULT_PROVIDER : parseLenientProvider(body.llm.provider);
    if (provider === undefined) {
      return json({ message: `Unknown LLM provider "${body.llm.provider}".` }, 400);
    }

    // TERMINAL, not retryable — same reasoning as the grade route: a deployment without
    // the provider can never judge, so it must fail fast instead of burning retries.
    const unavailable = providerUnavailableReason(provider);
    if (unavailable) return json({ message: unavailable }, 400);

    const requestContext = new RequestContext();
    requestContext.set(EVAL_JUDGE_INSTRUCTIONS, body.system);
    requestContext.set(EVAL_JUDGE_MODEL, body.llm.model);
    requestContext.set(EVAL_JUDGE_PROVIDER, provider);
    // Only when the caller pinned one: an unset key means no `reasoning_effort` is sent
    // at all, which is what "let the model decide" means.
    if (body.llm.reasoning) requestContext.set(EVAL_JUDGE_REASONING, body.llm.reasoning);
    // Judge tokens land in the SAME buckets as the gradings they audit — one eval run is
    // one cost, and splitting it would only make the dashboard harder to read.
    requestContext.set(USAGE_CODE, EVAL_USAGE_CODE);
    requestContext.set(USAGE_USER_ID, user.userId);
    requestContext.set(USAGE_MODULE, EVAL_USAGE_MODULE);

    try {
      const res = await mastra.getAgent("evalJudge").generate(body.subject, {
        // Built from the CALLER's criteria, so the model is constrained to exactly the
        // taxonomy the caller can render — see lib/quiz-feedback-judge.ts.
        structuredOutput: { schema: judgmentSchema(body.criteria) },
        modelSettings: { maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS },
        requestContext,
      });
      const object = res.object as { issues?: FeedbackJudgeIssue[] } | undefined;
      if (!object || !Array.isArray(object.issues)) {
        return json({ message: "The judge returned no judgment." }, 502);
      }
      const usage = llmCallUsage(res);
      return json(
        {
          issues: object.issues.map(({ criterion, note }) => ({ criterion, note })),
          ...(usage ? { usage } : {}),
        },
        200,
      );
    } catch (error) {
      // The same terminal-vs-retryable split as the grade route: a deployment name that
      // does not exist is the CALLER's and must not be retried; an outage is the
      // server's/provider's. See lib/llm/upstream-error.ts.
      const failure = classifyUpstreamLlmError(error, {
        provider,
        model: body.llm.model,
        opaqueMessage: "The feedback could not be judged right now.",
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
