import { MastraAgent } from "@ag-ui/mastra";
import {
  type AgentRunner,
  CopilotRuntime,
  createCopilotEndpoint,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";
import { after } from "next/server";
import { HistorySnapshotRunner } from "@/app/api/copilotkit/history-snapshot-runner";
import { ReasoningStrippingRunner } from "@/app/api/copilotkit/reasoning-runner";
import { RunErrorReportingRunner } from "@/app/api/copilotkit/run-error-runner";
import { mastra } from "@/app/mastra";
import { codeModules } from "@/lib/code-modules/registry";
import { type CodeRejection, checkCode } from "@/lib/code-store";
import { RUNTIME_CODE_HEADER, RUNTIME_THREAD_TOKEN_HEADER } from "@/lib/runtime-headers";
import { getSession } from "@/lib/session";
import { effectiveTeacherForSession } from "@/lib/student-mode";
import { getThreadTokenSecret, verifyThreadToken } from "@/lib/thread-token";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";
import { recordUserMessage } from "@/lib/usage-store";
import { recordUserChat } from "@/lib/user-chat-store";

// Human-readable rejection texts: a 403 can surface mid-session in the chat's
// error UI (e.g. when the window closes while the student is typing), so the
// message should explain, not just name a reason code.
const REJECTION_MESSAGES: Record<CodeRejection, string> = {
  "unknown-code": "This activity requires a valid code.",
  "not-started": "This activity's availability window has not started yet.",
  expired: "This activity's availability window has ended.",
  "lookup-failed": "Codes cannot be checked right now — try again in a moment.",
};

const THREAD_REJECTION_MESSAGE =
  "This chat does not belong to your session — reload the page to start a new chat.";

// Belt-and-braces shape check before the HMAC; the page issues UUIDs but the
// token (not this pattern) is what actually proves ownership.
const THREAD_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

// Ceiling on a run/connect body. The client caps what it SENDS (a normalized
// photo is at most `MAX_IMAGE_BYTES`, lib/answer-images.ts), but the client is
// never trusted and nothing on this path checked the size at all — the browser
// is now allowed to PICK a file several times larger than it may send, so the
// gap between the two is exactly where an unbounded POST would live. Sized to
// hold a turn's text plus a few base64-inlined photos with room to spare
// (base64 inflates by a third); anything past it is not a student typing.
const MAX_RUN_BODY_BYTES = 24 * 1024 * 1024;

/**
 * `true` when the request DECLARES a body larger than we will ever process.
 * Content-Length only — a cheap header check that rejects before the body is
 * read or parsed. A chunked request without the header simply falls through:
 * the point is to stop the obvious case early, not to be a byte-exact quota.
 */
function declaresOversizedBody(req: Request): boolean {
  const declared = Number(req.headers.get("content-length"));
  return Number.isFinite(declared) && declared > MAX_RUN_BODY_BYTES;
}

// CopilotKit/AG-UI re-sends the ENTIRE client-side conversation on every run,
// and Mastra persists whatever messages it is handed (each with a fresh id) —
// so forwarding the whole history re-stores every prior turn again. The
// conversation then balloons quadratically and the read-only viewer shows each
// turn many times. Mastra's own guidance (`@mastra/memory` message-history
// docs) is to send ONLY the new message and let `lastMessages` memory supply
// the prior context. So keep just the turn AFTER the last assistant reply:
// everything up to and including it is already persisted in this thread. The
// first turn (no assistant message yet) and any degenerate empty tail pass
// through unchanged — returning the SAME array signals "no trim needed".
export function trimToNewTurn<T extends { role?: unknown }>(messages: T[]): T[] {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0) return messages;
  const tail = messages.slice(lastAssistant + 1);
  return tail.length > 0 ? tail : messages;
}

// resourceId handed to the runtime when serving `/info` (metadata only, runs no
// agent), so it is never used to read or write memory — it just satisfies the
// required parameter. Distinct from any real code (codes are [a-z0-9-]{1,32}).
const INFO_RESOURCE_ID = "__info__";

/**
 * The agent ids the BROWSER may know about: every module's `runtime.agentId`
 * (tutor, quiz discussion, writing — derived from the registry, never listed by
 * hand). `/info` advertises exactly these, because CopilotKit's client resolves a
 * chat's agent from the `/info` agent list and throws for an id it does not find.
 * The internal agents Mastra also knows (`quizEvaluator`, `evalJudge`,
 * `evalTutor`, `clozeEvaluator`) are deliberately absent: no module runs them through this route,
 * so their names and descriptions have no business reaching a browser.
 */
function studentFacingAgentIds(): string[] {
  const ids = new Set<string>();
  for (const def of Object.values(codeModules)) {
    if (def.runtime) ids.add(def.runtime.agentId);
  }
  return [...ids];
}

