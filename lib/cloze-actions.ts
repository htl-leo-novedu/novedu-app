"use server";

import { RequestContext } from "@mastra/core/request-context";
import { after } from "next/server";
import { mastra } from "@/app/mastra";
import {
  CLOZE_EVAL_INSTRUCTIONS,
  CLOZE_EVAL_MODEL,
  CLOZE_EVAL_PROVIDER,
  CLOZE_EVAL_REASONING,
} from "@/app/mastra/cloze-agents";
import { recordClozeGapCounts } from "@/lib/cloze-counts-store";
import { buildClozeFeedbackMessage, buildClozeFeedbackPrompt } from "@/lib/cloze-feedback-prompt";
import { buildClozeGradingMessage, buildClozeGradingPrompt } from "@/lib/cloze-grading-prompt";
import { type ClozeGapNote, type ClozePattern, groundClozeFeedback } from "@/lib/cloze-grounding";
import {
  CLOZE_FEEDBACK_SCHEMA,
  CLOZE_GRADING_SCHEMA,
  type ClozeFeedbackOutput,
  type ClozeGradingOutput,
} from "@/lib/cloze-output-schemas";
import { runClozePrepass, undecidedGaps } from "@/lib/cloze-prepass";
import {
  getClozeResultSecret,
  signClozeResultToken,
  verifyClozeResultToken,
} from "@/lib/cloze-result-token";
import {
  answersMatchGaps,
  CLOZE_CHANGED_MESSAGE,
  type ClozeCodeInput,
  isAnswerList,
  type LoadedCloze,
  loadVerifiedCloze,
  verifyAndLoadCloze,
  verifyClozeCode,
} from "@/lib/cloze-verify";
import { providerUnavailableReason } from "@/lib/llm/availability";
import { withTruncationRetry } from "@/lib/quiz-truncation-retry";
import type { QuizVerdict } from "@/lib/quiz-types";
import { emitEvent, recordError } from "@/lib/telemetry";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";
import { recordClozeSubmission } from "@/lib/usage-store";

// The student-facing cloze server actions ("Fill the gaps", docs/cloze.md). The cloze
// CODE (a `novedu_codes` row with `module: "cloze"`) authorizes the exercise and is
// RE-VERIFIED on every action. The server-only reference answers and `evaluation` are
// read here and NEVER returned — except the references after a grading, which the
// results screen shows as "a possible answer" by design.
//
// Submit is two steps ("grade, then explain"):
//
//   1. `gradeCloze` — the deterministic pre-pass, then ONE grading call for the gaps it
//      left undecided; returns the verdicts, the references and a RESULT TOKEN
//      (lib/cloze-result-token.ts) over (code, user, attempt, answers, verdicts).
//   2. `explainCloze` — ONE feedback call over those verdicts, accepted only with a
//      matching token, then the grounding filter.
//
// Both calls run the memory-less `clozeEvaluator` agent: nothing about an attempt is
// persisted. Telemetry is content-free (ids, counts, durations — never an answer, a
// reference or feedback text).
//
// The verification preamble lives in the non-`"use server"` lib/cloze-verify.ts —
// exporting it from THIS file would mint a public endpoint returning the loaded
// exercise. Do NOT re-export anything (not even a type) from here: Next's `"use
// server"` transform emits a runtime reference for a type-only re-export, which
// crashes the module at load.

export type GradeClozeResult =
  | {
      ok: true;
      /** One verdict per gap, index-aligned with the gaps (gap N is `[N - 1]`). */
      verdicts: QuizVerdict[];
      /** The teacher's reference per gap — "a possible answer" (`""` = leave empty). */
      references: string[];
      /** Proves these verdicts to `explainCloze`. */
      resultToken: string;
    }
  | { ok: false; message: string };

export type ExplainClozeResult =
  | { ok: true; patterns: ClozePattern[]; gapNotes: ClozeGapNote[] }
  | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERDICTS: readonly QuizVerdict[] = ["correct", "partial", "incorrect"];
const REJECTED = "This submission cannot be checked.";
const GRADE_FAILED = "Couldn't check your answers — try again.";
const EXPLAIN_FAILED = "Couldn't load the feedback — try again.";

/** The RequestContext of one `clozeEvaluator` call, usage attribution included. */
function evaluatorContext(ctx: LoadedCloze, instructions: string): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set(CLOZE_EVAL_INSTRUCTIONS, instructions);
  requestContext.set(CLOZE_EVAL_MODEL, ctx.llm.model);
  requestContext.set(CLOZE_EVAL_PROVIDER, ctx.llm.provider);
  // Only when the effective llm carries one — absent grades at the model's default.
  if (ctx.llm.reasoning) requestContext.set(CLOZE_EVAL_REASONING, ctx.llm.reasoning);
  // Token usage is attributed exactly like every other agent seam: the observability
  // exporter reads these off the MODEL_GENERATION span (docs/usage-metering.md).
  requestContext.set(USAGE_CODE, ctx.code);
  requestContext.set(USAGE_USER_ID, ctx.userId);
  requestContext.set(USAGE_MODULE, "cloze");
  return requestContext;
}

