import type { Message } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  collapseReplayedRuns,
  toAguiChatMessages,
  toAguiMessage,
} from "@/lib/conversation-collapse";

// Pure helpers behind the conversation viewer (lib/code-stats-store.ts). The
// end-to-end "getConversationMessages collapses replays" test lives in the
// store's test; here we pin the pure logic directly.

describe("collapseReplayedRuns", () => {
  const u = (text: string): Message => ({ id: crypto.randomUUID(), role: "user", content: text });
  const a = (text: string): Message => ({
    id: crypto.randomUUID(),
    role: "assistant",
    content: text,
  });

  it("returns short conversations untouched", () => {
    expect(collapseReplayedRuns([])).toEqual([]);
    const one = [u("hi")];
    expect(collapseReplayedRuns(one)).toBe(one);
  });

  it("leaves a clean (non-telescoping) conversation unchanged", () => {
    const messages = [u("hi"), a("hello"), u("more"), a("sure")];
    const result = collapseReplayedRuns(messages);
    expect(result.map((m) => m.content)).toEqual(["hi", "hello", "more", "sure"]);
  });

  it("collapses telescoping replays to the final, complete run", () => {
    // Each run re-sends the whole prefix then appends one new turn — the shape
    // Mastra persists.
    const messages = [
      // run 1
      u("hi"),
      a("hello"),
      // run 2 (re-sends hi/hello, adds turn 2)
      u("hi"),
      a("hello"),
      u("q2"),
      a("ans2"),
      // run 3 (re-sends all, adds turn 3)
      u("hi"),
      a("hello"),
      u("q2"),
      a("ans2"),
      u("q3"),
      a("ans3"),
    ];
    const result = collapseReplayedRuns(messages);
    expect(result.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:hi",
      "assistant:hello",
      "user:q2",
      "assistant:ans2",
      "user:q3",
      "assistant:ans3",
    ]);
  });

  it("preserves a genuinely retyped opening line (not a prefix of the next run)", () => {
    // The student literally retypes the first message mid-conversation. Because
    // the second 'run' is NOT a prefix of anything after it, no content is lost.
    const messages = [u("start"), a("ok"), u("start"), a("again")];
    const result = collapseReplayedRuns(messages);
    expect(result.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:start",
      "assistant:ok",
      "user:start",
      "assistant:again",
    ]);
  });

  it("collapses replays even when the final run is missing its last reply", () => {
    const messages = [
      u("hi"),
      a("hello"),
      // final run re-sends the prefix and ends on an unanswered user turn
      u("hi"),
      a("hello"),
      u("pending"),
    ];
    const result = collapseReplayedRuns(messages);
    expect(result.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:hi",
      "assistant:hello",
      "user:pending",
    ]);
  });

  it("dedupes on rendered content, ignoring differing ids", () => {
    const messages: Message[] = [
      { id: "x1", role: "user", content: "hi" },
      { id: "x2", role: "assistant", content: "hello" },
      { id: "y1", role: "user", content: "hi" },
      { id: "y2", role: "assistant", content: "hello" },
      { id: "y3", role: "user", content: "next" },
    ];
    const result = collapseReplayedRuns(messages);
    expect(result.map((m) => m.content)).toEqual(["hi", "hello", "next"]);
  });
});

describe("toAguiMessage", () => {
  const row = (id: string, role: string, content: unknown) => ({
    id,
    role,
    content: JSON.stringify(content),
  });

  it("rebuilds text from parts and preserves the row id", () => {
    expect(
      toAguiMessage(row("m1", "user", { parts: [{ type: "text", text: "Hi" }], content: "Hi" })),
    ).toEqual({ id: "m1", role: "user", content: "Hi" });
  });

  it("maps a file part to an inline image and skips non-chat roles / bad JSON", () => {
    const dataUrl = "data:image/png;base64,AAAA";
    expect(toAguiMessage(row("m1", "user", { parts: [{ type: "file", data: dataUrl }] }))).toEqual({
      id: "m1",
      role: "user",
      content: [{ type: "image", source: { type: "url", value: dataUrl } }],
    });
    expect(toAguiMessage(row("s", "system", { parts: [{ type: "text", text: "x" }] }))).toBeNull();
    expect(toAguiMessage({ id: "bad", role: "user", content: "not json{" })).toBeNull();
  });
});

describe("toAguiChatMessages (the tutor chat snapshot)", () => {
  const steps = { steps: [{ op: "board", id: "b", title: "B" }] };
  const invocation = (id: string, result: unknown, toolName = "board") => ({
    type: "tool-invocation",
    toolInvocation: { state: "result", toolCallId: id, toolName, args: steps, result },
  });
  const row = (parts: unknown[]) => ({
    id: "m1",
    role: "assistant",
    content: JSON.stringify({ format: 2, parts }),
  });

  it("keeps a plain reply as one text message", () => {
    expect(toAguiChatMessages(row([{ type: "text", text: "Hi" }]))).toEqual([
      { id: "m1", role: "assistant", content: "Hi" },
    ]);
    expect(
      toAguiChatMessages({
        id: "u1",
        role: "user",
        content: JSON.stringify({ parts: [{ type: "text", text: "Q" }] }),
      }),
    ).toEqual([{ id: "u1", role: "user", content: "Q" }]);
  });

  it("carries successful board calls in the live shape: calls, results, then the text", () => {
    const messages = toAguiChatMessages(
      row([
        invocation("c1", { ok: false, errors: ["x"] }),
        invocation("c2", { ok: true, board: "board b (grid): empty" }),
        invocation("c3", { value: 4 }, "random_number"),
        { type: "step-start" },
        { type: "text", text: "Look at the board." },
      ]),
    );
    expect(messages).toEqual([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [
          {
            id: "c2",
            type: "function",
            function: { name: "board", arguments: JSON.stringify(steps) },
          },
        ],
      },
      {
        id: "c2-result",
        role: "tool",
        toolCallId: "c2",
        content: JSON.stringify({ ok: true, board: "board b (grid): empty" }),
      },
      { id: "m1-agui-text", role: "assistant", content: "Look at the board." },
    ]);
  });

  it("keeps text written before the drawing above it, and separates later segments", () => {
    const messages = toAguiChatMessages(
      row([
        { type: "text", text: "Let me draw it." },
        invocation("c1", { ok: true, board: "" }),
        { type: "text", text: "Here it is." },
        invocation("c2", { ok: true, board: "" }),
        { type: "text", text: "Now highlighted." },
      ]),
    );
    expect(messages[0]).toMatchObject({ id: "m1", content: "Let me draw it." });
    expect(messages.at(-1)).toEqual({
      id: "m1-agui-text",
      role: "assistant",
      content: "Here it is.\n\nNow highlighted.",
    });
  });

  it("returns nothing for an unreadable row", () => {
    expect(toAguiChatMessages({ id: "x", role: "assistant", content: "not json" })).toEqual([]);
  });
});
