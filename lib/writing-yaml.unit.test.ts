import { describe, expect, it } from "vitest";
import { parseWriting, toPublicWriting } from "@/lib/writing-yaml";

// The lenient writing YAML parser (mirrors lib/quiz-yaml's parser) and the
// client-safe projection. The parser requires only `llm.model` + `instructions`;
// everything else is optional, and `anonymous` DEFAULTS to FALSE — the writing
// divergence from the app-wide anonymous-by-default. `toPublicWriting` must drop
// every server-only field (the teacher's instructions, the model, the flag).

const VALID = `
id: essay-feedback
name: "Persuasive Essay Feedback"
title: "Write your persuasive essay"
description: |
  Draft your essay on the left.
anonymous: false
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
instructions: |
  You are a writing coach. Use getCurrentText to read the draft.
placeholder: "Start here…"
`;

describe("parseWriting", () => {
  it("parses a complete writing activity", () => {
    const result = parseWriting(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const w = result.writing;
    expect(w.id).toBe("essay-feedback");
    expect(w.name).toBe("Persuasive Essay Feedback");
    expect(w.title).toBe("Write your persuasive essay");
    expect(w.description).toContain("Draft your essay");
    expect(w.anonymous).toBe(false);
    expect(w.model).toBe("RedHatAI/gemma-4-31B-it-FP8-Dynamic");
    expect(w.instructions).toContain("writing coach");
    expect(w.placeholder).toBe("Start here…");
  });

  it("is lenient — only llm.model and instructions are required", () => {
    const result = parseWriting(`
llm:
  model: m
instructions: Give feedback.
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const w = result.writing;
    // The optional fields fall back to sensible defaults / undefined.
    expect(w.id).toBe("writing");
    expect(w.name).toBe("writing");
    expect(w.title).toBeUndefined();
    expect(w.description).toBeUndefined();
    expect(w.placeholder).toBeUndefined();
  });

  it("DEFAULTS anonymous to FALSE when omitted (the writing divergence)", () => {
    const result = parseWriting(`
llm:
  model: m
instructions: Give feedback.
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.writing.anonymous).toBe(false);
  });

  it("honours an explicit anonymous: true", () => {
    const result = parseWriting(`
anonymous: true
llm:
  model: m
instructions: Give feedback.
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.writing.anonymous).toBe(true);
  });

  // The shared prefix (YAML, llm.model/provider/reasoning) is covered by
  // lib/activity-load.unit.test.ts; this proves the wiring and the noun.
  it("carries the llm block and names itself in an llm failure", () => {
    const pinned = parseWriting(
      "llm:\n  model: m\n  provider: OpenRouter\n  reasoning: high\ninstructions: Coach.\n",
    );
    expect(pinned.ok && pinned.writing).toMatchObject({
      model: "m",
      provider: "OpenRouter",
      reasoning: "high",
    });
    expect(parseWriting("instructions: Coach.\n")).toEqual({
      ok: false,
      message: "This writing activity does not specify a model (llm.model).",
    });
  });

  it("rejects an activity without instructions", () => {
    expect(parseWriting("llm:\n  model: m\n")).toEqual({
      ok: false,
      message: "This writing activity has no instructions for the assistant.",
    });
  });
});

describe("toPublicWriting", () => {
  it("STRIPS the teacher instructions, the model, and the anonymous flag", () => {
    const result = parseWriting(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pub = toPublicWriting(result.writing);
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain("writing coach"); // instructions must not leak
    expect(serialized).not.toContain("gemma"); // model must not leak
    expect(pub).not.toHaveProperty("instructions");
    expect(pub).not.toHaveProperty("model");
    expect(pub).not.toHaveProperty("anonymous");
    // It carries only the student-facing fields.
    expect(pub).toEqual({
      title: "Write your persuasive essay",
      description: expect.stringContaining("Draft your essay"),
      placeholder: "Start here…",
    });
  });
});