/**
 * True when the grading output names every undecided gap exactly once and no other —
 * the contract of the grading call. Anything else is retried once, then fails.
 */
function coversExactly(output: ClozeGradingOutput | undefined, undecided: number[]): boolean {
  if (!output) return false;
  const named = output.gaps.map((entry) => entry.gap);
  return (
    named.length === undecided.length &&
    new Set(named).size === named.length &&
    undecided.every((gap) => named.includes(gap))
  );
}

/**
 * Step 1 of a submission: grades every gap. Re-verifies the session and the code,
 * reloads the exercise, requires one answer per gap, decides what the pre-pass can and
 * sends only the rest to the model. Every successful grading — practice rounds
 * included — counts as one `cloze_submissions` in the usage buckets; a first-round
 * grading also adds its verdicts to the per-gap counts (lib/cloze-counts-store.ts).
 */
export async function gradeCloze(
  input: ClozeCodeInput & { attemptId: string; round: "first" | "retry"; answers: string[] },
): Promise<GradeClozeResult> {
  // Cheap shape checks before any I/O.
  if (
    typeof input?.attemptId !== "string" ||
    !UUID.test(input.attemptId) ||
    (input.round !== "first" && input.round !== "retry") ||
    !isAnswerList(input.answers)
  ) {
    return { ok: false, message: REJECTED };
  }

  const ctx = await verifyAndLoadCloze(input);
  if (!ctx.ok) return ctx;
  if (!answersMatchGaps(input.answers, ctx.cloze)) {
    return { ok: false, message: CLOZE_CHANGED_MESSAGE };
  }

  const startedAt = performance.now();
  const prepass = runClozePrepass(ctx.cloze.gaps, input.answers);
  const undecided = undecidedGaps(prepass);
  const modelVerdicts = new Map<number, QuizVerdict>();

  if (undecided.length > 0) {
    const graded = await runGradingCall(ctx, input.answers, undecided);
    if (!graded) return { ok: false, message: GRADE_FAILED };
    for (const entry of graded.gaps) modelVerdicts.set(entry.gap, entry.result);
  }

  const verdicts = prepass.map(
    (entry) => entry.verdict ?? modelVerdicts.get(entry.gap) ?? "incorrect",
  );
  const resultToken = signClozeResultToken(
    {
      code: ctx.code,
      userId: ctx.userId,
      attemptId: input.attemptId,
      answers: input.answers,
      verdicts,
    },
    getClozeResultSecret(),
  );

  // Off the response path (both stores never throw). Only a FIRST submission adds to
  // the teacher's per-gap counts; practice rounds are metered but never counted.
  after(() => recordClozeSubmission({ code: ctx.code, userId: ctx.userId }));
  if (input.round === "first") {
    const gaps = ctx.cloze.gaps.map((gap, i) => ({
      gap: gap.number,
      reference: gap.reference,
      verdict: verdicts[i] ?? "incorrect",
    }));
    after(() => recordClozeGapCounts(ctx.code, gaps));
  }
  emitEvent("cloze.graded", {
    code: ctx.code,
    round: input.round,
    gaps: verdicts.length,
    modelGaps: undecided.length,
    latencyMs: Math.round(performance.now() - startedAt),
  });

  return {
    ok: true,
    verdicts,
    references: ctx.cloze.gaps.map((gap) => gap.reference),
    resultToken,
  };
}

/** The grading call, with the truncation retry and the one coverage retry. */
async function runGradingCall(
  ctx: LoadedCloze,
  answers: readonly string[],
  undecided: number[],
): Promise<ClozeGradingOutput | undefined> {
  const unavailable = providerUnavailableReason(ctx.llm.provider);
  if (unavailable) {
    recordError(new Error("Cloze provider unavailable"), {
      "novedu.area": "cloze",
      stage: "grade",
      provider: ctx.llm.provider,
    });
    return undefined;
  }
  const requestContext = evaluatorContext(ctx, buildClozeGradingPrompt(ctx.cloze));
  const message = buildClozeGradingMessage(
    undecided.map((gap) => ({ gap, answer: answers[gap - 1] ?? "" })),
  );
  const grade = async () =>
    (
      await withTruncationRetry(
        () =>
          mastra.getAgent("clozeEvaluator").generate(message, {
            structuredOutput: { schema: CLOZE_GRADING_SCHEMA },
            requestContext,
          }),
        (res) => res.object as ClozeGradingOutput | undefined,
        (object) => object.gaps.map((entry) => entry.reason),
        "cloze.grading.truncated",
        { code: ctx.code },
      )
    ).object;

  try {
    let output = await grade();
    if (!coversExactly(output, undecided)) {
      emitEvent("cloze.grading.mismatch", { code: ctx.code });
      output = await grade();
    }
    if (!coversExactly(output, undecided)) {
      recordError(new Error("Cloze grading did not cover the undecided gaps"), {
        "novedu.area": "cloze",
        stage: "grade",
      });
      return undefined;
    }
    return output;
  } catch (error) {
    recordError(error, { "novedu.area": "cloze", stage: "grade" });
    return undefined;
  }
}

