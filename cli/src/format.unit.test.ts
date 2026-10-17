import { describe, expect, it } from "vitest";
import type { CodingCheckResult } from "@/lib/coding-validate";
import type { BuildResult } from "@/lib/prompt-fragments";
import type { QuizCheckResult } from "@/lib/quiz-validate";
import type { WritingCheckResult } from "@/lib/writing-validate";
import type { EvalBatchFileInput, EvalRunResult } from "./eval-run";
import { summarizeBatch } from "./eval-run";
import {
  formatCodingResult,
  formatEvalBatchReport,
  formatEvalReport,
  formatFragmentResult,
  formatQuizResult,
  formatResult,
  formatWritingResult,
} from "./format";

// The formatter is pure presentation. Every `validate` report shares one shape
// (headline, the kind's detail lines, errors with their Zod field detail, warnings),
// pinned once here on the tutor; the per-kind blocks pin only each kind's own lines.

describe("formatResult — the shared report shape", () => {
  it("flattens zod issues beneath the tutor error line", () => {
    const result: BuildResult = {
      ok: false,
      warnings: [],
      errors: [
        {
          code: "TUTOR_SCHEMA_ERROR",
          message: "Document does not match the expected structure",
          zodIssues: {
            errors: ['Unrecognized key: "nae"'],
            properties: {
              name: { errors: ["Invalid input: expected string, received undefined"] },
            },
          },
        },
      ],
    };

    const out = formatResult(result, "tutor.yaml");

    expect(out).toContain("TUTOR_SCHEMA_ERROR");
    expect(out).toContain('Unrecognized key: "nae"');
    expect(out).toContain("name: Invalid input: expected string, received undefined");
  });

  it("closes either branch with the warnings block", () => {
    const warnings = [{ code: "UNUSED_FRAGMENT_FILE" as const, message: "lib is never placed" }];
    const valid = formatFragmentResult(
      { ok: true, fragmentFileId: "lib", fragmentIds: [], warnings },
      "lib.yaml",
    );
    expect(valid.split("\n")).toEqual([
      "✔ Valid fragment file — lib.yaml",
      "  id: lib",
      "  fragments: 0",
      "",
      "1 warning(s):",
      "  ⚠ UNUSED_FRAGMENT_FILE lib is never placed",
    ]);
    const invalid = formatFragmentResult(
      { ok: false, errors: [{ code: "FETCH_FAILED", message: "gone" }], warnings },
      "lib.yaml",
    );
    expect(invalid.split("\n")).toEqual([
      "✘ Invalid fragment file — lib.yaml",
      "",
      "1 error(s):",
      "  ✗ FETCH_FAILED gone",
      "",
      "1 warning(s):",
      "  ⚠ UNUSED_FRAGMENT_FILE lib is never placed",
    ]);
  });
});

describe("formatQuizResult", () => {
  it("renders a valid quiz's id, model and question count", () => {
    const result: QuizCheckResult = {
      ok: true,
      quizId: "capitals",
      model: "some-model",
      provider: "SCCH",
      questionCount: 5,
      anonymous: false,
      title: "Capitals",
      warnings: [],
    };

    const out = formatQuizResult(result, "quiz.yaml");

    expect(out).toContain("Valid quiz");
    expect(out).toContain("capitals");
    expect(out).toContain("questions: 5");
  });

  it("labels a duplicate-question-id error with the question id", () => {
    const result: QuizCheckResult = {
      ok: false,
      warnings: [],
      errors: [
        { code: "DUPLICATE_QUIZ_QUESTION_ID", message: 'Question id "a" …', questionId: "a" },
      ],
    };

    const out = formatQuizResult(result, "quiz.yaml");

    expect(out).toContain("DUPLICATE_QUIZ_QUESTION_ID");
    expect(out).toContain("question=a");
  });
});

describe("formatWritingResult", () => {
  it("renders a valid writing activity's id and model", () => {
    const result: WritingCheckResult = {
      ok: true,
      writingId: "essay",
      model: "some-model",
      provider: "SCCH",
      anonymous: false,
      title: "Essay",
      warnings: [],
    };

    const out = formatWritingResult(result, "writing.yaml");

    expect(out).toContain("Valid writing activity");
    expect(out).toContain("essay");
  });
});

/** A minimal finished run — only the fields the eval report renders. */
function runResult(usage: { input: number; cachedInput: number; output: number }): EvalRunResult {
  return {
    id: "demo-eval",
    kind: "quiz",
    target: "file:///quiz.yaml",
    llm: { provider: "SCCH", model: "gemma-4" },
    judging: "off",
    totals: {
      cases: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      skipped: 0,
      unstable: 0,
      feedbackFlagged: 0,
      toolsFlagged: 0,
      judgeErrored: 0,
      repeats: 1,
      calls: 1,
      usage,
    },
    mismatches: [],
    cases: [],
    questions: [],
    confusion: [],
    falseCorrect: { count: 0, denominator: 0, rate: 0 },
  } as EvalRunResult;
}

