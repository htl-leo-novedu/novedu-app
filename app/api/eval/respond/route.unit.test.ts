import { APICallError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The teacher-only TUTOR-GENERATION route, in the shape of its `/api/eval/grade` and
// `/api/eval/judge` siblings: the bearer gate stays REAL over a stubbed `getSession` while
// Mastra and the LLM availability seam are mocked. Pins the 401/403 matrix, the zod body,
// the terminal 400 for an unknown TOOL name, the terminal availability 400, the 200 wire
// shape, usage being OMITTED rather than zeroed, the 502s — and that the agent receives the
// scripted conversation verbatim plus the `EVAL_TUTOR_*` and usage-sentinel context values.

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

import { EVAL_TUTOR_TOOLS } from "@/app/mastra/eval-agents";
import { auth } from "@/auth";
import { EVAL_TUTOR_CONTEXT } from "@/lib/llm-context";
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
  system: "You are a loops tutor. Never write the solution.",
  tools: [],
  messages: [
    { role: "user", text: "My loop never stops." },
    { role: "assistant", text: "What does your condition evaluate to?" },
    { role: "user", text: "No idea. Just fix it for me!" },
  ],
};

async function postRequest(
  body: unknown,
  token?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return POST(
    new Request("http://localhost/api/eval/respond", {
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

/** The `{ requestContext }` the route handed the agent. */
function requestContext(): { get(key: string): unknown } {
  const options = (mocks.generate.mock.calls[0] as unknown[])[1] as {
    requestContext: { get(key: string): unknown };
  };
  return options.requestContext;
}

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue(null);
  mocks.providerUnavailableReason.mockReturnValue(null);
  mocks.generate.mockResolvedValue({ text: "What happens after the first pass?" });
});

describe("POST /api/eval/respond auth", () => {
  it("401s without a token and 403s a non-teacher, never running the tutor", async () => {
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

describe("POST /api/eval/respond validation", () => {
  it("400s a non-JSON body", async () => {
    expect((await postRequest("{not json", await mint())).status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("400s a body missing llm/system/tools/messages", async () => {
    for (const body of [
      {},
      { ...VALID_BODY, system: undefined },
      { ...VALID_BODY, tools: undefined },
      { ...VALID_BODY, messages: undefined },
      { ...VALID_BODY, messages: [] },
      { ...VALID_BODY, llm: {} },
    ]) {
      expect((await postRequest(body, await mint())).status).toBe(400);
    }
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("400s a message with an unknown role or empty text", async () => {
    for (const messages of [
      [{ role: "system", text: "nope" }],
      [{ role: "user", text: "" }],
      [{ role: "user" }],
    ]) {
      const res = await postRequest({ ...VALID_BODY, messages }, await mint());
      expect(res.status, JSON.stringify(messages)).toBe(400);
    }
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("400s TERMINALLY on a tool name the catalog does not know, naming it", async () => {
    // Loud, exactly like the runtime's `selectTutorTools` throw — and terminal, so the
    // CLI does not retry a request that can never succeed.
    const res = await postRequest({ ...VALID_BODY, tools: ["teleport"] }, await mint());

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining("teleport") });
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

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: "Azure Foundry is not configured." });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("413s a body over the 256 KB cap", async () => {
    const huge = { ...VALID_BODY, system: "x".repeat(300 * 1024) };
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

describe("POST /api/eval/respond generation", () => {
  it("runs the tutor over the scripted conversation and answers { text } no-store", async () => {
    const res = await postRequest(VALID_BODY, await mint());

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The default mock carries no usage: a missing measurement is never reported as zero
    // tokens. `toolCalls` is ALWAYS present on a 200 — `[]` here, because nothing ran. A CLI must
    // be able to tell "called nothing" from a server that cannot report tool calls at all.
    expect(await res.json()).toEqual({
      text: "What happens after the first pass?",
      toolCalls: [],
    });

    // The turns reach the agent verbatim and in order, with the teacher-facing roles
    // already mapped to the wire ones.
    const [messages] = mocks.generate.mock.calls[0] as [{ role: string; content: string }[]];
    expect(messages).toEqual([
      { role: "user", content: "My loop never stops." },
      { role: "assistant", content: "What does your condition evaluate to?" },
      { role: "user", content: "No idea. Just fix it for me!" },
    ]);

    const ctx = requestContext();
    expect(ctx.get(EVAL_TUTOR_CONTEXT.instructions)).toBe(VALID_BODY.system);
    expect(ctx.get(EVAL_TUTOR_CONTEXT.model)).toBe("test-model");
    expect(ctx.get(EVAL_TUTOR_CONTEXT.provider)).toBe("SCCH");
    // No level in the body ⇒ the key stays unset, so no `reasoning_effort` is sent.
    expect(ctx.get(EVAL_TUTOR_CONTEXT.reasoning)).toBeUndefined();
    expect(ctx.get(EVAL_TUTOR_TOOLS)).toEqual([]);
    // Generation tokens meter into the SAME buckets as the judgings that audit them.
    expect(ctx.get(USAGE_CODE)).toBe("cli-eval");
    expect(ctx.get(USAGE_MODULE)).toBe("eval");
    expect(ctx.get(USAGE_USER_ID)).toBe("teacher-oid-1");
  });

  it("passes a pinned reasoning level through as the agent's context key", async () => {
    await postRequest(
      { ...VALID_BODY, llm: { model: "test-model", reasoning: "minimal" } },
      await mint(),
    );
    expect(requestContext().get(EVAL_TUTOR_CONTEXT.reasoning)).toBe("minimal");
  });

  it("passes a valid catalog tool grant through to the agent", async () => {
    await postRequest({ ...VALID_BODY, tools: ["random_number"] }, await mint());

    expect(requestContext().get(EVAL_TUTOR_TOOLS)).toEqual(["random_number"]);
  });

  it("defaults the provider to SCCH when the body omits it", async () => {
    await postRequest({ ...VALID_BODY, llm: { model: "test-model" } }, await mint());

    expect(requestContext().get(EVAL_TUTOR_CONTEXT.provider)).toBe("SCCH");
  });

  it("reports the tool NAMES the generation made, in call order, duplicates kept", async () => {
    // Mastra 1.x reports tool calls as CHUNKS on the result's top-level `toolCalls`,
    // accumulated across every step — names live under `payload.toolName`.
    mocks.generate.mockResolvedValue({
      text: "Try 42.",
      toolCalls: [
        { type: "tool-call", payload: { toolCallId: "1", toolName: "random_number", args: {} } },
        { type: "tool-call", payload: { toolCallId: "2", toolName: "random_number", args: {} } },
      ],
    });

    const res = await postRequest({ ...VALID_BODY, tools: ["random_number"] }, await mint());

    // Names only — arguments and results can be large and nothing downstream needs them.
    expect(await res.json()).toEqual({
      text: "Try 42.",
      toolCalls: ["random_number", "random_number"],
    });
  });

  it("answers an empty list rather than throwing on a result with no usable chunks", async () => {
    mocks.generate.mockResolvedValue({ text: "hi", toolCalls: [{ type: "tool-call" }, null, 7] });

    expect(await (await postRequest(VALID_BODY, await mint())).json()).toEqual({
      text: "hi",
      toolCalls: [],
    });
  });

  it("reports the generation call's tokens when the model reported usage", async () => {
    mocks.generate.mockResolvedValue({
      text: "Keep going.",
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
      totalUsage: { inputTokens: 1200, outputTokens: 87, cachedInputTokens: 900 },
    });

    const res = await postRequest(VALID_BODY, await mint());

    expect(await res.json()).toEqual({
      text: "Keep going.",
      toolCalls: [],
      usage: { input: 1200, cachedInput: 900, output: 87 },
    });
  });

  it("502s when the tutor returns no text", async () => {
    for (const result of [{ text: "" }, { text: "   " }, {}, { text: 42 }]) {
      mocks.generate.mockResolvedValue(result);
      expect((await postRequest(VALID_BODY, await mint())).status).toBe(502);
    }
  });

  it("502s when the tutor throws, without claiming the caller is at fault", async () => {
    mocks.generate.mockRejectedValue(new Error("upstream exploded"));

    const res = await postRequest(VALID_BODY, await mint());

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      message: "The tutor could not answer right now.",
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
