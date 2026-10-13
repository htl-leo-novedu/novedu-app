import { APICallError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The teacher-only FEEDBACK-JUDGE route, in the shape of its `/api/eval/grade` sibling:
// the bearer gate stays REAL over a stubbed `getSession` while Mastra and the LLM
// availability seam are mocked. Pins the 401/403 matrix, the zod body (including the
// `criteria` bounds and their snake_case regex), the terminal availability 400, the 200
// wire shape, usage being OMITTED rather than zeroed, the 502s — and that the agent gets
// the client's subject plus a structured-output schema constrained to the CALLER's
// criteria, which is what keeps this endpoint kind-agnostic.

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

import {
  EVAL_JUDGE_INSTRUCTIONS,
  EVAL_JUDGE_MODEL,
  EVAL_JUDGE_PROVIDER,
  EVAL_JUDGE_REASONING,
} from "@/app/mastra/eval-agents";
import { auth } from "@/auth";
import { FEEDBACK_JUDGE_CRITERIA } from "@/lib/quiz-feedback-judge";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";
import { bearerSession } from "@/tests/mock-auth-session";
import { JUDGE_MAX_OUTPUT_TOKENS, POST } from "./route";

const getSession = vi.mocked(auth.api.getSession);

async function mint(teacher = true): Promise<string> {
  getSession.mockResolvedValue(
    bearerSession({ id: "teacher-oid-1", name: "Test Teacher", isTeacher: teacher }),
  );
  return "session-token";
}

const VALID_BODY = {
  llm: { provider: "SCCH", model: "test-model" },
  system: "You are auditing feedback.",
  subject: "=== The grader's feedback (JUDGE THIS) ===\nPerfect!",
  criteria: [...FEEDBACK_JUDGE_CRITERIA],
};

async function postRequest(
  body: unknown,
  token?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return POST(
    new Request("http://localhost/api/eval/judge", {
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

interface GenerateOptions {
  requestContext: { get(key: string): unknown };
  structuredOutput: { schema: { safeParse(value: unknown): { success: boolean } } };
  modelSettings?: { maxOutputTokens?: number };
}

/** The `{ requestContext, structuredOutput, modelSettings }` the route handed the agent. */
function generateOptions(): GenerateOptions {
  return (mocks.generate.mock.calls[0] as unknown[])[1] as GenerateOptions;
}

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue(null);
  mocks.providerUnavailableReason.mockReturnValue(null);
  mocks.generate.mockResolvedValue({ object: { issues: [] } });
});

describe("POST /api/eval/judge auth", () => {
  it("401s without a token and 403s a non-teacher, never running the judge", async () => {
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

describe("POST /api/eval/judge validation", () => {
  it("400s a non-JSON body", async () => {
    expect((await postRequest("{not json", await mint())).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("400s a body missing llm/system/subject/criteria", async () => {
    for (const body of [
      {},
      { ...VALID_BODY, system: undefined },
      { ...VALID_BODY, subject: undefined },
      { ...VALID_BODY, criteria: undefined },
      { ...VALID_BODY, llm: {} },
    ]) {
      expect((await postRequest(body, await mint())).status).toBe(400);
    }
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("400s criteria outside the 1–8 bound or the snake_case shape", async () => {
    const bad = [
      [],
      Array.from({ length: 9 }, (_, i) => `c_${String.fromCharCode(97 + i)}`),
      ["Contradicts_Verdict"],
      ["has spaces"],
      ["x".repeat(41)],
      [""],
    ];
    for (const criteria of bad) {
      const res = await postRequest({ ...VALID_BODY, criteria }, await mint());
      expect(res.status, JSON.stringify(criteria)).toBe(400);
    }
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

    // A 502 here would burn the CLI's whole retry budget on every single judge call.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: "Azure Foundry is not configured." });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("413s a body over the 256 KB cap", async () => {
    const huge = { ...VALID_BODY, subject: "x".repeat(300 * 1024) };
    expect((await postRequest(huge, await mint())).status).toBe(413);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("413s a declared Content-Length over the cap without reading the body", async () => {
    const res = await postRequest(VALID_BODY, await mint(), {
      "content-length": String(10 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
  });
});

describe("POST /api/eval/judge judging", () => {
  it("runs the judge over the client's subject and answers { issues } no-store", async () => {
    mocks.generate.mockResolvedValue({
      object: {
        issues: [{ criterion: "contradicts_verdict", note: "Praises an incorrect answer." }],
      },
    });

    const res = await postRequest(VALID_BODY, await mint());

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      issues: [{ criterion: "contradicts_verdict", note: "Praises an incorrect answer." }],
    });

    const [subject] = mocks.generate.mock.calls[0] as [string];
    expect(subject).toBe(VALID_BODY.subject);

    const ctx = generateOptions().requestContext;
    expect(ctx.get(EVAL_JUDGE_INSTRUCTIONS)).toBe(VALID_BODY.system);
    expect(ctx.get(EVAL_JUDGE_MODEL)).toBe("test-model");
    expect(ctx.get(EVAL_JUDGE_PROVIDER)).toBe("SCCH");
    // Judge tokens meter into the SAME buckets as the gradings they audit.
    expect(ctx.get(USAGE_CODE)).toBe("cli-eval");
    expect(ctx.get(USAGE_MODULE)).toBe("eval");
    expect(ctx.get(USAGE_USER_ID)).toBe("teacher-oid-1");
  });

  it("caps the judge's output tokens", async () => {
    await postRequest(VALID_BODY, await mint());
    expect(generateOptions().modelSettings?.maxOutputTokens).toBe(JUDGE_MAX_OUTPUT_TOKENS);
  });

  it("sets the reasoning key only when the body pins a level", async () => {
    await postRequest(
      { ...VALID_BODY, llm: { model: "judge-model", reasoning: "high" } },
      await mint(),
    );
    const [, withLevel] = mocks.generate.mock.calls[0] as [
      string,
      { requestContext: { get(key: string): unknown } },
    ];
    expect(withLevel.requestContext.get(EVAL_JUDGE_REASONING)).toBe("high");

    mocks.generate.mockClear();
    await postRequest(VALID_BODY, await mint());
    const [, without] = mocks.generate.mock.calls[0] as [
      string,
      { requestContext: { get(key: string): unknown } },
    ];
    // Unset ⇒ no `reasoning_effort` is sent at all.
    expect(without.requestContext.get(EVAL_JUDGE_REASONING)).toBeUndefined();
  });

  it("constrains the model to the CALLER's criteria — the kind-agnostic property", async () => {
    await postRequest(
      { ...VALID_BODY, criteria: ["breaks_persona", "solves_for_the_student"] },
      await mint(),
    );

    const { schema } = generateOptions().structuredOutput;
    expect(schema.safeParse({ issues: [{ criterion: "breaks_persona", note: "n" }] }).success).toBe(
      true,
    );
    // A quiz criterion is NOT accepted for a caller that did not send it.
    expect(schema.safeParse({ issues: [{ criterion: "leaks_rubric", note: "n" }] }).success).toBe(
      false,
    );
  });

  it("answers an EMPTY issues array for acceptable feedback (there is no `ok` flag)", async () => {
    const res = await postRequest(VALID_BODY, await mint());

    expect(res.status).toBe(200);
    // The default mock carries no usage: a missing measurement is never reported as zero tokens.
    expect(await res.json()).toEqual({ issues: [] });
  });

  it("defaults the provider to SCCH when the body omits it", async () => {
    await postRequest({ ...VALID_BODY, llm: { model: "test-model" } }, await mint());

    expect(generateOptions().requestContext.get(EVAL_JUDGE_PROVIDER)).toBe("SCCH");
  });

  it("reports the judge call's tokens when the model reported usage", async () => {
    mocks.generate.mockResolvedValue({
      object: { issues: [] },
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
      totalUsage: { inputTokens: 1200, outputTokens: 87, cachedInputTokens: 900 },
    });

    const res = await postRequest(VALID_BODY, await mint());

    expect(await res.json()).toEqual({
      issues: [],
      usage: { input: 1200, cachedInput: 900, output: 87 },
    });
  });

  it("502s when the judge returns no structured judgment", async () => {
    mocks.generate.mockResolvedValue({ object: undefined });
    expect((await postRequest(VALID_BODY, await mint())).status).toBe(502);

    mocks.generate.mockResolvedValue({ object: { issues: "not an array" } });
    expect((await postRequest(VALID_BODY, await mint())).status).toBe(502);
  });

  it("502s when the judge throws, without claiming the caller is at fault", async () => {
    mocks.generate.mockRejectedValue(new Error("upstream exploded"));

    const res = await postRequest(VALID_BODY, await mint());

    expect(res.status).toBe(502);
    // The opaque wording names JUDGING, not grading — this route is not the grader.
    expect(await res.json()).toMatchObject({
      message: "The feedback could not be judged right now.",
    });
  });

  it("400s and names the model when the deployment does not exist", async () => {
    // TERMINAL: a 502 would make the CLI retry a request that can never succeed.
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
});
