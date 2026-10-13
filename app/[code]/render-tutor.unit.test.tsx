import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The tutor module's student render: it loads + builds the tutor prompt from the
// code's file_url and renders the chat, or shows the validation errors on a broken
// tutor. Invoked directly (it is an async server component) with the loader
// mocked, so no DB/LLM; runs in CI.

const loadAndBuildTutorPrompt = vi.hoisted(() => vi.fn());
// The server's YAML fetcher as a sentinel (its resolution is tested in
// lib/app-hosted-fetcher.unit.test.ts); here only that the render loads through it.
const serverFetcher = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tutors", () => ({
  loadAndBuildTutorPrompt,
  sampleExampleQuestions: (q: unknown) => q ?? [],
}));
vi.mock("@/lib/app-hosted-fetcher", () => ({ serverYamlFetcher: async () => serverFetcher }));
// Stub the chat so the happy path needs no CopilotKit/runtime.
vi.mock("../tutor-chat", () => ({
  TutorChat: ({ code, historyEnabled }: { code: string; historyEnabled: boolean }) => (
    <div data-testid="chat" data-history={String(historyEnabled)}>
      chat for {code}
    </div>
  ),
}));
// The history gate's own store and YAML reads are never reached by the pure
// `historyEnabled` this render uses; stubbed so the import needs no database.
vi.mock("@/lib/tutor-history-store", () => ({ ownsTutorThread: vi.fn() }));

import type { CodeEntry } from "@/lib/code-store";
import { RenderTutor } from "./render-tutor";

const entry = {
  code: "a1b2c3d4e5",
  module: "tutor",
  fileUrl: "https://example.com/t.yaml",
} as unknown as CodeEntry;

async function render(frozenAnonymous = true) {
  const element = await RenderTutor({
    entry: { ...entry, anonymous: frozenAnonymous },
    code: "a1b2c3d4e5",
    threadId: "t1",
    threadToken: "tok",
  });
  return renderToStaticMarkup(element);
}

describe("RenderTutor", () => {
  it("valid + loadable tutor → renders the chat", async () => {
    loadAndBuildTutorPrompt.mockResolvedValue({
      ok: true,
      prompt: "system prompt",
      warnings: [],
      imageInput: true,
      title: "Tutor",
      description: "",
      exampleQuestions: [],
    });
    const html = await render();
    expect(html).toContain("chat for a1b2c3d4e5");
    expect(loadAndBuildTutorPrompt).toHaveBeenCalledWith(entry.fileUrl, serverFetcher);
  });

  // "Previous conversations" only when the frozen flag on the code row AND the
  // live flag from the YAML this render built are both false.
  it.each([
    [false, false, true],
    [false, true, false],
    [true, false, false],
    [true, true, false],
  ])("frozen anonymous %s, live %s → historyEnabled %s", async (frozen, live, expected) => {
    loadAndBuildTutorPrompt.mockResolvedValue({
      ok: true,
      prompt: "system prompt",
      warnings: [],
      imageInput: false,
      title: "Tutor",
      description: "",
      exampleQuestions: [],
      anonymous: live,
    });
    const html = await render(frozen);
    expect(html).toContain(`data-history="${expected}"`);
    // The live flag comes from this render's own build: one YAML load, no second fetch.
    expect(loadAndBuildTutorPrompt).toHaveBeenCalledTimes(1);
  });

  it("broken tutor → renders the load-failure notice and error list, no chat", async () => {
    loadAndBuildTutorPrompt.mockResolvedValue({
      ok: false,
      errors: [{ code: "MISSING_REQUIRED_VARIABLE", message: "Required variable missing." }],
      warnings: [],
    });
    const html = await render();
    expect(html).toContain("This tutor cannot be loaded");
    expect(html).toContain("MISSING_REQUIRED_VARIABLE");
    expect(html).not.toContain('data-testid="chat"');
  });
});
