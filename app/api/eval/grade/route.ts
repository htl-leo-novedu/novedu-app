import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { mastra } from "@/app/mastra";
import { QUIZ_VERDICT_SCHEMA } from "@/app/mastra/quiz-agents";
import { ApiAuthError, requireBearerTeacher } from "@/lib/api-auth";
import { readBoundedJson } from "@/lib/bounded-json";
import { providerUnavailableReason } from "@/lib/llm/availability";
import {
  DEFAULT_PROVIDER,
  parseLenientProvider,
  parseLenientReasoningLevel,
} from "@/lib/llm/provider";
import { classifyUpstreamLlmError } from "@/lib/llm/upstream-error";
import { QUIZ_EVAL_CONTEXT, setLlmContext } from "@/lib/llm-context";
import { buildAnswerMessage } from "@/lib/quiz-grading-prompt";
import { gradeWithTruncationRetry } from "@/lib/quiz-truncation-retry";
import type { QuizVerdict } from "@/lib/quiz-types";
import { recordError } from "@/lib/telemetry";
import { setUsageContext } from "@/lib/usage-context-keys";
import { authErrorResponse, json } from "../../shared";
import { llmCallUsage } from "../shared";

// CLI/API bearer route backing `novedu-cli eval` (docs/cli-eval.md): grade ONE golden
// answer with the EXACT production grading path — the same memory-less `quizEvaluator`
// agent, the same `QUIZ_VERDICT_SCHEMA` structured output, the same trimmed answer
// message `submitAnswer` builds. Stateless by design: one HTTP request = one graded
// answer, nothing queued, nothing persisted; the CLI does the fan-out and the retries.
//
// SECURITY (deliberate, documented amendment — AGENTS.md, docs/codes.md): this is the
// ONE other caller of `quizEvaluator` besides `submitAnswer`. It stays safe because
//   * the gate is `requireBearerTeacher` — never reachable by a student, and the
//     CopilotKit runtime route still 404s the agent,
//   * the grading `system` prompt comes from the CLIENT, so the server-held quiz
//     `evaluation` prompts still never leave the server (the CLI assembled its copy
//     offline from the teacher's own YAML),
//   * the agent is memory-less and this route writes nothing — the same privacy
//     property as `submitAnswer`.
// It is therefore, stated plainly, a teacher-scoped, verdict-schema-constrained LLM
// pass-through: a teacher may send arbitrary `system`/`answer` text. Acceptable under
// this repo's trust model — teachers already author every activity prompt.

export const dynamic = "force-dynamic";

// A grading prompt plus one student answer. Far above any real case (the PoC's largest
// question prompt is a few KB), while bounding worst-case memory on a buffered body.
const MAX_BODY_BYTES = 256 * 1024;

/**
 * The pseudo-code every eval grading is metered against. Not a `novedu_codes` row —
 * minted codes are 10 random chars, so a collision is impossible and the usage
 * dashboard's LEFT JOIN simply shows it with NULL metadata. (`route.ts` may only export
 * HTTP handlers + Next's route config, so these stay module-local.)
 */
const EVAL_USAGE_CODE = "cli-eval";

/** The usage module label for eval runs (its own group in the dashboard). */
const EVAL_USAGE_MODULE = "eval";

const GradeBodySchema = z.strictObject({
  llm: z.strictObject({
    provider: z.string().optional(),
    model: z.string().min(1).max(256),
    // Free-form here and hand-parsed below, exactly like `provider`: an unknown level
    // deserves a message that names it rather than a generic schema complaint.
    reasoning: z.string().optional(),
  }),
  system: z.string().min(1),
  answer: z.string().min(1),
});

