import { type BaseEvent, verifyEvents } from "@ag-ui/client";
import { EventType, type Message } from "@ag-ui/core";
import {
  type AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerRunRequest,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";
import { firstValueFrom, type Observable, of, toArray } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The snapshot runner answers a tutor's `connect` with the stored conversation
// and filters the in-process replay of the same messages (docs/chat.md →
// Resuming a conversation). Its store is mocked; the resume rule
// (lib/tutor-history-gate.ts) is real, and so is the library's
// `InMemoryAgentRunner` — the replay shape is exactly what this runner must
// survive — and every connect stream is run through AG-UI's own client-side
// `verifyEvents`, the check the browser applies.

const loadThreadForChat = vi.hoisted(() => vi.fn());
const ownsTutorThread = vi.hoisted(() => vi.fn());
const readAnonymousFlag = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tutor-history-store", () => ({ loadThreadForChat, ownsTutorThread }));
vi.mock("@/lib/file-validators", () => ({ readAnonymousFlag }));

import { HistorySnapshotRunner } from "./history-snapshot-runner";

const CODE = "c0de";
const USER = "student-1";
const FILE_URL = "https://example.com/api/files/tutor";
// A per-user code by default; the ownership branch only matters past the limit.
const SCOPE = { code: CODE, frozenAnonymous: false, fileUrl: FILE_URL, userId: USER };
const MINUTE = 60 * 1000;

const STORED: Message[] = [
  { id: "u1", role: "user", content: "What is a prime?" },
  { id: "a1", role: "assistant", content: "A number with exactly two divisors." },
];

function stored(messages: Message[] = STORED, ageMs = MINUTE) {
  return { messages, lastMessageAt: new Date(Date.now() - ageMs) };
}

function collect(stream: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return firstValueFrom(stream.pipe(toArray()));
}

/** The connect stream as the browser would accept it — `verifyEvents` throws on a protocol error. */
function collectVerified(stream: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return collect(stream.pipe(verifyEvents(false)));
}

function connectRequest(threadId: string): AgentRunnerConnectRequest {
  return { threadId } as unknown as AgentRunnerConnectRequest;
}

/** The minimum of an AG-UI agent the in-memory runner drives. */
function fakeAgent(
  events: BaseEvent[],
  opts: { gate?: Promise<void>; after?: BaseEvent[]; fail?: string } = {},
) {
  return {
    agentId: "tutor",
    messages: [],
    abortRun: () => {},
    runAgent: async (
      _input: unknown,
      subscriber: { onEvent: (payload: { event: BaseEvent }) => void },
    ) => {
      for (const event of events) subscriber.onEvent({ event });
      if (opts.gate) await opts.gate;
      for (const event of opts.after ?? []) subscriber.onEvent({ event });
      if (opts.fail) throw new Error(opts.fail);
    },
  };
}

function runRequest(threadId: string, runId: string, agent: ReturnType<typeof fakeAgent>) {
  return {
    threadId,
    agent,
    input: {
      threadId,
      runId,
      messages: [{ id: "u1", role: "user", content: "What is a prime?" }],
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
    },
  } as unknown as AgentRunnerRunRequest;
}

/**
 * One stored-and-completed reply: assistant text under the stored id `a1`, a tool
 * call parented on it with its result, then more text under `a1-agui-text`; a
 * second tool call and the text after it under `a1-agui-text-2`.
 */
function storedTurn(threadId: string, runId: string): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId, runId },
    { type: EventType.TEXT_MESSAGE_START, messageId: "a1", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a1", delta: "A number " },
    { type: EventType.TEXT_MESSAGE_END, messageId: "a1" },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "c1",
      toolCallName: "calc",
      parentMessageId: "a1",
    },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: "{}" },
    { type: EventType.TOOL_CALL_END, toolCallId: "c1" },
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "c1",
      messageId: "tr1",
      content: "2",
      role: "tool",
    },
    { type: EventType.TEXT_MESSAGE_START, messageId: "a1-agui-text", role: "assistant" },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "a1-agui-text",
      delta: "with two divisors.",
    },
    { type: EventType.TEXT_MESSAGE_END, messageId: "a1-agui-text" },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "c2",
      toolCallName: "board",
      parentMessageId: "a1-agui-text",
    },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "c2", delta: "{}" },
    { type: EventType.TOOL_CALL_END, toolCallId: "c2" },
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "c2",
      messageId: "tr2",
      content: "{}",
      role: "tool",
    },
    { type: EventType.TEXT_MESSAGE_START, messageId: "a1-agui-text-2", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a1-agui-text-2", delta: "And more." },
    { type: EventType.TEXT_MESSAGE_END, messageId: "a1-agui-text-2" },
    { type: EventType.RUN_FINISHED, threadId, runId },
  ] as BaseEvent[];
}