describe("formatCodingResult", () => {
  it("renders a valid coding activity's id and model, with the fixed anonymity note", () => {
    const result: CodingCheckResult = {
      ok: true,
      codingId: "buddy",
      model: "some-model",
      provider: "SCCH",
      title: null,
      warnings: [],
    };

    expect(formatCodingResult(result, "coding.yaml").split("\n")).toEqual([
      "✔ Valid coding activity — coding.yaml",
      "  id: buddy",
      "  model: some-model",
      "  anonymous: true (always — no conversations are stored)",
    ]);
  });
});

describe("formatEvalReport — token totals", () => {
  it("prints one tokens line when the run reported usage", () => {
    const out = formatEvalReport(
      runResult({ input: 15_420, cachedInput: 12_300, output: 2810 }),
      "demo.eval.yaml",
    );

    expect(out).toContain("tokens: 15,420 in (12,300 cached) / 2,810 out");
  });

  it("drops the cached parenthetical when the provider reported no cache reads", () => {
    const out = formatEvalReport(runResult({ input: 900, cachedInput: 0, output: 30 }), "x.yaml");

    expect(out).toContain("tokens: 900 in / 30 out");
  });

  it("prints NO tokens line when nothing was reported", () => {
    const out = formatEvalReport(runResult({ input: 0, cachedInput: 0, output: 0 }), "x.yaml");

    expect(out).not.toContain("tokens:");
  });

  it("adds the batch's grand token total under TOTAL", () => {
    const files: EvalBatchFileInput[] = [
      {
        source: "file:///a.eval.yaml",
        status: "ok",
        result: runResult({ input: 10, cachedInput: 4, output: 2 }),
      },
      {
        source: "file:///b.eval.yaml",
        status: "ok",
        result: runResult({ input: 5, cachedInput: 0, output: 1 }),
      },
    ];

    const out = formatEvalBatchReport(summarizeBatch(files));

    expect(out).toContain("tokens: 15 in (4 cached) / 3 out");
  });
});

describe("formatEvalReport — the feedback judge", () => {
  /** A judged run: the two counts the judge contributes, plus its llm pair. */
  const judged = (
    overrides: Partial<EvalRunResult> = {},
    totals: Partial<EvalRunResult["totals"]> = {},
  ): EvalRunResult => {
    const base = runResult({ input: 10, cachedInput: 0, output: 2 });
    return {
      ...base,
      judging: "on",
      llm: { provider: "SCCH", model: "gemma-4" },
      // One judged repeat: the flagged count renders only for a run that actually
      // holds a judgment (the shared `anyJudged` rule), never off `judging` alone.
      cases: [
        {
          questionId: "q1",
          answerIndex: 1,
          answer: "4",
          expected: ["correct"],
          status: "passed",
          verdict: "correct",
          unstable: false,
          feedbackFlagged: false,
          repeats: [{ repeatIndex: 0, got: "correct", feedback: "ok", judge: { issues: [] } }],
        },
      ],
      ...overrides,
      totals: { ...base.totals, ...totals },
    } as EvalRunResult;
  };

  it("names both halves of the call budget and the flagged count", () => {
    const out = formatEvalReport(judged({}, { feedbackFlagged: 2 }), "demo.eval.yaml");

    expect(out).toContain("cases: 1 × 1 repeat(s) = 1 grading call(s) + 1 judge call(s)");
    expect(out).toContain("flagged feedback: 2");
    // Reported, never gating: the run still passes.
    expect(out).toContain("Eval passed");
  });

  it("says nothing about judging when it was off", () => {
    const out = formatEvalReport(runResult({ input: 10, cachedInput: 0, output: 2 }), "x.yaml");

    expect(out).toContain("cases: 1 × 1 repeat(s) = 1 grading call(s)");
    expect(out).not.toContain("judge call(s)");
    expect(out).not.toContain("flagged");
  });

  it("confirms a clean judged run with an explicit zero", () => {
    // "judged, nothing flagged" must not render identically to "never judged" — the
    // terminal counterpart of the Markdown report's 0-vs-em-dash distinction.
    const out = formatEvalReport(judged({}, { feedbackFlagged: 0 }), "demo.eval.yaml");

    expect(out).toContain("flagged feedback: 0");
  });

  it("labels a tutor run's count 'flagged responses' — the judge read responses, not feedback", () => {
    const out = formatEvalReport(
      judged(
        {
          kind: "tutor",
          cases: [
            {
              index: 0,
              conversation: [{ student: "hi" }],
              status: "ok",
              unstable: false,
              feedbackFlagged: true,
              toolsFlagged: false,
              repeats: [{ repeatIndex: 0, text: "hello", judge: { issues: [] } }],
            },
          ],
        },
        { feedbackFlagged: 1 },
      ),
      "demo.eval.yaml",
    );

    expect(out).toContain("flagged responses: 1");
    expect(out).not.toContain("flagged feedback");
  });

  it("prints the judge pair only when it differs from the grading pair", () => {
    const same = formatEvalReport(
      judged({
        llm: {
          provider: "SCCH",
          model: "gemma-4",
          judge: { provider: "SCCH", model: "gemma-4", overridden: false },
        },
      }),
      "x.yaml",
    );
    expect(same).not.toContain("judge llm:");

    const differing = formatEvalReport(
      judged({
        llm: {
          provider: "SCCH",
          model: "gemma-4",
          judge: { provider: "Azure Foundry", model: "gpt-5.6-terra", overridden: true },
        },
      }),
      "x.yaml",
    );
    expect(differing).toContain("judge llm: Azure Foundry / gpt-5.6-terra");
    expect(differing).toContain("(override)");
  });

  it("reports judge errors and a degraded run without failing it", () => {
    const out = formatEvalReport(judged({ judging: "degraded" }, { judgeErrored: 3 }), "x.yaml");

    expect(out).toContain("judge errors: 3");
    expect(out).toContain("Feedback judging stopped after repeated judge failures");
    expect(out).toContain("Eval passed");
  });

  it("counts flagged cases per file and in the batch TOTAL", () => {
    const out = formatEvalBatchReport(
      summarizeBatch([
        { source: "file:///a.eval.yaml", status: "ok", result: judged({}, { feedbackFlagged: 2 }) },
        { source: "file:///b.eval.yaml", status: "ok", result: judged({}, { feedbackFlagged: 1 }) },
      ]),
    );

    expect(out).toContain("2 flagged");
    expect(out).toContain("1 flagged");
    expect(out).toContain("TOTAL: 2 case(s), 2 passed, 0 failed, 0 errored, 3 flagged");
  });

  it("reports a zero flagged count per file and in the TOTAL once any file judged", () => {
    const out = formatEvalBatchReport(
      summarizeBatch([
        { source: "file:///a.eval.yaml", status: "ok", result: judged({}, { feedbackFlagged: 0 }) },
        { source: "file:///b.eval.yaml", status: "ok", result: judged({}, { feedbackFlagged: 0 }) },
      ]),
    );

    expect(out).toContain("a.eval.yaml: 1 case(s), 1 passed, 0 failed, 0 errored, 0 flagged");
    expect(out).toContain("TOTAL: 2 case(s), 2 passed, 0 failed, 0 errored, 0 flagged");
  });

  it("stays silent about flagged feedback in a batch where no file judged", () => {
    const unjudged = runResult({ input: 10, cachedInput: 0, output: 2 });
    const out = formatEvalBatchReport(
      summarizeBatch([{ source: "file:///a.eval.yaml", status: "ok", result: unjudged }]),
    );

    expect(out).not.toContain("flagged");
  });
});

