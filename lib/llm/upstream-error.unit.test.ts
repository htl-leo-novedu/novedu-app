import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { classifyUpstreamLlmError } from "@/lib/llm/upstream-error";

// The caller/server split for upstream model failures. The DeploymentNotFound fixture
// below is the VERBATIM Azure Foundry response to a `--llm-model` naming an undeployed
// model (reproduced against a live resource), so these tests pin the real wire shape,
// not an invented one.

const FOUNDRY_URL = "https://example-resource.openai.azure.com/openai/v1/chat/completions";

const CONTEXT = { provider: "Azure Foundry" as const, model: "gpt-5.6-sol" };

/** Azure's real 404 body for a deployment that does not exist. */
function deploymentNotFound(): APICallError {
  return new APICallError({
    message:
      "The API deployment for this resource does not exist. If you created the " +
      "deployment within the last 5 minutes, please wait a moment and try again.",
    url: FOUNDRY_URL,
    requestBodyValues: { model: "gpt-5.6-sol" },
    statusCode: 404,
    responseBody: JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "DeploymentNotFound",
        message: "The API deployment for this resource does not exist.",
      },
    }),
    isRetryable: false,
    data: {
      error: {
        type: "invalid_request_error",
        code: "DeploymentNotFound",
        message: "The API deployment for this resource does not exist.",
      },
    },
  });
}

