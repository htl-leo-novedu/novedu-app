import { describe, expect, it, vi } from "vitest";

// The quiz code-module (Layer 3): buildRequestContext loads the quiz YAML to set the
// discussion system prompt + model (502 on load failure), and renderDetail dispatches
// to the shared conversation stats. Create-time validation (derived from fileKind by
// the registry) and the share-link result (the registry default) are not the
// descriptor's concern. loadQuiz is mocked.

const loadQuiz = vi.hoisted(() => vi.fn());
const conversationStats = vi.hoisted(() => vi.fn());

vi.mock("@/lib/quiz-fetch", () => ({ loadQuiz }));
// renderDetail calls the shared ConversationStats; mock it (the real one pulls in
// the code-stats store → @/app/mastra, which this hermetic test must not load).
vi.mock("@/app/codes/[code]/conversation-stats", () => ({ ConversationStats: conversationStats }));

import { quizModule } from "@/lib/code-modules/quiz";
import type { CodeEntry } from "@/lib/code-store";

const entry = {
  code: "a1b2c3d4e5",
  module: "quiz",
  fileUrl: "https://example.com/api/files/q",
} as unknown as CodeEntry;

describe("quizModule.runtime.buildRequestContext", () => {
  it("502s when the quiz YAML cannot be loaded", async () => {
    loadQuiz.mockResolvedValue({ ok: false, message: "quiz unavailable" });
    expect(await quizModule.runtime?.buildRequestContext(entry)).toEqual({
      ok: false,
      status: 502,
      message: "quiz unavailable",
    });
  });

  // The override / reasoning / provider-gate matrix is `llmRequestContext`'s
  // (lib/llm-context.unit.test.ts); this proves the quiz wiring.
  it("sets the discussion model, provider and instructions (default frame + the quiz's own)", async () => {
    // A Foundry quiz needs the endpoint configured — the availability gate is real here.
    vi.stubEnv("AZURE_FOUNDRY_ENDPOINT", "https://res.openai.azure.com");
    loadQuiz.mockResolvedValue({
      ok: true,
      quiz: {
        model: "gemma-4",
        provider: "Azure Foundry",
        discussionInstructions: "Focus on big-O.",
        questions: [],
      },
    });
    const result = await quizModule.runtime?.buildRequestContext(entry);
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      const ctx = result.context as unknown as { get(k: string): unknown };
      expect(ctx.get("quiz-discussion-model")).toBe("gemma-4");
      expect(ctx.get("quiz-discussion-provider")).toBe("Azure Foundry");
      expect(ctx.get("quiz-discussion-reasoning")).toBeUndefined();
      const instr = ctx.get("quiz-discussion-instructions") as string;
      expect(instr).toContain("single quiz question"); // the default frame
      expect(instr).toContain("Focus on big-O."); // appended quiz-authored instructions
    }
  });

  it("uses only the default frame when the quiz omits discussionInstructions", async () => {
    loadQuiz.mockResolvedValue({ ok: true, quiz: { model: "gemma-4", questions: [] } });
    const result = await quizModule.runtime?.buildRequestContext(entry);
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      const ctx = result.context as unknown as { get(k: string): unknown };
      expect(ctx.get("quiz-discussion-instructions")).toContain("single quiz question");
    }
  });
});

describe("quizModule discussion instructions — compound quizzes", () => {
  it("uses ONLY the compound file's instructions — chapter sourcePreambles are grading-only", async () => {
    loadQuiz.mockResolvedValue({
      ok: true,
      quiz: {
        model: "gemma-4",
        provider: "SCCH",
        instructionsPreamble: "COMPOUND-PREAMBLE shared rules.",
        discussionInstructions: "COMPOUND-DISCUSSION guidance.",
        questions: [
          { id: "own", question: "Q", evaluation: "E" },
          { id: "intro/q1", question: "Q", evaluation: "E", sourcePreamble: "INTRO-PREAMBLE." },
          { id: "loops/q1", question: "Q", evaluation: "E", sourcePreamble: "LOOPS-PREAMBLE." },
        ],
      },
    });
    const result = await quizModule.runtime?.buildRequestContext(entry);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    const ctx = result.context as unknown as { get(k: string): unknown };
    const instr = ctx.get("quiz-discussion-instructions") as string;
    // Compound preamble → the default frame → the compound's discussion guidance.
    const compoundAt = instr.indexOf("COMPOUND-PREAMBLE");
    const frameAt = instr.indexOf("single quiz question");
    const discussionAt = instr.indexOf("COMPOUND-DISCUSSION");
    expect(compoundAt).toBeGreaterThanOrEqual(0);
    expect(compoundAt).toBeLessThan(frameAt);
    expect(frameAt).toBeLessThan(discussionAt);
    // The chapters' preambles must NOT leak into the discussion prompt.
    expect(instr).not.toContain("INTRO-PREAMBLE");
    expect(instr).not.toContain("LOOPS-PREAMBLE");
  });
});

describe("quizModule.renderDetail", () => {
  it("renders the shared conversation stats", () => {
    conversationStats.mockReturnValue("<stats/>");
    const out = quizModule.renderDetail(entry, {});
    expect(conversationStats).toHaveBeenCalledWith({ entry });
    expect(out).toBe("<stats/>");
  });
});
