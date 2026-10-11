import { describe, expect, it, vi } from "vitest";
import { CLOZE_JUDGE_CRITERIA, CLOZE_JUDGE_SYSTEM } from "@/lib/cloze-judge";
import type { EvalCheckOk } from "@/lib/eval-validate";
import {
  type ClozeCallResult,
  type ClozeFn,
  type EvalClozeCaseResult,
  type EvalRunResult,
  type JudgeFn,
  runEval,
} from "./eval-run";

// The CLOZE runner over a fake ClozeFn: the pre-pass deciding gaps locally (and sparing
// the calls entirely), the coverage retry, per-gap `expect` gating through the majority
// rule, `expect_patterns` reported, the grounding filter applied before the judge, a
// failed feedback call leaving the verdicts standing, and the auth abort.

const GAPS = [
  { number: 1, reference: "is going to" },
  { number: 2, reference: "starts", hint: "start" },
  { number: 3, reference: "" },
];

type Submission = {
  id: string;
  answers: Record<string, string>;
  expect?: Record<string, string | string[]>;
  expect_patterns?: number[][];
};

function checked(submissions: Submission[]): EvalCheckOk {
  return {
    ok: true,
    kind: "cloze",
    llm: { provider: "SCCH", model: "test-model" },
    evalFile: { kind: "cloze", id: "cloze-eval", target: "./c.yaml", submissions },
    targetUrl: "file:///tmp/c.yaml",
    clozeDump: {
      kind: "cloze",
      id: "c",
      llm: { provider: "SCCH", model: "test-model" },
      gapCount: 3,
      grading: { system: "GRADING-SYSTEM", userMessageTemplate: "", responseSchema: {} },
      feedback: { system: "FEEDBACK-SYSTEM", userMessageTemplate: "", responseSchema: {} },
    },
    clozeGaps: GAPS,
    caseCount: submissions.length,
    warnings: [],
  } as unknown as EvalCheckOk;
}

/** The gap list a grading/feedback user message carries. */
function entriesOf(user: string): { gap: number; answer: string; verdict?: string }[] {
  return JSON.parse(user.slice(user.indexOf("\n[") + 1));
}

/** A fake ClozeFn: grades every listed gap `incorrect` (or per `verdicts`), explains richly. */
function fakeCloze(verdicts: Record<number, string> = {}): ClozeFn & { mock: unknown } {
  return vi.fn(async ({ step, user }): Promise<ClozeCallResult> => {
    const entries = entriesOf(user);
    if (step === "grade") {
      return {
        ok: true,
        output: {
          gaps: entries.map(({ gap }) => ({
            gap,
            result: verdicts[gap] ?? "incorrect",
            reason: `reason ${gap}`,
          })),
        },
        usage: { input: 10, cachedInput: 0, output: 1 },
      };
    }
    const wrong = entries.filter((e) => e.verdict !== "correct").map((e) => e.gap);
    return {
      ok: true,
      output: {
        patterns: [
          { title: "Shared", explanation: "E", gaps: wrong, next_time: "N" },
          { title: "Lonely", explanation: "E", gaps: [wrong[0]], next_time: "N" },
        ],
        gap_notes: [
          ...wrong.map((gap) => ({ gap, note: `note ${gap}` })),
          { gap: 3, note: "on a correct gap" },
        ],
      },
      usage: { input: 20, cachedInput: 0, output: 2 },
    };
  }) as unknown as ClozeFn & { mock: unknown };
}

type ClozeRun = Omit<EvalRunResult, "cases"> & { cases: EvalClozeCaseResult[] };

async function run(
  submissions: Submission[],
  options: { cloze: ClozeFn; judge?: JudgeFn; repeats?: number },
): Promise<ClozeRun> {
  return (await runEval("cloze", checked(submissions), {
    llm: { provider: "SCCH", model: "test-model" },
    retry: { baseDelayMs: 0, sleep: async () => {} },
    ...options,
  })) as ClozeRun;
}