// The runtime endpoints the CopilotKit v2 client actually uses, classified
// from the request path (segments after the /api/copilotkit base). Everything
// else 404s — see the THREAT MODEL note below.
type RuntimeRequest =
  | { kind: "info" }
  | { kind: "run" | "connect"; agentId: string; threadIdSource: "body" }
  | { kind: "stop"; agentId: string; threadId: string | undefined }
  | { kind: "unsupported" };

function classifyRequest(req: Request): RuntimeRequest {
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  // segments[0..1] are "api"/"copilotkit"; the runtime sub-path follows.
  const sub = segments.slice(2);
  if (sub.length === 1 && sub[0] === "info" && req.method === "GET") {
    return { kind: "info" };
  }
  // `agent/<agentId>/{run|connect}` — the agent id is checked against the code's
  // module in the handler (each module runs exactly one agent), so the grader
  // stays unreachable even though Mastra knows about it.
  if (sub.length === 3 && sub[0] === "agent" && req.method === "POST") {
    const agentId = sub[1] ?? "";
    if (sub[2] === "run") return { kind: "run", agentId, threadIdSource: "body" };
    if (sub[2] === "connect") return { kind: "connect", agentId, threadIdSource: "body" };
  }
  const stopThreadId = sub[3];
  if (
    sub.length === 4 &&
    sub[0] === "agent" &&
    sub[2] === "stop" &&
    stopThreadId !== undefined &&
    req.method === "POST"
  ) {
    // A malformed %-encoding (URIError) is rejected like any other invalid thread
    // id: `undefined` fails the ownership check (403), never an unhandled 500.
    let threadId: string | undefined;
    try {
      threadId = decodeURIComponent(stopThreadId);
    } catch {}
    return { kind: "stop", agentId: sub[1] ?? "", threadId };
  }
  return { kind: "unsupported" };
}

// Shared THREAD-OWNERSHIP check (+ run-history trim). Only run/connect/stop reach
// here; run/connect carry the threadId in their AG-UI body — peek it out of a
// clone, the runtime still needs the original. `run` additionally carries the
// full client-side message history; we rebuild its request with a body trimmed to
// the new turn (see trimToNewTurn) so Mastra persists only that turn + its reply
// instead of re-storing the whole history. `connect` is not trimmed — it opens
// the stream and carries no new turn.
//
// `code` is the value the thread token is bound to (the same for every module:
// the code itself, which is also the Mastra memory resourceId). Returns the
// verified threadId + the request to forward, or a 403 response.
async function resolveThreadOwnership(
  req: Request,
  runtimeRequest: Extract<RuntimeRequest, { kind: "run" | "connect" | "stop" }>,
  code: string,
  userId: string,
): Promise<
  { ok: true; threadId: string; forwardReq: Request } | { ok: false; response: Response }
> {
  let threadId: string | undefined;
  let forwardReq: Request = req;
  if (runtimeRequest.kind === "stop") {
    threadId = runtimeRequest.threadId;
  } else {
    const body = (await req
      .clone()
      .json()
      .catch(() => undefined)) as { threadId?: unknown; messages?: unknown } | undefined;
    const bodyThreadId = body?.threadId;
    threadId = typeof bodyThreadId === "string" ? bodyThreadId : undefined;

    if (runtimeRequest.kind === "run" && body && Array.isArray(body.messages)) {
      const trimmed = trimToNewTurn(body.messages as Array<{ role?: unknown }>);
      if (trimmed !== body.messages) {
        // Rebuild the request with the trimmed history. Drop content-length so
        // the platform recomputes it for the shorter body.
        const headers = new Headers(req.headers);
        headers.delete("content-length");
        forwardReq = new Request(req.url, {
          method: req.method,
          headers,
          body: JSON.stringify({ ...body, messages: trimmed }),
        });
      }
    }
  }
  const token = req.headers.get(RUNTIME_THREAD_TOKEN_HEADER);
  if (
    threadId === undefined ||
    !THREAD_ID_PATTERN.test(threadId) ||
    !verifyThreadToken(token, { code, userId, threadId }, getThreadTokenSecret())
  ) {
    return {
      ok: false,
      response: Response.json({ error: THREAD_REJECTION_MESSAGE }, { status: 403 }),
    };
  }
  return { ok: true, threadId, forwardReq };
}