/**
 * Step 2 of a submission: consolidated feedback on verdicts the server produced. The
 * result token must match the session user, the code, the attempt, the answers and the
 * verdicts — so the feedback writer never works from invented verdicts and this action
 * is never a general-purpose LLM endpoint. Returns only what the grounding filter keeps.
 */
export async function explainCloze(
  input: ClozeCodeInput & {
    attemptId: string;
    answers: string[];
    verdicts: QuizVerdict[];
    resultToken: string;
  },
): Promise<ExplainClozeResult> {
  // Cheap shape checks before any I/O.
  if (
    typeof input?.attemptId !== "string" ||
    !UUID.test(input.attemptId) ||
    !isAnswerList(input.answers) ||
    !Array.isArray(input.verdicts) ||
    input.verdicts.length !== input.answers.length ||
    !input.verdicts.every((verdict) => VERDICTS.includes(verdict)) ||
    typeof input.resultToken !== "string"
  ) {
    return { ok: false, message: REJECTED };
  }

  const verified = await verifyClozeCode(input);
  if (!verified.ok) return verified;
  // The token before the (expensive) reload: only a grading this server did for this
  // session user passes.
  const tokenOk = verifyClozeResultToken(
    input.resultToken,
    {
      code: verified.code,
      userId: verified.userId,
      attemptId: input.attemptId,
      answers: input.answers,
      verdicts: input.verdicts,
    },
    getClozeResultSecret(),
  );
  if (!tokenOk) return { ok: false, message: REJECTED };

  const ctx = await loadVerifiedCloze(verified);
  if (!ctx.ok) return ctx;
  if (!answersMatchGaps(input.answers, ctx.cloze)) {
    return { ok: false, message: CLOZE_CHANGED_MESSAGE };
  }

  // Nothing to explain: the page shows "All N gaps correct" without asking.
  if (input.verdicts.every((verdict) => verdict === "correct")) {
    return { ok: true, patterns: [], gapNotes: [] };
  }

  const unavailable = providerUnavailableReason(ctx.llm.provider);
  if (unavailable) {
    recordError(new Error("Cloze provider unavailable"), {
      "novedu.area": "cloze",
      stage: "explain",
      provider: ctx.llm.provider,
    });
    return { ok: false, message: EXPLAIN_FAILED };
  }

  const startedAt = performance.now();
  const requestContext = evaluatorContext(ctx, buildClozeFeedbackPrompt(ctx.cloze));
  const message = buildClozeFeedbackMessage(
    ctx.cloze.gaps.map((gap, i) => ({
      gap: gap.number,
      answer: input.answers[i] ?? "",
      verdict: input.verdicts[i] ?? "incorrect",
    })),
  );
  try {
    const { object } = await withTruncationRetry(
      () =>
        mastra.getAgent("clozeEvaluator").generate(message, {
          structuredOutput: { schema: CLOZE_FEEDBACK_SCHEMA },
          requestContext,
        }),
      (res) => res.object as ClozeFeedbackOutput | undefined,
      (object) => [
        ...object.patterns.flatMap((p) => [p.title, p.explanation, p.next_time]),
        ...object.gap_notes.map((n) => n.note),
      ],
      "cloze.feedback.truncated",
      { code: ctx.code },
    );
    if (!object) return { ok: false, message: EXPLAIN_FAILED };
    const grounded = groundClozeFeedback(object, input.verdicts);
    emitEvent("cloze.explained", {
      code: ctx.code,
      patterns: grounded.patterns.length,
      droppedPatterns: grounded.dropped.patterns.length,
      notes: grounded.gapNotes.length,
      latencyMs: Math.round(performance.now() - startedAt),
    });
    return { ok: true, patterns: grounded.patterns, gapNotes: grounded.gapNotes };
  } catch (error) {
    recordError(error, { "novedu.area": "cloze", stage: "explain" });
    return { ok: false, message: EXPLAIN_FAILED };
  }
}