describe("formatEvalReport — the required-tools check", () => {
  /** A tutor run whose single case does (or does not) declare `required_tools`. */
  const tutorRun = (requiredTools: string[] | undefined, toolsFlagged: boolean): EvalRunResult => {
    const base = runResult({ input: 10, cachedInput: 0, output: 2 });
    return {
      ...base,
      kind: "tutor",
      cases: [
        {
          index: 0,
          conversation: [{ student: "hi" }],
          ...(requiredTools ? { requiredTools } : {}),
          status: "ok",
          unstable: false,
          feedbackFlagged: false,
          toolsFlagged,
          repeats: [{ repeatIndex: 0, text: "hello" }],
        },
      ],
      totals: {
        ...base.totals,
        passed: 0,
        toolsFlagged: toolsFlagged ? 1 : 0,
      },
    } as EvalRunResult;
  };

  it("names the missing count once a case required a tool", () => {
    const out = formatEvalReport(tutorRun(["random_number"], true), "demo.eval.yaml");

    expect(out).toContain("missing tool calls: 1");
    // Reported, never gating.
    expect(out).toContain("Eval passed");
  });

  it("confirms a checked run with an explicit zero", () => {
    expect(formatEvalReport(tutorRun(["random_number"], false), "x.yaml")).toContain(
      "missing tool calls: 0",
    );
  });

  it("prints NO segment when no case required a tool", () => {
    // A run that checked nothing must never read as "every required tool ran".
    expect(formatEvalReport(tutorRun(undefined, false), "x.yaml")).not.toContain("tool calls");
  });

  it("follows the same rule per file and in the batch TOTAL", () => {
    const checkedBatch = formatEvalBatchReport(
      summarizeBatch([
        { source: "file:///a.eval.yaml", status: "ok", result: tutorRun(["random_number"], true) },
        { source: "file:///b.eval.yaml", status: "ok", result: tutorRun(undefined, false) },
      ]),
    );

    expect(checkedBatch).toContain(
      "a.eval.yaml: 1 conversation(s), 1 ok, 0 errored, 1 missing tool calls",
    );
    // The file that required nothing prints no segment of its own…
    expect(checkedBatch).toContain("b.eval.yaml: 1 conversation(s), 1 ok, 0 errored\n");
    // …but the TOTAL reports the batch's count, because SOME file checked.
    expect(checkedBatch).toContain("1 missing tool calls");

    const uncheckedBatch = formatEvalBatchReport(
      summarizeBatch([
        { source: "file:///a.eval.yaml", status: "ok", result: tutorRun(undefined, false) },
      ]),
    );
    expect(uncheckedBatch).not.toContain("tool calls");
  });
});