/** A reply whose ids are NOT in the snapshot (e.g. its save failed). */
function unstoredTurn(threadId: string, runId: string): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId, runId },
    { type: EventType.TEXT_MESSAGE_START, messageId: "a9", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a9", delta: "unsaved" },
    { type: EventType.TEXT_MESSAGE_END, messageId: "a9" },
    { type: EventType.RUN_FINISHED, threadId, runId },
  ] as BaseEvent[];
}

/** Runs one turn through the real runner to completion (fills its in-process store). */
async function completeRun(
  inner: InMemoryAgentRunner,
  threadId: string,
  runId: string,
  agent: ReturnType<typeof fakeAgent>,
): Promise<void> {
  await collect(inner.run(runRequest(threadId, runId, agent))).catch(() => undefined);
}

function freshThread(): string {
  // The library keys its in-process store globally, so every test gets its own.
  return `t-${crypto.randomUUID()}`;
}

function messageIdsOf(events: BaseEvent[]): string[] {
  return events
    .map((event) => (event as { messageId?: unknown }).messageId)
    .filter((id): id is string => typeof id === "string");
}

beforeEach(() => {
  loadThreadForChat.mockReset();
  ownsTutorThread.mockReset().mockResolvedValue(false);
  readAnonymousFlag.mockReset().mockResolvedValue({ anonymous: false, definitive: true });
});