describe("cloze eval runner — pre-pass and grading", () => {
  it("makes NO call when the pre-pass decides every gap and all are correct", async () => {
    const cloze = fakeCloze();
    const result = await run(
      [
        {
          id: "exact",
          answers: { "1": "is  going to", "2": "starts" },
          expect: { "1": "correct" },
        },
      ],
      { cloze },
    );

    expect(cloze).not.toHaveBeenCalled();
    expect(result.cases[0]?.status).toBe("passed");
    expect(result.cases[0]?.gaps.map((gap) => gap.decidedBy)).toEqual([
      "pre-pass",
      "pre-pass",
      "pre-pass",
    ]);
    // No feedback asked for — nothing to judge either.
    expect(result.cases[0]?.repeats[0]?.cloze?.feedback).toBeUndefined();
  });

  it("sends only the undecided gaps to grading, and gates on per-gap expect", async () => {
    const cloze = fakeCloze({ 2: "partial" });
    const result = await run(
      [
        {
          id: "mixed",
          answers: { "1": "will", "2": "start" },
          expect: { "1": "incorrect", "2": ["partial", "incorrect"], "3": "correct" },
        },
        { id: "miss", answers: { "1": "is going to", "2": "start" }, expect: { "2": "correct" } },
      ],
      { cloze },
    );

    const gradeCall = vi.mocked(cloze).mock.calls[0]?.[0];
    expect(gradeCall?.step).toBe("grade");
    expect(gradeCall?.system).toBe("GRADING-SYSTEM");
    expect(entriesOf(gradeCall?.user ?? "").map((e) => e.gap)).toEqual([1, 2]);

    const [mixed, miss] = result.cases;
    expect(mixed?.status).toBe("passed");
    expect(mixed?.gaps.map((gap) => gap.verdict)).toEqual(["incorrect", "partial", "correct"]);
    expect(miss?.status).toBe("failed");
    expect(miss?.gaps[1]).toMatchObject({ verdict: "partial", passed: false });
    expect(result.mismatches).toEqual([miss]);
    expect(result.totals).toMatchObject({ passed: 1, failed: 1 });
    // Confusion over the gaps that state an expectation; `correct` was never false-graded.
    expect(result.confusion).toContainEqual({ expected: "correct", got: "partial", count: 1 });
    expect(result.falseCorrect).toEqual({ count: 0, denominator: 2, rate: 0 });
    // Usage sums both calls of a repeat.
    expect(mixed?.repeats[0]?.usage).toEqual({ input: 30, cachedInput: 0, output: 3 });
  });

  it("retries a grading that misses a gap once, then errors the repeat", async () => {
    const cloze = vi.fn(async (): Promise<ClozeCallResult> => ({ ok: true, output: { gaps: [] } }));
    const result = await run([{ id: "s", answers: { "1": "will" } }], { cloze });

    expect(cloze).toHaveBeenCalledTimes(2);
    expect(result.cases[0]?.status).toBe("errored");
    expect(result.totals.errored).toBe(1);
  });

  it("errors a repeat whose 2xx is not a grading object", async () => {
    const cloze = vi.fn(
      async (): Promise<ClozeCallResult> => ({ ok: true, output: "<html>sign in</html>" }),
    );
    const result = await run([{ id: "s", answers: { "1": "will" } }], { cloze });

    expect(result.cases[0]?.status).toBe("errored");
    expect(JSON.stringify(result.cases[0]?.repeats[0]?.error)).toContain("/api/eval/cloze");
  });

  it("aborts the run on an auth failure and skips the rest", async () => {
    const cloze = vi.fn(
      async (): Promise<ClozeCallResult> => ({
        ok: false,
        retryable: false,
        auth: true,
        error: { message: "401" },
      }),
    );
    const result = await runEval(
      "cloze",
      checked([
        { id: "a", answers: { "1": "will" } },
        { id: "b", answers: { "1": "will" } },
      ]),
      {
        cloze,
        llm: { provider: "SCCH", model: "m" },
        concurrency: 1,
        retry: { baseDelayMs: 0, sleep: async () => {} },
      },
    );

    expect(result.aborted?.reason).toBe("auth");
    expect(result.cases.map((c) => c.status)).toEqual(["errored", "skipped"]);
  });
});

