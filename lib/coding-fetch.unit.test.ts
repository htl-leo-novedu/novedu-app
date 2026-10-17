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
import { LIB_A_URL, LIB_A_YAML } from "@/lib/prompt-fragments/test-fixtures";

const URL_ = "https://app.test/api/files/coding";

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
  - id: lib_a
    url: ${LIB_A_URL}
instructions: |
  {{fragment "lib_a.safety_frag"}}

  INSTRUCTIONS-MARKER help beginners.
`,
      [LIB_A_URL]: LIB_A_YAML,
    };
    const result = await loadCoding(URL_);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { instructions } = result.coding;
      expect(instructions).toContain("LAST-MARKER");
      expect(instructions.indexOf("LAST-MARKER")).toBeLessThan(
        instructions.indexOf("INSTRUCTIONS-MARKER"),
      );
    }
  });
});
