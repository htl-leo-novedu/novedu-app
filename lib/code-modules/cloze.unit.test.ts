import { describe, expect, it, vi } from "vitest";

// The cloze code-module (Layer 3): like coding it has NO `runtime` — it is graded by its
// own server actions, never through the CopilotKit runtime — and renderDetail dispatches
// to ClozeDetail. ClozeDetail is mocked as a plain function so this is hermetic.

const clozeDetail = vi.hoisted(() => vi.fn());

vi.mock("@/app/[code]/_cloze/cloze-detail", () => ({ ClozeDetail: clozeDetail }));

import { clozeModule } from "@/lib/code-modules/cloze";
import { codeModuleLabels } from "@/lib/code-modules/types";
import type { CodeEntry } from "@/lib/code-store";

const entry = {
  code: "a1b2c3d4e5",
  module: "cloze",
  fileUrl: "https://example.com/api/files/c",
  anonymous: true,
} as unknown as CodeEntry;

describe("clozeModule descriptor", () => {
  it("references the cloze file kind and has NO runtime", () => {
    expect(clozeModule.fileKind).toBe("cloze");
    expect(clozeModule.runtime).toBeUndefined();
  });

  it("is labelled Cloze, counting submissions", () => {
    expect(codeModuleLabels.cloze).toEqual({
      badge: "Cloze",
      countColumn: "Submissions",
      tone: "rose",
    });
  });
});

describe("clozeModule.renderDetail", () => {
  it("renders ClozeDetail for the entry", () => {
    clozeDetail.mockReturnValue("<cloze-detail/>");
    const out = clozeModule.renderDetail(entry, {});
    expect(clozeDetail).toHaveBeenCalledWith({ entry });
    expect(out).toBe("<cloze-detail/>");
  });
});
