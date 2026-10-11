import { beforeEach, describe, expect, it, vi } from "vitest";

// The chat runtime route gates every DATA request (run/connect/stop) with three
// server-side checks (auth → code → thread-ownership token) before it ever builds
// the Mastra runtime, and dispatches by the code's `module` (which agent runs).
// GET `/info` is the exception: metadata only, gated by AUTH ALONE (the read-only
// conversation viewer needs it without a code). Those checks are the security
// boundary, and they all short-circuit with a 401/403/404 — so they can be
// exercised fast, with no DB and no LLM, by mocking only the I/O seams and driving
// real `Request`s through the handler.
//
// What is REAL here: `classifyRequest` (the endpoint allowlist) and the
// thread-token HMAC (`lib/thread-token.ts`). What is mocked: the session, the code
// lookup, the module registry, and everything downstream of a passed gate (the
// CopilotKit runtime, the Mastra agent factory, the attribution write). One
// `/info` case additionally replays the captured runtime options through the
// REAL CopilotKit runtime, so what `/info` advertises is asserted on the
// library's own response, not on a mock.

const getSession = vi.hoisted(() => vi.fn());
const checkCode = vi.hoisted(() => vi.fn());
const recordUserChat = vi.hoisted(() => vi.fn());
const recordUserMessage = vi.hoisted(() => vi.fn());
// The RequestContext the route mutates with the usage-attribution keys before
// building the runtime; a spy `set` lets us assert it, and stands in for the real
// RequestContext.set().
const contextSet = vi.hoisted(() => vi.fn());
const buildRequestContext = vi.hoisted(() =>
  vi.fn(
    async (): Promise<
      | { ok: true; context: { set: (k: string, v: unknown) => void } }
      | { ok: false; status: number; message: string }
    > => ({ ok: true, context: { set: contextSet } }),
  ),
);
// `getLocalAgent` returns a recognisable stub per agent id, so a test can read
// the exact agent set a runtime was built with off the CopilotRuntime options.
// `getLocalAgents` (every Mastra agent) must never be used — it is kept as a spy
// only to assert exactly that.
const getLocalAgent = vi.hoisted(() =>
  vi.fn(({ agentId }: { agentId: string }) => ({ agentId, description: `stub ${agentId}` })),
);
const getLocalAgents = vi.hoisted(() => vi.fn(() => ({})));
const endpointFetch = vi.hoisted(() =>
  vi.fn(async (_req: Request) => new Response("{}", { status: 200 })),
);
const CopilotRuntime = vi.hoisted(() => vi.fn());
// The student-mode cookie jar. `lib/student-mode.ts` stays REAL (it holds the
// effective-teacher rule that gates reasoning display), so only its ONE I/O
// seam — next/headers' cookies() — is stubbed, with the jar builder the rule's
// own suite uses (tests/mocks/student-mode-cookies.ts).
const cookies = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session", () => ({ getSession, requireTeacher: vi.fn() }));
vi.mock("next/headers", () => ({ cookies }));
vi.mock("@/lib/code-store", () => ({ checkCode }));
vi.mock("@/lib/user-chat-store", () => ({ recordUserChat }));
vi.mock("@/lib/usage-store", () => ({ recordUserMessage }));
// The module registry decides which agent runs per module. All runtime modules
// share one buildRequestContext mock so a test can flip it to the error path;
// `coding` and `cloze` mirror the real descriptors — no runtime, so no agent in `/info`.
vi.mock("@/lib/code-modules/registry", () => ({
  codeModules: {
    tutor: { fileKind: "tutor", runtime: { agentId: "tutor", buildRequestContext } },
    quiz: { fileKind: "quiz", runtime: { agentId: "quizDiscussion", buildRequestContext } },
    writing: { fileKind: "writing", runtime: { agentId: "writing", buildRequestContext } },
    coding: { fileKind: "coding" },
    cloze: { fileKind: "cloze" },
  },
}));
// Importing the real Mastra instance would pull in @mastra/pg + the Azure
// credential chain; the handler only passes it through to getLocalAgent.
vi.mock("@/app/mastra", () => ({ mastra: {} }));
// after() needs a Next request scope; running the callback at once keeps the
// tests in the plain node env and lets them assert the scheduled attribution.
vi.mock("next/server", () => ({ after: (callback: () => unknown) => void callback() }));
// Stub everything past the gate so a passed request returns deterministically
// without a real runtime, agent, or model.
vi.mock("@ag-ui/mastra", () => ({ MastraAgent: { getLocalAgent, getLocalAgents } }));
// The snapshot runner's DB read; only consulted on a connect the stubbed runtime
// never performs, but the import must not reach a real database.
vi.mock("@/lib/tutor-history-store", () => ({
  loadThreadForChat: vi.fn(),
  ownsTutorThread: vi.fn(),
}));
// `ReasoningStrippingRunner` stays REAL (it is the security-critical filter), so
// the two runner classes it extends/wraps must exist on the stubbed module. The
// stub `InMemoryAgentRunner` is also what the route hands a teacher, so the tests
// below import it back and assert on its identity.
vi.mock("@copilotkit/runtime/v2", () => ({
  CopilotRuntime,
  createCopilotEndpoint: () => ({ fetch: endpointFetch }),
  AgentRunner: class {},
  InMemoryAgentRunner: class {},
}));

import { InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { HistorySnapshotRunner } from "@/app/api/copilotkit/history-snapshot-runner";
import { ReasoningStrippingRunner } from "@/app/api/copilotkit/reasoning-runner";
import { RunErrorReportingRunner } from "@/app/api/copilotkit/run-error-runner";
import {
  getThreadTokenSecret,
  resetThreadTokenSecretForTests,
  signThreadToken,
} from "@/lib/thread-token";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";
import { studentModeCookies, TEST_SESSION_ID } from "@/tests/mocks/student-mode-cookies";
import { GET, POST, trimToNewTurn } from "./route";

const CODE = "a1b2c3d4e5";
const USER_ID = "user-1";
const BASE = "http://localhost/api/copilotkit";

function runBody(threadId: string | undefined, messages: unknown[] = []) {
  return JSON.stringify({
    ...(threadId === undefined ? {} : { threadId }),
    runId: "r1",
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
}

function agentRequest(
  opts: {
    kind?: "run" | "connect" | "stop";
    threadId?: string;
    token?: string;
    code?: string;
    messages?: unknown[];
    agent?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    "x-code": opts.code ?? CODE,
    "content-type": "application/json",
  };
  if (opts.token !== undefined) headers["x-thread-token"] = opts.token;
  const kind = opts.kind ?? "run";
  // A stop names its thread in the URL and has no body; run/connect carry it in the body.
  const path = kind === "stop" ? `stop/${encodeURIComponent(opts.threadId ?? "")}` : kind;
  return new Request(`${BASE}/agent/${opts.agent ?? "tutor"}/${path}`, {
    method: "POST",
    headers,
    body: kind === "stop" ? undefined : runBody(opts.threadId, opts.messages),
  });
}

function token(threadId: string, code = CODE, userId = USER_ID) {
  return signThreadToken({ code, userId, threadId }, getThreadTokenSecret());
}

/** The options the route handed to the last `new CopilotRuntime(...)`. */
function lastRuntimeOptions(): { agents?: Record<string, unknown>; runner?: unknown } {
  const options = CopilotRuntime.mock.lastCall?.[0] as
    | { agents?: Record<string, unknown>; runner?: unknown }
    | undefined;
  expect(options).toBeDefined();
  return options ?? {};
}

/** The agent ids the last runtime was built with, sorted. */
function lastRuntimeAgentIds(): string[] {
  return Object.keys(lastRuntimeOptions().agents ?? {}).sort();
}

/** The last runtime's runner and every runner it wraps, outermost first. */
function runnerChain(): unknown[] {
  const chain: unknown[] = [];
  let runner: unknown = lastRuntimeOptions().runner;
  while (runner) {
    chain.push(runner);
    runner = (runner as { wrapped?: unknown }).wrapped;
  }
  return chain;
}

// Mastra-registered agents that no module runs through this route.
const INTERNAL_AGENT_IDS = ["quizEvaluator", "evalJudge", "evalTutor", "clozeEvaluator"];

beforeEach(() => {
  // The REAL thread-token module memoizes its secret; derive it afresh per test.
  resetThreadTokenSecretForTests();
  // Default: an authenticated student with a valid tutor-module code. Individual
  // tests override as needed.
  getSession.mockResolvedValue({ user: { id: USER_ID } });
  // No student-mode cookie by default.
  cookies.mockResolvedValue(studentModeCookies(false));
  checkCode.mockResolvedValue({
    ok: true,
    entry: { module: "tutor", fileUrl: "https://example.com/t.yaml", anonymous: false },
  });
  buildRequestContext.mockResolvedValue({ ok: true, context: { set: contextSet } });
  endpointFetch.mockResolvedValue(new Response("{}", { status: 200 }));
});

describe("authentication gate", () => {
  it("401s a request without a session user", async () => {
    getSession.mockResolvedValue(null);
    const res = await POST(agentRequest({ threadId: crypto.randomUUID() }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });
});

describe("code gate (re-checked on every data request)", () => {
  it("403s an unknown code with a human-readable message", async () => {
    checkCode.mockResolvedValue({ ok: false, reason: "unknown-code" });
    const res = await POST(agentRequest({ threadId: crypto.randomUUID() }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/requires a valid code/i);
  });

  it("403s an expired code — the per-request window re-check (mid-session close)", async () => {
    checkCode.mockResolvedValue({
      ok: false,
      reason: "expired",
      validFrom: new Date("2026-06-10T10:00:00Z"),
      validUntil: new Date("2026-06-10T11:00:00Z"),
    });
    const res = await POST(agentRequest({ threadId: crypto.randomUUID() }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/availability window has ended/i);
  });
});

describe("endpoint allowlist (classifyRequest)", () => {
  it("404s the runtime's thread-listing endpoint", async () => {
    const res = await GET(new Request(`${BASE}/threads`, { headers: { "x-code": CODE } }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("404s the runtime's thread-messages endpoint", async () => {
    const res = await GET(
      new Request(`${BASE}/threads/${crypto.randomUUID()}/messages`, {
        headers: { "x-code": CODE },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404s an unknown sub-path", async () => {
    const res = await POST(
      new Request(`${BASE}/agent/tutor/bogus`, {
        method: "POST",
        headers: { "x-code": CODE, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);
  });
});

// The client may PICK a photo several times larger than it may SEND (it is
// normalized down in the browser first), so the gap between those two limits is
// exactly where an unbounded POST would live; the route rejects on the declared
// content-length.
describe("run-body size ceiling", () => {
  it("413s a run whose declared body is larger than any real turn", async () => {
    const threadId = crypto.randomUUID();
    const req = new Request(`${BASE}/agent/tutor/run`, {
      method: "POST",
      headers: {
        "x-code": CODE,
        "content-type": "application/json",
        "x-thread-token": token(threadId),
        "content-length": String(64 * 1024 * 1024),
      },
      body: runBody(threadId),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    // Rejected BEFORE the code lookup and the token check — the point is to stop
    // reading, not to reach a verdict about who is asking.
    expect(checkCode).not.toHaveBeenCalled();
  });

  it("lets an ordinary turn through", async () => {
    const threadId = crypto.randomUUID();
    const res = await POST(agentRequest({ threadId, token: token(threadId) }));
    expect(res.status).toBe(200);
  });
});

describe("thread-ownership token (real HMAC)", () => {
  const badTokens: Array<[string, (threadId: string) => string | undefined]> = [
    ["no token", () => undefined],
    ["a bogus token", () => "deadbeef"],
    ["a token for a different user", (threadId) => token(threadId, CODE, "someone-else")],
    ["a token for a different code", (threadId) => token(threadId, "zzzzzzzzzz")],
    ["a token for a different thread", () => token(crypto.randomUUID())],
  ];
  it.each(badTokens)("403s a run with %s and never builds a runtime", async (_what, sign) => {
    const threadId = crypto.randomUUID();
    const res = await POST(agentRequest({ threadId, token: sign(threadId) }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/does not belong to your session/i);
    expect(CopilotRuntime).not.toHaveBeenCalled();
  });

  // connect and stop share the run's check; one foreign-thread token each shows
  // they are gated at all.
  it.each(["connect", "stop"] as const)(
    "403s a %s with a token for a different thread and never builds a runtime",
    async (kind) => {
      const threadId = crypto.randomUUID();
      const res = await POST(agentRequest({ kind, threadId, token: token(crypto.randomUUID()) }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/does not belong to your session/i);
      expect(CopilotRuntime).not.toHaveBeenCalled();
    },
  );

  it("403s a run whose body carries no threadId", async () => {
    const res = await POST(agentRequest({ token: token("x") }));
    expect(res.status).toBe(403);
  });

  it("forwards a stop whose URL threadId matches its token", async () => {
    const threadId = crypto.randomUUID();
    const res = await POST(agentRequest({ kind: "stop", threadId, token: token(threadId) }));
    expect(res.status).toBe(200);
    expect(CopilotRuntime).toHaveBeenCalledOnce();
  });

  it("403s a stop whose URL threadId is malformed, even with a matching token", async () => {
    const threadId = "not a thread/id";
    const res = await POST(agentRequest({ kind: "stop", threadId, token: token(threadId) }));
    expect(res.status).toBe(403);
  });

  it("rejects a stop whose URL threadId is not valid percent-encoding as a foreign thread (403)", async () => {
    const res = await POST(
      new Request(`${BASE}/agent/tutor/stop/%ZZ`, {
        method: "POST",
        headers: { "x-code": CODE, "x-thread-token": token("%ZZ") },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/does not belong to your session/i);
  });
});

describe("info endpoint (auth-only metadata)", () => {
  it("serves GET /info with auth alone — no code, no code check", async () => {
    const res = await GET(new Request(`${BASE}/info`));
    expect(res.status).toBe(200);
    expect(endpointFetch).toHaveBeenCalledOnce();
    expect(checkCode).not.toHaveBeenCalled();
    expect(getLocalAgent).toHaveBeenCalledWith(expect.objectContaining({ resourceId: "__info__" }));
  });

  it("lists exactly the student-facing agents — never the internal ones", async () => {
    const res = await GET(new Request(`${BASE}/info`));
    expect(res.status).toBe(200);
    // Derived from the registry: every module's runtime.agentId, nothing more
    // (`coding` and `cloze` have no runtime, so contribute none).
    expect(lastRuntimeAgentIds()).toEqual(["quizDiscussion", "tutor", "writing"]);
    for (const internal of INTERNAL_AGENT_IDS) {
      expect(lastRuntimeAgentIds()).not.toContain(internal);
      expect(getLocalAgent).not.toHaveBeenCalledWith(
        expect.objectContaining({ agentId: internal }),
      );
    }
    // Never Mastra's whole registry, and no request context: /info runs nothing.
    expect(getLocalAgents).not.toHaveBeenCalled();
    for (const [options] of getLocalAgent.mock.calls) {
      expect(options).not.toHaveProperty("requestContext");
    }
  });

  it("uses a runner that does not advertise local thread endpoints", async () => {
    await GET(new Request(`${BASE}/info`));
    const { runner } = lastRuntimeOptions();
    expect(runner).toBeInstanceOf(ReasoningStrippingRunner);
    expect(runner).not.toBeInstanceOf(InMemoryAgentRunner);
    expect(runner).not.toHaveProperty("ɵsupportsLocalThreadEndpoints");
  });

  it("the REAL runtime's /info response lists only those agents and no thread endpoints", async () => {
    await GET(new Request(`${BASE}/info`));
    // Replay the exact options the route built through the library's own runtime
    // + endpoint, so the assertion is on what a browser would actually receive.
    // Its telemetry client reads this once, when the real module loads below —
    // keep it from ever phoning home from a test.
    vi.stubEnv("COPILOTKIT_TELEMETRY_DISABLED", "true");
    const actual =
      await vi.importActual<typeof import("@copilotkit/runtime/v2")>("@copilotkit/runtime/v2");
    const runtime = new actual.CopilotRuntime(
      lastRuntimeOptions() as ConstructorParameters<typeof actual.CopilotRuntime>[0],
    );
    const app = actual.createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" });
    const res = await app.fetch(new Request(`${BASE}/info`));
    expect(res.status).toBe(200);
    const info = (await res.json()) as {
      agents: Record<string, unknown>;
      threadEndpoints: { list: boolean; inspect: boolean };
    };
    expect(Object.keys(info.agents).sort()).toEqual(["quizDiscussion", "tutor", "writing"]);
    expect(info.threadEndpoints.list).toBe(false);
    expect(info.threadEndpoints.inspect).toBe(false);
  });

  it("401s GET /info without a session (auth still required)", async () => {
    getSession.mockResolvedValue(null);
    const res = await GET(new Request(`${BASE}/info`));
    expect(res.status).toBe(401);
  });
});

describe("happy path past the gate (tutor module)", () => {
  it("forwards a run carrying a correctly-signed token, scoped to the code", async () => {
    const threadId = crypto.randomUUID();
    const res = await POST(agentRequest({ threadId, token: token(threadId) }));
    expect(res.status).toBe(200);
    expect(getLocalAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "tutor", resourceId: CODE }),
    );
    // The three usage-attribution keys are set on the request context for the
    // observability exporter (usageUserId is set even though tutor defaults anonymous).
    expect(contextSet).toHaveBeenCalledWith(USAGE_CODE, CODE);
    expect(contextSet).toHaveBeenCalledWith(USAGE_USER_ID, USER_ID);
    expect(contextSet).toHaveBeenCalledWith(USAGE_MODULE, "tutor");
  });

  it("404s a tutor-module request targeting a non-tutor agent (grader unreachable)", async () => {
    const threadId = crypto.randomUUID();
    const res = await POST(
      agentRequest({ threadId, token: token(threadId), agent: "quizEvaluator" }),
    );
    expect(res.status).toBe(404);
  });

  it("registers ONLY the module's own agent on the run runtime", async () => {
    const threadId = crypto.randomUUID();
    const res = await POST(agentRequest({ threadId, token: token(threadId) }));
    expect(res.status).toBe(200);
    expect(lastRuntimeAgentIds()).toEqual(["tutor"]);
    expect(getLocalAgent).toHaveBeenCalledOnce();
    expect(getLocalAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "tutor",
        resourceId: CODE,
        requestContext: { set: contextSet },
      }),
    );
    expect(getLocalAgents).not.toHaveBeenCalled();
  });

  it("registers ONLY the module's own agent on the connect runtime", async () => {
    const threadId = crypto.randomUUID();
    const res = await POST(agentRequest({ kind: "connect", threadId, token: token(threadId) }));
    expect(res.status).toBe(200);
    expect(lastRuntimeAgentIds()).toEqual(["tutor"]);
    expect(getLocalAgents).not.toHaveBeenCalled();
  });
});

// The route's ONE role-dependent branch: which AgentRunner feeds the SSE writer,
// and therefore whether a thinking model's REASONING_* frames are ever written
// to this caller's stream (docs/chat.md). These are the assertions that protect
// the property in CI — the @live-llm e2e that proves it against a real model is
// excluded from CI by design (docs/testing.md), so this suite is the real guard.
//
// `lib/student-mode.ts` is REAL here, so each case exercises the ACTUAL
// effective-teacher rule, not a stub of it.
describe("reasoning gate (teacher-only, fail-closed)", () => {
  /**
   * Drive one authorized request as `session` and report the runner chain it
   * produced. Failure reporting wraps every variant, so every path also asserts
   * it is the outermost runner.
   */
  async function chainFor(
    session: unknown,
    { module = "tutor", agent = "tutor", kind = "run" as "run" | "connect" } = {},
  ): Promise<unknown[]> {
    getSession.mockResolvedValue(session);
    checkCode.mockResolvedValue({
      ok: true,
      entry: { module, fileUrl: "https://example.com/api/files/x", anonymous: false },
    });
    const threadId = crypto.randomUUID();
    const res = await POST(agentRequest({ kind, agent, threadId, token: token(threadId) }));
    expect(res.status).toBe(200);
    const chain = runnerChain();
    expect(chain[0]).toBeInstanceOf(RunErrorReportingRunner);
    return chain;
  }

  const strips = (chain: unknown[]) =>
    chain.some((runner) => runner instanceof ReasoningStrippingRunner);

  // Both requests that feed the SSE writer.
  describe.each(["run", "connect"] as const)("on a tutor %s", (kind) => {
    it("strips reasoning for a plain student (no teacher claim)", async () => {
      expect(strips(await chainFor({ user: { id: USER_ID } }, { kind }))).toBe(true);
    });

    it("strips reasoning for a REAL teacher while student mode is active", async () => {
      // THE security-critical case: "view as student" must show exactly what a
      // student sees, so the raw isTeacher claim can never be the gate.
      cookies.mockResolvedValue(studentModeCookies(true));
      expect(
        strips(
          await chainFor(
            { session: { id: TEST_SESSION_ID }, user: { id: USER_ID, isTeacher: true } },
            { kind },
          ),
        ),
      ).toBe(true);
    });

    it("lets an EFFECTIVE teacher through on the library's own runner (reasoning streams)", async () => {
      const chain = await chainFor(
        { session: { id: TEST_SESSION_ID }, user: { id: USER_ID, isTeacher: true } },
        { kind },
      );
      expect(strips(chain)).toBe(false);
      expect(chain.at(-1)).toBeInstanceOf(InMemoryAgentRunner);
    });
  });

  // The decision does not depend on the module; one case each for the other
  // runtime modules.
  it.each([
    ["quiz", "quizDiscussion"],
    ["writing", "writing"],
  ] as const)("strips reasoning for a plain student on a %s run", async (module, agent) => {
    expect(strips(await chainFor({ user: { id: USER_ID } }, { module, agent }))).toBe(true);
  });

  it("strips reasoning for a session whose teacher claim is explicitly false", async () => {
    expect(strips(await chainFor({ user: { id: USER_ID, isTeacher: false } }))).toBe(true);
  });

  it("ignores the student-mode cookie for a non-teacher (it only ever restricts)", async () => {
    cookies.mockResolvedValue(studentModeCookies(true));
    expect(strips(await chainFor({ user: { id: USER_ID } }))).toBe(true);
  });

  it("FAILS CLOSED: strips reasoning when the teacher check throws", async () => {
    cookies.mockRejectedValue(new Error("cookies() blew up"));
    expect(
      strips(
        await chainFor({
          session: { id: TEST_SESSION_ID },
          user: { id: USER_ID, isTeacher: true },
        }),
      ),
    ).toBe(true);
  });
});

// A tutor's `connect` is answered with the stored conversation by the snapshot
// runner, which must sit INNERMOST — directly around the library's runner — so
// the reasoning stripper and the failure reporter see its frames like any other.
// Writing and quiz connect without it.
describe("history snapshot runner (tutor only, innermost)", () => {
  async function connectAs(session: unknown, agent = "tutor"): Promise<unknown[]> {
    getSession.mockResolvedValue(session);
    const threadId = crypto.randomUUID();
    const res = await POST(
      agentRequest({ kind: "connect", agent, threadId, token: token(threadId) }),
    );
    expect(res.status).toBe(200);
    return runnerChain();
  }

  it("student: failure reporting → reasoning stripping → snapshot → library runner", async () => {
    const chain = await connectAs({ user: { id: USER_ID } });
    expect(chain.map((runner) => (runner as object).constructor)).toEqual([
      RunErrorReportingRunner,
      ReasoningStrippingRunner,
      HistorySnapshotRunner,
      InMemoryAgentRunner,
    ]);
  });

  it("teacher: failure reporting → snapshot → library runner", async () => {
    const chain = await connectAs({
      session: { id: TEST_SESSION_ID },
      user: { id: USER_ID, isTeacher: true },
    });
    expect(chain.map((runner) => (runner as object).constructor)).toEqual([
      RunErrorReportingRunner,
      HistorySnapshotRunner,
      InMemoryAgentRunner,
    ]);
  });

  it("scopes the snapshot to the code, its frozen anonymous flag, its file and the session user", async () => {
    const chain = await connectAs({ user: { id: USER_ID } });
    const snapshot = chain.find((runner) => runner instanceof HistorySnapshotRunner);
    expect((snapshot as unknown as { scope: unknown }).scope).toEqual({
      code: CODE,
      frozenAnonymous: false,
      fileUrl: "https://example.com/t.yaml",
      userId: USER_ID,
    });
  });

  it.each([
    ["quiz", "quizDiscussion"],
    ["writing", "writing"],
  ])("a %s code gets no snapshot runner", async (module, agent) => {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { module, fileUrl: "https://example.com/api/files/x" },
    });
    const chain = await connectAs({ user: { id: USER_ID } }, agent);
    expect(chain.some((runner) => runner instanceof HistorySnapshotRunner)).toBe(false);
    expect(chain.at(-1)).toBeInstanceOf(InMemoryAgentRunner);
  });
});

describe("quiz module (reached via a quiz-module code)", () => {
  beforeEach(() => {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { module: "quiz", fileUrl: "https://example.com/api/files/q" },
    });
  });

  it("forwards a discussion run to quizDiscussion, scoped to the CODE", async () => {
    const threadId = crypto.randomUUID();
    const res = await POST(
      agentRequest({ threadId, token: token(threadId), agent: "quizDiscussion" }),
    );
    expect(res.status).toBe(200);
    // resourceId is the CODE for every module (not the quiz URL).
    expect(getLocalAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "quizDiscussion", resourceId: CODE }),
    );
    // The runtime holds the discussion agent alone — the grader is not even registered.
    expect(lastRuntimeAgentIds()).toEqual(["quizDiscussion"]);
  });

  // The registered-but-internal agents (docs/cli-eval.md): besides submitAnswer for
  // the grader, their only callers are the teacher-only bearer routes
  // POST /api/eval/{grade,judge,respond}.
  it.each(INTERNAL_AGENT_IDS)(
    "404s a quiz-module request targeting %s (never web-reachable)",
    async (agent) => {
      const threadId = crypto.randomUUID();
      const res = await POST(agentRequest({ threadId, token: token(threadId), agent }));
      expect(res.status).toBe(404);
      expect(getLocalAgent).not.toHaveBeenCalled();
      expect(CopilotRuntime).not.toHaveBeenCalled();
    },
  );

  it("forwards the runtime status when buildRequestContext fails (e.g. quiz load 502)", async () => {
    buildRequestContext.mockResolvedValue({ ok: false, status: 502, message: "quiz unavailable" });
    const threadId = crypto.randomUUID();
    const res = await POST(
      agentRequest({ threadId, token: token(threadId), agent: "quizDiscussion" }),
    );
    expect(res.status).toBe(502);
    expect(getLocalAgent).not.toHaveBeenCalled();
    expect(CopilotRuntime).not.toHaveBeenCalled();
  });
});

describe("writing module (reached via a writing-module code)", () => {
  beforeEach(() => {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { module: "writing", fileUrl: "https://example.com/api/files/w" },
    });
  });

  it("forwards a run to the writing agent, scoped to the CODE, building its context", async () => {
    const threadId = crypto.randomUUID();
    const res = await POST(agentRequest({ threadId, token: token(threadId), agent: "writing" }));
    expect(res.status).toBe(200);
    expect(buildRequestContext).toHaveBeenCalledOnce();
    expect(getLocalAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "writing", resourceId: CODE }),
    );
    expect(lastRuntimeAgentIds()).toEqual(["writing"]);
  });

  it("404s a writing-module request targeting a non-runtime agent id", async () => {
    const threadId = crypto.randomUUID();
    const res = await POST(
      agentRequest({ threadId, token: token(threadId), agent: "quizEvaluator" }),
    );
    expect(res.status).toBe(404);
    expect(getLocalAgent).not.toHaveBeenCalled();
    expect(CopilotRuntime).not.toHaveBeenCalled();
  });

  it("forwards the runtime status when buildRequestContext fails (writing load 502)", async () => {
    buildRequestContext.mockResolvedValue({
      ok: false,
      status: 502,
      message: "writing unavailable",
    });
    const threadId = crypto.randomUUID();
    const res = await POST(agentRequest({ threadId, token: token(threadId), agent: "writing" }));
    expect(res.status).toBe(502);
    expect(getLocalAgent).not.toHaveBeenCalled();
    expect(CopilotRuntime).not.toHaveBeenCalled();
  });
});

describe("coding module (no CopilotKit runtime)", () => {
  it("404s a coding-module code and never builds a runtime", async () => {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { module: "coding", fileUrl: "https://example.com/api/files/c" },
    });
    const threadId = crypto.randomUUID();
    const res = await POST(agentRequest({ threadId, token: token(threadId) }));
    expect(res.status).toBe(404);
    expect(CopilotRuntime).not.toHaveBeenCalled();
  });
});

describe("cloze module (no CopilotKit runtime)", () => {
  // The cloze grader is reached only through the gradeCloze/explainCloze actions.
  it.each(["clozeEvaluator", "tutor"])(
    "404s a cloze-module request targeting %s and never builds a runtime",
    async (agent) => {
      checkCode.mockResolvedValue({
        ok: true,
        entry: { module: "cloze", fileUrl: "https://example.com/api/files/cz" },
      });
      const threadId = crypto.randomUUID();
      const res = await POST(agentRequest({ threadId, token: token(threadId), agent }));
      expect(res.status).toBe(404);
      expect(getLocalAgent).not.toHaveBeenCalled();
      expect(CopilotRuntime).not.toHaveBeenCalled();
    },
  );
});

// The user↔chat link is written after a run the runtime accepted; whether the
// activity is anonymous is decided inside recordUserChat (lib/user-chat-store.ts).
describe("attribution after a run", () => {
  it("records a successful run once, with the verified thread and the session user", async () => {
    const threadId = crypto.randomUUID();
    const res = await POST(agentRequest({ threadId, token: token(threadId) }));
    expect(res.status).toBe(200);
    expect(recordUserChat).toHaveBeenCalledExactlyOnceWith(
      CODE,
      threadId,
      USER_ID,
      "https://example.com/t.yaml",
      "tutor",
    );
    expect(recordUserMessage).toHaveBeenCalledExactlyOnceWith({
      code: CODE,
      module: "tutor",
      userId: USER_ID,
    });
  });

  it.each([
    ["a connect", "connect", true, 200],
    ["a stop", "stop", true, 200],
    ["a run rejected by the token check", "run", false, 200],
    ["a run the runtime answered with an error", "run", true, 500],
  ] as const)("records nothing for %s", async (_what, kind, validToken, status) => {
    endpointFetch.mockResolvedValue(new Response("{}", { status }));
    const threadId = crypto.randomUUID();
    await POST(agentRequest({ kind, threadId, token: validToken ? token(threadId) : "deadbeef" }));
    expect(recordUserChat).not.toHaveBeenCalled();
    expect(recordUserMessage).not.toHaveBeenCalled();
  });
});

describe("trimToNewTurn (replayed-history trimming)", () => {
  it("keeps the turn after the last assistant reply, dropping the replayed prefix", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3 — the new turn" },
    ];
    expect(trimToNewTurn(messages)).toEqual([{ role: "user", content: "u3 — the new turn" }]);
  });

  it("passes the first turn through unchanged (no assistant message yet)", () => {
    const messages = [{ role: "user", content: "first message" }];
    expect(trimToNewTurn(messages)).toBe(messages);
  });

  it("does not trim to empty when the history ends with an assistant message", () => {
    const messages = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];
    expect(trimToNewTurn(messages)).toBe(messages);
  });

  it("forwards a run with only the new turn in its body", async () => {
    const threadId = crypto.randomUUID();
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "the new turn" },
    ];
    const res = await POST(agentRequest({ threadId, token: token(threadId), messages }));
    expect(res.status).toBe(200);
    const forwarded = endpointFetch.mock.calls[0]?.[0] as Request;
    const body = (await forwarded.json()) as { messages: unknown[]; threadId: string };
    expect(body.messages).toEqual([{ role: "user", content: "the new turn" }]);
    expect(body.threadId).toBe(threadId);
  });
});
