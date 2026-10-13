import { beforeEach, describe, expect, it, vi } from "vitest";

// loadCoding resolves the document-level fragment block and prepends the assembled
// fragments AHEAD of the teacher's `instructions` — the proxy then folds that ONE
// finished string into each completion request (no route change). Hermetic: the
// app-hosted seam is mocked to serve fixture YAML from an in-process map.

const state = vi.hoisted(() => ({ bodies: {} as Record<string, string> }));

vi.mock("@/lib/app-hosted-fetcher", () => ({
  serverYamlFetcher: async () => async (url: string) => {
    const text = state.bodies[url];
    return text === undefined
      ? { ok: false as const, status: 404, text: async () => "" }
      : { ok: true as const, status: 200, text: async () => text };
  },
}));

import { loadCoding } from "@/lib/coding-fetch";

const URL_ = "https://app.test/api/files/coding";
const LIB_URL = "https://example.com/lib.yaml";
const LIB_YAML = `id: lib
fragments:
  - id: safety
    version: 1
    content: |
      SAFETY-MARKER be kind.
`;

beforeEach(() => {
  state.bodies = {};
});

describe("loadCoding — fragments", () => {
  it("prepends the assembled fragments ahead of instructions", async () => {
    state.bodies = {
      [URL_]: `
id: buddy
llm:
  model: m
fragment_files:
  - id: lib
    url: ${LIB_URL}
instructions: |
  {{fragment "lib.safety"}}

  INSTRUCTIONS-MARKER help beginners.
`,
      [LIB_URL]: LIB_YAML,
    };
    const result = await loadCoding(URL_);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { instructions } = result.coding;
      expect(instructions).toContain("SAFETY-MARKER");
      expect(instructions.indexOf("SAFETY-MARKER")).toBeLessThan(
        instructions.indexOf("INSTRUCTIONS-MARKER"),
      );
    }
  });

  it("leaves instructions byte-identical for a plain activity (no fragments)", async () => {
    state.bodies = {
      [URL_]: `
id: buddy
llm:
  model: m
instructions: "INSTRUCTIONS-MARKER only."
`,
    };
    const result = await loadCoding(URL_);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.coding.instructions).toBe("INSTRUCTIONS-MARKER only.");
  });

  it("fails closed when a referenced fragment library cannot be fetched", async () => {
    state.bodies = {
      [URL_]: `
id: buddy
llm:
  model: m
fragment_files:
  - id: lib
    url: ${LIB_URL}
instructions: |
  {{fragment "lib.safety"}}

  Help.
`,
    };
    const result = await loadCoding(URL_);
    expect(result.ok).toBe(false);
  });
});
