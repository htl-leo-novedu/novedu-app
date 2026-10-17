import { describe, expect, it } from "vitest";
import { parse as parseYamlText } from "yaml";
import { checkCodingValue, loadAndCheckCoding } from "@/lib/coding-validate";
import type { Fetcher } from "@/lib/prompt-fragments";
import { fixtureResponse, fragmentFetcher, LIB_A_URL } from "@/lib/prompt-fragments/test-fixtures";

// The coding AUTHORING validator: the strict schema gate. Pure, no network — a
// fixture Fetcher returns YAML text in-process. Coding is ALWAYS anonymous (its
// conversations are never stored), so the validator carries no anonymity flag.

const URL_ = "https://example.com/coding.yaml";
const fetcherFor =
  (text: string, ok = true): Fetcher =>
  async () => ({ ok, status: ok ? 200 : 404, text: async () => text });

const VALID = `
id: buddy
name: "Coding Buddy"
title: "Coding Buddy"
llm:
  model: some-model
instructions: "You are a friendly coding buddy. Keep code beginner-friendly."
`;

describe("loadAndCheckCoding — positive", () => {
  it("accepts a valid activity and reports its metadata", async () => {
    const result = await loadAndCheckCoding(URL_, fetcherFor(VALID));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.codingId).toBe("buddy");
      expect(result.model).toBe("some-model");
      expect(result.provider).toBe("SCCH"); // llm.provider defaults to SCCH
      expect(result.title).toBe("Coding Buddy");
    }
  });

  it("accepts and reports an explicit llm.provider", async () => {
    const foundry = `
id: c
llm:
  model: gpt-5.4-mini
  provider: Azure Foundry
instructions: "Help the student code."
`;
    const result = await loadAndCheckCoding(URL_, fetcherFor(foundry));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe("Azure Foundry");
  });

  it("accepts the minimal shape (no name/title) and defaults title to null", async () => {
    const minimal = `
id: c
llm:
  model: m
instructions: "Help the student code."
`;
    const result = await loadAndCheckCoding(URL_, fetcherFor(minimal));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.codingId).toBe("c");
      expect(result.title).toBeNull();
    }
  });
});

describe("checkCodingValue — schema errors", () => {
  const check = (yaml: string) => checkCodingValue(parseYamlText(yaml), URL_);

  it("rejects an unsupported llm.provider", () => {
    const result = check(`
id: c
llm:
  model: m
  provider: OpenAI
instructions: "Help."
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("CODING_SCHEMA_ERROR");
  });

  it("rejects a missing llm.model", () => {
    const result = check(`
id: c
instructions: "Help."
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("CODING_SCHEMA_ERROR");
  });

  it("rejects a missing instructions block", () => {
    const result = check(`
id: c
llm:
  model: m
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("CODING_SCHEMA_ERROR");
  });

  it("rejects an unrecognized (misspelled) key", () => {
    const result = check(`
id: c
llm:
  model: m
instructons: "typo — should be instructions"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("CODING_SCHEMA_ERROR");
      expect(result.errors[0]?.zodIssues).toBeTruthy();
    }
  });

  it("rejects an `anonymous` field — coding is always anonymous, so it is NOT configurable", () => {
    const result = check(`
id: c
anonymous: false
llm:
  model: m
instructions: "Help."
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("CODING_SCHEMA_ERROR");
  });
});

// --- wiring of the shared steps -----------------------------------------------------
// The fetch / YAML / scheme failures (`loadAndValidate`, lib/prompt-fragments) and the
// fragment + text-file gate over `instructions` (`checkInstructions`,
// lib/activity-load.ts) are covered once by their own tests; these prove the wiring.

describe("loadAndCheckCoding — shared steps", () => {
  it("reports a schema error of the file with its own code", async () => {
    const result = await loadAndCheckCoding(URL_, fetcherFor("id: x\n"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("CODING_SCHEMA_ERROR");
  });

  it("runs the fragment gate over instructions", async () => {
    const coding = `
id: buddy
llm:
  model: m
fragment_files:
  - id: lib_a
    url: ${LIB_A_URL}
instructions: |
  {{fragment "lib_a.str_frag"}}
`;
    const result = await loadAndCheckCoding(
      URL_,
      fragmentFetcher(new Map([[URL_, fixtureResponse(coding)]])),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("MISSING_REQUIRED_VARIABLE");
  });
});
