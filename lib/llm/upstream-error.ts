import { APICallError } from "ai";
import type { LlmProvider } from "@/lib/llm/provider";

// Turning an upstream LLM failure into (a) something the CALLER can act on and (b)
// something an OPERATOR can debug — two audiences, two channels, deliberately kept
// apart.
//
// The motivating case (reproduced against Azure Foundry): `--llm-model` naming a
// deployment that does not exist. Azure answers
// `404 { error: { code: "DeploymentNotFound", type: "invalid_request_error" } }`, the
// ai-sdk raises it as an `APICallError`, and a caller that collapses every failure into
// one generic sentence leaves the teacher unable to tell a typo from an outage — and,
// if that sentence is a 502, the CLI retries a request that can never succeed (four
// attempts, 30 s of backoff, per case).
//
// The inverse mistake matters just as much: blaming the caller for a SERVER fault. An
// upstream 401/403 (a rotated key, a stale Managed-Identity role) and a bare 404 from a
// misconfigured endpoint path are not the teacher's model name — the wording below
// never claims more than the status proves.
//
// SECURITY — what crosses back to the caller: the provider and model IT sent, the
// upstream HTTP status, and the upstream error CODE (a short, stable identifier like
// `DeploymentNotFound`). NOT the endpoint URL — that is the Foundry resource host, an
// infrastructure detail — and NOT the provider's free-form message, which is the field
// most likely to grow to echo request content. The endpoint URL goes to Application
// Insights instead (`telemetry` below); the free-form message reaches no telemetry at
// all — an `APICallError` is not a plain `Error`, so `recordError` withholds its
// message and exports only its type and stack frames (docs/telemetry.md).
//
// PROVIDER-AGNOSTIC by construction: the provider name is interpolated, never branched
// on — the three provider branches stay where `docs/ai-models.md` pins them.

/** What the caller should say and do about one failed model call. */
export interface UpstreamLlmFailure {
  /**
   * `true` when the request can NEVER succeed as sent (a wrong deployment name, a
   * rejected parameter) — the caller should fail fast with a 4xx instead of a 5xx, so
   * neither the CLI nor any other client burns a retry budget on it. `false` covers
   * outages, rate limits and timeouts, which are worth another attempt.
   */
  terminal: boolean;
  /** Caller-safe and actionable. Never the endpoint URL, never raw provider prose. */
  message: string;
  /** Server-side detail for `recordError` — the infrastructure fields live HERE. */
  telemetry: Record<string, string | number | boolean>;
}

/**
 * The generic fallback: nothing about this failure is worth promising to a caller. It is
 * the ONE message that names what the call was for, so a caller doing something other
 * than grading (the feedback judge) overrides it via `context.opaqueMessage`.
 */
const OPAQUE_MESSAGE = "The answer could not be graded right now.";

/**
 * The OpenAI-compatible error envelope both providers speak:
 * `{ error: { code, type, message } }`. Every field is optional in practice (vLLM omits
 * `code`), so each is read defensively and simply missing when absent.
 */
function errorEnvelope(data: unknown): { code?: string; type?: string } {
  if (!data || typeof data !== "object") return {};
  const inner = (data as { error?: unknown }).error;
  if (!inner || typeof inner !== "object") return {};
  const { code, type } = inner as { code?: unknown; type?: unknown };
  return {
    ...(typeof code === "string" && code ? { code } : {}),
    ...(typeof type === "string" && type ? { type } : {}),
  };
}

/**
 * Digs the ai-sdk `APICallError` out of whatever was actually thrown. Wrappers are
 * real: the ai-sdk's own `RetryError` carries the attempts in `errors`, and Mastra
 * wraps a failed generate in a `MastraError` chaining the original via `cause`.
 * Newest attempt first; bounded so a cyclic chain cannot loop.
 */
