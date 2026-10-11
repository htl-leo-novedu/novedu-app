import { buildClozeFeedbackMessage } from "@/lib/cloze-feedback-prompt";
import { buildClozeGradingMessage } from "@/lib/cloze-grading-prompt";
import { type ClozeGroundedFeedback, groundClozeFeedback } from "@/lib/cloze-grounding";
import {
  buildClozeJudgeSubject,
  CLOZE_JUDGE_CRITERIA,
  CLOZE_JUDGE_SYSTEM,
} from "@/lib/cloze-judge";
import {
  CLOZE_FEEDBACK_SCHEMA,
  CLOZE_GRADING_SCHEMA,
  type ClozeGradingOutput,
  clozeGradingCovers,
} from "@/lib/cloze-output-schemas";
import { runClozePrepass, undecidedGaps } from "@/lib/cloze-prepass";
import {
  EVAL_KINDS,
  EVAL_VERDICTS,
  type EvalConversationTurn,
  type EvalKind,
  type EvalVerdict,
  expectedKey,
  normalizeExpect,
  turnToMessage,
} from "@/lib/eval-schema";
import type {
  ClozeEvalCheckOk,
  EvalCheckOk,
  QuizEvalCheckOk,
  TutorEvalCheckOk,
} from "@/lib/eval-validate";
import type { ReasoningLevel } from "@/lib/llm/provider";
import type { PromptKind } from "@/lib/prompt-dump";
import {
  buildFeedbackJudgeSubject,
  FEEDBACK_JUDGE_CRITERIA,
  FEEDBACK_JUDGE_SYSTEM,
  type FeedbackJudgeIssue,
} from "@/lib/quiz-feedback-judge";
import { buildTutorJudgeSubject, TUTOR_JUDGE_SYSTEM, tutorJudgeCriteria } from "@/lib/tutor-judge";
import { mapWithConcurrency, withRetry } from "./retry";

// The PURE core of `novedu-cli eval`: turn a checked eval file into a finished run
// report by calling injected HTTP seams — a `GradeFn` per grading call (quiz kind) or a
// `RespondFn` per generated tutor turn (tutor kind), plus the kind-agnostic `JudgeFn`.
// No fetch, no auth, no I/O — everything the command needs to be unit-testable.
//
// ONE HIERARCHY governs the whole report:
//
//   a CASE is (questionId, answerIndex) — one golden answer;
//   a REPEAT is an OBSERVATION of that case (`--repeats N`).
//
// The case VERDICT is the majority over its successfully graded repeats (a tie passes
// only if EVERY tied verdict is expected); a case that was ATTEMPTED but got zero
// verdicts is `errored`, and a case never attempted at all (the run had already
// aborted) is `skipped` — reported honestly instead of inflating the errored count.
// Totals, mismatches, the confusion matrix, the false-correct rate and the exit code
// are ALL over case verdicts — never per-repeat rows, which would make `--repeats 3`
// strictly harsher than `--repeats 1` and the majority vote decorative. Per-repeat rows
// stay in the JSON as detail, plus an `unstable` count (cases whose repeats disagreed)
// that is REPORTED but never gates: grader nondeterminism is the actually interesting
// `--repeats` signal.
//
// THE FEEDBACK JUDGE is layered on top of that hierarchy without disturbing it: every
// SUCCESSFULLY GRADED repeat gets one judge call, as a dependent step of that repeat (no
// barrier over the file), judged against THAT repeat's own verdict — an outvoted repeat's
// feedback is consistent with the verdict it actually got, not with the case majority.
// A case is `feedbackFlagged` when ANY of its repeats collected an issue: one bad
// feedback out of three observations is exactly the signal `--repeats` is there to find,
// so there is deliberately no majority vote over judgments. NOTHING the judge reports
// touches `status`, `passed`, `batchPassed` or the exit code — it is report-only, the
// same philosophy as `unstable` (docs/cli-eval.md).
//
// THE TUTOR KIND reuses that whole machinery with a different pair of calls per repeat: a
// generated response (`RespondFn`) and then the judge over THAT repeat's own response. It
// has no verdict, so it has no `passed`/`failed`, no majority, no confusion matrix and no
// `unstable` — its case statuses are `ok` / `errored` / `skipped`, and it has two findings:
// the judge's, and the DETERMINISTIC `required_tools` check (did every tool the case
// demands get called at least once?). Both (per-kind policy) REPORT and never gate. One
// report shape serves every kind; renderers branch on `EvalRunResult.kind`.
//
// THE CLOZE KIND replays the app's cloze pipeline per repeat: the pre-pass and the
// grounding filter run HERE (pure lib code), the grading and feedback calls through the
// `ClozeFn` seam, then the judge over the feedback that survived. A case is one
// SUBMISSION; its per-gap `expect` gates through the quiz's majority rule, per gap, and
// `expect_patterns` and the judge only report.

/**
 * The eval kinds. Re-exported from the format module (`lib/eval-schema.ts`) so the
 * `kind` discriminator, the runner registry and the JSON can never name different sets.
 */
export type { EvalKind };
export { EVAL_KINDS };

// Every eval kind must be a kind `dumpPrompts` can produce prompts for — a compile-time
// tie rather than a comment, so adding a kind without a dumper fails the build.
const _evalKindsArePromptKinds: readonly PromptKind[] = EVAL_KINDS;
void _evalKindsArePromptKinds;

/**
 * Token usage, in the shape `POST /api/eval/grade` reports it: `input` is the total
 * input as the provider counted it — cached tokens INCLUDED — `cachedInput` the
 * cache-read portion of that, `output` the completion tokens.
 *
 * SEMANTICS (documented in docs/cli-eval.md): only SUCCESSFUL grading calls carry
 * usage, so every total built from it is a LOWER BOUND — the tokens a failed or
 * retried attempt burned are never counted, and a server that reports no usage at all
 * simply contributes nothing.
 */
export interface EvalUsage {
  input: number;
  cachedInput: number;
  output: number;
}

const ZERO_USAGE: EvalUsage = { input: 0, cachedInput: 0, output: 0 };

/** Add one call's usage into an accumulator (mutating it — internal to the sums below). */
function addUsage(total: EvalUsage, usage: EvalUsage | undefined): void {
  if (!usage) return;
  total.input += usage.input;
  total.cachedInput += usage.cachedInput;
  total.output += usage.output;
}

/** One grading call's outcome, as the HTTP seam reports it. */
export type GradeResult =
  | { ok: true; verdict: EvalVerdict; feedback: string; usage?: EvalUsage }
  | {
      ok: false;
      /** Worth another attempt: a 5xx or a true network failure. Any 4xx is terminal. */
      retryable: boolean;
      /** 401/403/not-signed-in — aborts the WHOLE run, never retried. */
      auth?: boolean;
      /** The failure payload, verbatim, for the report. */
      error: unknown;
    };

/** The injected HTTP seam: grade one answer with one grading prompt. */
export type GradeFn = (request: { system: string; answer: string }) => Promise<GradeResult>;

/** One generated tutor turn, as the HTTP seam reports it. */
export type RespondResult =
  | {
      ok: true;
      text: string;
      /**
       * The tool names the generation invoked, in call order, duplicates kept. ABSENT
       * (rather than `[]`) when the server did not report the field at all — a server
       * predating tool reporting, which the runner must never read as "called nothing".
       */
      toolCalls?: string[];
      usage?: EvalUsage;
    }
  | {
      ok: false;
      /** Worth another attempt: a 5xx or a true network failure. Any 4xx is terminal. */
      retryable: boolean;
      /** 401/403/not-signed-in — aborts the WHOLE run, never retried. */
      auth?: boolean;
      /** The failure payload, verbatim, for the report. */
      error: unknown;
    };

/**
 * The injected HTTP seam for ONE generated tutor turn: the tutor's assembled system
 * prompt, its `tools:` grant and the scripted conversation (ending on the student message
 * the model must answer). The tutor-kind sibling of {@link GradeFn}.
 */
export type RespondFn = (request: {
  system: string;
  tools: readonly string[];
  messages: readonly { role: "user" | "assistant"; text: string }[];
}) => Promise<RespondResult>;

/** One thing the judge found wrong with a feedback text — the `lib` wire type, re-exported. */
export type EvalJudgeIssue = FeedbackJudgeIssue;