// The chat backend, for EVERY module. Server-side checks gate every DATA request
// (run, connect, stop) — the frontend already performed them, but headers and
// bodies are client-controlled, so they are re-verified here where they actually
// matter:
//
//  1. AUTHENTICATION — a valid Entra session is required (ALL requests).
//  2. ACCESS — the `x-code` header names a stored, in-window code. Re-checked on
//     every DATA request, so an open activity stops accepting input once its
//     window closes. The code's `module` (read off the row) selects the renderer
//     here: which agent runs and how its RequestContext is built.
//  3. THREAD OWNERSHIP — every thread-touching request must carry the
//     `x-thread-token` HMAC binding (code, session user, threadId), signed when
//     the threadId was issued (lib/thread-token.ts).
//  4. AGENT — each module RUNS exactly one agent (codeModules[module].runtime
//     .agentId), and the per-request runtime REGISTERS only that one agent. Any
//     other agent id 404s here before a runtime is built (and the runtime would
//     not know it anyway), so the Mastra-registered but internal `quizEvaluator`
//     grader, `evalJudge` feedback judge, `evalTutor` eval tutor and
//     `clozeEvaluator` cloze grader are never reachable through this web route.
//     (Their only other callers are `submitAnswer`, `gradeCloze`/`explainCloze`
//     and the teacher-only bearer routes /api/eval/{grade,judge,respond}, which
//     bring their own system prompts — docs/cli-eval.md.)
//
// The lone exception is GET `/info`: runtime metadata (the student-facing agent
// list + capabilities) with no chat data, gated by AUTHENTICATION ALONE — the
// teacher's read-only conversation viewer needs it without a code.
//
// Past those gates the route makes ONE role-dependent choice — the only one it
// has: which AgentRunner feeds the SSE writer, so that a thinking model's
// REASONING_* events reach effective TEACHERS only (fail-closed; docs/chat.md).
// It changes nothing about access: the code + thread-token model above is
// identical for every caller.
//
// THREAT MODEL for check 3 and the endpoint allowlist: the threadId arrives in
// the client-controlled run body, and Mastra does NOT bind threads to a
// resource (@ag-ui/mastra fetches threads by id alone and silently rebinds
// their resourceId on save) — without the token, any code holder could replay
// another student's threadId and read/continue their chat. The CopilotKit
// runtime additionally exposes thread endpoints the app never uses; only the
// endpoints the client calls are forwarded, the rest 404. A stateless HMAC —
// not an ownership table — keeps the `anonymous` promise: nothing links users to
// threads in storage unless the activity opts out of anonymity
// (novedu_user_chats; see lib/user-chat-store.ts).
//
// The code becomes the Mastra memory `resourceId`, so every thread is grouped
// under it (`mastra_threads.resourceId`) — "all chats/discussions for a code" is
// one SQL query. The per-request system prompt + model reach the agent via
// RequestContext (built by the module; headers carry the code, not a query
// string, because CopilotKit appends sub-paths like `/info`).
async function handler(req: Request): Promise<Response> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const runtimeRequest = classifyRequest(req);
  if (runtimeRequest.kind === "unsupported") {
    // Includes OPTIONS: the chat is same-origin, so no request ever preflights.
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Before the body is touched: a run carrying more than any real turn could.
  if (declaresOversizedBody(req)) {
    return Response.json(
      { error: "This message is too large to send. Try again with fewer or smaller photos." },
      { status: 413 },
    );
  }

  // INFO is runtime METADATA — the student-facing agent list and AG-UI
  // capabilities, with NO chat data — gated by AUTHENTICATION ALONE. The
  // teacher's read-only conversation viewer pings `/info` on mount without any
  // access header, so requiring one here would 403 it for no benefit. The
  // placeholder resourceId is never consulted: `/info` runs no agent.
  //
  // Two things keep it from advertising more than the browser needs: the agent
  // list is exactly `studentFacingAgentIds()` (never the internal agents), and
  // the runner is the stripping one — which deliberately does not re-expose
  // `ɵsupportsLocalThreadEndpoints`, so `threadEndpoints.list`/`inspect` report
  // false instead of offering the local thread endpoints this route 404s anyway.
  if (runtimeRequest.kind === "info") {
    const runtime = new CopilotRuntime({
      agents: Object.fromEntries(
        studentFacingAgentIds().map((agentId) => [
          agentId,
          MastraAgent.getLocalAgent({ mastra, agentId, resourceId: INFO_RESOURCE_ID }),
        ]),
      ),
      runner: new ReasoningStrippingRunner(),
    });
    const app = createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" });
    return app.fetch(req);
  }

  // ACCESS: one header scheme for every module. The row's `module` drives the
  // rest (agent + RequestContext).
  const code = req.headers.get(RUNTIME_CODE_HEADER) ?? "";
  const verification = await checkCode(code);
  if (!verification.ok) {
    return Response.json({ error: REJECTION_MESSAGES[verification.reason] }, { status: 403 });
  }
  const { entry } = verification;
  const def = codeModules[entry.module];

  // A module without a CopilotKit runtime (`coding`, reached only through its own
  // public OpenAI-compatible route; `cloze`, graded by its own server actions) is
  // never served here.
  if (!def.runtime) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // AGENT: each module runs exactly one agent; any other id 404s, so the
  // Mastra-registered but internal `quizEvaluator`, `evalJudge`, `evalTutor` and
  // `clozeEvaluator` stay unreachable from the web. Defense in depth with the runtime below,
  // which registers ONLY this module's agent.
  if (runtimeRequest.agentId !== def.runtime.agentId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // These three are independent — the thread-ownership check (token verify + body
  // peek), building the per-request context (the quiz module fetches its YAML
  // here, the tutor module does no I/O), and the reasoning gate (which only needs
  // the session already in hand). Run them concurrently; an ownership failure
  // still takes precedence over a context-build failure.
  //
  // REASONING is TEACHER-ONLY (docs/chat.md): a thinking model's chain of thought
  // must never be WRITTEN to a student's stream, so the runner that feeds the SSE
  // writer is chosen here rather than hidden client-side. FAILS CLOSED — any
  // error from the teacher check leaves the stripping runner in place.
  const [ownership, built, showReasoning] = await Promise.all([
    resolveThreadOwnership(req, runtimeRequest, code, userId),
    def.runtime.buildRequestContext(entry),
    effectiveTeacherForSession(session).catch(() => false),
  ]);
  if (!ownership.ok) return ownership.response;
  if (!built.ok) {
    return Response.json({ error: built.message }, { status: built.status });
  }

  // Usage attribution: the observability exporter (app/mastra/usage-exporter.ts)
  // reads these three keys off every span. `usageUserId` is set for ALL codes,
  // including anonymous ones — it is only ever stored against an hour bucket in
  // `usage_by_user`, never linked to the code (see lib/usage-store.ts).
  built.context.set(USAGE_CODE, code);
  built.context.set(USAGE_USER_ID, userId);
  built.context.set(USAGE_MODULE, entry.module);

  // The library's own runner, innermost. A TUTOR's is wrapped in the snapshot
  // runner, which answers a `connect` with the thread's stored messages so a
  // reloaded tab gets its conversation back (app/api/copilotkit/
  // history-snapshot-runner.ts) — innermost, so the decorators below see its
  // frames like any other. Writing and quiz connect as before.
  const baseRunner: AgentRunner =
    entry.module === "tutor"
      ? new HistorySnapshotRunner(new InMemoryAgentRunner(), {
          code,
          frozenAnonymous: entry.anonymous,
          fileUrl: entry.fileUrl,
          userId,
        })
      : new InMemoryAgentRunner();

  // ONLY the module's own agent is registered — never Mastra's whole registry —
  // keyed by the id the client addresses it with.
  const agentId = def.runtime.agentId;
  const runtime = new CopilotRuntime({
    agents: {
      [agentId]: MastraAgent.getLocalAgent({
        mastra,
        agentId,
        resourceId: code,
        requestContext: built.context,
      }),
    },
    // A teacher gets the base runner unfiltered — the very one the stripping
    // runner wraps — so their stream is the unmodified behaviour, reasoning
    // included. BOTH are wrapped for failure reporting: a turn that dies inside
    // the agent does so in-band, on a stream this route has already answered 200
    // for, so this decorator is the only place it can be seen (app/api/copilotkit/
    // run-error-runner.ts). It observes and never alters the stream.
    runner: new RunErrorReportingRunner(
      showReasoning ? baseRunner : new ReasoningStrippingRunner(baseRunner),
      entry.module,
    ),
  });

  // createCopilotEndpoint returns a Hono app whose `.fetch` is a standard
  // (Request) => Response handler. Mounted on an optional catch-all route so it
  // serves both the base path and sub-routes like `/info`.
  const app = createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" });
  const res = await app.fetch(ownership.forwardReq);

  // Attribution bookkeeping AFTER the run actually started: the triple is
  // token-verified above, and gating on `res.ok` keeps requests the runtime
  // rejected from minting rows. recordUserChat dedupes repeat calls per thread,
  // reads the live `anonymous` flag for the code's file kind, and skips anonymous
  // activities (the default); it runs off the response path.
  if (runtimeRequest.kind === "run" && res.ok) {
    const verifiedThreadId = ownership.threadId;
    after(() => recordUserChat(code, verifiedThreadId, userId, entry.fileUrl, def.fileKind));
    // One user message per run (a run is one user turn). Off the response path,
    // next to the attribution write; the store never throws.
    after(() => recordUserMessage({ code, module: entry.module, userId }));
  }

  return res;
}

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
