import { describe, expect, it } from "vitest";
import { buildClozeFeedbackMessage } from "@/lib/cloze-feedback-prompt";
import { buildClozeGradingMessage } from "@/lib/cloze-grading-prompt";
import { defaultReply, fakeReply } from "./markers.mjs";

// The fake LLM's rule table (fake-llm/markers.mjs, docs/testing.md "Fake LLM").
// aimock's matching and wire format are not re-tested — only which response
// object each request maps to.

const user = (content: unknown) => ({ role: "user", content });

const chat = (text: string, extra: Record<string, unknown> = {}) => ({
  model: "gemma",
  messages: [{ role: "system", content: "You are a tutor." }, user(text)],
  ...extra,
});

const GRADER_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "verdict",
    schema: { type: "object", properties: { result: {}, feedback: {} } },
  },
};

const JUDGE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "judge", schema: { type: "object", properties: { issues: {} } } },
};

describe("fakeReply", () => {
  it("answers anything unmarked with the default echo", () => {
    expect(fakeReply(chat("Hello there"))).toEqual({
      content: "This reply comes from Novedu's fake LLM, not a real model. You wrote: Hello there",
    });
  });

  it("cuts the echo to the first 80 characters of the last user message", () => {
    const long = "x".repeat(100);
    expect(defaultReply(long)).toBe(
      `This reply comes from Novedu's fake LLM, not a real model. You wrote: ${"x".repeat(80)}`,
    );
  });

  it("reads only the last user message", () => {
    const request = {
      model: "gemma",
      messages: [user("[reply:old]"), { role: "assistant", content: "old" }, user("new")],
    };
    expect(fakeReply(request)).toEqual({ content: defaultReply("new") });
  });

  it("joins the text parts of a multimodal message", () => {
    const parts = [
      { type: "text", text: "What is " },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
      { type: "text", text: "this?" },
    ];
    expect(fakeReply({ model: "gemma", messages: [user(parts)] })).toEqual({
      content: defaultReply("What is this?"),
    });
  });

  it("fails a model id containing no-such-model with a 404", () => {
    expect(fakeReply({ ...chat("[reply:ignored]"), model: "novedu-e2e-no-such-model" })).toEqual({
      status: 404,
      error: { message: "model not found", type: "invalid_request_error", code: "model_not_found" },
    });
  });

  describe("structured output", () => {
    it("grades a grader request correct without a marker", () => {
      expect(fakeReply(chat("Vienna", { response_format: GRADER_FORMAT }))).toEqual({
        content: JSON.stringify({ result: "correct", feedback: "Fake LLM verdict: correct." }),
      });
    });

    it.each(["correct", "partial", "incorrect"])("grades [grade:%s] as that verdict", (result) => {
      expect(
        fakeReply(chat(`[grade:${result}] Vienna`, { response_format: GRADER_FORMAT })),
      ).toEqual({
        content: JSON.stringify({ result, feedback: `Fake LLM verdict: ${result}.` }),
      });
    });

    it("refuses any other json_schema request with a 400", () => {
      expect(fakeReply(chat("[grade:partial]", { response_format: JUDGE_FORMAT }))).toEqual({
        status: 400,
        error: {
          message: "fake LLM: no fixture for this structured request",
          type: "invalid_request_error",
        },
      });
    });
  });

  describe("tools", () => {
    it("calls the named tool with {} when the marker has no arguments", () => {
      expect(fakeReply(chat("[tool:getCurrentText] read my draft"))).toEqual({
        toolCalls: [{ name: "getCurrentText", arguments: "{}" }],
      });
    });

    it("passes the marker's JSON arguments through", () => {
      expect(fakeReply(chat('[tool:random_number {"min":100000,"max":999999}] go'))).toEqual({
        toolCalls: [{ name: "random_number", arguments: '{"min":100000,"max":999999}' }],
      });
    });

    it("falls through to the default reply on malformed JSON arguments", () => {
      const text = '[tool:random_number {"min":}] go';
      expect(fakeReply(chat(text))).toEqual({ content: defaultReply(text) });
    });

    it("echoes the tool result once the tool has answered", () => {
      const request = {
        model: "gemma",
        messages: [
          user("[tool:getCurrentText]"),
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "getCurrentText", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "My draft text" },
        ],
      };
      expect(fakeReply(request)).toEqual({
        content: "Fake LLM received the tool result: My draft text",
      });
    });

    it("ignores tool results from before the last user message", () => {
      const request = {
        model: "gemma",
        messages: [
          user("[tool:getCurrentText]"),
          { role: "tool", tool_call_id: "c1", content: "earlier" },
          { role: "assistant", content: "done" },
          user("[tool:getCurrentText] again"),
        ],
      };
      expect(fakeReply(request)).toEqual({
        toolCalls: [{ name: "getCurrentText", arguments: "{}" }],
      });
    });
  });

  it("adds [reasoning:…] as reasoning before the default reply", () => {
    const text = "[reasoning:Let me think.] Why is the sky blue?";
    expect(fakeReply(chat(text))).toEqual({
      reasoning: "Let me think.",
      content: defaultReply(text),
    });
  });

  it("answers [reply:…] with exactly that text", () => {
    expect(fakeReply(chat("[reply:Exactly this.] ignored"))).toEqual({ content: "Exactly this." });
  });

  it("applies the first matching rule when markers combine", () => {
    expect(fakeReply(chat("[reply:x] [reasoning:y] [tool:getCurrentText]"))).toEqual({
      toolCalls: [{ name: "getCurrentText", arguments: "{}" }],
    });
    expect(fakeReply(chat("[reply:x] [reasoning:y]"))).toEqual({
      reasoning: "y",
      content: defaultReply("[reply:x] [reasoning:y]"),
    });
  });
});