/** One judge call's outcome, in the shape `POST /api/eval/judge` reports it. */
export type JudgeResult =
  | { ok: true; issues: EvalJudgeIssue[]; usage?: EvalUsage }
  | {
      ok: false;
      /** Worth another attempt: a 5xx or a true network failure. Any 4xx is terminal. */
      retryable: boolean;
      /** The failure payload, verbatim — recorded as `judgeError`, never as a case error. */
      error: unknown;
    };

/**
 * The injected HTTP seam for ONE judge call. Deliberately takes the ASSEMBLED prompt,
 * subject and taxonomy rather than an eval-kind's raw pieces: the endpoint is
 * kind-agnostic, and each kind's runner assembles its own subject (this one via
 * `lib/quiz-feedback-judge.ts`), so a future eval kind reuses both seam and endpoint
 * unchanged.
 */
export type JudgeFn = (request: {
  system: string;
  subject: string;
  criteria: readonly string[];
}) => Promise<JudgeResult>;

/**
 * Whether the run judged feedback at all: `"off"` when judging was not requested
 * (`--no-judge-feedback`), `"degraded"` when the breaker stopped it mid-run, `"on"`
 * otherwise. Carried per file so a report never has to guess why judgments are missing.
 */
export type EvalJudging = "on" | "off" | "degraded";

/**
 * The judge's run-wide circuit breaker, shared across EVERY file of a batch (unlike the
 * grading breaker, which is per file) — a judge model that is down must stop costing
 * calls for the rest of the run, not once per file.
 *
 * It DEGRADES rather than aborts: the grading half of a 252-case run must never be lost
 * to a broken judge, so judging simply stops and the run finishes.
 */
export interface JudgeBreaker {
  consecutiveErrors: number;
  stopped: boolean;
}

export function createJudgeBreaker(): JudgeBreaker {
  return { consecutiveErrors: 0, stopped: false };
}

/** Consecutive fully-errored judge calls that mean "stop judging for the rest of the run". */
const JUDGE_BREAKER_LIMIT = 3;

export interface EvalRunOptions {
  /** The QUIZ kind's generation seam. Required by `evalRunners.quiz`. */
  grade?: GradeFn;
  /** The TUTOR kind's generation seam. Required by `evalRunners.tutor`. */
  respond?: RespondFn;
  /** The CLOZE kind's seam (both calls). Required by `evalRunners.cloze`. */
  cloze?: ClozeFn;
  /**
   * The judge seam. ABSENT means judging is off for this run (`--no-judge-feedback`) —
   * no judge fields appear anywhere in the result.
   */
  judge?: JudgeFn;
  /** Shared across the batch's files, so degradation is run-wide (see {@link JudgeBreaker}). */
  judgeBreaker?: JudgeBreaker;
  /** Called ONCE, the moment judging degrades, so the command can warn on stderr. */
  onJudgeDegraded?: () => void;
  /** Cases in flight at once (repeats of a case run sequentially within it). */
  concurrency?: number;
  repeats?: number;
  /** The EFFECTIVE llm the grade calls use — recorded in the result, never used here. */
  llm: EvalRunLlm;
  /** Live counter; `done` counts completed GRADING CALLS out of `total`. */
  onProgress?: (progress: { done: number; total: number }) => void;
  /** Retry knobs, injected end to end so tests need no timers. */
  retry?: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> };
}

/**
 * ONE llm spec: the provider/model pair plus the OPTIONAL reasoning effort, absent when
 * no level applies (the parameter is then not sent at all). The shape every seam closes
 * over and every wire body carries — `reasoning` is omitted rather than sent as null, so
 * a run without a level keeps working against a server that never heard of the field.
 */
export interface EvalLlmSpec {
  provider: string;
  model: string;
  reasoning?: ReasoningLevel;
}

/** Which LLM a run actually graded with, and whether that came from `--llm-*`. */
export interface EvalRunLlm extends EvalLlmSpec {
  /**
   * The activity's OWN spec, kept alongside the effective one whenever the run overrode
   * anything about it — the pair (`--llm-provider/--llm-model`) or only the effort
   * (`--llm-reasoning`). Its presence is what makes a report say "override".
   */
  overrides?: EvalLlmSpec;
  /**
   * The spec the FEEDBACK JUDGE ran on, and whether it came from `--judge-llm-*` rather
   * than defaulting to the effective grading spec. Absent when judging was off — a run
   * that made no judge call must not advertise a judge model. Judge strictness varies by
   * model AND by effort, so two reports are only comparable when this matches.
   */
  judge?: EvalLlmSpec & { overridden: boolean };
}

/**
 * The spec a run's calls are actually served with, out of the TARGET activity's own spec
 * and the run's two override flags. TWO independent axes (docs/cli-eval.md):
 *
 * - the PAIR (`--llm-provider`/`--llm-model`) replaces provider+model **wholesale**, so a
 *   pair given without a level DROPS the file's level — the same bundle semantics a
 *   per-code LLM override has (`effectiveLlm`, docs/ai-models.md);
 * - the LEVEL (`--llm-reasoning`) replaces only the effort, on top of whichever pair won,
 *   which is what makes "the file's own model, at high effort" a one-flag run.
 *
 * The judge's flags reuse this with the EFFECTIVE grading spec as the activity, which is
 * why "no judge flag" means "judge exactly like the model under test", level included.
 */
export function resolveEvalSpec(
  activity: EvalLlmSpec,
  pair: { provider: string; model: string } | undefined,
  reasoning: ReasoningLevel | undefined,
): EvalLlmSpec {
  const base: EvalLlmSpec = pair ?? activity;
  // Rebuilt from the pair rather than spread, so the level never survives by accident:
  // `reasoning` must be exactly what this function decided.
  return reasoning ? { provider: base.provider, model: base.model, reasoning } : base;
}

/** Do two specs describe the same call? Provider, model AND effort — all three matter. */
export function sameEvalSpec(a: EvalLlmSpec, b: EvalLlmSpec): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoning === b.reasoning;
}

export interface EvalRepeatRow {
  repeatIndex: number;
  /** QUIZ: the verdict this observation produced. */
  got?: EvalVerdict;
  /** QUIZ: the feedback text the grader wrote for the student. */
  feedback?: string;
  /** TUTOR: the response the model generated for this observation, verbatim. */
  text?: string;
  /**
   * TUTOR: the tool names this generation invoked, verbatim — in call order, duplicates
   * kept, `[]` when it called nothing. Absent when the server reported no tool calls at
   * all (only possible on a case that declares no `required_tools`; a case that does
   * declare them turns that silence into an error instead — see the tutor runner).
   */
  toolCalls?: string[];
  /**
   * TUTOR: the `required_tools` this observation never called. Present ONLY on a case
   * that declares `required_tools`, so an empty array honestly means "all of them ran
   * here" and a missing key means "nothing was required" — never "nothing was checked".
   */
  missingTools?: string[];
  /** CLOZE: the verdicts, the grounded feedback and what was dropped, for this repeat. */
  cloze?: EvalClozeRepeatDetail;
  /** This ONE generation call's tokens (a cloze repeat: both calls), when reported. */
  usage?: EvalUsage;
  /** Present when this observation never produced a verdict. */
  error?: unknown;
  /**
   * The judge's verdict on THIS repeat's feedback: an empty `issues` array means the
   * feedback is acceptable, and `null` means this repeat produced no judgment (its
   * grading errored, its judge call failed, or the breaker had already degraded the run).
   * Present on EVERY repeat of a judged run; absent from the JSON only when judging was
   * off for the whole run, which `EvalRunResult.judging` already says.
   */
  judge?: { issues: EvalJudgeIssue[]; usage?: EvalUsage } | null;
  /** This repeat's judge call exhausted its retries. NEVER makes the case `errored`. */
  judgeError?: string;
}

interface EvalCaseBase {
  /**
   * `errored` = attempted but produced nothing; `skipped` = never attempted because the
   * run had already aborted (empty `repeats`). Both gate the exit code; only `errored`
   * appears in the mismatch listing (an aborted run must not print hundreds of lines).
   */
  status: "passed" | "failed" | "ok" | "errored" | "skipped";
  /** The repeats disagreed — reported, never gating. Always `false` for a tutor case. */
  unstable: boolean;
  /**
   * ANY repeat's output collected a judge issue. Reported, never gating — the same
   * standing as `unstable`. No majority vote: one bad response out of three observations
   * is precisely the signal `--repeats` exists to surface. (The name is the JSON's, kept
   * across kinds so one `summarizeBatch` and one report shape serve both.)
   */
  feedbackFlagged: boolean;
  /**
   * ANY repeat missed a tool the case's `required_tools` demanded. The exact sibling of
   * {@link EvalCaseBase.feedbackFlagged}: same any-repeat rule, same standing — reported,
   * never gating. Always `false` for a quiz case (the grader has no tools), kept on the
   * base so one `summarizeBatch` and one report shape serve both kinds.
   */
  toolsFlagged: boolean;
  repeats: EvalRepeatRow[];
}