describe("HistorySnapshotRunner.connect — the snapshot", () => {
  it("cold process with stored messages → exactly RUN_STARTED, MESSAGES_SNAPSHOT, RUN_FINISHED", async () => {
    loadThreadForChat.mockResolvedValue(stored());
    const threadId = freshThread();
    const runner = new HistorySnapshotRunner(new InMemoryAgentRunner(), SCOPE);

    const out = await collectVerified(runner.connect(connectRequest(threadId)));

    expect(out.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    const [started, snapshot, finished] = out as Array<Record<string, unknown>>;
    expect(started?.threadId).toBe(threadId);
    expect(String(started?.runId)).toMatch(/^restore-/);
    expect(finished?.runId).toBe(started?.runId);
    expect(snapshot?.messages).toEqual(STORED);
    expect(loadThreadForChat).toHaveBeenCalledWith(CODE, threadId);
  });

  it.each([
    ["no stored messages", async () => ({ messages: [], lastMessageAt: null })],
    ["idle past the limit + grace (66 min)", async () => stored(STORED, 66 * MINUTE)],
    ["a store failure", async () => undefined],
    [
      "a throwing store",
      async () => {
        throw new Error("db down");
      },
    ],
  ])("%s → the inner connect unchanged, never a RUN_ERROR", async (_label, impl) => {
    loadThreadForChat.mockImplementation(impl);
    const innerEvents = [{ type: EventType.CUSTOM, name: "x", value: 1 }] as BaseEvent[];
    const inner = {
      run: vi.fn(),
      connect: vi.fn(() => of(...innerEvents)),
      isRunning: vi.fn(),
      stop: vi.fn(),
    };
    const runner = new HistorySnapshotRunner(inner as unknown as AgentRunner, SCOPE);

    const out = await collect(runner.connect(connectRequest(freshThread())));

    expect(out).toEqual(innerEvents);
    expect(out.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
  });

  it("still snapshots inside the grace (64 min: past the limit, within limit + grace)", async () => {
    loadThreadForChat.mockResolvedValue(stored(STORED, 64 * MINUTE));
    const runner = new HistorySnapshotRunner(new InMemoryAgentRunner(), SCOPE);
    const out = await collectVerified(runner.connect(connectRequest(freshThread())));
    expect(out.map((event) => event.type)).toContain(EventType.MESSAGES_SNAPSHOT);
  });
});

describe("HistorySnapshotRunner.connect — a reopened conversation past the limit", () => {
  const innerEvents = [{ type: EventType.CUSTOM, name: "x", value: 1 }] as BaseEvent[];
  function stubbed(scope = SCOPE) {
    const inner = {
      run: vi.fn(),
      connect: vi.fn(() => of(...innerEvents)),
      isRunning: vi.fn(),
      stop: vi.fn(),
    };
    return new HistorySnapshotRunner(inner as unknown as AgentRunner, scope);
  }

  it("snapshots the session user's own thread on a history-enabled code, however old", async () => {
    loadThreadForChat.mockResolvedValue(stored(STORED, 30 * 24 * 60 * MINUTE));
    ownsTutorThread.mockResolvedValue(true);
    const threadId = freshThread();

    const out = await collect(stubbed().connect(connectRequest(threadId)));

    expect(out.map((event) => event.type)).toContain(EventType.MESSAGES_SNAPSHOT);
    expect(ownsTutorThread).toHaveBeenCalledWith(USER, CODE, threadId);
    expect(readAnonymousFlag).toHaveBeenCalledWith("tutor", FILE_URL);
  });

  it.each([
    ["no ownership row", () => ownsTutorThread.mockResolvedValue(false)],
    ["an ownership lookup failure", () => ownsTutorThread.mockResolvedValue(undefined)],
    [
      "a live anonymous YAML",
      () => {
        ownsTutorThread.mockResolvedValue(true);
        readAnonymousFlag.mockResolvedValue({ anonymous: true, definitive: true });
      },
    ],
    [
      "an unreadable YAML",
      () => {
        ownsTutorThread.mockResolvedValue(true);
        readAnonymousFlag.mockResolvedValue({ anonymous: true, definitive: false });
      },
    ],
  ])("connects as before with %s", async (_label, arrange) => {
    loadThreadForChat.mockResolvedValue(stored(STORED, 2 * 60 * MINUTE));
    arrange();
    expect(await collect(stubbed().connect(connectRequest(freshThread())))).toEqual(innerEvents);
  });

  it("never consults the ownership row on a frozen-anonymous code", async () => {
    loadThreadForChat.mockResolvedValue(stored(STORED, 2 * 60 * MINUTE));
    ownsTutorThread.mockResolvedValue(true);
    const out = await collect(
      stubbed({ ...SCOPE, frozenAnonymous: true }).connect(connectRequest(freshThread())),
    );
    expect(out).toEqual(innerEvents);
    expect(ownsTutorThread).not.toHaveBeenCalled();
    expect(readAnonymousFlag).not.toHaveBeenCalled();
  });

  it("within the limit, needs no ownership row and no YAML read", async () => {
    loadThreadForChat.mockResolvedValue(stored());
    await collect(stubbed().connect(connectRequest(freshThread())));
    expect(ownsTutorThread).not.toHaveBeenCalled();
    expect(readAnonymousFlag).not.toHaveBeenCalled();
  });
});

describe("HistorySnapshotRunner.connect — the filtered in-process replay (warm process)", () => {
  it("drops every TEXT/TOOL event of a snapshotted message, leaving bare run frames", async () => {
    loadThreadForChat.mockResolvedValue(stored());
    const threadId = freshThread();
    const inner = new InMemoryAgentRunner();
    await completeRun(inner, threadId, "r1", fakeAgent(storedTurn(threadId, "r1")));
    const runner = new HistorySnapshotRunner(inner, SCOPE);

    const out = await collectVerified(runner.connect(connectRequest(threadId)));

    // Nothing about a1 (incl. a1-agui-text and a1-agui-text-2) or its tool calls (incl. results).
    expect(
      out.filter((event) => /^(TEXT_MESSAGE|TOOL_CALL)_/.test(event.type)).map((e) => e.type),
    ).toEqual([]);
    expect(out.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_FINISHED,
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });

  it("drops a FINISHED run's reasoning (never stored, so it has no place in the snapshot)", async () => {
    loadThreadForChat.mockResolvedValue(stored());
    const threadId = freshThread();
    const inner = new InMemoryAgentRunner();
    const [started, ...rest] = storedTurn(threadId, "r1");
    const withReasoning = [
      started,
      { type: EventType.REASONING_START, messageId: "rz1" },
      { type: EventType.REASONING_MESSAGE_START, messageId: "rz1", role: "reasoning" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "rz1", delta: "the student wants…" },
      { type: EventType.REASONING_MESSAGE_END, messageId: "rz1" },
      { type: EventType.REASONING_END, messageId: "rz1" },
      ...rest,
    ] as BaseEvent[];
    await completeRun(inner, threadId, "r1", fakeAgent(withReasoning));
    // Precondition: the library really does replay it.
    const raw = await collect(inner.connect(connectRequest(threadId)));
    expect(raw.some((event) => event.type.startsWith("REASONING_"))).toBe(true);

    const runner = new HistorySnapshotRunner(inner, SCOPE);
    const out = await collectVerified(runner.connect(connectRequest(threadId)));

    expect(out.some((event) => event.type.startsWith("REASONING_"))).toBe(false);
  });

  it("keeps an IN-FLIGHT run's reasoning, early part and live remainder alike", async () => {
    loadThreadForChat.mockResolvedValue(stored());
    const threadId = freshThread();
    const inner = new InMemoryAgentRunner();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const liveDone = collect(
      inner.run(
        runRequest(
          threadId,
          "r2",
          fakeAgent(
            [
              { type: EventType.RUN_STARTED, threadId, runId: "r2" },
              { type: EventType.REASONING_START, messageId: "rz2" },
              { type: EventType.REASONING_MESSAGE_START, messageId: "rz2", role: "reasoning" },
              { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "rz2", delta: "early" },
            ] as BaseEvent[],
            {
              gate,
              after: [
                { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "rz2", delta: " late" },
                { type: EventType.REASONING_MESSAGE_END, messageId: "rz2" },
                { type: EventType.REASONING_END, messageId: "rz2" },
                { type: EventType.RUN_FINISHED, threadId, runId: "r2" },
              ] as BaseEvent[],
            },
          ),
        ),
      ),
    );
    const runner = new HistorySnapshotRunner(inner, SCOPE);

    const connected = collectVerified(runner.connect(connectRequest(threadId)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const out = await connected;
    await liveDone;

    const deltas = out
      .filter((event) => event.type === EventType.REASONING_MESSAGE_CONTENT)
      .map((event) => (event as { delta?: string }).delta);
    expect(deltas.join("")).toBe("early late");
  });

  it("replays a run whose ids are NOT in the snapshot in full (e.g. its save failed)", async () => {
    loadThreadForChat.mockResolvedValue(stored());
    const threadId = freshThread();
    const inner = new InMemoryAgentRunner();
    await completeRun(inner, threadId, "r1", fakeAgent(unstoredTurn(threadId, "r1")));
    const runner = new HistorySnapshotRunner(inner, SCOPE);

    const out = await collectVerified(runner.connect(connectRequest(threadId)));

    expect(messageIdsOf(out)).toContain("a9");
    expect(out.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)).toHaveLength(1);
  });

  it("closes a HISTORIC RUN_ERROR as RUN_FINISHED so later runs stay legal", async () => {
    loadThreadForChat.mockResolvedValue(stored());
    const threadId = freshThread();
    const inner = new InMemoryAgentRunner();
    // A failed turn (one event, then the agent throws) followed by a good one.
    await completeRun(
      inner,
      threadId,
      "r1",
      fakeAgent([{ type: EventType.RUN_STARTED, threadId, runId: "r1" } as BaseEvent], {
        fail: "provider down",
      }),
    );
    await completeRun(inner, threadId, "r2", fakeAgent(storedTurn(threadId, "r2")));
    // Precondition: the library really does replay the failure as a RUN_ERROR.
    const raw = await collect(inner.connect(connectRequest(threadId)));
    expect(raw.some((event) => event.type === EventType.RUN_ERROR)).toBe(true);

    const runner = new HistorySnapshotRunner(inner, SCOPE);
    const out = await collectVerified(runner.connect(connectRequest(threadId)));

    expect(out.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
    const finishedR1 = out.find(
      (event) =>
        event.type === EventType.RUN_FINISHED && (event as { runId?: string }).runId === "r1",
    ) as { threadId?: string } | undefined;
    expect(finishedR1?.threadId).toBe(threadId);
  });

  it("lets an IN-FLIGHT run's live events through (a reload mid-answer)", async () => {
    loadThreadForChat.mockResolvedValue(stored());
    const threadId = freshThread();
    const inner = new InMemoryAgentRunner();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = inner.run(
      runRequest(
        threadId,
        "r2",
        fakeAgent(
          [
            { type: EventType.RUN_STARTED, threadId, runId: "r2" },
            { type: EventType.TEXT_MESSAGE_START, messageId: "a2", role: "assistant" },
            { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a2", delta: "Thinking" },
          ] as BaseEvent[],
          {
            gate,
            after: [
              { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a2", delta: " done" },
              { type: EventType.TEXT_MESSAGE_END, messageId: "a2" },
              { type: EventType.RUN_FINISHED, threadId, runId: "r2" },
            ] as BaseEvent[],
          },
        ),
      ),
    );
    const liveDone = collect(live);
    const runner = new HistorySnapshotRunner(inner, SCOPE);

    const connected = collectVerified(runner.connect(connectRequest(threadId)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const out = await connected;
    await liveDone;

    const deltas = out
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as { delta?: string }).delta);
    expect(deltas.join("")).toBe("Thinking done");
    expect(out.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it("passes a LIVE RUN_ERROR (the in-flight run failing) unchanged", async () => {
    loadThreadForChat.mockResolvedValue(stored());
    const threadId = freshThread();
    const inner = new InMemoryAgentRunner();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const liveDone = collect(
      inner.run(
        runRequest(
          threadId,
          "r2",
          fakeAgent([{ type: EventType.RUN_STARTED, threadId, runId: "r2" }] as BaseEvent[], {
            gate,
            fail: "provider down",
          }),
        ),
      ),
    ).catch(() => undefined);
    const runner = new HistorySnapshotRunner(inner, SCOPE);

    const connected = collectVerified(runner.connect(connectRequest(threadId)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const out = await connected;
    await liveDone;

    expect(out.at(-1)?.type).toBe(EventType.RUN_ERROR);
  });
});

describe("the in-memory runner's replay timing (what 'historic' rests on)", () => {
  it("delivers a completed thread's history synchronously during subscribe", async () => {
    const threadId = freshThread();
    const inner = new InMemoryAgentRunner();
    await completeRun(inner, threadId, "r1", fakeAgent(storedTurn(threadId, "r1")));

    const seen: boolean[] = [];
    let duringSubscribe = true;
    inner.connect(connectRequest(threadId)).subscribe((/* event */) => {
      seen.push(duringSubscribe);
    });
    duringSubscribe = false;

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });
});

describe("HistorySnapshotRunner delegation", () => {
  function stubInner() {
    return {
      run: vi.fn(() => of({ type: EventType.RUN_FINISHED } as BaseEvent)),
      connect: vi.fn(),
      isRunning: vi.fn(async () => true),
      stop: vi.fn(async () => true),
    };
  }

  it("delegates run verbatim (no store read)", async () => {
    const inner = stubInner();
    const runner = new HistorySnapshotRunner(inner as unknown as AgentRunner, SCOPE);
    const request = { threadId: "t1" } as unknown as AgentRunnerRunRequest;
    expect(await collect(runner.run(request))).toEqual([{ type: EventType.RUN_FINISHED }]);
    expect(inner.run).toHaveBeenCalledWith(request);
    expect(loadThreadForChat).not.toHaveBeenCalled();
  });

  it("delegates isRunning and stop verbatim", async () => {
    const inner = stubInner();
    const runner = new HistorySnapshotRunner(inner as unknown as AgentRunner, SCOPE);
    await expect(runner.isRunning({ threadId: "t1" })).resolves.toBe(true);
    await expect(runner.stop({ threadId: "t1" })).resolves.toBe(true);
    expect(inner.isRunning).toHaveBeenCalledWith({ threadId: "t1" });
    expect(inner.stop).toHaveBeenCalledWith({ threadId: "t1" });
  });
});
