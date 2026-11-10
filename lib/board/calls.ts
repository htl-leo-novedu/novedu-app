// Finding the thread's successful `board` calls in a message list — on the
// server in Mastra's stored messages (the executor's prior calls), in the
// browser in the chat's AG-UI messages (the board pane). Both shapes are read
// loosely: anything unexpected is skipped, never thrown. Pure, no imports of
// Mastra or AG-UI types.

/** The tool's name, as in the tutor-tool catalog. */
export const BOARD_TOOL_NAME = "board";

/** One successful board call: its tool-call id and its input. */
export interface BoardCall {
  id: string;
  input: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a tool result says the call was applied (`{ok: true, …}`), also as a JSON string. */
export function isAppliedResult(result: unknown): boolean {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return isObject(value) && value.ok === true;
}

/** An applied board call in one stored message part (`tool-invocation`), or null. */
export function appliedBoardInvocation(
  part: unknown,
): { id: string; input: unknown; result: unknown } | null {
  if (!isObject(part) || part.type !== "tool-invocation") return null;
  const inv = part.toolInvocation;
  if (!isObject(inv) || inv.toolName !== BOARD_TOOL_NAME || inv.state !== "result") return null;
  if (typeof inv.toolCallId !== "string" || !isAppliedResult(inv.result)) return null;
  return { id: inv.toolCallId, input: inv.args, result: inv.result };
}

/**
 * Successful board calls in stored Mastra messages (the v2 envelope: assistant
 * `content.parts` holding `tool-invocation` parts with `state: "result"`), in
 * message order, deduplicated by tool-call id.
 */
export function boardCallsFromStored(
  messages: readonly { role?: unknown; content?: unknown }[],
): BoardCall[] {
  const calls: BoardCall[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    let content = message.content;
    if (typeof content === "string") {
      try {
        content = JSON.parse(content);
      } catch {
        continue;
      }
    }
    const parts = isObject(content) && Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      const call = appliedBoardInvocation(part);
      if (!call || seen.has(call.id)) continue;
      seen.add(call.id);
      calls.push({ id: call.id, input: call.input });
    }
  }
  return calls;
}

/**
 * Successful board calls in an AG-UI message list (assistant `toolCalls` with
 * JSON-string arguments, answered by `tool` messages carrying the result), in
 * call order. A call without a result yet, or with a rejected one, is skipped.
 */
export function boardCallsFromAgui(messages: readonly unknown[]): BoardCall[] {
  const results = new Map<string, unknown>();
  for (const m of messages) {
    if (isObject(m) && m.role === "tool" && typeof m.toolCallId === "string") {
      results.set(m.toolCallId, m.content);
    }
  }
  const calls: BoardCall[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (!isObject(m) || m.role !== "assistant" || !Array.isArray(m.toolCalls)) continue;
    for (const call of m.toolCalls) {
      if (!isObject(call) || typeof call.id !== "string" || seen.has(call.id)) continue;
      const fn = call.function;
      if (!isObject(fn) || fn.name !== BOARD_TOOL_NAME) continue;
      if (!results.has(call.id) || !isAppliedResult(results.get(call.id))) continue;
      let input: unknown;
      try {
        input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
      } catch {
        continue;
      }
      seen.add(call.id);
      calls.push({ id: call.id, input });
    }
  }
  return calls;
}

/** The chat marker under a reply that changed the board. */
export type BoardPillLabel = "Drew on the board" | "Changed the board";

/**
 * Which tool calls show the chat marker: per assistant message, only its last
 * applied board call (several calls in one reply show one marker), labelled
 * "Drew on the board" when the message holds the thread's first applied call,
 * "Changed the board" otherwise. Rejected calls never show one.
 */
export function boardPillLabels(messages: readonly unknown[]): Map<string, BoardPillLabel> {
  const applied = boardCallsFromAgui(messages);
  const order = new Map(applied.map((c, i) => [c.id, i]));
  const labels = new Map<string, BoardPillLabel>();
  for (const m of messages) {
    if (!isObject(m) || m.role !== "assistant" || !Array.isArray(m.toolCalls)) continue;
    const ids = m.toolCalls
      .map((call) => (isObject(call) && typeof call.id === "string" ? call.id : ""))
      .filter((id) => order.has(id));
    const last = ids.at(-1);
    if (last === undefined) continue;
    const first = Math.min(...ids.map((id) => order.get(id) ?? 0));
    labels.set(last, first === 0 ? "Drew on the board" : "Changed the board");
  }
  return labels;
}
