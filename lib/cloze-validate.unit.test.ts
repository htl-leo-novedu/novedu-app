import { describe, expect, it } from "vitest";
import { parse as parseYamlText } from "yaml";
import { checkClozeValue, loadAndCheckCloze } from "@/lib/cloze-validate";
import type { Fetcher } from "@/lib/prompt-fragments";

// The cloze AUTHORING validator: the strict schema gate + the gap parser + the
// fragment block's authoring gate, and the gap inventory a successful check
// reports. Pure, no network — a fixture Fetcher returns YAML text in-process.

const URL_ = "https://example.com/cloze.yaml";
const LIB_URL = "https://example.com/lib.yaml";

const fetcherMap =
  (bodies: Record<string, string>): Fetcher =>
  async (url) => {
    const text = bodies[url];
    return text === undefined
      ? { ok: false, status: 404, text: async () => "" }
      : { ok: true, status: 200, text: async () => text };
  };
const fetcherFor = (text: string) => fetcherMap({ [URL_]: text });

const VALID = `
id: future-forms
name: "Future forms"
title: "Sue's fresh start"
description: Complete the text.
llm:
  model: some-model
evaluation: |
  Correct: the intended future form.
text: |
  ## A plan

  She [[is going to]] start next week. The class [[starts|start]] at nine.
  Yes[[]] she said.
`;

describe("loadAndCheckCloze — positive", () => {
  it("accepts a valid exercise and reports its metadata and gap inventory", async () => {
    const result = await loadAndCheckCloze(URL_, fetcherFor(VALID));
    expect(result).toEqual({
      ok: true,
      clozeId: "future-forms",
      model: "some-model",
      provider: "SCCH", // llm.provider defaults to SCCH
      title: "Sue's fresh start",
      gapCount: 3,
      gaps: [
        { number: 1, reference: "is going to" },
        { number: 2, reference: "starts", hint: "start" },
        { number: 3, reference: "" },
      ],
      inventory: '3 gaps · 1 "is going to" · 2 "starts" (start) · 3 (empty)',
      warnings: [],
    });
  });

  it("accepts the minimal shape and defaults the title to null", async () => {
    const minimal = `
id: c
llm: { model: m }
evaluation: e
text: A [[b]] c.
`;
    const result = await loadAndCheckCloze(URL_, fetcherFor(minimal));
    expect(result).toMatchObject({ ok: true, clozeId: "c", title: null, gapCount: 1 });
  });

  it("accepts an exercise that pulls in fragments via instructions", async () => {
    const lib = `id: lib
fragments:
  - id: safety
    version: 1
    content: Always be kind.
`;
    const cloze = `
id: c
llm: { model: m }
fragment_files:
  - id: lib
    url: ${LIB_URL}
instructions: |
  {{fragment "lib.safety"}}
evaluation: e
text: A [[b]] c.
`;
    const result = await loadAndCheckCloze(URL_, fetcherMap({ [URL_]: cloze, [LIB_URL]: lib }));
    expect(result.ok).toBe(true);
  });
});

describe("loadAndCheckCloze — negative", () => {
  it("rejects a fetch failure as FETCH_FAILED (no throw)", async () => {
    const result = await loadAndCheckCloze(URL_, fetcherMap({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("FETCH_FAILED");
  });

  it("rejects a disallowed URL scheme as INVALID_URL", async () => {
    const result = await loadAndCheckCloze("file:///etc/passwd", fetcherFor(VALID));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("INVALID_URL");
  });

  it("surfaces every gap problem with its line and column", async () => {
    const broken = `
id: c
llm: { model: m }
evaluation: e
text: |
  A stray ]] and [[a]].

  Fine [[b]] but [[c|]] here.
`;
    const result = await loadAndCheckCloze(URL_, fetcherFor(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => [e.code, e.line, e.column])).toEqual([
        ["CLOZE_GAP_SYNTAX", 1, 9],
        ["CLOZE_GAP_SYNTAX", 3, 16],
      ]);
    }
  });

  it("rejects an unknown fragment alias in instructions (the fragment gate)", async () => {
    const cloze = `
id: c
llm: { model: m }
instructions: |
  {{fragment "nope.x"}}
fragment_files:
  - id: lib
    url: ${LIB_URL}
evaluation: e
text: A [[b]] c.
`;
    const result = await loadAndCheckCloze(URL_, fetcherFor(cloze));
    expect(result.ok).toBe(false);
  });
});

describe("checkClozeValue — schema errors", () => {
  const check = (yaml: string) => checkClozeValue(parseYamlText(yaml), URL_);
  const base = {
    id: "c",
    llm: { model: "m" },
    evaluation: "e",
    text: "A [[b]] c.",
  };

  it("accepts the base shape", () => {
    expect(checkClozeValue(base, URL_).ok).toBe(true);
  });

  it.each([
    ["a missing id", { ...base, id: undefined }],
    ["a missing llm.model", { ...base, llm: {} }],
    ["an unsupported llm.provider", { ...base, llm: { model: "m", provider: "OpenAI" } }],
    ["a missing evaluation", { ...base, evaluation: undefined }],
    ["a missing text", { ...base, text: undefined }],
    ["a misspelled key", { ...base, evaluaton: "typo" }],
    ["an unknown key inside llm", { ...base, llm: { model: "m", imageInput: true } }],
    // Cloze is always anonymous, and none of the quiz-only fields exist here.
    ["an anonymous field", { ...base, anonymous: false }],
    ["a shuffle field", { ...base, shuffle: false }],
    ["a questions field", { ...base, questions: [] }],
  ])("rejects %s as CLOZE_SCHEMA_ERROR", (_label, value) => {
    const result = checkClozeValue(value, URL_);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("CLOZE_SCHEMA_ERROR");
  });

  it("rejects a text without gaps as CLOZE_NO_GAPS", () => {
    const result = check(`
id: c
llm: { model: m }
evaluation: e
text: No gaps.
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("CLOZE_NO_GAPS");
  });
});
