import type { Message } from "@ag-ui/core";
import { appliedBoardInvocation, BOARD_TOOL_NAME } from "@/lib/board/calls";

// Pure helpers for turning stored Mastra messages into AG-UI messages and for
// collapsing the "replayed history" duplicates. No DB or Mastra imports, so the
// conversation viewer (`lib/code-stats-store.ts`) can render a clean transcript
// from rows that hold telescoped replays. See docs/codes.md ("Only the new
// turn is persisted").

// A stored Mastra message: the v2 UIMessage envelope. The top-level `content`
// string is sometimes absent, so the text is rebuilt from `parts` instead.
export interface StoredMessageContent {
  parts?: Array<
    | { type: "text"; text?: string }
    // Image attachments are stored as a `file` part whose `data` is a data: URL.
    | { type: "file"; data?: string; url?: string }
    | { type: string; [key: string]: unknown }
  >;
}

// Turns one stored row into the AG-UI message the chat renderer consumes. Text
// is concatenated from all text parts; image (`file`) parts become AG-UI image
// parts so the teacher sees the same attachments the student sent. Assistant
// messages are plain text: a tutor granted `tools:` stores `tool-invocation`
// parts too, which this viewer drops (the conversation export keeps them —
// `lib/conversation-export.ts`). The row `id` is preserved as the message id (the cleanup script relies on this to
// map a kept/dropped message back to its `mastra_messages.id`).
export function toAguiMessage(row: { id: string; role: string; content: string }): Message | null {
  let parsed: StoredMessageContent;
  try {
    parsed = JSON.parse(row.content) as StoredMessageContent;
  } catch {
    return null;
  }
  const parts = parsed.parts ?? [];
  const text = parts
    .filter((p): p is { type: "text"; text?: string } => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");

  if (row.role === "assistant") {
    return { id: row.id, role: "assistant", content: text };
  }
  if (row.role === "user") {
    const images = parts
      .filter((p): p is { type: "file"; data?: string; url?: string } => p.type === "file")
      .map((p) => p.data ?? p.url)
      .filter((src): src is string => typeof src === "string");
    if (images.length === 0) {
      return { id: row.id, role: "user", content: text };
    }
    // Mixed content: the text plus each attached image, rendered inline. The
    // data: URL goes in straight as a URL source (an <img src> renders it).
    return {
      id: row.id,
      role: "user",
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...images.map((value) => ({
          type: "image" as const,
          source: { type: "url" as const, value },
        })),
      ],
    };
  }
  // Any other role (system/developer/tool) is not part of a tutor chat — skip.
  return null;
}

// `@ag-ui/mastra`'s id for assistant text streamed after a tool call within one
// reply; the snapshot reuses it so the restored list has the live shape.
const TEXT_CONTINUATION_SUFFIX = "-agui-text";

/**
 * The tutor chat's view of one stored row (the `connect` snapshot, never a
 * teacher view): like `toAguiMessage`, but an assistant reply that drew on the
 * board also carries its SUCCESSFUL `board` calls, in the shape the live stream
 * produced — an assistant message with the `toolCalls` (under the row id), one
 * `tool` message per result, then the text written after the drawing under
 * `<id>-agui-text` (text before it stays on the first message). The
 * browser rebuilds the board from that list exactly as it does live
 * (docs/tutor-board.md). Other tools and rejected board calls stay dropped.
 */
