import { describe, expect, it } from "vitest";
import { parseCoding } from "@/lib/coding-yaml";

// The lenient coding YAML parser (mirrors lib/writing-yaml's parser). It requires
// only `llm.model` + `instructions`; everything else is optional. There is no
// `anonymous` field — a coding activity is always anonymous. (Parsing a full
// on-disk sample is covered by the CLI validate test over test-fixtures/.)

const VALID = `
id: beginner-typescript
name: "Beginner TypeScript Coding Buddy"
title: "TypeScript Coding Buddy (Beginners)"
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
instructions: |
  You are a friendly TypeScript coding buddy. Use only primitive types.
`;

describe("parseCoding", () => {
  it("parses a complete coding activity", () => {
    const result = parseCoding(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const c = result.coding;
    expect(c.title).toBe("TypeScript Coding Buddy (Beginners)");
    expect(c.model).toBe("RedHatAI/gemma-4-31B-it-FP8-Dynamic");
    expect(c.instructions).toContain("primitive types");
  });

  it("is lenient — only llm.model and instructions are required", () => {
    const result = parseCoding("llm:\n  model: m\ninstructions: Help.\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.coding.title).toBeUndefined();
  });

  // The shared prefix (YAML, llm.model/provider/reasoning) is covered by
  // lib/activity-load.unit.test.ts; this proves the wiring and the noun.
  it("carries the llm block and names itself in an llm failure", () => {
    const pinned = parseCoding(
      "llm:\n  model: m\n  provider: OpenRouter\n  reasoning: high\ninstructions: Help.\n",
    );
    expect(pinned.ok && pinned.coding).toMatchObject({
      model: "m",
      provider: "OpenRouter",
      reasoning: "high",
    });
    expect(parseCoding("instructions: Help.\n")).toEqual({
      ok: false,
      message: "This coding activity does not specify a model (llm.model).",
    });
  });

  it("rejects an activity without instructions", () => {
    expect(parseCoding("llm:\n  model: m\n")).toEqual({
      ok: false,
      message: "This coding activity has no instructions for the assistant.",
    });
  });
});
