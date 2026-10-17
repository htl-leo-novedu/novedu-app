import type { CodeModule } from "@/lib/code-modules/types";
import { collapseReplayedRuns } from "@/lib/conversation-collapse";

// Pure helpers + wire types behind the conversation export
// (`GET /api/codes/<code>/conversations` — docs/api.md). No DB, Mastra or app
// imports (only the pure collapse helper): the store (`lib/conversation-export-store.ts`)
// feeds these the rows it read; a client imports the wire TYPES only.
//
// The export carries NO identity — no user id, name or pseudonym — and image
// bytes never get here: the store's SQL already replaced every stored `file`
// part with `{ type: "file", mimeType, bytes }`.

/** The export file's format version — a future shape change bumps it. */
export const EXPORT_FORMAT = "novedu-conversations/1";

/**
 * At most this many stored user/assistant messages per conversation — the LAST
 * ones; an older remainder is cut and the conversation is marked `truncated`.
 * Pages are bounded by thread count, so this is what bounds the memory one
 * huge thread can take (the store applies it in SQL, before any content is read
 * into Node).
 */
export const MAX_MESSAGES_PER_CONVERSATION = 500;

export type ExportPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string | null; bytes: number | null }
  | { type: "tool"; name: string; args: unknown; result: unknown };

export interface ExportMessage {
  role: "user" | "assistant";
  /** ISO 8601 UTC. */
  createdAt: string;
  /** A plain string when the message is text only; otherwise its parts in stored order. */
  content: string | ExportPart[];
}

export interface ExportConversation {
  threadId: string;
  startedAt: string;
  endedAt: string;
  /** `true` when older messages were cut by `MAX_MESSAGES_PER_CONVERSATION`. */
  truncated: boolean;
  messages: ExportMessage[];
}

/** The code block every page repeats, so a client can write its header from page one. */
export interface ExportCodeBlock {
  code: string;
  module: CodeModule;
  note: string | null;
  fileUrl: string;
  anonymous: boolean;
}

export interface ConversationPageWire {
  code: ExportCodeBlock;
  conversations: ExportConversation[];
  nextCursor: string | null;
}

/** One `mastra_messages` row as the store hands it over (content already photo-stripped). */
export interface ExportRow {
  role: string;
  createdAt: Date;
  content: string;
}

interface StoredPart {
  type?: unknown;
  text?: unknown;
  mimeType?: unknown;
  bytes?: unknown;
  toolInvocation?: { toolName?: unknown; args?: unknown; result?: unknown; state?: unknown };
}

/**
 * Maps one stored row to an export message, or `null` for a role other than
 * user/assistant or content that is not JSON. `text` → text, the SQL-shaped
 * `file` → an image placeholder, Mastra's `tool-invocation` part → a `tool` part.
 * Every other part (`step-start`, `reasoning`, …) is dropped.
 */
export function toExportMessage(row: ExportRow): ExportMessage | null {
  if (row.role !== "user" && row.role !== "assistant") return null;
  let parsed: { parts?: unknown };
  try {
    parsed = JSON.parse(row.content) as { parts?: unknown };
  } catch {
    return null;
  }
  const stored = Array.isArray(parsed?.parts) ? (parsed.parts as StoredPart[]) : [];

  const parts: ExportPart[] = [];
  for (const part of stored) {
    if (part === null || typeof part !== "object") continue;
    if (part.type === "text") {
      parts.push({ type: "text", text: typeof part.text === "string" ? part.text : "" });
    } else if (part.type === "file") {
      parts.push({
        type: "image",
        mimeType: typeof part.mimeType === "string" && part.mimeType !== "" ? part.mimeType : null,
        bytes: typeof part.bytes === "number" ? part.bytes : null,
      });
    } else if (part.type === "tool-invocation" && part.toolInvocation) {
      const invocation = part.toolInvocation;
      parts.push({
        type: "tool",
        name: typeof invocation.toolName === "string" ? invocation.toolName : "",
        args: invocation.args ?? null,
        result: invocation.state === "result" ? (invocation.result ?? null) : null,
      });
    }
  }

  const createdAt = row.createdAt.toISOString();
  if (parts.every((p) => p.type === "text")) {
    return {
      role: row.role,
      createdAt,
      content: parts.map((p) => (p as { text: string }).text).join(""),
    };
  }
  return { role: row.role, createdAt, content: parts };
}

/**
 * A message's identity for `collapseReplayedRuns`: role + all text + image
 * placeholders, ignoring `createdAt` and tool parts — like the transcript
 * viewer's `messageKey` (a replayed copy never carried the tool parts).
 */
export function exportMessageKey(message: ExportMessage): string {
  const parts: ExportPart[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  const images = parts
    .filter((p) => p.type === "image")
    .map((p) => `${p.mimeType}:${p.bytes}`)
    .join(",");
  return `${message.role} ${text} ${images}`;
}

/**
 * Assembles one conversation from its thread's rows (in stored order). The
 * store reads at most `MAX_MESSAGES_PER_CONVERSATION + 1` rows per thread, so
 * more than MAX rows means the conversation was cut: only the last MAX are kept
 * and it is marked `truncated`. Then: map, collapse the replayed history, and
 * keep it only if a user message survives (a truncated one always stays — it
 * qualified as a whole in SQL). `startedAt`/`endedAt` are the first/last kept
 * message timestamps.
 */
export function buildConversation(threadId: string, rows: ExportRow[]): ExportConversation | null {
  const truncated = rows.length > MAX_MESSAGES_PER_CONVERSATION;
  const kept = truncated ? rows.slice(-MAX_MESSAGES_PER_CONVERSATION) : rows;
  const mapped = kept.map(toExportMessage).filter((m): m is ExportMessage => m !== null);
  const messages = collapseReplayedRuns(mapped, exportMessageKey);
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (!first || !last) return null;
  if (!truncated && !messages.some((m) => m.role === "user")) return null;
  return { threadId, startedAt: first.createdAt, endedAt: last.createdAt, truncated, messages };
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * The paging position: the last thread of the previous page. `createdAt` is the
 * EXACT text of `mastra_threads."createdAt"` (a naive microsecond timestamp,
 * rendered by the store's `to_char`), never a JS Date — a Date round-trip would
 * shift it by the server's timezone and drop the microseconds, so a page could
 * skip or repeat threads.
 */
export interface Cursor {
  createdAt: string;
  id: string;
}

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
// Thread ids are server-generated UUIDs — the same guard as THREAD_ID_PATTERN in
// lib/thread-token.ts, copied because this module is CLI-bundled and must not pull
// in the server-only token module.
const THREAD_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]{1,200}$/;

/** Opaque base64url of `<createdAt>|<threadId>`. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url");
}

/**
 * Decodes and validates a client-supplied cursor; `null` when malformed. A
 * forged cursor can only move the walk WITHIN the same code — the code is a
 * separate `WHERE` clause.
 */
export function decodeCursor(value: string): Cursor | null {
  if (!BASE64URL.test(value)) return null;
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const [createdAt, id, ...rest] = decoded.split("|");
  if (rest.length > 0 || createdAt === undefined || id === undefined) return null;
  if (!CURSOR_TIMESTAMP.test(createdAt) || !THREAD_ID_PATTERN.test(id)) return null;
  return { createdAt, id };
}