// The two cloze calls, driven by the REAL user-message builders so the fake parses
// exactly what the app sends (lib/cloze-grading-prompt.ts, lib/cloze-feedback-prompt.ts).
describe("fakeReply — cloze", () => {
  const format = (properties: Record<string, unknown>) => ({
    type: "json_schema",
    json_schema: { name: "cloze", schema: { type: "object", properties } },
  });
  const GRADING = format({ gaps: {} });
  const FEEDBACK = format({ patterns: {}, gap_notes: {} });
  const parse = (reply: unknown) => JSON.parse((reply as { content: string }).content);

  it("grades every listed gap: a marker picks the verdict, else incorrect; omit drops it", () => {
    const message = buildClozeGradingMessage([
      { gap: 2, answer: "will" },
      { gap: 4, answer: "am meeting [grade:partial]" },
      { gap: 5, answer: "[grade:omit]" },
    ]);
    expect(parse(fakeReply(chat(message, { response_format: GRADING })))).toEqual({
      gaps: [
        { gap: 2, result: "incorrect", reason: "Fake LLM reason for gap 2." },
        { gap: 4, result: "partial", reason: "Fake LLM reason for gap 4." },
      ],
    });
  });

  it("explains: one pattern over two or more non-correct gaps and a note each", () => {
    const message = buildClozeFeedbackMessage([
      { gap: 1, answer: "will", verdict: "incorrect" },
      { gap: 2, answer: "starts", verdict: "correct" },
      { gap: 3, answer: "", verdict: "partial" },
    ]);
    expect(parse(fakeReply(chat(message, { response_format: FEEDBACK })))).toEqual({
      patterns: [
        {
          title: "Fake LLM pattern",
          explanation: "Fake LLM explanation for gaps 1, 3.",
          gaps: [1, 3],
          next_time: "Fake LLM tip for next time.",
        },
      ],
      gap_notes: [
        { gap: 1, note: "Fake LLM note for gap 1." },
        { gap: 3, note: "Fake LLM note for gap 3." },
      ],
    });
  });

  it("returns no pattern for a single non-correct gap", () => {
    const message = buildClozeFeedbackMessage([{ gap: 1, answer: "x", verdict: "incorrect" }]);
    expect(parse(fakeReply(chat(message, { response_format: FEEDBACK })))).toMatchObject({
      patterns: [],
    });
  });

  it("fails the feedback call on [explain:fail]", () => {
    const message = buildClozeFeedbackMessage([
      { gap: 1, answer: "[explain:fail]", verdict: "incorrect" },
    ]);
    expect(fakeReply(chat(message, { response_format: FEEDBACK }))).toMatchObject({ status: 500 });
  });
});