describe("cloze eval runner — feedback, grounding and the judge", () => {
  it("grounds the feedback before judging it, and reports expect_patterns", async () => {
    const judge = vi.fn(async () => ({
      ok: true as const,
      issues: [{ criterion: "unsupported_pattern", note: "n" }],
    }));
    const cloze = fakeCloze();
    const result = await run(
      [
        {
          id: "s",
          answers: { "1": "will", "2": "start" },
          expect_patterns: [
            [1, 2],
            [1, 3],
          ],
        },
      ],
      { cloze, judge },
    );

    const detail = result.cases[0]?.repeats[0]?.cloze;
    expect(detail?.feedback?.patterns.map((p) => p.title)).toEqual(["Shared"]);
    expect(detail?.feedback?.dropped.patterns).toEqual([
      expect.objectContaining({ reason: "too-few-gaps" }),
    ]);
    expect(detail?.feedback?.dropped.gapNotes).toEqual([
      expect.objectContaining({ reason: "correct-gap" }),
    ]);
    expect(result.cases[0]?.patternChecks).toEqual([
      { gaps: [1, 2], grouped: 1, of: 1 },
      { gaps: [1, 3], grouped: 0, of: 1 },
    ]);

    const explainCall = vi.mocked(cloze).mock.calls[1]?.[0];
    expect(explainCall?.system).toBe("FEEDBACK-SYSTEM");
    const request = (judge.mock.calls as unknown[][])[0]?.[0] as {
      system: string;
      subject: string;
      criteria: string[];
    };
    expect(request.system).toBe(CLOZE_JUDGE_SYSTEM);
    expect(request.criteria).toEqual([...CLOZE_JUDGE_CRITERIA]);
    expect(request.subject).toContain("FEEDBACK-SYSTEM");
    expect(request.subject).toContain("Shared");
    expect(request.subject).not.toContain("Lonely");
    // Flagged, yet still passed — the judge reports and never gates.
    expect(result.cases[0]?.feedbackFlagged).toBe(true);
    expect(result.cases[0]?.status).toBe("passed");
  });

  it("keeps the verdicts when the feedback call fails, and judges nothing", async () => {
    const judge = vi.fn();
    const grader = fakeCloze();
    const cloze = vi.fn(async (request: Parameters<ClozeFn>[0]) =>
      request.step === "grade"
        ? grader(request)
        : ({ ok: false, retryable: false, error: { message: "boom" } } as ClozeCallResult),
    );
    const result = await run(
      [{ id: "s", answers: { "1": "will" }, expect: { "1": "incorrect" } }],
      {
        cloze,
        judge: judge as unknown as JudgeFn,
      },
    );

    expect(result.cases[0]?.status).toBe("passed");
    expect(result.cases[0]?.repeats[0]?.cloze?.feedbackError).toBe("boom");
    expect(result.cases[0]?.repeats[0]?.judge).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it("takes the majority per gap over repeats and marks disagreement unstable", async () => {
    let call = 0;
    const cloze = vi.fn(async (request: Parameters<ClozeFn>[0]) => {
      if (request.step === "grade") call += 1;
      return fakeCloze({ 1: call === 2 ? "partial" : "incorrect" })(request);
    });
    const result = await run(
      [{ id: "s", answers: { "1": "will" }, expect: { "1": "incorrect" } }],
      { cloze, repeats: 3 },
    );

    expect(result.cases[0]?.gaps[0]?.verdict).toBe("incorrect");
    expect(result.cases[0]?.unstable).toBe(true);
    expect(result.cases[0]?.status).toBe("passed");
    expect(result.totals.unstable).toBe(1);
  });
});
