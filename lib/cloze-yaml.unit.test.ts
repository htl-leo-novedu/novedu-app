import { describe, expect, it } from "vitest";
import { splitOnClozeGaps } from "@/lib/cloze-types";
import { parseCloze, toPublicCloze } from "@/lib/cloze-yaml";

// The LENIENT runtime parse (the student path) and the public projection — above
// all the guard that no server-only field (reference answers, `evaluation`,
// `instructions`, the `llm` block) ever reaches the browser.

const VALID = `
id: future-forms
name: Teacher label
title: "Sue's fresh start"
description: Complete the text.
llm:
  model: secret-model
  provider: SCCH
  reasoning: low
instructions: SECRET-PREAMBLE
evaluation: SECRET-RUBRIC
text: |
  ## A plan

  She [[REF-ONE]] start. The class [[REF-TWO|start]] at nine.
`;

describe("parseCloze", () => {
  it("reads the essentials, the gaps and the server-only fields", () => {
    const result = parseCloze(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cloze).toMatchObject({
      id: "future-forms",
      title: "Sue's fresh start",
      model: "secret-model",
      provider: "SCCH",
      reasoning: "low",
      instructions: "SECRET-PREAMBLE",
      instructionsPreamble: "",
      evaluation: "SECRET-RUBRIC",
    });
    expect(result.cloze.gaps.map(({ reference, hint }) => ({ reference, hint }))).toEqual([
      { reference: "REF-ONE", hint: undefined },
      { reference: "REF-TWO", hint: "start" },
    ]);
  });

  it("defaults the provider to SCCH and the id to 'cloze', coercing scalars", () => {
    const result = parseCloze("llm: { model: m }\nevaluation: e\ntitle: 7\ntext: A [[b]].");
    expect(result).toMatchObject({
      ok: true,
      cloze: { id: "cloze", provider: "SCCH", title: "7" },
    });
  });

  it.each([
    ["invalid YAML", "a: : :", /YAML is not valid/],
    ["a non-object document", "- a", /empty or malformed/],
    ["no llm.model", "evaluation: e\ntext: A [[b]].", /llm\.model/],
    [
      "an unsupported provider",
      "llm: { model: m, provider: X }\nevaluation: e\ntext: A [[b]].",
      /llm\.provider/,
    ],
    [
      "an unsupported reasoning level",
      "llm: { model: m, reasoning: max }\nevaluation: e\ntext: A [[b]].",
      /llm\.reasoning/,
    ],
    ["no evaluation", "llm: { model: m }\ntext: A [[b]].", /grading criteria/],
    ["no text", "llm: { model: m }\nevaluation: e", /no text/],
    [
      "unreadable gaps",
      "llm: { model: m }\nevaluation: e\ntext: No gaps.",
      /gaps of this exercise/,
    ],
  ])("fails with a friendly message on %s", (_label, yaml, message) => {
    const result = parseCloze(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });

  it("ignores unknown keys (lenient)", () => {
    expect(parseCloze("llm: { model: m }\nevaluation: e\ntext: A [[b]].\nextra: 1").ok).toBe(true);
  });
});

describe("toPublicCloze — the projection guard", () => {
  const loaded = parseCloze(VALID);
  if (!loaded.ok) throw new Error(loaded.message);
  const projected = toPublicCloze({ ...loaded.cloze, instructionsPreamble: "SECRET-RENDERED" });

  it("carries only the whitelisted public fields", () => {
    expect(Object.keys(projected).sort()).toEqual(["description", "gaps", "text", "title"]);
    expect(projected.gaps).toEqual([{ number: 1 }, { number: 2, hint: "start" }]);
    for (const gap of projected.gaps) expect(Object.keys(gap).sort()).not.toContain("reference");
  });

  it("never contains a reference answer, the rubric, the preamble or the llm block", () => {
    const wire = JSON.stringify(projected);
    for (const secret of [
      "REF-ONE",
      "REF-TWO",
      "SECRET-RUBRIC",
      "SECRET-PREAMBLE",
      "SECRET-RENDERED",
      "secret-model",
      "Teacher label",
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("replaces every gap with its numbered placeholder and keeps the rest of the Markdown", () => {
    expect(splitOnClozeGaps(projected.text)).toEqual([
      "## A plan\n\nShe ",
      1,
      " start. The class ",
      2,
      " at nine.\n",
    ]);
  });
});