/** One golden answer of a QUIZ eval — the case `(questionId, answerIndex)`. */
export interface EvalQuizCaseResult extends EvalCaseBase {
  questionId: string;
  /** 0-based index of the golden answer within its question. */
  answerIndex: number;
  expected: EvalVerdict[];
  /** The golden answer, verbatim (the report shows a snippet). */
  answer: string;
  status: "passed" | "failed" | "errored" | "skipped";
  /** The majority verdict over the graded repeats; absent when errored/skipped. */
  verdict?: EvalVerdict;
}

/** One scripted conversation of a TUTOR eval. */
export interface EvalTutorCaseResult extends EvalCaseBase {
  /** 0-based position in the file — the case's identity when it has no `title`. */
  index: number;
  /** The teacher's optional label, the case's stable report heading. */
  title?: string;
  /** The scripted turns, verbatim — the report prints them so a flag can be read. */
  conversation: EvalConversationTurn[];
  /** The teacher's per-case expectations, when this case states any. */
  gradingInstructions?: string;
  /**
   * The tools this case demands at least one call of, verbatim from the file. Absent when
   * the case declares none — which is what every renderer's "was this even checked?" rule
   * reads, so a run that required nothing never prints a reassuring zero.
   */
  requiredTools?: string[];
  /**
   * No verdict exists, so there is no `passed`/`failed`: a case either produced its
   * responses (`ok`) or did not. Judge findings and missing tool calls never change this —
   * both are report-only.
   */
  status: "ok" | "errored" | "skipped";
  unstable: false;
}

export type EvalCaseResult = EvalQuizCaseResult | EvalTutorCaseResult | EvalClozeCaseResult;

/** Narrow a case to the quiz arm (the union has no `kind` field — the JSON stays lean). */
export function isQuizCase(evalCase: EvalCaseResult): evalCase is EvalQuizCaseResult {
  return "questionId" in evalCase;
}

/** Narrow a case to the cloze arm. */
export function isClozeCase(evalCase: EvalCaseResult): evalCase is EvalClozeCaseResult {
  return "submissionId" in evalCase;
}

/** Narrow a case to the tutor arm. */
export function isTutorCase(evalCase: EvalCaseResult): evalCase is EvalTutorCaseResult {
  return "conversation" in evalCase;
}

export interface EvalConfusionRow {
  /** The canonical SORTED expected set, e.g. `correct|partial`. */
  expected: string;
  got: EvalVerdict;
  count: number;
}

export interface EvalRunResult {
  id: string;
  /** Which eval kind produced this result — the ONE field a renderer branches on. */
  kind: EvalKind;
  target: string;
  llm: EvalRunLlm;
  /** Whether this file's output was judged at all ({@link EvalJudging}). */
  judging: EvalJudging;
  totals: {
    cases: number;
    /** QUIZ only — a tutor file has no verdict to pass, so it reports `0`. */
    passed: number;
    /** QUIZ only — likewise `0` for a tutor file. */
    failed: number;
    errored: number;
    /** Cases never attempted because the run aborted first. */
    skipped: number;
    /** QUIZ only — a tutor run makes no majority vote, so it reports `0`. */
    unstable: number;
    /** CASES whose output the judge flagged — reported, never gating, both kinds. */
    feedbackFlagged: number;
    /** TUTOR only: CASES that missed a required tool call — reported, never gating. */
    toolsFlagged: number;
    /** REPEATS whose judge call exhausted its retries (the generation still counted). */
    judgeErrored: number;
    repeats: number;
    /** Generation calls this run intended to make (cases × repeats). */
    calls: number;
    /**
     * Summed over every repeat row that reported usage — GENERATION **and** judge calls,
     * in one bucket on purpose (one eval run is one cost). A LOWER bound
     * ({@link EvalUsage}).
     */
    usage: EvalUsage;
  };
  /**
   * Every case the human report must list: quiz cases that failed or errored, tutor
   * cases that errored. (`skipped` is deliberately absent — see the runners.)
   */
  mismatches: EvalCaseResult[];
  cases: EvalCaseResult[];
  /**
   * QUIZ only: the evaluated questions' TEXT (id + Markdown), in eval-file order — so a
   * report can show the question a mismatched answer belongs to without re-reading the
   * quiz. Empty for a tutor run, whose cases carry their conversation instead.
   */
  questions: { id: string; text: string }[];
  /** QUIZ only; empty for a tutor run, which has no verdicts to confuse. */
  confusion: EvalConfusionRow[];
  /**
   * QUIZ only: cases the grader called `correct` although `correct` was NOT acceptable,
   * over ALL cases whose expected set excludes `correct` (the pinned denominator). All
   * zeros for a tutor run.
   */
  falseCorrect: { count: number; denominator: number; rate: number };
  /** Set when the run stopped early; the untouched cases are reported as `skipped`. */
  aborted?: { reason: "auth" | "circuit-breaker"; message: string };
}

export interface EvalRunner {
  run(checked: EvalCheckOk, options: EvalRunOptions): Promise<EvalRunResult>;
}

/** Consecutive fully-errored cases that mean "the server is down, stop now". */
const CIRCUIT_BREAKER_LIMIT = 3;

interface PlannedCase {
  questionId: string;
  answerIndex: number;
  expected: EvalVerdict[];
  answer: string;
  system: string | undefined;
}

/** Flatten questions × answers into cases, each carrying its grading prompt. */
function planCases(checked: QuizEvalCheckOk): PlannedCase[] {
  const systemById = new Map(
    checked.quizDump.grading.questions.map((question) => [question.id, question.system]),
  );
  const cases: PlannedCase[] = [];
  for (const question of checked.evalFile.questions) {
    question.answers.forEach((answer, answerIndex) => {
      cases.push({
        questionId: question.question,
        answerIndex,
        expected: normalizeExpect(answer.expect),
        answer: answer.answer,
        system: systemById.get(question.question),
      });
    });
  }
  return cases;
}

/**
 * The majority verdict over the graded repeats. Returns the winner plus whether the
 * case PASSES: a unique majority passes when it is expected; a TIE passes only when
 * every tied verdict is expected (so a coin-flip between two acceptable gradings is a
 * pass, and one between an acceptable and an unacceptable one is not).
 */
function majority(
  graded: EvalVerdict[],
  expected: readonly EvalVerdict[],
): { verdict: EvalVerdict; passed: boolean } | undefined {
  if (graded.length === 0) return undefined;
  const counts = new Map<EvalVerdict, number>();
  for (const verdict of graded) counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const tied = [...counts.entries()]
    .filter(([, count]) => count === top)
    .map(([verdict]) => verdict)
    .sort((a, b) => EVAL_VERDICTS.indexOf(a) - EVAL_VERDICTS.indexOf(b));
  return {
    // Canonical pick so a tie always reports the same verdict for the same repeats.
    verdict: tied[0] as EvalVerdict,
    passed: tied.every((verdict) => expected.includes(verdict)),
  };
}

/**
 * The confusion matrix and the false-correct rate over verdict UNITS — quiz cases, or
 * the cloze gaps that state an expectation. Rows are keyed by the canonical SORTED
 * expected set (never "first-listed", which would make the matrix depend on the
 * author's list order); a unit without a verdict (errored) is not in the matrix. The
 * false-correct denominator is EVERY unit whose expected set excludes `correct`, errored
 * ones included, so it cannot be gamed by failures.
 */
