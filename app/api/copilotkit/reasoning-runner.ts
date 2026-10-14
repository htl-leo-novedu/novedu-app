import type { BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";
import { filter, type Observable } from "rxjs";

// The server-side seam that keeps a thinking model's chain of thought away from
// students: reasoning must never reach the browser AT ALL (hiding it in CSS
// would still ship the text to devtools), so it is dropped here, inside the
// runtime, before anything is written to the SSE stream.
//
// AG-UI's reasoning events. The enum is the contract (never hardcode the
// strings): `@ag-ui/mastra` emits only the five REASONING_* ones, but the whole
// family is filtered — REASONING_MESSAGE_CHUNK / REASONING_ENCRYPTED_VALUE are
// the shapes another emitter may use. The legacy THINKING_* names are the one
// exception to "never hardcode": the enum no longer defines them, yet
// `@ag-ui/client` still upgrades them to REASONING_* in the browser, so a frame
// under an old name would still render as reasoning. Filtering something nobody
// emits costs nothing; missing one leaks the scratchpad.
//
// Dropping the whole START…END group SYMMETRICALLY is what keeps the browser's
// `verifyEvents` validator happy — a lone REASONING_END would be a protocol
// error. The filter also sits DOWNSTREAM of the runtime's own verifier, so it
// can never trip server-side validation either.
export const LEGACY_THINKING_EVENT_TYPES = [
  "THINKING_START",
  "THINKING_TEXT_MESSAGE_START",
  "THINKING_TEXT_MESSAGE_CONTENT",
  "THINKING_TEXT_MESSAGE_END",
  "THINKING_END",
] as const;

const REASONING_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  EventType.REASONING_START,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
  EventType.REASONING_MESSAGE_CHUNK,
  EventType.REASONING_END,
  EventType.REASONING_ENCRYPTED_VALUE,
  ...LEGACY_THINKING_EVENT_TYPES,
]);

/** True for every AG-UI event that carries (or frames) reasoning text. */
export function isReasoningEvent(event: BaseEvent): boolean {
  return REASONING_EVENT_TYPES.has(event.type);
}

/**
 * An `AgentRunner` decorator that strips every reasoning event from the two
 * paths into the SSE writer — `run` (the live turn) and `connect` (the
 * replay/reconnect stream) — and delegates `isRunning` / `stop` untouched.
 * Everything else passes through byte-identical and in order.
 *
 * FRAGILE ACROSS UPGRADES (same spirit as the welcome-screen override in
 * app/_tutor/welcome-view.tsx): it delegates METHOD BY METHOD to a 4-method
 * abstract class, so a future version that adds a fifth event-producing method
 * would bypass the filter entirely and silently leak reasoning to students. That
 * method list is GUARDED — `reasoning-runner.unit.test.ts` reads the four
 * abstract methods off the installed package's type declaration (they erase at
 * runtime) and fails when they change. Wrap the new method before upgrading.
 *
 * Note it deliberately does NOT re-expose `ɵsupportsLocalThreadEndpoints`, so
 * the runtime's local thread endpoints stay unsupported through this runner —
 * the route 404s them anyway (docs/codes.md). The `/info` runtime relies on
 * this: it is built with this runner so `/info` never advertises them.
 */
export class ReasoningStrippingRunner extends AgentRunner {
  /**
   * The runner this one filters — PUBLIC (as on `RunErrorReportingRunner`) so the
   * route's suite can assert what a student's stream is built on.
   */
  readonly wrapped: AgentRunner;

  /** Wraps a fresh `InMemoryAgentRunner` — the same default `CopilotRuntime` builds. */
  constructor(inner: AgentRunner = new InMemoryAgentRunner()) {
    super();
    this.wrapped = inner;
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    return this.wrapped.run(request).pipe(filter((event) => !isReasoningEvent(event)));
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return this.wrapped.connect(request).pipe(filter((event) => !isReasoningEvent(event)));
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return this.wrapped.isRunning(request);
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    return this.wrapped.stop(request);
  }
}