/**
 * Grades one golden answer. Body
 * `{ llm: { provider?, model, reasoning? }, system, answer }` →
 * `200 { result, feedback, usage? }`,
 * where the OPTIONAL `usage: { input, cachedInput, output }` carries this call's token
 * counts when the provider reported any (see {@link llmCallUsage}).
 * `400` on a malformed body, an unknown reasoning level, an unknown or unavailable
 * provider, an answer that is empty
 * after trimming, or an upstream model call that can never succeed as sent (a deployment
 * name that does not exist — terminal, so the CLI does not retry it); `413` over the
 * 256 KB cap; `401`/`403` from the bearer gate; `502` when the grader returns no
 * structured object or fails for a reason worth retrying (outage, rate limit, timeout,
 * or the provider refusing the server's own credentials — that one says so explicitly).
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

    const parsed = GradeBodySchema.safeParse(read.value);
    if (!parsed.success) {
      return json(
        { message: "Provide `llm: { provider?, model, reasoning? }`, `system` and `answer`." },
        400,
      );
    }
    const body = parsed.data;

    // An UNKNOWN provider string is rejected rather than silently defaulted — a
    // Foundry-intended run must never quietly grade on SCCH. Absent means the YAML
    // default, exactly like every activity loader.
    const provider =
      body.llm.provider === undefined ? DEFAULT_PROVIDER : parseLenientProvider(body.llm.provider);
    if (provider === undefined) {
      return json({ message: `Unknown LLM provider "${body.llm.provider}".` }, 400);
    }

    // An UNKNOWN reasoning level is rejected on the same argument as the provider — and
    // TERMINALLY (400), because no number of retries turns it into a valid one. Absent
    // means no `reasoning_effort` at all, the model's own default.
    const reasoning =
      body.llm.reasoning === undefined ? undefined : parseLenientReasoningLevel(body.llm.reasoning);
    if (body.llm.reasoning !== undefined && reasoning === undefined) {
      return json({ message: `Unknown reasoning level "${body.llm.reasoning}".` }, 400);
    }

    // TERMINAL, not retryable: a deployment without Azure Foundry can never grade a
    // Foundry eval, so it must fail fast with the reason instead of burning the CLI's
    // whole retry budget on every single case.
    const unavailable = providerUnavailableReason(provider);
    if (unavailable) return json({ message: unavailable }, 400);

    // `submitAnswer` trims before `buildAnswerMessage`; golden answers written as YAML
    // block scalars ALWAYS carry a trailing newline, so skipping this would break the
    // "exact production prompt" promise.
    const answer = body.answer.trim();
    if (!answer) return json({ message: "The answer is empty." }, 400);

    const requestContext = new RequestContext();
    setLlmContext(requestContext, QUIZ_EVAL_CONTEXT, body.system, {
      provider,
      model: body.llm.model,
      // Absent unless the caller pinned one — "the model decides".
      reasoning,
    });
    // Usage attribution: evals are metered under their own pseudo-code + module, so a
    // teacher's eval spend shows as its own group in the dashboard and can never be
    // mistaken for a class's usage (docs/usage-metering.md).
    setUsageContext(requestContext, {
      code: EVAL_USAGE_CODE,
      userId: user.userId,
      module: EVAL_USAGE_MODULE,
    });

    try {
      // The same truncation retry as the student path — the ONE shared implementation,
      // so an eval measures what a student would actually have been shown.
      const { raw: res, object } = await gradeWithTruncationRetry(
        () =>
          mastra.getAgent("quizEvaluator").generate(buildAnswerMessage(answer), {
            structuredOutput: { schema: QUIZ_VERDICT_SCHEMA },
            requestContext,
          }),
        (result) => result.object as { result: QuizVerdict; feedback: string } | undefined,
      );
      if (!object) return json({ message: "The grader returned no verdict." }, 502);
      const usage = llmCallUsage(res);
      return json(
        { result: object.result, feedback: object.feedback, ...(usage ? { usage } : {}) },
        200,
      );
    } catch (error) {
      // A grading failure is either the CALLER's (a deployment name that does not
      // exist) or the SERVER's/provider's (an outage). Only the first can be described
      // and must not be retried — see lib/llm/upstream-error.ts for the split, and for
      // why only the endpoint URL goes to telemetry (the free-form text is withheld).
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