describe("classifyUpstreamLlmError", () => {
  it("names the model and the upstream code for a missing deployment", () => {
    const failure = classifyUpstreamLlmError(deploymentNotFound(), CONTEXT);

    expect(failure.terminal).toBe(true);
    expect(failure.message).toContain('"gpt-5.6-sol"');
    expect(failure.message).toContain("Azure Foundry");
    expect(failure.message).toContain("DeploymentNotFound");
    expect(failure.message).toContain("404");
  });

  it("keeps the endpoint URL and the provider's prose OUT of the caller's message", () => {
    const failure = classifyUpstreamLlmError(deploymentNotFound(), CONTEXT);

    // The resource host is infrastructure detail; the free-form upstream text is the
    // field most likely to grow to echo request content. Both are telemetry-only.
    expect(failure.message).not.toContain("example-resource");
    expect(failure.message).not.toContain("openai.azure.com");
    expect(failure.message).not.toContain("The API deployment for this resource");
  });

  it("puts the full technical detail on the telemetry attributes", () => {
    const failure = classifyUpstreamLlmError(deploymentNotFound(), CONTEXT);

    expect(failure.telemetry).toEqual({
      "novedu.llm.provider": "Azure Foundry",
      "novedu.llm.model": "gpt-5.6-sol",
      "novedu.llm.upstream_url": FOUNDRY_URL,
      "novedu.llm.upstream_retryable": false,
      "novedu.llm.upstream_status": 404,
      "novedu.llm.upstream_code": "DeploymentNotFound",
      "novedu.llm.upstream_type": "invalid_request_error",
    });
  });

  it("keeps a bare 404 ambiguous: wrong model, disallowed model OR misconfigured endpoint", () => {
    // Without a proving code (vLLM omits it), the same 404 also comes from a wrong
    // endpoint base path on OUR side — the wording must not assert a missing
    // deployment, or a teacher with a correct model name hunts a typo that isn't there.
    const error = new APICallError({
      message: "Not Found",
      url: "https://scch.example/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      isRetryable: false,
    });

    const failure = classifyUpstreamLlmError(error, { provider: "SCCH", model: "ghost-model" });

    expect(failure.terminal).toBe(true);
    expect(failure.message).toContain('"ghost-model"');
    expect(failure.message).toContain("SCCH");
    expect(failure.message).toContain("misconfigured");
    expect(failure.message).toContain("not allowed to use it");
    expect(failure.message).not.toContain("no deployment");
    expect(failure.telemetry).not.toHaveProperty("novedu.llm.upstream_code");
  });

  it("reports an upstream 401/403 as a server credential fault, NOT terminal", () => {
    // A rotated key or a stale Managed-Identity role fails every call with 401 — the
    // caller's model name is fine, and a token refresh may cure it, so retries stay
    // live (502) and the message must not blame the request.
    const error = new APICallError({
      message: "Access denied due to invalid subscription key",
      url: FOUNDRY_URL,
      requestBodyValues: {},
      statusCode: 401,
      isRetryable: false,
    });

    const failure = classifyUpstreamLlmError(error, CONTEXT);

    expect(failure.terminal).toBe(false);
    expect(failure.message).toContain("credentials");
    expect(failure.message).toContain("server-side");
    expect(failure.message).not.toContain("model name");
    expect(failure.telemetry["novedu.llm.upstream_status"]).toBe(401);
  });

  it("points a content_filter rejection at the text, not the llm settings", () => {
    // Azure's prompt filter answers a non-retryable 400 — terminal is right, but the
    // fix is the failing text, never the model configuration.
    const error = new APICallError({
      message: "The response was filtered",
      url: FOUNDRY_URL,
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
      data: { error: { code: "content_filter", type: "invalid_request_error" } },
    });

    const failure = classifyUpstreamLlmError(error, CONTEXT);

    expect(failure.terminal).toBe(true);
    expect(failure.message).toContain("content filter");
    expect(failure.message).not.toContain("Check the model name");
  });

  it("unwraps a wrapper error chaining the APICallError via `cause`", () => {
    // Mastra wraps a failed generate in a MastraError with the original as `cause`;
    // the classification must be identical to receiving the raw error.
    const wrapped = new Error("AGENT_GENERATE_FAILED", { cause: deploymentNotFound() });

    const failure = classifyUpstreamLlmError(wrapped, CONTEXT);

    expect(failure.terminal).toBe(true);
    expect(failure.message).toContain("DeploymentNotFound");
  });

  it("unwraps an ai-sdk RetryError carrying the attempts in `errors`", () => {
    const retryError = Object.assign(new Error("Failed after 3 attempts"), {
      errors: [deploymentNotFound(), deploymentNotFound()],
    });

    const failure = classifyUpstreamLlmError(retryError, CONTEXT);

    expect(failure.terminal).toBe(true);
    expect(failure.message).toContain("DeploymentNotFound");
    expect(failure.telemetry["novedu.llm.upstream_status"]).toBe(404);
  });

  it("stays retryable and opaque for a rate limit", () => {
    // 429 is a 4xx but NOT the caller's mistake — it must keep its retries and must not
    // claim the model is wrong.
    const error = new APICallError({
      message: "Requests to the endpoint have exceeded the rate limit.",
      url: FOUNDRY_URL,
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
      data: { error: { code: "429", type: "rate_limit_error" } },
    });

    const failure = classifyUpstreamLlmError(error, CONTEXT);

    expect(failure.terminal).toBe(false);
    expect(failure.message).toBe("The answer could not be graded right now.");
    expect(failure.telemetry["novedu.llm.upstream_status"]).toBe(429);
  });

  it("describes a non-404 rejection without guessing at the cause", () => {
    const error = new APICallError({
      message: "Unsupported parameter",
      url: FOUNDRY_URL,
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
      data: { error: { code: "unsupported_parameter", type: "invalid_request_error" } },
    });

    const failure = classifyUpstreamLlmError(error, CONTEXT);

    expect(failure.terminal).toBe(true);
    expect(failure.message).toContain("400");
    expect(failure.message).toContain("unsupported_parameter");
    expect(failure.message).not.toContain("no deployment");
  });

  it("stays opaque and retryable for anything that is not an API call error", () => {
    // A token-acquisition timeout or an outright bug tells us nothing to pass on.
    const failure = classifyUpstreamLlmError(new Error("credential timeout"), CONTEXT);

    expect(failure.terminal).toBe(false);
    expect(failure.message).toBe("The answer could not be graded right now.");
    expect(failure.telemetry).toEqual({
      "novedu.llm.provider": "Azure Foundry",
      "novedu.llm.model": "gpt-5.6-sol",
    });
  });
});
