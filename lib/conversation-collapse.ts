import type { Message } from "@ag-ui/core";

// Pure helpers for turning stored Mastra messages into AG-UI messages and for
// collapsing the "replayed history" duplicates. No DB or Mastra imports, so the
// conversation viewer (`lib/code-stats-store.ts`) can render a clean transcript
// from rows that hold telescoped replays. See docs/tutor-codes.md ("Only the new
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

// A stable identity for a message, by what the viewer actually shows: its role
// and rendered content (text, or text + image sources). Deliberately ignores
// `id`/`createdAt` — the replayed copies differ in exactly those.
function messageKey(message: Message): string {
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
