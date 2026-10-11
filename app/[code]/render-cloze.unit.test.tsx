import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, expect, it, vi } from "vitest";

// The cloze module's student render: only the public projection reaches the client
// runner. The "use client" runner is replaced by a stub that renders its props
// serialized — props cross into the RSC payload even where the component never renders
// them, so the markup alone could not show a leak. `loadCloze` is mocked; the parser and
// `toPublicCloze` stay real.

const loadCloze = vi.hoisted(() => vi.fn());
const getUserSettings = vi.hoisted(() => vi.fn());

vi.mock("@/lib/cloze-fetch", () => ({ loadCloze }));
vi.mock("@/lib/user-settings-store", () => ({ getUserSettings }));
vi.mock("./_cloze/cloze-runner", () => ({
  ClozeRunner: (props: object) => (
    <div data-testid="cloze-runner" data-props={JSON.stringify(props)} />
  ),
}));

import { parseCloze } from "@/lib/cloze-yaml";
import type { CodeEntry } from "@/lib/code-store";
import { RenderCloze } from "./render-cloze";

const entry = { code: "a1b2c3d4e5", module: "cloze", fileUrl: "https://x/c" } as CodeEntry;

const parsed = parseCloze(`
id: t
title: Sue's week
llm: { model: SECRET-MODEL }
instructions: SECRET-INSTRUCTIONS
evaluation: SECRET-EVALUATION
text: |
  Sue [[SECRET-REFERENCE]] starts. The class [[SECRET-TWO|start]] at nine.
`);
assert(parsed.ok);

describe("RenderCloze", () => {
  it("ships the projection only — no reference, criteria, instructions or model", async () => {
    loadCloze.mockResolvedValue({
      ok: true,
      cloze: { ...parsed.cloze, instructionsPreamble: "SECRET-PREAMBLE" },
    });
    const html = renderToStaticMarkup(
      await RenderCloze({ entry, code: "a1b2c3d4e5", userId: "student-1" }),
    );
    expect(html).toContain('data-testid="cloze-runner"');
    expect(html).toContain("Sue&#x27;s week");
    expect(html).toContain("start");
    expect(html).not.toContain("SECRET");
  });

  it("passes the user's result-save setting as the runner's autoSave hint", async () => {
    loadCloze.mockResolvedValue({ ok: true, cloze: parsed.cloze });
    getUserSettings.mockResolvedValue({ saveQuizResults: true });
    const on = renderToStaticMarkup(
      await RenderCloze({ entry, code: "a1b2c3d4e5", userId: "student-1" }),
    );
    expect(getUserSettings).toHaveBeenCalledWith("student-1");
    expect(on).toContain("&quot;autoSave&quot;:true");
    // A failed settings read asks.
    getUserSettings.mockResolvedValue(undefined);
    const failed = renderToStaticMarkup(
      await RenderCloze({ entry, code: "a1b2c3d4e5", userId: "student-1" }),
    );
    expect(failed).toContain("&quot;autoSave&quot;:false");
  });

  it("shows a friendly notice when the exercise cannot be loaded", async () => {
    loadCloze.mockResolvedValue({ ok: false, message: "This exercise could not be found." });
    const html = renderToStaticMarkup(
      await RenderCloze({ entry, code: "a1b2c3d4e5", userId: "student-1" }),
    );
    expect(html).toContain("This exercise cannot be opened");
    expect(html).toContain("This exercise could not be found.");
  });
});