function confusionStats(
  units: readonly { expected: readonly EvalVerdict[]; verdict?: EvalVerdict }[],
): Pick<EvalRunResult, "confusion" | "falseCorrect"> {
  const counts = new Map<string, number>();
  for (const unit of units) {
    if (!unit.verdict) continue;
    const key = `${expectedKey(unit.expected)}\u0000${unit.verdict}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const confusion: EvalConfusionRow[] = [...counts.entries()]
    .map(([key, count]) => {
      const [expected = "", got = ""] = key.split("\u0000");
      return { expected, got: got as EvalVerdict, count };
    })
    .sort((a, b) => a.expected.localeCompare(b.expected) || a.got.localeCompare(b.got));
  const strict = units.filter((unit) => !unit.expected.includes("correct"));
  const count = strict.filter((unit) => unit.verdict === "correct").length;
  return {
    confusion,
    falseCorrect: {
      count,
      denominator: strict.length,
      rate: strict.length === 0 ? 0 : count / strict.length,
    },
  };
}

/** A 2xx whose body is not the step's structured output. */
const NOT_A_CLOZE_ANSWER =
  "The server's response is not a cloze grading or feedback object — it may not offer " +
  "/api/eval/cloze at all. Check the target server, e.g. --server http://localhost:3000.";

/** The one-line message a failed judge call leaves on its repeat row. */
function judgeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return JSON.stringify(error ?? null);
}

/**
 * The `judge` field of a repeat that produced NO judgment — spread onto every row that
 * is not a successful generation. Judging on ⇒ an explicit `null` (so a script reading
 * `judge === null` catches every unjudged repeat, not only the degraded ones); judging
 * off ⇒ nothing at all, since the whole run then carries no judge fields.
 */
function unjudgedFields(
  options: EvalRunOptions,
): Pick<EvalRepeatRow, "judge"> | Record<string, never> {
  return options.judge ? { judge: null } : {};
}

/**
 * The KIND-AGNOSTIC judge step: judge ONE repeat's output as a dependent step of that
 * repeat, retrying and feeding the run-wide degrade breaker. Each kind assembles its own
 * `system` / `subject` / `criteria` (quiz via `lib/quiz-feedback-judge.ts`, tutor via
 * `lib/tutor-judge.ts`) — the endpoint and this step never learn the kind.
 *
 * Returns the fields to merge onto the row: a judgment, or `judge: null` plus a
 * `judgeError` when the call failed, or a bare `judge: null` when the breaker had
 * already degraded the run.
 */
function createJudgeStep(options: EvalRunOptions, breaker: JudgeBreaker) {
  return async (request: {
    system: string;
    subject: string;
    criteria: readonly string[];
  }): Promise<Pick<EvalRepeatRow, "judge" | "judgeError">> => {
    const judge = options.judge;
    if (!judge || breaker.stopped) return { judge: null };
    const outcome = await withRetry(() => judge(request), {
      attempts: options.retry?.attempts,
      baseDelayMs: options.retry?.baseDelayMs,
      sleep: options.retry?.sleep,
      // `!breaker.stopped` re-reads the SHARED breaker between attempts: judge calls
      // already in flight when a concurrent one trips it would otherwise keep burning
      // their full budget against a judge the run has already given up on.
      shouldRetry: (value) => !value.ok && value.retryable && !breaker.stopped,
    });
    if (outcome.ok) {
      breaker.consecutiveErrors = 0;
      return {
        judge: {
          issues: outcome.issues,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        },
      };
    }
    // DEGRADE, never abort: the generation half of the run must survive a down judge.
    breaker.consecutiveErrors += 1;
    if (!breaker.stopped && breaker.consecutiveErrors >= JUDGE_BREAKER_LIMIT) {
      breaker.stopped = true;
      options.onJudgeDegraded?.();
    }
    return { judge: null, judgeError: judgeErrorMessage(outcome.error) };
  };
}

const quizEvalRunner: EvalRunner = {
  async run(rawChecked, options) {
    if (rawChecked.kind !== "quiz") throw new Error("The quiz eval runner needs a quiz eval file.");
    const checked: QuizEvalCheckOk = rawChecked;
    const grade = options.grade;
    if (!grade) throw new Error("The quiz eval runner needs a `grade` seam.");
    const repeats = Math.max(1, Math.floor(options.repeats ?? 1));
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
    const planned = planCases(checked);
    const total = planned.length * repeats;
    const questionTexts = new Map(checked.quizQuestions.map((q) => [q.id, q.text]));
    // Absent breaker ⇒ this file owns one; the command passes a shared instance so
    // degradation carries across a batch.
    const breaker = options.judgeBreaker ?? createJudgeBreaker();
    const judgeStep = createJudgeStep(options, breaker);

    let done = 0;
    let consecutiveErrored = 0;
    let aborted: EvalRunResult["aborted"];

    const unjudged = unjudgedFields(options);

    /**
     * Judge ONE graded repeat's feedback, against the repeat's OWN verdict — never the
     * case majority: an outvoted repeat's feedback is consistent with the verdict it
     * actually got.
     */
    const judgeRepeat = (system: string, answer: string, verdict: EvalVerdict, feedback: string) =>
      judgeStep({
        system: FEEDBACK_JUDGE_SYSTEM,
        subject: buildFeedbackJudgeSubject(system, answer, verdict, feedback),
        criteria: FEEDBACK_JUDGE_CRITERIA,
      });

    const progress = () => {
      done += 1;
      options.onProgress?.({ done, total });
    };

    const results = await mapWithConcurrency(
      planned,
      concurrency,
      async (plan): Promise<EvalQuizCaseResult> => {
        const rows: EvalRepeatRow[] = [];
        for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
          // Once the run is aborted, remaining repeats are simply not attempted — no
          // filler error rows; a case with ZERO rows becomes `skipped` below.
          if (aborted) break;
          if (plan.system === undefined) {
            // Unreachable after `loadAndCheckEval` (unknown ids are rejected there);
            // fail the CASE rather than the run if it ever happens.
            rows.push({
              repeatIndex,
              error: { message: `The quiz has no question "${plan.questionId}".` },
              ...unjudged,
            });
            progress();
            continue;
          }
          const outcome = await withRetry(
            () => grade({ system: plan.system as string, answer: plan.answer }),
            {
              attempts: options.retry?.attempts,
              baseDelayMs: options.retry?.baseDelayMs,
              sleep: options.retry?.sleep,
              // ONLY 5xx + true network failures. Auth failures and any other 4xx are
              // terminal — retrying them would just burn the budget.
              shouldRetry: (value) => !value.ok && value.retryable && value.auth !== true,
            },
          );
          if (outcome.ok) {
            // The judge call is a DEPENDENT step of this repeat, not a barrier over the
            // file: only a successfully graded repeat has feedback worth auditing. The
            // progress tick happens AFTER it, so the counter never reads "done" while
            // minutes of judging (or judge retries) are still to come.
            const judged = options.judge
              ? await judgeRepeat(plan.system, plan.answer, outcome.verdict, outcome.feedback)
              : {};
            progress();
            rows.push({
              repeatIndex,
              got: outcome.verdict,
              feedback: outcome.feedback,
              // Absent on a server that reports no usage — tolerated everywhere, never
              // faked as zeros (see EvalUsage).
              ...(outcome.usage ? { usage: outcome.usage } : {}),
              ...judged,
            });
            continue;
          }
          progress();
          rows.push({ repeatIndex, error: outcome.error, ...unjudged });
          if (outcome.auth) {
            // Token expiry mid-run is a real risk on a 252 × 3 run; abort with ONE
            // clear message instead of hundreds of per-case auth errors.
            aborted ??= {
              reason: "auth",
              message: "Authentication failed — the run was aborted. Run `novedu-cli login`.",
            };
            break;
          }
        }

        const graded = rows.flatMap((row) => (row.got ? [row.got] : []));
        const winner = majority(graded, plan.expected);
        const status: EvalQuizCaseResult["status"] =
          rows.length === 0 ? "skipped" : !winner ? "errored" : winner.passed ? "passed" : "failed";

        // Circuit breaker: a down server must fail the run in seconds, not after
        // 252 × 4 attempts × backoff. Counted over COMPLETIONS; any graded case resets.
        // `skipped` cases are consequences of an abort, never causes — they don't count.
        if (status === "errored") {
          consecutiveErrored += 1;
          if (consecutiveErrored >= CIRCUIT_BREAKER_LIMIT) {
            aborted ??= {
              reason: "circuit-breaker",
              message: `${CIRCUIT_BREAKER_LIMIT} cases failed in a row — the run was aborted.`,
            };
          }
        } else if (status !== "skipped") {
          consecutiveErrored = 0;
        }

        return {
          questionId: plan.questionId,
          answerIndex: plan.answerIndex,
          expected: plan.expected,
          answer: plan.answer,
          status,
          ...(winner ? { verdict: winner.verdict } : {}),
          unstable: new Set(graded).size > 1,
          // ANY repeat, never a majority — see the header.
          feedbackFlagged: rows.some((row) => (row.judge?.issues.length ?? 0) > 0),
          // The grader has no tools, so this is structurally false — carried only so both
          // kinds share one case shape.
          toolsFlagged: false,
          repeats: rows,
        };
      },
    );

    // Tokens over every SUCCESSFUL call of the run — grading AND judging, one bucket by
    // design (failed/retried attempts report nothing, so this is honestly a lower bound).
    // Always present — zeros mean "nothing was reported", which the renderers read as
    // "print no tokens line".
    const usage: EvalUsage = { ...ZERO_USAGE };
    for (const result of results) {
      for (const row of result.repeats) {
        addUsage(usage, row.usage);
        addUsage(usage, row.judge?.usage);
      }
    }

    const totals = {
      cases: results.length,
      passed: results.filter((c) => c.status === "passed").length,
      failed: results.filter((c) => c.status === "failed").length,
      errored: results.filter((c) => c.status === "errored").length,
      skipped: results.filter((c) => c.status === "skipped").length,
      unstable: results.filter((c) => c.unstable).length,
      feedbackFlagged: results.filter((c) => c.feedbackFlagged).length,
      toolsFlagged: 0,
      judgeErrored: results.reduce(
        (sum, c) => sum + c.repeats.filter((row) => row.judgeError !== undefined).length,
        0,
      ),
      repeats,
      calls: total,
      usage,
    };

    const verdictStats = confusionStats(results);

    return {
      id: checked.evalFile.id,
      kind: "quiz",
      target: checked.targetUrl,
      llm: options.llm,
      // `degraded` covers the rest of the batch too: once the breaker trips, every later
      // file judged nothing, and saying "on" there would misread as "nothing was flagged".
      judging: !options.judge ? "off" : breaker.stopped ? "degraded" : "on",
      totals,
      // The evaluated questions' text, deduped in eval-file order. Carried in the JSON
      // (and used by the Markdown report) so a reader never has to open the quiz to
      // understand a mismatch. A question the quiz text could not be re-read for keeps
      // its id with an empty text rather than disappearing.
      questions: [...new Set(checked.evalFile.questions.map((question) => question.question))].map(
        (id) => ({ id, text: questionTexts.get(id) ?? "" }),
      ),
      // `skipped` is deliberately NOT listed here: an aborted 252-case run must print
      // one abort line + a count, not hundreds of identical rows. It still gates.
      mismatches: results.filter(
        (result) => result.status === "failed" || result.status === "errored",
      ),
      cases: results,
      ...verdictStats,
      ...(aborted ? { aborted } : {}),
    };
  },
};

interface PlannedTutorCase {
  index: number;
  title?: string;
  conversation: EvalConversationTurn[];
  gradingInstructions?: string;
  /** The tools this case demands at least one call of; absent when it demands none. */
  requiredTools?: string[];
  /** The scripted turns on the wire — `student`/`tutor` mapped to `user`/`assistant`. */
  messages: { role: "user" | "assistant"; text: string }[];
}

/** One planned case per conversation, in file order. */
function planTutorCases(checked: TutorEvalCheckOk): PlannedTutorCase[] {
  return checked.evalFile.conversations.map((conversation, index) => ({
    index,
    ...(conversation.title ? { title: conversation.title } : {}),
    conversation: conversation.conversation,
    ...(conversation.grading_instructions
      ? { gradingInstructions: conversation.grading_instructions }
      : {}),
    ...(conversation.required_tools ? { requiredTools: [...conversation.required_tools] } : {}),
    messages: conversation.conversation.map(turnToMessage),
  }));
}

/**
 * The message a repeat carries when the case REQUIRES tools but the 200 answered without a
 * `toolCalls` field: a new CLI against a server too old to report them. Terminal and loud
 * — reporting "nothing missing" for a check that never ran would certify a tool
 * expectation nobody verified, which is worse than failing. The advisory `/api/version`
 * check cannot carry this: it only warns (never gates, never compares an ordering), while
 * this must fail the run's health.
 */
const NO_TOOL_CALLS_REPORTED =
  "This case declares `required_tools`, but the server's answer carried no tool calls — " +
  "it is too old to report them, so the requirement could not be checked. Update the " +
  "Novedu server, or remove `required_tools` from this case.";

/** The required tools this repeat never called, in the case's own order. */
function missingToolsOf(required: readonly string[], called: readonly string[]): string[] {
  const seen = new Set(called);
  return required.filter((tool) => !seen.has(tool));
}

/**
 * The TUTOR runner: one generated turn per repeat, judged against the tutor's own system
 * prompt plus the case's expectations. Shares every piece of machinery with the quiz
 * runner (retry, concurrency, the auth abort, the generation circuit breaker, the judge
 * breaker) and differs only in what a "case" is and in having no verdict — hence no
 * majority, no confusion matrix, no `unstable`, and a report-only judge as the sole
 * finding.
 */
const tutorEvalRunner: EvalRunner = {
  async run(rawChecked, options) {
    if (rawChecked.kind !== "tutor") {
      throw new Error("The tutor eval runner needs a tutor eval file.");
    }
    const checked: TutorEvalCheckOk = rawChecked;
    const respond = options.respond;
    if (!respond) throw new Error("The tutor eval runner needs a `respond` seam.");
    const repeats = Math.max(1, Math.floor(options.repeats ?? 1));
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
    const planned = planTutorCases(checked);
    const total = planned.length * repeats;
    const system = checked.tutorDump.system;
    const tools = checked.tutorDump.tools;
    const breaker = options.judgeBreaker ?? createJudgeBreaker();
    const judgeStep = createJudgeStep(options, breaker);

    let done = 0;
    let consecutiveErrored = 0;
    let aborted: EvalRunResult["aborted"];

    const unjudged = unjudgedFields(options);

    const progress = () => {
      done += 1;
      options.onProgress?.({ done, total });
    };

    const results = await mapWithConcurrency(
      planned,
      concurrency,
      async (plan): Promise<EvalTutorCaseResult> => {
        const rows: EvalRepeatRow[] = [];
        for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
          // Once the run is aborted, remaining repeats are simply not attempted — no
          // filler error rows; a case with ZERO rows becomes `skipped` below.
          if (aborted) break;
          const outcome = await withRetry(
            () => respond({ system, tools, messages: plan.messages }),
            {
              attempts: options.retry?.attempts,
              baseDelayMs: options.retry?.baseDelayMs,
              sleep: options.retry?.sleep,
              // ONLY 5xx + true network failures. Auth failures and any other 4xx are
              // terminal — retrying them would just burn the budget.
              shouldRetry: (value) => !value.ok && value.retryable && value.auth !== true,
            },
          );
          if (outcome.ok) {
            // A case that REQUIRES tools against a server that reports none cannot be
            // checked at all — fail it loudly (run health) instead of silently reporting
            // "nothing missing". Terminal: another attempt would answer the same way.
            if (plan.requiredTools && outcome.toolCalls === undefined) {
              progress();
              rows.push({
                repeatIndex,
                error: { message: NO_TOOL_CALLS_REPORTED },
                ...unjudged,
              });
              break;
            }
            const missingTools = plan.requiredTools
              ? missingToolsOf(plan.requiredTools, outcome.toolCalls ?? [])
              : undefined;
            // The judge call is a DEPENDENT step of this repeat: it audits THIS repeat's
            // own generated response, never another's. The progress tick happens AFTER
            // it, so the counter never reads "done" while judging is still to come.
            const judged = options.judge
              ? await judgeStep({
                  system: TUTOR_JUDGE_SYSTEM,
                  subject: buildTutorJudgeSubject(system, plan.conversation, outcome.text, {
                    ...(plan.gradingInstructions
                      ? { gradingInstructions: plan.gradingInstructions }
                      : {}),
                    // EVIDENCE only: the tool block appears when this tutor HAS tools and
                    // the server reported what ran. Whether a REQUIRED tool ran is decided
                    // above, deterministically — never by the judge.
                    tools,
                    ...(outcome.toolCalls ? { toolCalls: outcome.toolCalls } : {}),
                  }),
                  // A case that states no expectations drops `fails_expectations`, so the
                  // judge cannot invent expectations nobody wrote.
                  criteria: tutorJudgeCriteria(plan.gradingInstructions !== undefined),
                })
              : {};
            progress();
            rows.push({
              repeatIndex,
              text: outcome.text,
              ...(outcome.toolCalls ? { toolCalls: outcome.toolCalls } : {}),
              // Present exactly when the case demanded tools — an empty array then means
              // "all of them ran", which is a real (and reassuring) measurement.
              ...(missingTools ? { missingTools } : {}),
              ...(outcome.usage ? { usage: outcome.usage } : {}),
              ...judged,
            });
            continue;
          }
          progress();
          rows.push({ repeatIndex, error: outcome.error, ...unjudged });
          if (outcome.auth) {
            aborted ??= {
              reason: "auth",
              message: "Authentication failed — the run was aborted. Run `novedu-cli login`.",
            };
            break;
          }
        }

        const generated = rows.some((row) => row.text !== undefined);
        const status: EvalTutorCaseResult["status"] =
          rows.length === 0 ? "skipped" : generated ? "ok" : "errored";

        // Circuit breaker: a down server must fail the run in seconds. Same rule as the
        // quiz runner — counted over COMPLETIONS, any produced case resets it, and
        // `skipped` cases are consequences of an abort rather than causes.
        if (status === "errored") {
          consecutiveErrored += 1;
          if (consecutiveErrored >= CIRCUIT_BREAKER_LIMIT) {
            aborted ??= {
              reason: "circuit-breaker",
              message: `${CIRCUIT_BREAKER_LIMIT} cases failed in a row — the run was aborted.`,
            };
          }
        } else if (status !== "skipped") {
          consecutiveErrored = 0;
        }

        return {
          index: plan.index,
          ...(plan.title ? { title: plan.title } : {}),
          conversation: plan.conversation,
          ...(plan.gradingInstructions ? { gradingInstructions: plan.gradingInstructions } : {}),
          ...(plan.requiredTools ? { requiredTools: plan.requiredTools } : {}),
          status,
          unstable: false,
          // ANY repeat, never a majority — one flagged response out of three is exactly
          // the `--repeats` signal.
          feedbackFlagged: rows.some((row) => (row.judge?.issues.length ?? 0) > 0),
          // Same any-repeat rule, same standing: a tool the tutor skipped once out of
          // three is precisely what `--repeats` exists to surface. Reported, never gating.
          toolsFlagged: rows.some((row) => (row.missingTools?.length ?? 0) > 0),
          repeats: rows,
        };
      },
    );

    const usage: EvalUsage = { ...ZERO_USAGE };
    for (const result of results) {
      for (const row of result.repeats) {
        addUsage(usage, row.usage);
        addUsage(usage, row.judge?.usage);
      }
    }

    return {
      id: checked.evalFile.id,
      kind: "tutor",
      target: checked.targetUrl,
      llm: options.llm,
      judging: !options.judge ? "off" : breaker.stopped ? "degraded" : "on",
      totals: {
        cases: results.length,
        // A tutor case has no verdict, so it can neither pass nor fail a comparison —
        // the kind-agnostic fields stay 0 and the exit-code rule (which only looks at
        // failed/errored/skipped) works unchanged.
        passed: 0,
        failed: 0,
        errored: results.filter((c) => c.status === "errored").length,
        skipped: results.filter((c) => c.status === "skipped").length,
        unstable: 0,
        feedbackFlagged: results.filter((c) => c.feedbackFlagged).length,
        toolsFlagged: results.filter((c) => c.toolsFlagged).length,
        judgeErrored: results.reduce(
          (sum, c) => sum + c.repeats.filter((row) => row.judgeError !== undefined).length,
          0,
        ),
        repeats,
        calls: total,
        usage,
      },
      // Quiz-only surfaces, empty by construction for this kind.
      questions: [],
      confusion: [],
      falseCorrect: { count: 0, denominator: 0, rate: 0 },
      // Only `errored` cases: a flagged case is REPORTED, never a failure, so it must not
      // appear in the list a reader reads as "what went wrong with the run".
      mismatches: results.filter((result) => result.status === "errored"),
      cases: results,
      ...(aborted ? { aborted } : {}),
    };
  },
};

/** How a cloze gap's verdict was decided: by the deterministic pre-pass, or by the model. */
export type ClozeDecidedBy = "pre-pass" | "model";

/** ONE gap's outcome in one cloze repeat. */
export interface EvalClozeRepeatGap {
  gap: number;
  verdict: EvalVerdict;
  decidedBy: ClozeDecidedBy;
  /** The grading call's one-sentence reason (model-decided gaps only). Never shown to students. */
  reason?: string;
}

/** What ONE cloze repeat produced, beyond the shared row fields. */
export interface EvalClozeRepeatDetail {
  /** Every gap's final verdict, in reading order. */
  gaps: EvalClozeRepeatGap[];
  /**
   * The feedback AFTER the grounding filter — exactly what a student would see — plus
   * what the filter dropped and why. Absent when every gap was correct (the app asks for
   * no feedback then) or when the feedback call failed.
   */
  feedback?: ClozeGroundedFeedback;
  /** The feedback call failed; the verdicts still count (a student would see them). */
  feedbackError?: string;
}

/** One gap of a cloze case: the submission's answer, the expectation and the outcome. */
export interface EvalClozeGapResult {
  gap: number;
  /** The teacher's reference — the "possible answer" (`""` = nothing belongs here). */
  reference: string;
  /** The submitted answer, `""` for a gap left empty. */
  answer: string;
  /** The acceptable verdicts, canonical order — absent when the gap states no `expect`. */
  expected?: EvalVerdict[];
  /** The majority verdict over the graded repeats; absent when errored/skipped. */
  verdict?: EvalVerdict;
  decidedBy?: ClozeDecidedBy;
  /** Whether the majority meets `expected` — present only when the gap has one. */
  passed?: boolean;
}

/** One `expect_patterns` entry and how many feedback repeats grouped it. REPORTED only. */
export interface EvalClozePatternCheck {
  gaps: number[];
  /** Repeats in which ONE surviving pattern cited every gap of the set. */
  grouped: number;
  /** Repeats that produced feedback at all — the denominator. */
  of: number;
}

/** One submission of a CLOZE eval. */
export interface EvalClozeCaseResult extends EvalCaseBase {
  submissionId: string;
  status: "passed" | "failed" | "errored" | "skipped";
  gaps: EvalClozeGapResult[];
  /** Present only when the submission states `expect_patterns`. */
  patternChecks?: EvalClozePatternCheck[];
}

/** One call of the cloze pipeline, as the HTTP seam reports it. */
export type ClozeCallResult =
  | {
      ok: true;
      /** The step's structured output, unparsed — the runner checks it against the schema. */
      output: unknown;
      usage?: EvalUsage;
    }
  | {
      ok: false;
      /** Worth another attempt: a 5xx or a true network failure. Any 4xx is terminal. */
      retryable: boolean;
      /** 401/403/not-signed-in — aborts the WHOLE run, never retried. */
      auth?: boolean;
      /** The failure payload, verbatim, for the report. */
      error: unknown;
    };

/**
 * The injected HTTP seam for ONE cloze call (`POST /api/eval/cloze`): the step, its
 * assembled system prompt and its user message — the cloze kind's sibling of
 * {@link GradeFn}.
 */
export type ClozeFn = (request: {
  step: "grade" | "explain";
  system: string;
  user: string;
}) => Promise<ClozeCallResult>;

interface PlannedClozeCase {
  index: number;
  submissionId: string;
  /** Index-aligned with the exercise's gaps (gap N is `[N - 1]`); `""` = left empty. */
  answers: string[];
  /** Index-aligned too; `undefined` where the gap states no expectation. */
  expected: (EvalVerdict[] | undefined)[];
  expectPatterns?: number[][];
}

function planClozeCases(checked: ClozeEvalCheckOk): PlannedClozeCase[] {
  return checked.evalFile.submissions.map((submission, index) => ({
    index,
    submissionId: submission.id,
    answers: checked.clozeGaps.map((gap) => submission.answers[String(gap.number)] ?? ""),
    expected: checked.clozeGaps.map((gap) => {
      const expect = submission.expect?.[String(gap.number)];
      return expect === undefined ? undefined : normalizeExpect(expect);
    }),
    ...(submission.expect_patterns ? { expectPatterns: submission.expect_patterns } : {}),
  }));
}

/** Does ONE surviving pattern cite every gap of `set`? */
function groupedBy(patterns: readonly { gaps: number[] }[], set: readonly number[]): boolean {
  return patterns.some((pattern) => set.every((gap) => pattern.gaps.includes(gap)));
}

/**
 * The CLOZE runner: per repeat, the app's own pipeline replayed locally around two server
 * calls — the pre-pass, ONE grading call for the gaps it left undecided (retried once on
 * a coverage mismatch, like `gradeCloze`), ONE feedback call over the final verdicts
 * (skipped when all are correct, like the app), the grounding filter, then the judge over
 * what survived. `expect` gates per gap through the same majority rule as the quiz kind;
 * `expect_patterns` and the judge only report.
 */
const clozeEvalRunner: EvalRunner = {
  async run(rawChecked, options) {
    if (rawChecked.kind !== "cloze")
      throw new Error("The cloze eval runner needs a cloze eval file.");
    const checked: ClozeEvalCheckOk = rawChecked;
    const call = options.cloze;
    if (!call) throw new Error("The cloze eval runner needs a `cloze` seam.");
    const repeats = Math.max(1, Math.floor(options.repeats ?? 1));
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
    const planned = planClozeCases(checked);
    const total = planned.length * repeats;
    const gaps = checked.clozeGaps;
    const gradingSystem = checked.clozeDump.grading.system;
    const feedbackSystem = checked.clozeDump.feedback.system;
    const breaker = options.judgeBreaker ?? createJudgeBreaker();
    const judgeStep = createJudgeStep(options, breaker);
    const unjudged = unjudgedFields(options);

    let done = 0;
    let consecutiveErrored = 0;
    let aborted: EvalRunResult["aborted"];
    const abortForAuth = () => {
      aborted ??= {
        reason: "auth",
        message: "Authentication failed — the run was aborted. Run `novedu-cli login`.",
      };
    };

    // ONE call with the shared retry policy: 5xx and network failures only.
    const callWithRetry = (request: Parameters<ClozeFn>[0]) =>
      withRetry(() => call(request), {
        attempts: options.retry?.attempts,
        baseDelayMs: options.retry?.baseDelayMs,
        sleep: options.retry?.sleep,
        shouldRetry: (value) => !value.ok && value.retryable && value.auth !== true,
      });

    /** One repeat; `auth` set when the run must abort. */
    const runRepeat = async (
      plan: PlannedClozeCase,
      repeatIndex: number,
    ): Promise<{ row: EvalRepeatRow; auth?: boolean }> => {
      const usage: EvalUsage = { ...ZERO_USAGE };
      const usageField = () =>
        usage.input || usage.cachedInput || usage.output ? { usage: { ...usage } } : {};
      const failed = (error: unknown, auth?: boolean) => ({
        row: { repeatIndex, error, ...usageField(), ...unjudged },
        ...(auth ? { auth } : {}),
      });

      // 1. The pre-pass, locally — exactly what `gradeCloze` decides without a model.
      const prepass = runClozePrepass(gaps, plan.answers);
      const undecided = undecidedGaps(prepass);
      const modelGaps = new Map<number, { result: EvalVerdict; reason: string }>();

      // 2. ONE grading call for the rest, retried once when it does not name every
      //    undecided gap exactly once (the app's coverage rule).
      if (undecided.length > 0) {
        const user = buildClozeGradingMessage(
          undecided.map((gap) => ({ gap, answer: plan.answers[gap - 1] ?? "" })),
        );
        let graded: ClozeGradingOutput | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const outcome = await callWithRetry({ step: "grade", system: gradingSystem, user });
          if (!outcome.ok) return failed(outcome.error, outcome.auth);
          addUsage(usage, outcome.usage);
          const parsed = CLOZE_GRADING_SCHEMA.safeParse(outcome.output);
          if (!parsed.success) return failed({ message: NOT_A_CLOZE_ANSWER });
          graded = parsed.data;
          if (clozeGradingCovers(graded, undecided)) break;
          graded = undefined;
        }
        if (!graded) {
          return failed({
            message:
              "The grader did not return exactly one verdict per undecided gap, even after a retry.",
          });
        }
        for (const entry of graded.gaps) {
          modelGaps.set(entry.gap, { result: entry.result, reason: entry.reason });
        }
      }

      const repeatGaps: EvalClozeRepeatGap[] = prepass.map((entry) => {
        if (entry.verdict) {
          return { gap: entry.gap, verdict: entry.verdict, decidedBy: "pre-pass" };
        }
        const model = modelGaps.get(entry.gap);
        return {
          gap: entry.gap,
          verdict: model?.result ?? "incorrect",
          decidedBy: "model",
          ...(model?.reason ? { reason: model.reason } : {}),
        };
      });
      const verdicts = repeatGaps.map((gap) => gap.verdict);
      const detail: EvalClozeRepeatDetail = { gaps: repeatGaps };

      // 3. Feedback only when something is not correct — the app asks for none otherwise.
      let judged: Pick<EvalRepeatRow, "judge" | "judgeError"> = unjudged;
      let auth: boolean | undefined;
      if (verdicts.some((verdict) => verdict !== "correct")) {
        const user = buildClozeFeedbackMessage(
          gaps.map((gap, i) => ({
            gap: gap.number,
            answer: plan.answers[i] ?? "",
            verdict: verdicts[i] ?? "incorrect",
          })),
        );
        const outcome = await callWithRetry({ step: "explain", system: feedbackSystem, user });
        const parsed = outcome.ok ? CLOZE_FEEDBACK_SCHEMA.safeParse(outcome.output) : undefined;
        if (outcome.ok) addUsage(usage, outcome.usage);
        if (!outcome.ok) {
          // Like the app: a failed feedback call leaves the verdicts standing.
          detail.feedbackError = judgeErrorMessage(outcome.error);
          auth = outcome.auth;
        } else if (!parsed?.success) {
          detail.feedbackError = NOT_A_CLOZE_ANSWER;
        } else {
          // 4. The grounding filter, locally — the report shows what a student would see.
          const grounded = groundClozeFeedback(parsed.data, verdicts);
          detail.feedback = grounded;
          // 5. The judge over the SURVIVING feedback, against the feedback prompt.
          if (options.judge) {
            judged = await judgeStep({
              system: CLOZE_JUDGE_SYSTEM,
              subject: buildClozeJudgeSubject(feedbackSystem, user, grounded),
              criteria: CLOZE_JUDGE_CRITERIA,
            });
          }
        }
      }

      return {
        row: {
          repeatIndex,
          cloze: detail,
          ...usageField(),
          ...judged,
        },
        ...(auth ? { auth } : {}),
      };
    };

    const results = await mapWithConcurrency(
      planned,
      concurrency,
      async (plan): Promise<EvalClozeCaseResult> => {
        const rows: EvalRepeatRow[] = [];
        for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
          if (aborted) break;
          const { row, auth } = await runRepeat(plan, repeatIndex);
          done += 1;
          options.onProgress?.({ done, total });
          rows.push(row);
          if (auth) {
            abortForAuth();
            break;
          }
        }

        const graded = rows.flatMap((row) => (row.cloze ? [row.cloze] : []));
        const caseGaps: EvalClozeGapResult[] = gaps.map((gap, i) => {
          const expected = plan.expected[i];
          const observed = graded.flatMap((detail) => {
            const verdict = detail.gaps[i]?.verdict;
            return verdict ? [verdict] : [];
          });
          const winner = majority(observed, expected ?? []);
          return {
            gap: gap.number,
            reference: gap.reference,
            answer: plan.answers[i] ?? "",
            ...(expected ? { expected } : {}),
            ...(winner ? { verdict: winner.verdict } : {}),
            ...(graded[0]?.gaps[i] ? { decidedBy: graded[0].gaps[i].decidedBy } : {}),
            ...(expected && winner ? { passed: winner.passed } : {}),
          };
        });
        const status: EvalClozeCaseResult["status"] =
          rows.length === 0
            ? "skipped"
            : graded.length === 0
              ? "errored"
              : caseGaps.some((gap) => gap.passed === false)
                ? "failed"
                : "passed";

        if (status === "errored") {
          consecutiveErrored += 1;
          if (consecutiveErrored >= CIRCUIT_BREAKER_LIMIT) {
            aborted ??= {
              reason: "circuit-breaker",
              message: `${CIRCUIT_BREAKER_LIMIT} cases failed in a row — the run was aborted.`,
            };
          }
        } else if (status !== "skipped") {
          consecutiveErrored = 0;
        }

        const explained = graded.flatMap((detail) => (detail.feedback ? [detail.feedback] : []));
        return {
          submissionId: plan.submissionId,
          status,
          gaps: caseGaps,
          ...(plan.expectPatterns
            ? {
                patternChecks: plan.expectPatterns.map((set) => ({
                  gaps: set,
                  grouped: explained.filter((feedback) => groupedBy(feedback.patterns, set)).length,
                  of: explained.length,
                })),
              }
            : {}),
          unstable: gaps.some(
            (_, i) => new Set(graded.map((detail) => detail.gaps[i]?.verdict)).size > 1,
          ),
          feedbackFlagged: rows.some((row) => (row.judge?.issues.length ?? 0) > 0),
          toolsFlagged: false,
          repeats: rows,
        };
      },
    );

    const usage: EvalUsage = { ...ZERO_USAGE };
    for (const result of results) {
      for (const row of result.repeats) {
        addUsage(usage, row.usage);
        addUsage(usage, row.judge?.usage);
      }
    }

    // Confusion and false-correct over the GAPS that state an expectation — the cloze
    // kind's verdict unit (errored cases' gaps stay in the denominator, as for the quiz).
    const verdictStats = confusionStats(
      results.flatMap((result) =>
        result.gaps.flatMap((gap) =>
          gap.expected ? [{ expected: gap.expected, verdict: gap.verdict }] : [],
        ),
      ),
    );

    return {
      id: checked.evalFile.id,
      kind: "cloze",
      target: checked.targetUrl,
      llm: options.llm,
      judging: !options.judge ? "off" : breaker.stopped ? "degraded" : "on",
      totals: {
        cases: results.length,
        passed: results.filter((c) => c.status === "passed").length,
        failed: results.filter((c) => c.status === "failed").length,
        errored: results.filter((c) => c.status === "errored").length,
        skipped: results.filter((c) => c.status === "skipped").length,
        unstable: results.filter((c) => c.unstable).length,
        feedbackFlagged: results.filter((c) => c.feedbackFlagged).length,
        toolsFlagged: 0,
        judgeErrored: results.reduce(
          (sum, c) => sum + c.repeats.filter((row) => row.judgeError !== undefined).length,
          0,
        ),
        repeats,
        calls: total,
        usage,
      },
      questions: [],
      ...verdictStats,
      mismatches: results.filter(
        (result) => result.status === "failed" || result.status === "errored",
      ),
      cases: results,
      ...(aborted ? { aborted } : {}),
    };
  },
};

/** The seam: one runner per eval kind (mirrors `promptDumpers`). */
export const evalRunners: Record<EvalKind, EvalRunner> = {
  quiz: quizEvalRunner,
  tutor: tutorEvalRunner,
  cloze: clozeEvalRunner,
};

/** Run ONE checked eval file — the single entry point the command uses. */
export function runEval(
  kind: EvalKind,
  checked: EvalCheckOk,
  options: EvalRunOptions,
): Promise<EvalRunResult> {
  return evalRunners[kind].run(checked, options);
}

// --- batch mode (§ multi-file runs) -----------------------------------------------
// A run over several eval files is a pure CLI-side loop over the same single-file
// runner: files are checked up front and then graded ONE AFTER ANOTHER, so the server
// sees exactly the load of N separate invocations. Per-entry isolation, same philosophy
// as `codes sync`: one invalid file never aborts the batch.

/**
 * One file's place in a batch as the COMMAND assembles it: either a finished run, or
 * the validation issues. `summarizeBatch` turns it into an {@link EvalBatchFile} by
 * stamping the per-file verdict on it.
 */
export interface EvalBatchFileInput {
  /** The resolved source URL (what `toUrl` made of the argument). */
  source: string;
  status: "ok" | "invalid";
  result?: EvalRunResult;
  errors?: EvalBatchIssue[];
}

/** A batch entry in the emitted report — the input plus its own pass/fail verdict. */
export interface EvalBatchFile extends EvalBatchFileInput {
  /**
   * Which eval kind this file ran as — absent only for an `invalid` file, whose kind
   * could not be determined. Lets a script tell a mixed batch's rows apart without
   * reaching into `result`.
   */
  kind?: EvalKind;
  /**
   * This file alone would pass the CI gate: it is valid AND has no failed, errored or
   * skipped case. Always `false` for an `invalid` file. Carried so a script can point
   * at the offending file without re-deriving the rule.
   */
  passed: boolean;
}

/** The structured validation issues of an invalid file (`ValidationError` shape). */
export interface EvalBatchIssue {
  code: string;
  message: string;
  [key: string]: unknown;
}

export interface EvalBatchResult {
  files: EvalBatchFile[];
  /** Exactly the {@link batchPassed} verdict — the run's exit-code rule, precomputed. */
  passed: boolean;
  totals: {
    files: number;
    invalid: number;
    cases: number;
    passed: number;
    failed: number;
    errored: number;
    skipped: number;
    unstable: number;
    /** CASES whose feedback the judge flagged, across the batch — reported, never gating. */
    feedbackFlagged: number;
    /** CASES that missed a required tool call, across the batch — reported, never gating. */
    toolsFlagged: number;
    /** REPEATS whose judge call exhausted its retries, across the batch. */
    judgeErrored: number;
    /** Every file's usage added up, grading + judge — a LOWER bound ({@link EvalUsage}). */
    usage: EvalUsage;
  };
}

/** One file's own verdict: valid, graded, and not a single non-passing case. */
function filePassed(file: EvalBatchFileInput): boolean {
  if (file.status === "invalid" || !file.result) return false;
  const { failed, errored, skipped } = file.result.totals;
  return failed === 0 && errored === 0 && skipped === 0;
}

/**
 * Grand totals across a batch. This is the ONE machine-readable shape `--json` /
 * `--out` emit, single file or not, so scripts never branch on the file count.
 */
export function summarizeBatch(files: EvalBatchFileInput[]): EvalBatchResult {
  const totals = {
    files: files.length,
    invalid: files.filter((file) => file.status === "invalid").length,
    cases: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    skipped: 0,
    unstable: 0,
    feedbackFlagged: 0,
    toolsFlagged: 0,
    judgeErrored: 0,
    usage: { ...ZERO_USAGE },
  };
  for (const file of files) {
    if (!file.result) continue;
    totals.cases += file.result.totals.cases;
    totals.passed += file.result.totals.passed;
    totals.failed += file.result.totals.failed;
    totals.errored += file.result.totals.errored;
    totals.skipped += file.result.totals.skipped;
    totals.unstable += file.result.totals.unstable;
    totals.feedbackFlagged += file.result.totals.feedbackFlagged;
    totals.toolsFlagged += file.result.totals.toolsFlagged;
    totals.judgeErrored += file.result.totals.judgeErrored;
    addUsage(totals.usage, file.result.totals.usage);
  }
  // `passed` is DERIVED from `batchPassed`, never a second implementation of the rule.
  return {
    files: files.map((file) => ({
      ...file,
      ...(file.result ? { kind: file.result.kind } : {}),
      passed: filePassed(file),
    })),
    passed: batchPassed({ totals }),
    totals,
  };
}

/**
 * Did this file's run produce ANY judgment? The ONE rule every renderer derives its
 * flagged count's visibility from: a file that judged nothing — judging off, or every
 * case run after the breaker degraded the run — has NOT been found clean, so its flagged
 * count renders as "not checked" (an em dash, an omitted segment), never as a `0`.
 */
export function anyJudged(result: EvalRunResult): boolean {
  return result.cases.some((evalCase) =>
    evalCase.repeats.some((repeat) => repeat.judge !== undefined && repeat.judge !== null),
  );
}

/**
 * Did this file's run CHECK tool calls at all — i.e. does any case declare
 * `required_tools`? The tool sibling of {@link anyJudged}, and the same rule: a run that
 * required nothing has not been found complete, so its `toolsFlagged` count is OMITTED
 * rather than printed as a reassuring `0`.
 */
export function anyToolsRequired(result: EvalRunResult): boolean {
  return result.cases.some(
    (evalCase) => isTutorCase(evalCase) && evalCase.requiredTools !== undefined,
  );
}

/**
 * The CI gate: every file valid, and not a single failed, errored, or skipped CASE —
 * an aborted (and therefore incomplete) run must never read as a pass. The single
 * source of truth for the exit code AND for `EvalBatchResult.passed`.
 *
 * `unstable`, `feedbackFlagged`, `toolsFlagged` and `judgeErrored` deliberately do NOT
 * appear here: all four are reported, none gates. (Gating is per-KIND policy, not a
 * property of judge
 * results — and BOTH shipped kinds are report-only. For the tutor kind that is the whole
 * policy: its exit code reflects RUN HEALTH only, so a flagged conversation changes
 * nothing, and the Markdown report is the deliverable — docs/cli-eval.md.)
 */
export function batchPassed(batch: { totals: EvalBatchResult["totals"] }): boolean {
  return (
    batch.totals.invalid === 0 &&
    batch.totals.failed === 0 &&
    batch.totals.errored === 0 &&
    batch.totals.skipped === 0
  );
}
