import { describe, expect, it, vi } from "vitest";

// The writing code-module (Layer 3): buildRequestContext loads the writing YAML and
// sets the agent instructions + model on the RequestContext (502 on load failure); and
// renderDetail dispatches to the savers list (attributed) or the shared
// ConversationStats (anonymous). Create-time validation (derived from fileKind by the
// registry) and the share-link result (the registry default) are not the descriptor's
// concern. loadWriting + both render components are mocked as plain functions.

const loadWriting = vi.hoisted(() => vi.fn());
const writingSaversList = vi.hoisted(() => vi.fn());
const conversationStats = vi.hoisted(() => vi.fn());

vi.mock("@/lib/writing-fetch", () => ({ loadWriting }));
vi.mock("@/app/[code]/_writing/writing-review", () => ({ WritingSaversList: writingSaversList }));
vi.mock("@/app/codes/[code]/conversation-stats", () => ({ ConversationStats: conversationStats }));

import { writingModule } from "@/lib/code-modules/writing";
import type { CodeEntry } from "@/lib/code-store";

const entry = {
  code: "a1b2c3d4e5",
  module: "writing",
  fileUrl: "https://example.com/api/files/w",
  anonymous: false,
} as unknown as CodeEntry;

describe("writingModule descriptor", () => {
  it("references the writing file kind", () => {
    expect(writingModule.fileKind).toBe("writing");
    expect(writingModule.runtime?.agentId).toBe("writing");
  });
});

describe("writingModule.runtime.buildRequestContext", () => {
  it("502s when the writing YAML cannot be loaded", async () => {
    loadWriting.mockResolvedValue({ ok: false, message: "writing unavailable" });
    expect(await writingModule.runtime?.buildRequestContext(entry)).toEqual({
      ok: false,
      status: 502,
      message: "writing unavailable",
    });
  });

  // The override / reasoning / provider-gate matrix is `llmRequestContext`'s
  // (lib/llm-context.unit.test.ts); this proves the writing wiring.
  it("sets the model, provider and the teacher's instructions on the request context", async () => {
    loadWriting.mockResolvedValue({
      ok: true,
      writing: { model: "gemma-4", provider: "SCCH", instructions: "Be a writing coach." },
    });
    const result = await writingModule.runtime?.buildRequestContext(entry);
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      const ctx = result.context as unknown as { get(k: string): unknown };
      expect(ctx.get("writing-model")).toBe("gemma-4");
      expect(ctx.get("writing-provider")).toBe("SCCH");
      expect(ctx.get("writing-instructions")).toBe("Be a writing coach.");
    }
  });
});

describe("writingModule.renderDetail", () => {
  it("renders the savers list for an attributed code, passing the code + search", () => {
    writingSaversList.mockReturnValue("<savers/>");
    const out = writingModule.renderDetail(entry, { q: "ada" });
    expect(writingSaversList).toHaveBeenCalledWith({ code: entry.code, search: "ada" });
    expect(conversationStats).not.toHaveBeenCalled();
    expect(out).toBe("<savers/>");
  });

  it("ignores a non-string search param (no filter)", () => {
    writingSaversList.mockReturnValue("<savers/>");
    writingModule.renderDetail(entry, { q: ["a", "b"] });
    expect(writingSaversList).toHaveBeenCalledWith({ code: entry.code, search: undefined });
  });

  it("falls back to the conversation stats for an anonymous code", () => {
    conversationStats.mockReturnValue("<stats/>");
    const anon = { ...entry, anonymous: true } as unknown as CodeEntry;
    const out = writingModule.renderDetail(anon, {});
    expect(conversationStats).toHaveBeenCalledWith({ entry: anon });
    expect(writingSaversList).not.toHaveBeenCalled();
    expect(out).toBe("<stats/>");
  });
});
