import { describe, expect, it } from "vitest";
import { parse as parseYamlText } from "yaml";
import type { Fetcher } from "@/lib/prompt-fragments";
import { fixtureResponse, fragmentFetcher, LIB_A_URL } from "@/lib/prompt-fragments/test-fixtures";
import { checkWritingValue, loadAndCheckWriting } from "@/lib/writing-validate";

// The writing AUTHORING validator: the strict schema gate. Pure, no network — a
// fixture Fetcher returns YAML text in-process. Writing DIVERGES: anonymous
// defaults to FALSE (attributed).

const URL_ = "https://example.com/writing.yaml";
const fetcherFor =
  (text: string, ok = true): Fetcher =>
  async () => ({ ok, status: ok ? 200 : 404, text: async () => text });

const VALID = `
id: essay
name: "Essay"
title: "Write an essay"
description: "Write 400 words."
anonymous: true
llm:
  model: some-model
instructions: "You are a writing coach. Read the draft, then advise."
placeholder: ""
`;

describe("loadAndCheckWriting — positive", () => {
  it("accepts a valid activity and reports its metadata", async () => {
    const result = await loadAndCheckWriting(URL_, fetcherFor(VALID));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.writingId).toBe("essay");
      expect(result.model).toBe("some-model");
      expect(result.provider).toBe("SCCH"); // llm.provider defaults to SCCH
      expect(result.anonymous).toBe(true);
      expect(result.title).toBe("Write an essay");
    }
  });

  it("accepts and reports an explicit llm.provider", async () => {
    const foundry = `
id: w
llm:
  model: gpt-5.4-mini
  provider: Azure Foundry
instructions: "Coach the student."
`;
    const result = await loadAndCheckWriting(URL_, fetcherFor(foundry));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe("Azure Foundry");
  });

  it("DEFAULTS anonymous to FALSE (the writing divergence) when omitted", async () => {
    const minimal = `
id: w
llm:
  model: m
instructions: "Coach the student."
`;
    const result = await loadAndCheckWriting(URL_, fetcherFor(minimal));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.anonymous).toBe(false);
      expect(result.title).toBeNull();
    }
  });
});

describe("checkWritingValue — schema errors", () => {
  const check = (yaml: string) => checkWritingValue(parseYamlText(yaml), URL_);

  it("rejects a missing llm.model", () => {
    const result = check(`
id: w
instructions: "Coach."
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("WRITING_SCHEMA_ERROR");
  });

  it("rejects a missing instructions block", () => {
    const result = check(`
id: w
llm:
  model: m
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("WRITING_SCHEMA_ERROR");
  });

  it("rejects an unsupported llm.provider", () => {
    const result = check(`
id: w
llm:
  model: m
  provider: OpenAI
instructions: "Coach."
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("WRITING_SCHEMA_ERROR");
  });

  it("rejects an unrecognized (misspelled) key", () => {
    const result = check(`
id: w
llm:
  model: m
instructons: "typo — should be instructions"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("WRITING_SCHEMA_ERROR");
      expect(result.errors[0]?.zodIssues).toBeTruthy();
    }
  });
});

// --- wiring of the shared steps -----------------------------------------------------
// The fetch / YAML / scheme failures (`loadAndValidate`, lib/prompt-fragments) and the
// fragment + text-file gate over `instructions` (`checkInstructions`,
// lib/activity-load.ts) are covered once by their own tests; these prove the wiring.

describe("loadAndCheckWriting — shared steps", () => {
  it("reports a schema error of the file with its own code", async () => {
    const result = await loadAndCheckWriting(URL_, fetcherFor("id: x\n"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("WRITING_SCHEMA_ERROR");
  });

  it("runs the fragment gate over instructions", async () => {
    const writing = `
id: essay
llm:
  model: m
fragment_files:
  - id: lib_a
    url: ${LIB_A_URL}
instructions: |
  {{fragment "lib_a.str_frag"}}
`;
    const result = await loadAndCheckWriting(
      URL_,
      fragmentFetcher(new Map([[URL_, fixtureResponse(writing)]])),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("MISSING_REQUIRED_VARIABLE");
  });
});
