import { beforeEach, describe, expect, it, vi } from "vitest";

// loadWriting resolves the document-level fragment block and prepends the assembled
// fragments AHEAD of the teacher's `instructions`. Hermetic: the app-hosted seam is
// mocked to serve fixture YAML from an in-process map.

const state = vi.hoisted(() => ({ bodies: {} as Record<string, string> }));

vi.mock("@/lib/app-hosted-fetcher", () => ({
  serverYamlFetcher: async () => async (url: string) => {
    const text = state.bodies[url];
    return text === undefined
      ? { ok: false as const, status: 404, text: async () => "" }
      : { ok: true as const, status: 200, text: async () => text };
  },
}));

import { LIB_A_URL, LIB_A_YAML } from "@/lib/prompt-fragments/test-fixtures";
import { loadWriting } from "@/lib/writing-fetch";
import { toPublicWriting } from "@/lib/writing-yaml";

const URL_ = "https://app.test/api/files/writing";

beforeEach(() => {
  state.bodies = {};
});

describe("loadWriting — fragments", () => {
  it("prepends the assembled fragments ahead of instructions", async () => {
    state.bodies = {
      [URL_]: `
id: essay
llm:
  model: m
fragment_files:
  - id: lib_a
    url: ${LIB_A_URL}
instructions: |
  {{fragment "lib_a.safety_frag"}}

  INSTRUCTIONS-MARKER coach the draft.
`,
      [LIB_A_URL]: LIB_A_YAML,
    };
    const result = await loadWriting(URL_);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { instructions } = result.writing;
      expect(instructions).toContain("LAST-MARKER");
      expect(instructions).toContain("INSTRUCTIONS-MARKER");
      expect(instructions.indexOf("LAST-MARKER")).toBeLessThan(
        instructions.indexOf("INSTRUCTIONS-MARKER"),
      );
    }
  });

  it("does not leak the fragment-augmented instructions through toPublicWriting", async () => {
    state.bodies = {
      [URL_]: `
id: essay
llm:
  model: m
fragment_files:
  - id: lib_a
    url: ${LIB_A_URL}
instructions: |
  {{fragment "lib_a.safety_frag"}}

  INSTRUCTIONS-MARKER coach the draft.
`,
      [LIB_A_URL]: LIB_A_YAML,
    };
    const result = await loadWriting(URL_);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Guard: the fold really happened, so the projection is exercised on a non-trivial
      // (fragment-augmented) instructions string.
      expect(result.writing.instructions).toContain("LAST-MARKER");
      const pub = toPublicWriting(result.writing);
      expect(pub).not.toHaveProperty("instructions");
      expect(pub).not.toHaveProperty("fragmentBlock");
      // Neither the server-only fragment text nor the teacher's prompt may reach the client.
      expect(JSON.stringify(pub)).not.toContain("LAST-MARKER");
      expect(JSON.stringify(pub)).not.toContain("INSTRUCTIONS-MARKER");
    }
  });
});
