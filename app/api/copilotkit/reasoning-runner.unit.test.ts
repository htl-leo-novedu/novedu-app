import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerRunRequest,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";
import { firstValueFrom, type Observable, of, toArray } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { HistorySnapshotRunner } from "./history-snapshot-runner";
import {
  isReasoningEvent,
  LEGACY_THINKING_EVENT_TYPES,
  ReasoningStrippingRunner,
} from "./reasoning-runner";
import { RunErrorReportingRunner } from "./run-error-runner";

// The runner is the ONE place that keeps a thinking model's chain of thought
// off a student's wire (docs/chat.md). Everything it does is a pure transform of
// an event stream, so it is driven here with synthetic Observables — no network,
// no Mastra, no LLM.

const RUN_REQUEST = { threadId: "t1" } as unknown as AgentRunnerRunRequest;
const CONNECT_REQUEST = { threadId: "t1" } as unknown as AgentRunnerConnectRequest;

/** A realistic reasoning-model turn: reasoning frames interleaved with the answer. */
function turn(): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED },
    { type: EventType.REASONING_START },
    { type: EventType.REASONING_MESSAGE_START },
    { type: EventType.REASONING_MESSAGE_CONTENT, delta: "the student is asking about…" },
    { type: EventType.REASONING_MESSAGE_END },
    { type: EventType.REASONING_END },
    { type: EventType.TEXT_MESSAGE_START, messageId: "m1" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Hello" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: " there" },
    { type: EventType.TEXT_MESSAGE_END, messageId: "m1" },
    { type: EventType.TOOL_CALL_START, toolCallId: "c1" },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: "{}" },
    { type: EventType.TOOL_CALL_END, toolCallId: "c1" },
    { type: EventType.RUN_FINISHED },
  ] as unknown as BaseEvent[];
}

/**
 * Exactly what `turn()` must still deliver once the filter has run — spelled out
 * rather than derived from `turn()` with the same predicate the runner uses, so a
 * broken predicate cannot make the expectation agree with the bug.
 */
const KEPT_EVENT_TYPES: string[] = [
  EventType.RUN_STARTED,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.RUN_FINISHED,
];

/** A stub inner runner whose run/connect emit the given events. */
function fakeInner(events: BaseEvent[]) {
  return {
    run: vi.fn(() => of(...events)),
    connect: vi.fn(() => of(...events)),
    isRunning: vi.fn(async () => true),
    stop: vi.fn(async () => true),
  };
}

function collect(stream: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return firstValueFrom(stream.pipe(toArray()));
}

describe("isReasoningEvent", () => {
  // The forward guard: if a future @ag-ui/core adds another reasoning member,
  // this fails instead of silently leaking that frame to students.
  it("covers EVERY reasoning/thinking member the installed EventType enum defines", () => {
    const reasoningMembers = Object.values(EventType).filter((type) =>
      /REASONING|THINKING/.test(type),
    );
    expect(reasoningMembers.length).toBeGreaterThan(0);
    for (const type of reasoningMembers) {
      expect(isReasoningEvent({ type } as BaseEvent), type).toBe(true);
    }
  });

  it("leaves every non-reasoning member alone", () => {
    const others = Object.values(EventType).filter((type) => !/REASONING|THINKING/.test(type));
    for (const type of others) {
      expect(isReasoningEvent({ type } as BaseEvent), type).toBe(false);
    }
  });
});

describe("ReasoningStrippingRunner.run (the live turn)", () => {
  it("drops every reasoning frame", async () => {
    const events = turn();
    const runner = new ReasoningStrippingRunner(fakeInner(events) as unknown as AgentRunner);
    const out = await collect(runner.run(RUN_REQUEST));
    expect(out.some((event) => /REASONING|THINKING/.test(event.type))).toBe(false);
  });

  it("passes non-reasoning frames through byte-identical and in order", async () => {
    const events = turn();
    const runner = new ReasoningStrippingRunner(fakeInner(events) as unknown as AgentRunner);
    const out = await collect(runner.run(RUN_REQUEST));
    expect(out.map((event) => event.type)).toEqual(KEPT_EVENT_TYPES);
    // The very objects the inner runner emitted (never re-created or re-serialized).
    for (const event of out) expect(events).toContain(event);
  });

  it("forwards the request to the inner runner untouched", () => {
    const inner = fakeInner(turn());
    new ReasoningStrippingRunner(inner as unknown as AgentRunner).run(RUN_REQUEST);
    expect(inner.run).toHaveBeenCalledWith(RUN_REQUEST);
  });

  it("filters the legacy THINKING_* names too", async () => {
    const events = [
      ...LEGACY_THINKING_EVENT_TYPES.map((type) => ({ type, delta: "hidden" })),
      { type: EventType.RUN_FINISHED },
    ] as unknown as BaseEvent[];
    const runner = new ReasoningStrippingRunner(fakeInner(events) as unknown as AgentRunner);
    expect(await collect(runner.run(RUN_REQUEST))).toEqual([{ type: EventType.RUN_FINISHED }]);
  });
});

describe("ReasoningStrippingRunner.connect (the replay/reconnect path)", () => {
  // connect() is the SECOND way into the SSE writer — an unfiltered replay would
  // hand a student the very reasoning the run path just withheld.
  it("drops every reasoning frame and preserves the rest in order", async () => {
    const events = turn();
    const runner = new ReasoningStrippingRunner(fakeInner(events) as unknown as AgentRunner);
    const out = await collect(runner.connect(CONNECT_REQUEST));
    expect(out.some((event) => /REASONING|THINKING/.test(event.type))).toBe(false);
    expect(out.map((event) => event.type)).toEqual(KEPT_EVENT_TYPES);
    for (const event of out) expect(events).toContain(event);
  });

  it("forwards the request to the inner runner untouched", () => {
    const inner = fakeInner(turn());
    new ReasoningStrippingRunner(inner as unknown as AgentRunner).connect(CONNECT_REQUEST);
    expect(inner.connect).toHaveBeenCalledWith(CONNECT_REQUEST);
  });
});

