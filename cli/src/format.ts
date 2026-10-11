import type { ClozeCheckResult } from "@/lib/cloze-validate";
import type { CodingCheckResult } from "@/lib/coding-validate";
import type { EvalCheckResult } from "@/lib/eval-validate";
import type { PromptDump } from "@/lib/prompt-dump";
import {
  type BuildResult,
  type FragmentCheckResult,
  formatZodIssues,
  type ValidationError,
  type ValidationWarning,
} from "@/lib/prompt-fragments";
import type { QuizCheckResult } from "@/lib/quiz-validate";
import type { WritingCheckResult } from "@/lib/writing-validate";
import {
  anyJudged,
  anyToolsRequired,
  type EvalBatchResult,
  type EvalRunResult,
  type EvalUsage,
  isClozeCase,
  isTutorCase,
} from "./eval-run";

// Pure presentation: turn a `BuildResult` into a human-readable terminal report.
// No validation logic lives here — it only renders the structured errors/warnings
// the core already produced.

// What the judge audited, in the reader's words: a quiz judge reads the grader's
// FEEDBACK, a tutor judge reads the generated RESPONSE. The JSON field stays
// `feedbackFlagged` for both (one batch shape); only the human label branches —
// the same wording the Markdown report uses.
function flaggedLabel(kind: EvalRunResult["kind"]): string {
  return kind === "tutor" ? "flagged responses" : "flagged feedback";
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => paint("32", s);
const red = (s: string) => paint("31", s);
const yellow = (s: string) => paint("33", s);
const dim = (s: string) => paint("2", s);

/** Append the context fields an error/warning carries, when present. */
function context(item: ValidationError | ValidationWarning): string {
  const parts: string[] = [];
  if (item.fileAlias) parts.push(`file=${item.fileAlias}`);
  if (item.fragmentId) parts.push(`fragment=${item.fragmentId}`);
  if ("questionId" in item && item.questionId) parts.push(`question=${item.questionId}`);
  if (item.variable) parts.push(`variable=${item.variable}`);
  if ("url" in item && item.url) parts.push(`url=${item.url}`);
  if ("expectedType" in item && item.expectedType) {
    parts.push(`expected=${item.expectedType}`);
  }
  if ("actualType" in item && item.actualType) parts.push(`actual=${item.actualType}`);
  return parts.length ? dim(` (${parts.join(", ")})`) : "";
}

function renderWarnings(warnings: ValidationWarning[]): string[] {
  return warnings.map((w) => `  ${yellow("⚠")} ${yellow(w.code)} ${w.message}${context(w)}`);
}

/**
 * Render each error as a line, with any flattened Zod schema-issue detail
 * indented beneath it — so a generic "Document does not match the expected
 * structure" is followed by the actual field paths (e.g. `Unrecognized key:
 * "nae"`), matching what the web UI shows.
 */
function renderErrors(errors: ValidationError[]): string[] {
  const lines: string[] = [];
  for (const e of errors) {
    lines.push(`  ${red("✗")} ${red(e.code)} ${e.message}${context(e)}`);
    if (e.zodIssues) {
      for (const issue of formatZodIssues(e.zodIssues)) lines.push(`      ${dim(issue)}`);
    }
  }
  return lines;
}

export function formatResult(result: BuildResult, source: string): string {
  const lines: string[] = [];

  if (result.ok) {
    lines.push(green(`✔ Valid tutor`) + dim(` — ${source}`));
    lines.push(`  model: ${result.model}`);
    lines.push(`  system prompt: ${result.prompt.length} chars`);
    lines.push(
      `  imageInput: ${result.imageInput}   anonymous: ${result.anonymous}` +
        (result.exampleQuestions.length
          ? `   exampleQuestions: ${result.exampleQuestions.length}`
          : ""),
    );
    if (result.tools.length) lines.push(`  tools: ${result.tools.join(", ")}`);
    if (result.warnings.length) {
      lines.push("");
      lines.push(yellow(`${result.warnings.length} warning(s):`));
      lines.push(...renderWarnings(result.warnings));
    }
    return lines.join("\n");
  }

  lines.push(red(`✘ Invalid tutor`) + dim(` — ${source}`));
  lines.push("");
  lines.push(red(`${result.errors.length} error(s):`));
  lines.push(...renderErrors(result.errors));
  if (result.warnings.length) {
    lines.push("");
    lines.push(yellow(`${result.warnings.length} warning(s):`));
    lines.push(...renderWarnings(result.warnings));
  }
  return lines.join("\n");
}

/** Same renderer, for a standalone fragment-FILE check (`--kind fragment`). */
export function formatFragmentResult(result: FragmentCheckResult, source: string): string {
  const lines: string[] = [];

  if (result.ok) {
    lines.push(green(`✔ Valid fragment file`) + dim(` — ${source}`));
    lines.push(`  id: ${result.fragmentFileId}`);
    lines.push(
      `  fragments: ${result.fragmentIds.length}` +
        (result.fragmentIds.length ? ` (${result.fragmentIds.join(", ")})` : ""),
    );
    if (result.warnings.length) {
      lines.push("");
      lines.push(yellow(`${result.warnings.length} warning(s):`));
      lines.push(...renderWarnings(result.warnings));
    }
    return lines.join("\n");
  }

  lines.push(red(`✘ Invalid fragment file`) + dim(` — ${source}`));
  lines.push("");
  lines.push(red(`${result.errors.length} error(s):`));
  lines.push(...renderErrors(result.errors));
  if (result.warnings.length) {
    lines.push("");
    lines.push(yellow(`${result.warnings.length} warning(s):`));
    lines.push(...renderWarnings(result.warnings));
  }
  return lines.join("\n");
}

/**
 * Shared tail for the quiz/writing renderers: on failure, the error list (with any
 * flattened Zod issues); plus any warnings on either branch.
 */
function renderFailureAndWarnings(
  result: { ok: false; errors: ValidationError[]; warnings: ValidationWarning[] },
  label: string,
  source: string,
): string {
  const lines = [red(`✘ Invalid ${label}`) + dim(` — ${source}`), ""];
  lines.push(red(`${result.errors.length} error(s):`));
  lines.push(...renderErrors(result.errors));
  if (result.warnings.length) {
    lines.push("");
    lines.push(yellow(`${result.warnings.length} warning(s):`));
    lines.push(...renderWarnings(result.warnings));
  }
  return lines.join("\n");
}

/** Renderer for a quiz check (`--kind quiz`). */
export function formatQuizResult(result: QuizCheckResult, source: string): string {
  if (!result.ok) return renderFailureAndWarnings(result, "quiz", source);

  const lines = [green(`✔ Valid quiz`) + dim(` — ${source}`)];
  lines.push(`  id: ${result.quizId}`);
  lines.push(`  model: ${result.model}`);
  lines.push(`  questions: ${result.questionCount}   anonymous: ${result.anonymous}`);
  if (result.warnings.length) {
    lines.push("");
    lines.push(yellow(`${result.warnings.length} warning(s):`));
    lines.push(...renderWarnings(result.warnings));
  }
  return lines.join("\n");
}

/** Renderer for a writing-activity check (`--kind writing`). */
export function formatWritingResult(result: WritingCheckResult, source: string): string {
  if (!result.ok) return renderFailureAndWarnings(result, "writing activity", source);

  const lines = [green(`✔ Valid writing activity`) + dim(` — ${source}`)];
  lines.push(`  id: ${result.writingId}`);
  lines.push(`  model: ${result.model}`);
  lines.push(`  anonymous: ${result.anonymous}`);
  if (result.warnings.length) {
    lines.push("");
    lines.push(yellow(`${result.warnings.length} warning(s):`));
    lines.push(...renderWarnings(result.warnings));
  }
  return lines.join("\n");
}

/**
 * Renderer for a coding-activity check (`--kind coding`). Coding is ALWAYS anonymous
 * (there are no in-app conversations to attribute), so — unlike quiz/writing — that
 * is shown as a fixed note, not a per-file value.
 */
export function formatCodingResult(result: CodingCheckResult, source: string): string {
  if (!result.ok) return renderFailureAndWarnings(result, "coding activity", source);

  const lines = [green(`✔ Valid coding activity`) + dim(` — ${source}`)];
  lines.push(`  id: ${result.codingId}`);
  lines.push(`  model: ${result.model}`);
  lines.push(`  anonymous: true ${dim("(always — no conversations are stored)")}`);
  if (result.warnings.length) {
    lines.push("");
    lines.push(yellow(`${result.warnings.length} warning(s):`));
    lines.push(...renderWarnings(result.warnings));
  }
  return lines.join("\n");
}

/**
 * Renderer for a cloze check (`--kind cloze`): the summary plus the gap inventory, one
 * gap per line. Cloze is ALWAYS anonymous (nothing links a submission to a student),
 * so — like coding — that is shown as a fixed note, not a per-file value.
 */
export function formatClozeResult(result: ClozeCheckResult, source: string): string {
  if (!result.ok) return renderFailureAndWarnings(result, "cloze exercise", source);

  const lines = [green(`✔ Valid cloze exercise`) + dim(` — ${source}`)];
  lines.push(`  id: ${result.clozeId}`);
  lines.push(`  model: ${result.model}`);
  lines.push(`  anonymous: true ${dim("(always — no submission is linked to a student)")}`);
  lines.push(`  gaps: ${result.gapCount}`);
  const width = String(result.gapCount).length;
  for (const gap of result.gaps) {
    const reference = gap.reference === "" ? dim("(empty)") : `"${gap.reference}"`;
    const hint = gap.hint ? dim(`  (${gap.hint})`) : "";
    lines.push(`    ${String(gap.number).padStart(width)}  ${reference}${hint}`);
  }
  if (result.warnings.length) {
    lines.push("");
    lines.push(yellow(`${result.warnings.length} warning(s):`));
    lines.push(...renderWarnings(result.warnings));
  }
  return lines.join("\n");
}

/**
 * Renderer for an eval check (`--kind eval`). An eval describes an activity it does not
 * contain, so the summary names the resolved target and the size of the run the file
 * would produce — in the units of its own kind.
 */
export function formatEvalResult(result: EvalCheckResult, source: string): string {
  if (!result.ok) return renderFailureAndWarnings(result, "eval", source);

  const lines = [green(`✔ Valid eval`) + dim(` — ${source}`)];
  lines.push(`  id: ${result.evalFile.id}`);
  lines.push(`  kind: ${result.kind}`);
  lines.push(`  target: ${result.targetUrl}`);
  if (result.kind === "tutor") {
    lines.push(`  conversations: ${result.caseCount}`);
  } else if (result.kind === "cloze") {
    lines.push(`  submissions: ${result.caseCount}   gaps: ${result.clozeGaps.length}`);
  } else {
    lines.push(`  questions: ${result.evalFile.questions.length}   cases: ${result.caseCount}`);
  }
  lines.push(`  ${result.kind} model: ${llmSpecText(result.llm)}`);
  if (result.warnings.length) {
    lines.push("");
    lines.push(yellow(`${result.warnings.length} warning(s):`));
    lines.push(...renderWarnings(result.warnings));
  }
  return lines.join("\n");
}

/** One-line answer snippet for a mismatch line (single-line, bounded). */
function snippet(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Thousands-separated, en-US so a report reads the same on every machine. */
export function formatTokenCount(count: number): string {
  return count.toLocaleString("en-US");
}

/**
 * `tokens: 15,420 in (12,300 cached) / 2,810 out` — or `undefined` when nothing was
 * reported at all (no server usage, or none of the calls succeeded), in which case the
 * reports print no token line rather than a misleading row of zeros. The cached
 * parenthetical is dropped when the provider reported no cache reads. Counts SUCCESSFUL
 * grading calls only, so it is a lower bound (docs/cli-eval.md).
 */
export function formatUsageLine(usage: EvalUsage): string | undefined {
  if (usage.input === 0 && usage.cachedInput === 0 && usage.output === 0) return undefined;
  const cached = usage.cachedInput ? ` (${formatTokenCount(usage.cachedInput)} cached)` : "";
  return `tokens: ${formatTokenCount(usage.input)} in${cached} / ${formatTokenCount(usage.output)} out`;
}

/** The first error message a case's repeats recorded, for a one-line mismatch row. */
function firstErrorMessage(repeats: readonly { error?: unknown }[], fallback: string): string {
  const first = repeats.find((row) => row.error !== undefined)?.error;
  return typeof first === "object" && first !== null && "message" in first
    ? String((first as { message: unknown }).message)
    : fallback;
}

/**
 * One line per non-passing case: `question#index expected … got … "answer…"` for a quiz,
 * `#n title — error …` for a tutor conversation (which has no verdict to compare).
 */
function mismatchLines(result: EvalRunResult): string[] {
  return result.mismatches.map((c) => {
    if (isTutorCase(c)) {
      const head = `#${c.index + 1}${c.title ? ` ${c.title}` : ""}`;
      return `  ${red("✗")} ${head} ${red("error")} ${dim(firstErrorMessage(c.repeats, "no response"))}`;
    }
    if (isClozeCase(c)) {
      if (c.status === "errored") {
        return `  ${red("✗")} ${c.submissionId} ${red("error")} ${dim(firstErrorMessage(c.repeats, "no verdicts"))}`;
      }
      // One `gap N expected … got …` per gap that missed its expectation.
      const missed = c.gaps
        .filter((gap) => gap.passed === false)
        .map(
          (gap) =>
            `gap ${gap.gap} expected ${gap.expected?.join("|")} got ${red(gap.verdict ?? "?")}`,
        );
      return `  ${red("✗")} ${c.submissionId}: ${missed.join(", ")}`;
    }
    const head = `${c.questionId}#${c.answerIndex}`;
    const expected = c.expected.join("|");
    if (c.status === "errored") {
      const message = firstErrorMessage(c.repeats, "no verdict");
      return `  ${red("✗")} ${head} expected ${expected} got ${red("error")} ${dim(message)}`;
    }
    return (
      `  ${red("✗")} ${head} expected ${expected} got ${red(c.verdict ?? "?")}` +
      dim(` "${snippet(c.answer)}"`)
    );
  });
}

/**
 * One llm spec as the reports name it: `SCCH / gemma-4`, with ` (reasoning: high)`
 * appended whenever an effort level applies — two runs of one model at different efforts
 * behave differently, so the level belongs in the header.
 */
function llmSpecText(spec: { provider: string; model: string; reasoning?: string }): string {
  return `${spec.provider} / ${spec.model}${spec.reasoning ? ` (reasoning: ${spec.reasoning})` : ""}`;
}

/**
 * The human report for ONE eval run: header (id, target, the EFFECTIVE llm — rendered
 * as `quiz-llm → override-llm` when `--llm-provider`/`--llm-model` was used, so a
 * comparison report can never be mistaken for a baseline one), one line per
 * mismatch/error, totals, the confusion matrix and the false-correct rate.
 */
export function formatEvalReport(result: EvalRunResult, source: string): string {
  const { totals } = result;
  const clean = totals.failed === 0 && totals.errored === 0 && totals.skipped === 0;
  const lines = [
    (clean ? green("✔ Eval passed") : red("✘ Eval failed")) + dim(` — ${source}`),
    `  id: ${result.id}`,
    `  target: ${result.target}`,
  ];
  const llm = result.llm.overrides
    ? `${llmSpecText(result.llm.overrides)} ${yellow("→")} ${llmSpecText(result.llm)} ${yellow("(override)")}`
    : llmSpecText(result.llm);
  lines.push(`  llm: ${llm}`);
  // The judge spec, but only when it differs from the grading one — judge strictness
  // varies by model AND by reasoning effort, so a differing spec is exactly what makes
  // two reports comparable.
  const judge = result.llm.judge;
  if (
    judge &&
    (judge.provider !== result.llm.provider ||
      judge.model !== result.llm.model ||
      judge.reasoning !== result.llm.reasoning)
  ) {
    lines.push(
      `  judge llm: ${llmSpecText(judge)}${judge.overridden ? ` ${yellow("(override)")}` : ""}`,
    );
  }
  const unit = { quiz: "case", tutor: "conversation", cloze: "submission" }[result.kind];
  // A cloze run is up to two calls (grading, then feedback) — the pre-pass may need none.
  const generation = {
    quiz: "grading call(s)",
    tutor: "generation call(s)",
    cloze: "grading/feedback run(s)",
  }[result.kind];
  lines.push(
    `  ${unit}s: ${totals.cases} × ${totals.repeats} repeat(s) = ${totals.calls} ${generation}` +
      (result.judging === "off" ? "" : ` + ${totals.calls} judge call(s)`),
  );

  if (result.aborted) {
    lines.push("");
    lines.push(red(`Run aborted: ${result.aborted.message}`));
  }
  if (result.judging === "degraded") {
    lines.push("");
    lines.push(
      yellow("Feedback judging stopped after repeated judge failures — grading was unaffected."),
    );
  }

  if (result.mismatches.length) {
    lines.push("");
    lines.push(red(`${result.mismatches.length} mismatch(es):`));
    lines.push(...mismatchLines(result));
  }

  lines.push("");
  lines.push(
    // A tutor run has no verdict, so `passed`/`failed` would always read 0/0 — it counts
    // the conversations that produced a response instead.
    (result.kind === "tutor"
      ? `  ok: ${totals.cases - totals.errored - totals.skipped}   errored: ${totals.errored}`
      : `  passed: ${totals.passed}   failed: ${totals.failed}   errored: ${totals.errored}`) +
      (totals.skipped ? red(`   skipped: ${totals.skipped} (run aborted)`) : "") +
      (totals.unstable ? dim(`   unstable: ${totals.unstable}`) : "") +
      // Reported, never gating — hence yellow rather than red. Printed whenever ANY
      // judgment exists, zero included: a silent line would make "judged, all clean" look
      // exactly like "never judged" — the same `anyJudged` rule as the Markdown report's
      // em dash, so a file the breaker left unjudged never claims a clean 0.
      (!anyJudged(result)
        ? ""
        : totals.feedbackFlagged
          ? yellow(`   ${flaggedLabel(result.kind)}: ${totals.feedbackFlagged}`)
          : dim(`   ${flaggedLabel(result.kind)}: 0`)) +
      // The deterministic sibling of the judge's count, under the SAME omission rule
      // (`anyToolsRequired`): a run where no case declared `required_tools` prints no
      // segment at all, because a `0` there would claim a check nobody ran.
      (!anyToolsRequired(result)
        ? ""
        : totals.toolsFlagged
          ? yellow(`   missing tool calls: ${totals.toolsFlagged}`)
          : dim("   missing tool calls: 0")) +
      (totals.judgeErrored ? dim(`   judge errors: ${totals.judgeErrored}`) : ""),
  );

  const tokens = formatUsageLine(totals.usage);
  if (tokens) lines.push(dim(`  ${tokens}`));

  if (result.confusion.length) {
    lines.push("");
    lines.push("  confusion (expected → got):");
    for (const row of result.confusion) {
      lines.push(`    ${row.expected} → ${row.got}: ${row.count}`);
    }
  }

  // Verdict metrics belong to the quiz kind alone; printing an all-zero false-correct
  // rate for a tutor run would invite reading meaning into it.
  if (result.kind !== "tutor") {
    const { count, denominator, rate } = result.falseCorrect;
    lines.push("");
    lines.push(
      `  false-correct: ${count}/${denominator}` +
        (denominator ? ` (${(rate * 100).toFixed(1)}%)` : ""),
    );
  }
  return lines.join("\n");
}

/**
 * The human report for a MULTI-file run: a per-file summary table, grand totals, then
 * the per-file detail sections only for files that had mismatches. The confusion matrix
 * and false-correct rate stay per file — mixing verdicts across unrelated quizzes is
 * not meaningful. A single-file run keeps the plain {@link formatEvalReport}.
 */
export function formatEvalBatchReport(batch: EvalBatchResult): string {
  const lines: string[] = [];
  lines.push(`Evaluated ${batch.totals.files} file(s):`);
  for (const file of batch.files) {
    const name = shortSource(file.source);
    if (file.status === "invalid" || !file.result) {
      lines.push(`  ${red("✘")} ${name}: ${red("invalid")} (${file.errors?.length ?? 0} error(s))`);
      continue;
    }
    const t = file.result.totals;
    const mark = t.failed === 0 && t.errored === 0 && t.skipped === 0 ? green("✔") : red("✗");
    const counts =
      file.result.kind === "tutor"
        ? `${t.cases} conversation(s), ${t.cases - t.errored - t.skipped} ok, ${t.errored} errored`
        : `${t.cases} ${file.result.kind === "cloze" ? "submission" : "case"}(s), ${t.passed} passed, ${t.failed} failed, ${t.errored} errored`;
    lines.push(
      `  ${mark} ${name}: ${counts}` +
        (t.skipped ? red(`, ${t.skipped} skipped`) : "") +
        (t.unstable ? dim(`, ${t.unstable} unstable`) : "") +
        // `anyJudged`, the renderers' shared rule: no flagged segment for a file that
        // was never judged — an unjudged file has not been found clean.
        (!anyJudged(file.result)
          ? ""
          : t.feedbackFlagged
            ? yellow(`, ${t.feedbackFlagged} flagged`)
            : dim(", 0 flagged")) +
        // Same omission rule for the tool check: a file that required no tool says
        // nothing about missing tool calls.
        (!anyToolsRequired(file.result)
          ? ""
          : t.toolsFlagged
            ? yellow(`, ${t.toolsFlagged} missing tool calls`)
            : dim(", 0 missing tool calls")),
    );
  }

  const g = batch.totals;
  // Same rule as the per-file rows: a batch where no file judged says nothing about
  // flagged feedback; one where any file did reports its count, zero included.
  const judged = batch.files.some((file) => file.result && anyJudged(file.result));
  // …and the same for the tool check across the batch: no file required a tool ⇒ no
  // segment, never a reassuring zero.
  const toolChecked = batch.files.some((file) => file.result && anyToolsRequired(file.result));
  lines.push("");
  lines.push(
    `  TOTAL: ${g.cases} case(s), ${g.passed} passed, ${g.failed} failed, ${g.errored} errored` +
      (g.skipped ? red(`, ${g.skipped} skipped`) : "") +
      (judged
        ? g.feedbackFlagged
          ? yellow(`, ${g.feedbackFlagged} flagged`)
          : dim(", 0 flagged")
        : "") +
      (toolChecked
        ? g.toolsFlagged
          ? yellow(`, ${g.toolsFlagged} missing tool calls`)
          : dim(", 0 missing tool calls")
        : "") +
      (g.invalid ? red(`, ${g.invalid} invalid file(s)`) : ""),
  );
  if (batch.files.some((file) => file.result?.judging === "degraded")) {
    lines.push(
      yellow(
        "  Feedback judging stopped mid-run after repeated judge failures — files without a flagged count were graded but not judged.",
      ),
    );
  }

  const tokens = formatUsageLine(g.usage);
  if (tokens) lines.push(dim(`  ${tokens}`));

  for (const file of batch.files) {
    if (file.status === "invalid") {
      lines.push("");
      lines.push(red(`✘ ${shortSource(file.source)} — not a usable eval:`));
      lines.push(...renderErrors((file.errors ?? []) as unknown as ValidationError[]));
      continue;
    }
    if (!file.result || file.result.mismatches.length === 0) continue;
    lines.push("");
    lines.push(formatEvalReport(file.result, shortSource(file.source)));
  }
  return lines.join("\n");
}

/** The last path segment of a source URL — enough to tell files apart in a table. */
function shortSource(source: string): string {
  try {
    const { pathname } = new URL(source);
    return decodeURIComponent(pathname.split("/").pop() || source);
  } catch {
    return source;
  }
}

/**
 * Renderer for a prompt dump (`prompts`). Kind-agnostic by construction: the envelope
 * (kind / id / provider+model) plus one line per prompt with its character count — the
 * sections come from `promptSections`, so a new kind needs no change here. `--json`
 * carries the prompt text itself.
 */
export function formatPromptDump(
  dump: PromptDump,
  sections: { name: string; text: string }[],
  source: string,
): string {
  const lines = [green(`✔ Prompts — ${dump.kind}`) + dim(` — ${source}`)];
  lines.push(`  id: ${dump.id}`);
  lines.push(
    `  provider: ${dump.llm.provider}   model: ${dump.llm.model}` +
      (dump.llm.reasoning ? `   reasoning: ${dump.llm.reasoning}` : ""),
  );
  // A tutor's opted-in built-in tools ship to the model alongside the prompt.
  if (dump.kind === "tutor" && dump.tools.length > 0) {
    lines.push(`  tools: ${dump.tools.join(", ")}`);
  }
  lines.push(`  prompts: ${sections.length}`);
  for (const section of sections) {
    lines.push(`    ${section.name}: ${section.text.length} chars`);
  }
  lines.push("");
  lines.push(dim("  Run again with --json for the full prompt text."));
  return lines.join("\n");
}
