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

import { loadWriting } from "@/lib/writing-fetch";
import { toPublicWriting } from "@/lib/writing-yaml";

const URL_ = "https://app.test/api/files/writing";
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

describe("loadWriting — fragments", () => {
  it("prepends the assembled fragments ahead of instructions", async () => {
    state.bodies = {
      [URL_]: `
id: essay
llm:
  model: m
fragment_files:
  - id: lib
    url: ${LIB_URL}
instructions: |
  {{fragment "lib.safety"}}

  INSTRUCTIONS-MARKER coach the draft.
`,
      [LIB_URL]: LIB_YAML,
    };
    const result = await loadWriting(URL_);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { instructions } = result.writing;
      expect(instructions).toContain("SAFETY-MARKER");
      expect(instructions).toContain("INSTRUCTIONS-MARKER");
      expect(instructions.indexOf("SAFETY-MARKER")).toBeLessThan(
        instructions.indexOf("INSTRUCTIONS-MARKER"),
      );
    }
  });

  it("leaves instructions unchanged for a plain activity (no fragments)", async () => {
    state.bodies = {
      [URL_]: `
id: essay
llm:
  model: m
instructions: "INSTRUCTIONS-MARKER only."
`,
    };
    const result = await loadWriting(URL_);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.writing.instructions).toBe("INSTRUCTIONS-MARKER only.");
  });

  it("fails closed when a referenced fragment library cannot be fetched", async () => {
    state.bodies = {
      [URL_]: `
id: essay
llm:
  model: m
fragment_files:
  - id: lib
    url: ${LIB_URL}
instructions: |
  {{fragment "lib.safety"}}

  Coach.
`,
    };
    const result = await loadWriting(URL_);
    expect(result.ok).toBe(false);
  });

  it("does not leak the fragment-augmented instructions through toPublicWriting", async () => {
    state.bodies = {
      [URL_]: `
id: essay
llm:
  model: m
fragment_files:
  - id: lib
    url: ${LIB_URL}
instructions: |
  {{fragment "lib.safety"}}

  INSTRUCTIONS-MARKER coach the draft.
`,
      [LIB_URL]: LIB_YAML,
    };
    const result = await loadWriting(URL_);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Guard: the fold really happened, so the projection is exercised on a non-trivial
      // (fragment-augmented) instructions string.
      expect(result.writing.instructions).toContain("SAFETY-MARKER");
      const pub = toPublicWriting(result.writing);
      expect(pub).not.toHaveProperty("instructions");
      expect(pub).not.toHaveProperty("fragmentBlock");
      // Neither the server-only fragment text nor the teacher's prompt may reach the client.
      expect(JSON.stringify(pub)).not.toContain("SAFETY-MARKER");
      expect(JSON.stringify(pub)).not.toContain("INSTRUCTIONS-MARKER");
    }
  });
});