function findApiCallError(error: unknown, depth = 4): APICallError | undefined {
  if (depth < 0 || !error || typeof error !== "object") return undefined;
  if (APICallError.isInstance(error)) return error;
  const { cause, errors } = error as { cause?: unknown; errors?: unknown };
  for (const candidate of [...(Array.isArray(errors) ? [...errors].reverse() : []), cause]) {
    const found = findApiCallError(candidate, depth - 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Classifies a thrown model-call error, unwrapping wrapper errors first (see
 * {@link findApiCallError}). Anything that does not contain an ai-sdk `APICallError`
 * (a bug, a token-acquisition timeout, an aborted stream) stays opaque and retryable —
 * we know nothing specific enough to tell the caller.
 */
export function classifyUpstreamLlmError(
  error: unknown,
  context: {
    provider: LlmProvider;
    model: string;
    /** Overrides the "could not be graded" wording for a non-grading call. */
    opaqueMessage?: string;
  },
): UpstreamLlmFailure {
  const { provider, model } = context;
  const opaque = context.opaqueMessage ?? OPAQUE_MESSAGE;
  const apiError = findApiCallError(error);

  if (!apiError) {
    return {
      terminal: false,
      message: opaque,
      telemetry: { "novedu.llm.provider": provider, "novedu.llm.model": model },
    };
  }

  const { code, type } = errorEnvelope(apiError.data);
  const status = apiError.statusCode;
  const telemetry: Record<string, string | number | boolean> = {
    "novedu.llm.provider": provider,
    "novedu.llm.model": model,
    // Infrastructure detail, deliberately telemetry-only (see the header).
    "novedu.llm.upstream_url": apiError.url,
    "novedu.llm.upstream_retryable": apiError.isRetryable,
    ...(status === undefined ? {} : { "novedu.llm.upstream_status": status }),
    ...(code ? { "novedu.llm.upstream_code": code } : {}),
    ...(type ? { "novedu.llm.upstream_type": type } : {}),
  };

  // The ai-sdk already decides retryability the way we would (408/409/429 and 5xx are
  // retryable, everything else is not) — reusing it keeps rate limits and outages
  // retryable while a bad request fails on the first attempt.
  if (apiError.isRetryable) {
    return { terminal: false, message: opaque, telemetry };
  }

  // e.g. " (upstream 404 DeploymentNotFound)" — status and code, whichever exist.
  const detail = [status, code].filter((part) => part !== undefined).join(" ");
  const upstreamRef = detail ? ` (upstream ${detail})` : "";

  // The provider refusing OUR credentials (a rotated key, a stale Managed-Identity
  // role) is a server fault the caller can neither see nor fix — and one a token
  // refresh may cure, so it keeps its retries. Explicit rather than opaque, so nobody
  // chases a model-name typo through an RBAC outage.
  if (status === 401 || status === 403) {
    return {
      terminal: false,
      message:
        `${provider} refused the server's credentials${upstreamRef}. Nothing about ` +
        "the request needs to change — this is a server-side configuration problem; " +
        "retry later, and contact the operator if it persists.",
      telemetry,
    };
  }

  // A missing model is the one upstream error a teacher hits routinely and can fix
  // alone — but only a named code PROVES it. Azure says `DeploymentNotFound`,
  // OpenAI-compatible servers say `model_not_found`.
  if (code === "DeploymentNotFound" || code === "model_not_found") {
    return {
      terminal: true,
      message:
        `The model "${model}" is not available on ${provider}: no deployment of that ` +
        `name answered${upstreamRef}. Check the spelling, or wait a moment and retry ` +
        "if you just created the deployment.",
      telemetry,
    };
  }

  // A bare 404 is ambiguous: the same status comes from a model that does not exist
  // (vLLM omits the code), from a model the server's account may not use (OpenRouter
  // answers a guardrail's model allowlist with a 404) and from a misconfigured
  // endpoint path on OUR side. Say all three, so a teacher whose model name is
  // correct escalates instead of hunting a typo that isn't there.
  if (status === 404) {
    return {
      terminal: true,
      message:
        `${provider} answered 404 for model "${model}": either no model of that name ` +
        "exists there, this server is not allowed to use it, or the server's " +
        `${provider} endpoint is misconfigured. Check the model name; if it is ` +
        "correct, contact the operator.",
      telemetry,
    };
  }

  // A content filter fires on the TEXT, not the configuration — fixed model-settings
  // advice would send the teacher to the wrong place.
  if (code === "content_filter") {
    return {
      terminal: true,
      message:
        `${provider} rejected the request for model "${model}"${upstreamRef}: the ` +
        "prompt or answer text tripped the provider's content filter. The text needs " +
        "to change — the model and llm settings are not the problem.",
      telemetry,
    };
  }

  return {
    terminal: true,
    message:
      `${provider} rejected the request for model "${model}"${upstreamRef}. The ` +
      "request will not succeed unchanged; if the activity's llm settings look " +
      "right, contact the operator.",
    telemetry,
  };
}
