import { APICallError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The teacher-only grader-eval route: the bearer gate stays REAL over a stubbed
// `getSession` while Mastra is mocked like in `lib/quiz-actions.unit.test.ts`. Pins the
// 401/403 matrix, the 400 matrix (bad body, unknown provider, unavailable provider,
// empty-after-trim answer), the 413 cap, the 200 wire shape + no-store, the 502 on a
// grader throw, the terminal-vs-retryable split for upstream model failures (400 with a
// named model vs. 502 opaque) — and, crucially, that the agent receives
// `buildAnswerMessage` of the
// TRIMMED answer plus the QUIZ_EVAL_* / usage RequestContext values (production parity
// with `submitAnswer`).

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  providerUnavailableReason: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/app/mastra", () => ({
  mastra: { getAgent: () => ({ generate: mocks.generate }) },
}));
vi.mock("@/lib/llm/availability", () => ({
  providerUnavailableReason: mocks.providerUnavailableReason,
}));
vi.mock("@/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));

import { auth } from "@/auth";
import { QUIZ_EVAL_CONTEXT } from "@/lib/llm-context";
import { buildAnswerMessage } from "@/lib/quiz-grading-prompt";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";
import { bearerSession } from "@/tests/mock-auth-session";
import { POST } from "./route";

const getSession = vi.mocked(auth.api.getSession);

async function mint(teacher = true): Promise<string> {
  getSession.mockResolvedValue(
    bearerSession({ id: "teacher-oid-1", name: "Test Teacher", isTeacher: teacher }),
  );
  return "session-token";
}

const VALID_BODY = {
  llm: { provider: "SCCH", model: "test-model" },
  system: "You are grading question q1.",
  answer: "4\n",
};

async function postRequest(
  body: unknown,
  token?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return POST(
    new Request("http://localhost/api/eval/grade", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue(null);
  mocks.providerUnavailableReason.mockReturnValue(null);
  mocks.generate.mockResolvedValue({ object: { result: "correct", feedback: "Well done." } });
});

describe("POST /api/eval/grade auth", () => {
  it("401s without a token and 403s a non-teacher, never running the grader", async () => {
    expect((await postRequest(VALID_BODY)).status).toBe(401);
    expect((await postRequest(VALID_BODY, await mint(false))).status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("sends WWW-Authenticate: Bearer with a JSON message body", async () => {
    const res = await postRequest(VALID_BODY);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toMatchObject({ message: expect.any(String) });
  });
});

describe("POST /api/eval/grade validation", () => {
  it("400s a non-JSON body", async () => {
    expect((await postRequest("{not json", await mint())).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("400s a body missing system/answer/llm", async () => {
    expect((await postRequest({}, await mint())).status).toBe(400);
    expect((await postRequest({ llm: { model: "m" }, system: "s" }, await mint())).status).toBe(
      400,
    );
    expect((await postRequest({ llm: {}, system: "s", answer: "a" }, await mint())).status).toBe(
      400,
    );
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("400s an unknown provider rather than silently defaulting to SCCH", async () => {
    const res = await postRequest(
      { ...VALID_BODY, llm: { provider: "OpenAI", model: "m" } },
      await mint(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining("OpenAI") });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("400s TERMINALLY when the provider is not configured on this server", async () => {
    mocks.providerUnavailableReason.mockReturnValue("Azure Foundry is not configured.");

    const res = await postRequest(
      { ...VALID_BODY, llm: { provider: "Azure Foundry", model: "gpt" } },
      await mint(),
    );

    // A 502 here would burn the CLI's whole retry budget on every single case.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: "Azure Foundry is not configured." });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("400s an unknown reasoning level, terminally", async () => {
    const res = await postRequest(
      { ...VALID_BODY, llm: { model: "m", reasoning: "turbo" } },
      await mint(),
    );
    // A retry could never turn "turbo" into a level, so this must not be a 502.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining("turbo") });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("400s an answer that is empty after trimming", async () => {
    const res = await postRequest({ ...VALID_BODY, answer: "   \n  " }, await mint());
    expect(res.status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("413s a body over the 256 KB cap", async () => {
    const huge = { ...VALID_BODY, answer: "x".repeat(300 * 1024) };
    const res = await postRequest(huge, await mint());
    expect(res.status).toBe(413);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("413s a declared Content-Length over the cap without reading the body", async () => {
    const res = await postRequest(VALID_BODY, await mint(), {
      "content-length": String(10 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
  });
});

describe("POST /api/eval/grade grading", () => {
  it("runs the production grading path and answers { result, feedback } no-store", async () => {
    const res = await postRequest(VALID_BODY, await mint());

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The default mock carries no usage: the exact body also pins that a missing
    // measurement is never reported as zero tokens.
    expect(await res.json()).toEqual({ result: "correct", feedback: "Well done." });

    // The TRIMMED answer, wrapped by the shared production builder (parity with
    // submitAnswer — a golden answer's YAML block scalar always ends in a newline).
    const [prompt, opts] = mocks.generate.mock.calls[0] as [
      string,
      { requestContext: { get(key: string): unknown } },
    ];
    expect(prompt).toBe(buildAnswerMessage("4"));

    const ctx = opts.requestContext;
    expect(ctx.get(QUIZ_EVAL_CONTEXT.instructions)).toBe(VALID_BODY.system);
    expect(ctx.get(QUIZ_EVAL_CONTEXT.model)).toBe("test-model");
    expect(ctx.get(QUIZ_EVAL_CONTEXT.provider)).toBe("SCCH");
    expect(ctx.get(USAGE_CODE)).toBe("cli-eval");
    expect(ctx.get(USAGE_MODULE)).toBe("eval");
    expect(ctx.get(USAGE_USER_ID)).toBe("teacher-oid-1");
  });

  it("passes a valid reasoning level through as the agent's context key", async () => {
    await postRequest(
      { ...VALID_BODY, llm: { model: "test-model", reasoning: "high" } },
      await mint(),
    );

    const [, opts] = mocks.generate.mock.calls[0] as [
      string,
      { requestContext: { get(key: string): unknown } },
    ];
    expect(opts.requestContext.get(QUIZ_EVAL_CONTEXT.reasoning)).toBe("high");
  });

  it("leaves the reasoning key UNSET when the body carries no level", async () => {
    await postRequest(VALID_BODY, await mint());

    const [, opts] = mocks.generate.mock.calls[0] as [
      string,
      { requestContext: { get(key: string): unknown } },
    ];
    // Unset ⇒ the resolver sends no `reasoning_effort` at all, the model's own default.
    expect(opts.requestContext.get(QUIZ_EVAL_CONTEXT.reasoning)).toBeUndefined();
  });

  it("defaults the provider to SCCH when the body omits it", async () => {
    await postRequest({ ...VALID_BODY, llm: { model: "test-model" } }, await mint());

    const [, opts] = mocks.generate.mock.calls[0] as [
      string,
      { requestContext: { get(key: string): unknown } },
    ];
    expect(opts.requestContext.get(QUIZ_EVAL_CONTEXT.provider)).toBe("SCCH");
  });

  it("reports the grading call's tokens when the model reported usage", async () => {
    // Mastra's `FullOutput`: `totalUsage` across all steps, AI-SDK v5 field names
    // (`@mastra/core/dist/stream/base/output.d.ts` → `LanguageModelUsage`).
    mocks.generate.mockResolvedValue({
      object: { result: "partial", feedback: "Half." },
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
      totalUsage: { inputTokens: 1200, outputTokens: 87, cachedInputTokens: 900 },
    });

    const res = await postRequest(VALID_BODY, await mint());

    expect(await res.json()).toEqual({
      result: "partial",
      feedback: "Half.",
      // `input` is the TOTAL input (cached included); `cachedInput` its cache-read part.
      usage: { input: 1200, cachedInput: 900, output: 87 },
    });
  });

  it("falls back to the last step's usage when there is no total", async () => {
    mocks.generate.mockResolvedValue({
      object: { result: "correct", feedback: "Yes." },
      usage: { inputTokens: 30, outputTokens: 5 },
    });

    const res = await postRequest(VALID_BODY, await mint());

    // No cache reporting from this provider ⇒ 0, not a missing field.
    expect(await res.json()).toMatchObject({ usage: { input: 30, cachedInput: 0, output: 5 } });
  });

  it("502s when the grader throws", async () => {
    mocks.generate.mockRejectedValue(new Error("upstream exploded"));
    const res = await postRequest(VALID_BODY, await mint());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ message: expect.any(String) });
  });

  it("502s when the grader returns no structured object", async () => {
    mocks.generate.mockResolvedValue({ object: undefined });
    const res = await postRequest(VALID_BODY, await mint());
    expect(res.status).toBe(502);
  });

  it("400s and names the model when the deployment does not exist", async () => {
    // TERMINAL: a 502 here would make the CLI retry a request that can never succeed —
    // four attempts and 30 s of backoff per case, all ending in the same 404.
    mocks.generate.mockRejectedValue(
      new APICallError({
        message: "The API deployment for this resource does not exist.",
        url: "https://example-resource.openai.azure.com/openai/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 404,
        isRetryable: false,
        data: { error: { code: "DeploymentNotFound", type: "invalid_request_error" } },
      }),
    );

    const res = await postRequest(VALID_BODY, await mint());

    expect(res.status).toBe(400);
    const { message } = (await res.json()) as { message: string };
    expect(message).toContain('"test-model"');
    expect(message).toContain("DeploymentNotFound");
    // The Foundry resource host must never reach the client (it is telemetry-only).
    expect(message).not.toContain("openai.azure.com");
  });

  it("502s an upstream 401 as a server credential fault, keeping retries", async () => {
    // NOT terminal: the caller's model name is fine — a rotated key or stale
    // Managed-Identity role is the server's to fix, and a token refresh may cure it.
    mocks.generate.mockRejectedValue(
      new APICallError({
        message: "Access denied due to invalid subscription key",
        url: "https://example-resource.openai.azure.com/openai/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      }),
    );

    const res = await postRequest(VALID_BODY, await mint());

    expect(res.status).toBe(502);
    const { message } = (await res.json()) as { message: string };
    expect(message).toContain("credentials");
    expect(message).not.toContain("model name");
  });

  it("keeps a rate-limited grading retryable (502, opaque)", async () => {
    mocks.generate.mockRejectedValue(
      new APICallError({
        message: "rate limit",
        url: "https://example-resource.openai.azure.com/openai/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      }),
    );

    const res = await postRequest(VALID_BODY, await mint());

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      message: "The answer could not be graded right now.",
    });
  });
});