describe("ReasoningStrippingRunner delegation", () => {
  it("delegates isRunning verbatim", async () => {
    const inner = fakeInner([]);
    const runner = new ReasoningStrippingRunner(inner as unknown as AgentRunner);
    await expect(runner.isRunning({ threadId: "t1" })).resolves.toBe(true);
    expect(inner.isRunning).toHaveBeenCalledWith({ threadId: "t1" });
  });

  it("delegates stop verbatim", async () => {
    const inner = fakeInner([]);
    const runner = new ReasoningStrippingRunner(inner as unknown as AgentRunner);
    await expect(runner.stop({ threadId: "t1" })).resolves.toBe(true);
    expect(inner.stop).toHaveBeenCalledWith({ threadId: "t1" });
  });

  it("defaults to wrapping the library's own InMemoryAgentRunner", () => {
    // No inner argument = the same runner CopilotRuntime would have built.
    expect(new ReasoningStrippingRunner().wrapped).toBeInstanceOf(InMemoryAgentRunner);
  });
});

// THE upgrade guard. `ReasoningStrippingRunner` filters by delegating METHOD BY
// METHOD, so a CopilotKit release that adds a fifth event-producing method to
// `AgentRunner` would route straight past the filter and leak reasoning to
// students. The abstract methods are TYPE-ONLY (they erase to an empty class at
// runtime — asserted below), so the installed package's type DECLARATION is the
// contract this reads.
//
// A FAILURE HERE IS NOT A TEST TO UPDATE: the decorator must wrap the new method
// before the upgrade can land.
const AGENT_RUNNER_DECLARATION = fileURLToPath(
  new URL(
    "../../../node_modules/@copilotkit/runtime/dist/v2/runtime/runner/agent-runner.d.mts",
    import.meta.url,
  ),
);

describe("AgentRunner method-list guard", () => {
  it("the installed AgentRunner declares exactly the four methods the runner wraps", () => {
    const declaration = readFileSync(AGENT_RUNNER_DECLARATION, "utf8");
    const methods = [...declaration.matchAll(/^\s*abstract\s+(\w+)\s*\(/gm)]
      .map((match) => match[1] ?? "")
      .sort();
    expect(methods).toEqual(["connect", "isRunning", "run", "stop"]);
  });

  it("carries no runtime methods of its own (why the declaration is the contract)", () => {
    expect(
      Object.getOwnPropertyNames(AgentRunner.prototype).filter((name) => name !== "constructor"),
    ).toEqual([]);
  });

  // Every decorator in the route's runner chain delegates method by method, so
  // each must implement all four itself: the stripper (a missed method leaks
  // reasoning), the failure reporter (a missed method hides failures) and the
  // tutor's snapshot runner (a missed method bypasses the replay filter).
  it.each([
    ["ReasoningStrippingRunner", ReasoningStrippingRunner],
    ["RunErrorReportingRunner", RunErrorReportingRunner],
    ["HistorySnapshotRunner", HistorySnapshotRunner],
  ])("%s implements all four itself — none inherited or missed", (_name, runner) => {
    // Private helpers may sit beside them; the four must all be OWN methods.
    expect(Object.getOwnPropertyNames(runner.prototype)).toEqual(
      expect.arrayContaining(["connect", "isRunning", "run", "stop"]),
    );
  });
});

// One pass through the REAL InMemoryAgentRunner — the runner the route hands a
// teacher and the one this decorator wraps in production. The stub-inner tests
// above prove the filter; this proves it still holds once the library's own
// buffering, run bookkeeping and `connect` replay sit in between.
describe("wrapping the real InMemoryAgentRunner", () => {
  /** The minimum of an AG-UI agent the in-memory runner drives. */
  function fakeAguiAgent(events: BaseEvent[]) {
    return {
      agentId: "fake-agent",
      messages: [],
      abortRun: () => {},
      runAgent: async (
        _input: unknown,
        subscriber: { onEvent: (payload: { event: BaseEvent }) => void },
      ) => {
        for (const event of events) subscriber.onEvent({ event });
      },
    };
  }

  it("filters BOTH the live run and the connect replay of the same thread", async () => {
    // A thread id of this run's own, since the library keys its store globally.
    const threadId = `real-inner-${crypto.randomUUID()}`;
    const runner = new ReasoningStrippingRunner(new InMemoryAgentRunner());
    const request = {
      threadId,
      agent: fakeAguiAgent(turn()),
      input: { runId: "r1", messages: [], tools: [], context: [], forwardedProps: {}, state: {} },
    } as unknown as AgentRunnerRunRequest;

    const ran = await collect(runner.run(request));
    expect(ran.some((event) => /REASONING|THINKING/.test(event.type))).toBe(false);
    // …and the answer itself still came through, so this is not an empty stream.
    expect(ran.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(true);

    // connect() replays the finished run from the library's store — the SECOND
    // path into the SSE writer, and the one a page reload takes.
    const replayed = await collect(
      runner.connect({ threadId } as unknown as AgentRunnerConnectRequest),
    );
    expect(replayed.some((event) => /REASONING|THINKING/.test(event.type))).toBe(false);
    expect(replayed.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(true);
  });
});