export function toAguiChatMessages(row: { id: string; role: string; content: string }): Message[] {
  const message = toAguiMessage(row);
  if (!message) return [];
  if (row.role !== "assistant") return [message];
  let parts: StoredMessageContent["parts"];
  try {
    parts = (JSON.parse(row.content) as StoredMessageContent).parts;
  } catch {
    return [message];
  }
  // Text before the first drawing stays on the message that carries the calls
  // (above the marker, as live); text after it moves below, segments split by a
  // tool call kept apart as paragraphs.
  const calls: { id: string; input: unknown; result: unknown }[] = [];
  const before: string[] = [];
  const after: string[][] = [[]];
  for (const part of parts ?? []) {
    const call = appliedBoardInvocation(part);
    if (call) calls.push(call);
    if (part.type === "tool-invocation") {
      if (calls.length && (after.at(-1)?.length ?? 0) > 0) after.push([]);
      continue;
    }
    if (part.type !== "text") continue;
    const text = (part as { text?: string }).text ?? "";
    if (calls.length) after.at(-1)?.push(text);
    else before.push(text);
  }
  if (calls.length === 0) return [message];
  const beforeText = before.join("");
  const afterText = after
    .map((segment) => segment.join(""))
    .filter(Boolean)
    .join("\n\n");
  const out: Message[] = [
    {
      id: row.id,
      role: "assistant",
      ...(beforeText ? { content: beforeText } : {}),
      toolCalls: calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: BOARD_TOOL_NAME, arguments: JSON.stringify(c.input ?? {}) },
      })),
    },
    ...calls.map(
      (c): Message => ({
        id: `${c.id}-result`,
        role: "tool",
        toolCallId: c.id,
        content: JSON.stringify(c.result),
      }),
    ),
  ];
  if (afterText) {
    out.push({ id: `${row.id}${TEXT_CONTINUATION_SUFFIX}`, role: "assistant", content: afterText });
  }
  return out;
}

// A stable identity for a message, by what the viewer actually shows: its role
// and rendered content (text, or text + image sources). Deliberately ignores
// `id`/`createdAt` — the replayed copies differ in exactly those.
export function messageKey(message: Message): string {
  const content = message.content as unknown;
  if (typeof content === "string") return `${message.role} ${content}`;
  if (Array.isArray(content)) {
    const parts = content.map((raw) => {
      const part = raw as { type?: string; text?: string; source?: { value?: string } };
      if (part.type === "text") return `t:${part.text ?? ""}`;
      if (part.type === "image") return `i:${part.source?.value ?? ""}`;
      return part.type ?? "";
    });
    return `${message.role} ${parts.join("")}`;
  }
  return `${message.role} `;
}

/**
 * Collapses the replayed history in a stored conversation so each turn shows
 * once. CopilotKit/AG-UI re-sends the entire conversation on every run, and
 * older conversations — recorded when Mastra stored that re-sent history under
 * fresh ids — hold the history many times over: a
 * sequence of telescoping "runs" `R1 ⊂ R2 ⊂ … ⊂ Rk`, each re-sending the whole
 * prefix and appending one new turn. `Rk` is the full, correct conversation.
 *
 * Runs are delimited by the recurrence of the FIRST message (every full-history
 * replay begins with it). A run is dropped only when it is an exact
 * element-wise prefix of the run that follows it — so genuinely different
 * content (e.g. a student who retypes the opening line) is preserved, and a
 * clean conversation with no replay collapses to itself unchanged.
 */
export function collapseReplayedRuns(messages: Message[]): Message[];
// The same collapse over any message shape, with the caller's content identity
// (the conversation export passes `exportMessageKey`).
export function collapseReplayedRuns<T>(messages: T[], keyOf: (message: T) => string): T[];
export function collapseReplayedRuns<T>(
  messages: T[],
  keyOf: (message: T) => string = messageKey as (message: T) => string,
): T[] {
  const first = messages[0];
  if (first === undefined || messages.length <= 1) return messages;

  const firstKey = keyOf(first);
  // Split into runs at each recurrence of the first message.
  const runs: T[][] = [];
  let current: T[] = [];
  for (const message of messages) {
    if (current.length > 0 && keyOf(message) === firstKey) {
      runs.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) runs.push(current);
  if (runs.length <= 1) return messages;

  const isPrefixOf = (shorter: T[], longer: T[]): boolean => {
    if (shorter.length > longer.length) return false;
    return shorter.every((m, i) => {
      const other = longer[i];
      return other !== undefined && keyOf(m) === keyOf(other);
    });
  };

  // Drop any run wholly contained (as a prefix) in the run that follows it —
  // those are the telescoping replays. Whatever survives is concatenated in
  // order; a non-telescoping conversation keeps all its runs untouched.
  const kept = runs.filter((run, i) => {
    const next = runs[i + 1];
    return !(next && isPrefixOf(run, next));
  });
  return kept.flat();
}
