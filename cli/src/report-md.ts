import {
  anyJudged,
  anyToolsRequired,
  type EvalBatchFile,
  type EvalBatchResult,
  type EvalCaseResult,
  type EvalLlmSpec,
  type EvalQuizCaseResult,
  type EvalRunLlm,
  type EvalRunResult,
  type EvalTutorCaseResult,
  type EvalUsage,
  isTutorCase,
} from "./eval-run";

// The Markdown report of an eval run (`novedu-cli eval --report <file.md>`): a PURE
// renderer over the same `EvalBatchResult` `--json` emits, written for a TEACHER rather
// than for a script — the overview first, then only what needs attention.
//
// ONE uniform layout for a single file and for a batch, exactly like the JSON shape: a
// reader (or a diff between two runs) never has to learn a second structure because a
// glob happened to match one file.
//
// Both eval kinds render into that one layout, branching on `EvalRunResult.kind`: a quiz
// file fills the verdict columns and lists its mismatches, a TUTOR file leaves them as em
// dashes (it has no verdict to measure) and its deliverables are the "Missing tool calls"
// section — the deterministic `required_tools` check — and the "Flagged responses" one,
// the judge's findings over each generated turn.
//
// Two deliberate rules:
//   * DETAILS ONLY FOR WHAT WENT WRONG — mismatched, errored and unstable cases,
//     skipped counts, invalid files, and whatever an LLM judge flagged. A clean pass
//     has no per-case section; the JSON carries every case for anyone who wants them.
//     The flagged section is the one whose cases usually PASSED — it reports on WORDING,
//     never on a verdict, and gates nothing, for either kind.
//   * TEACHER-AUTHORED AND MODEL-GENERATED TEXT IS DATA — question texts, golden
//     answers, grader feedback, scripted conversations and generated responses are
//     neutralized where Markdown structure would break (pipes and newlines in table
//     cells, list items), and otherwise quoted verbatim line by line so nothing is
//     silently reformatted.
//
// Everything variable (the timestamp included) is injected, so the output is a pure
// function of its inputs and unit-testable byte for byte.

/** The run metadata the report stamps that the batch result itself does not carry. */
export interface EvalReportMeta {
  /** Injected rather than read from the clock — the renderer stays pure. */
  generatedAt: Date;
  /** The CLI that produced the run (`cliVersion()`). */
  cliVersion: string;
  repeats: number;
  concurrency: number;
}

/** `2026-08-08 14:32 UTC` — UTC always, so two reports are comparable across machines. */
function timestamp(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Thousands-separated, en-US so the report reads the same on every machine. */
function count(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * A teacher-authored string made safe for a TABLE CELL: newlines collapse to spaces
 * (a raw newline would end the row) and pipes are escaped (they would split it).
 */
function cell(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/** The same neutralization for a LIST ITEM, where only the newline is structural. */
function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A verbatim blockquote: every line prefixed, so the text keeps its own line breaks and
 * can never escape into the surrounding document structure.
 */
function quote(text: string): string {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  return lines.map((line) => (line ? `> ${line}` : ">")).join("\n");
}

/**
 * One spec: `SCCH / gemma-4`, and `Azure Foundry / gpt-5.6-terra (reasoning: high)` when
 * an effort level applies. The level is part of a run's identity — two runs of one model
 * at different efforts produce different behavior — so it must be readable off the report.
 */
function specText(spec: EvalLlmSpec): string {
  return `${spec.provider} / ${spec.model}${spec.reasoning ? ` (reasoning: ${spec.reasoning})` : ""}`;
}

/** `SCCH / gemma-4`, or `SCCH / gemma-4 → Azure Foundry / gpt-5-mini (override)`. */
function llmText(llm: EvalRunLlm): string {
  const effective = specText(llm);
  return llm.overrides ? `${specText(llm.overrides)} → ${effective} (override)` : effective;
}

/**
 * The judge's pair, but ONLY when it differs from the grading pair — a judge line that
 * merely repeats the grader would be noise, while a differing one is essential: judge
 * strictness varies by model, so two reports are comparable only when it matches.
 */
function judgeLlmText(llm: EvalRunLlm): string | undefined {
  const judge = llm.judge;
  if (!judge) return undefined;
  // The EFFORT counts as a difference too: the same model judging at another level is a
  // different judge for comparison purposes.
  if (
    judge.provider === llm.provider &&
    judge.model === llm.model &&
    judge.reasoning === llm.reasoning
  ) {
    return undefined;
  }
  return `${specText(judge)}${judge.overridden ? " (override)" : ""}`;
}

/** `15,420 / 12,300 / 2,810`, or an em dash when nothing was reported. */
function usageCell(usage: EvalUsage): string {
  if (usage.input === 0 && usage.cachedInput === 0 && usage.output === 0) return "—";
  return `${count(usage.input)} / ${count(usage.cachedInput)} / ${count(usage.output)}`;
}

/** The last path segment of a source URL — how a file is named throughout the report. */
function shortSource(source: string): string {
  try {
    const { pathname } = new URL(source);
    return decodeURIComponent(pathname.split("/").pop() || source);
  } catch {
    return source;
  }
}

/** `1/12 (8.3%)` — the false-correct rate, or `0/0` when nothing could be false-correct. */
function falseCorrectCell(result: EvalRunResult): string {
  const { count: hits, denominator, rate } = result.falseCorrect;
  return denominator === 0 ? `${hits}/0` : `${hits}/${denominator} (${(rate * 100).toFixed(1)}%)`;
}

const OVERVIEW_HEADER = [
  "File",
  "Eval",
  "Cases",
  "Passed",
  "Failed",
  "Errored",
  "Skipped",
  "Unstable",
  // Cases whose FEEDBACK the judge flagged. Reported next to the verdict columns, but it
  // gates nothing — a file can be ✅ and still carry flags.
  "Flagged",
  "False-correct",
  "Tokens (in / cached / out)",
];

/** `| a | b |` for one row of the overview table. */
function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** The overview table: one row per file, plus a grand TOTAL row for a real batch. */
function overview(batch: EvalBatchResult): string[] {
  const lines = [
    row(OVERVIEW_HEADER),
    // Names left, numbers right — the shape a teacher scans down.
    row(["---", "---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]),
  ];
  for (const file of batch.files) {
    const name = cell(shortSource(file.source));
    if (!file.result) {
      // An invalid file keeps its row (it is part of the run) but claims no numbers;
      // its validation errors are listed in the details section.
      lines.push(row([name, "**invalid**", "—", "—", "—", "—", "—", "—", "—", "—", "—"]));
      continue;
    }
    const t = file.result.totals;
    // A tutor file has no verdicts, so the verdict columns render as em dashes rather
    // than zeros — "no such measurement" must not read as "measured zero".
    const tutor = file.result.kind === "tutor";
    lines.push(
      row([
        `${file.passed ? "✅" : "❌"} ${name}`,
        `\`${cell(file.result.id)}\``,
        count(t.cases),
        tutor ? "—" : count(t.passed),
        tutor ? "—" : count(t.failed),
        count(t.errored),
        count(t.skipped),
        tutor ? "—" : count(t.unstable),
        // An em dash, not a `0`: a file that was never judged has not been found clean.
        anyJudged(file.result) ? count(t.feedbackFlagged) : "—",
        tutor ? "—" : falseCorrectCell(file.result),
        usageCell(t.usage),
      ]),
    );
  }
  if (batch.files.length > 1) {
    const g = batch.totals;
    const judged = batch.files.some((file) => file.result && anyJudged(file.result));
    lines.push(
      row([
        "**TOTAL**",
        g.invalid ? `${count(g.invalid)} invalid` : "",
        `**${count(g.cases)}**`,
        `**${count(g.passed)}**`,
        `**${count(g.failed)}**`,
        `**${count(g.errored)}**`,
        `**${count(g.skipped)}**`,
        `**${count(g.unstable)}**`,
        judged ? `**${count(g.feedbackFlagged)}**` : "—",
        "",
        `**${usageCell(g.usage)}**`,
      ]),
    );
  }
  return lines;
}

/** The one-line error message an errored repeat row carries. */
function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return JSON.stringify(error ?? null);
}

/** `expected correct, got incorrect` — the heading's verdict half. */
function verdictSummary(evalCase: EvalQuizCaseResult): string {
  const expected = evalCase.expected.join(" | ");
  const got = evalCase.status === "errored" ? "error" : (evalCase.verdict ?? "no verdict");
  return `expected ${expected}, got ${got}`;
}

/** Whether a case belongs in the details section at all (§ details only for problems). */
function needsDetail(evalCase: EvalCaseResult): boolean {
  return evalCase.status === "failed" || evalCase.status === "errored" || evalCase.unstable;
}

/** The "**Question** / **Golden answer**" intro every case detail section opens with. */
function questionAndAnswer(
  evalCase: EvalQuizCaseResult,
  questionText: string | undefined,
): string[] {
  const lines: string[] = [];
  if (questionText) {
    lines.push("**Question**", "", quote(questionText), "");
  }
  lines.push("**Golden answer**", "", quote(evalCase.answer), "");
  return lines;
}

/**
 * One case's section: the question it belongs to, the golden answer, and what the
 * grader said — plus every repeat when they disagreed (the `--repeats` signal is
 * exactly what a teacher wants to read here, not a majority hidden behind one line).
 */
function caseSection(evalCase: EvalQuizCaseResult, questionText: string | undefined): string[] {
  const lines: string[] = [];
  const unstable = evalCase.unstable ? " *(unstable)*" : "";
  lines.push(
    `### \`${evalCase.questionId}\` #${evalCase.answerIndex} — ${verdictSummary(evalCase)}${unstable}`,
  );
  lines.push("");
  lines.push(...questionAndAnswer(evalCase, questionText));

  const graded = evalCase.repeats.filter((r) => r.got !== undefined);
  const disagreed = new Set(graded.map((r) => r.got)).size > 1;

  if (evalCase.repeats.length > 1 && (disagreed || graded.length !== evalCase.repeats.length)) {
    // Every observation, verbatim per repeat — an averaged single line would hide the
    // very nondeterminism the run was measuring.
    lines.push("**Repeats**");
    lines.push("");
    for (const repeat of evalCase.repeats) {
      const verdict = repeat.got ? `\`${repeat.got}\`` : "**error**";
      const detail = repeat.got
        ? inline(repeat.feedback ?? "")
        : inline(errorMessage(repeat.error));
      lines.push(`- #${repeat.repeatIndex + 1} — ${verdict}${detail ? ` — ${detail}` : ""}`);
    }
    lines.push("");
    return lines;
  }

  const feedback = graded.find((r) => r.feedback)?.feedback;
  if (feedback) {
    lines.push("**Grader feedback**");
    lines.push("");
    lines.push(quote(feedback));
    lines.push("");
  }
  const failure = evalCase.repeats.find((r) => r.error !== undefined);
  if (failure) {
    lines.push("**Error**");
    lines.push("");
    lines.push(quote(errorMessage(failure.error)));
    lines.push("");
  }
  return lines;
}

/**
 * The "Flagged feedback" section: what the LLM judge found wrong with the TEXT the
 * grader wrote, per case, with each flagged repeat's verdict and feedback quoted verbatim
 * and the judge's issues as `criterion — note` items.
 *
 * Separate from the verdict sections on purpose — these cases usually PASSED (the verdict
 * was right, the wording was not), and mixing them into the mismatch list would suggest
 * the run failed on them. Empty when the file has no flags.
 */
function flaggedSection(result: EvalRunResult, questionText: Map<string, string>): string[] {
  const flagged = result.cases.filter(
    (evalCase): evalCase is EvalQuizCaseResult =>
      evalCase.feedbackFlagged && !isTutorCase(evalCase),
  );
  if (flagged.length === 0) return [];

  const lines = ["### Flagged feedback", ""];
  lines.push(
    "_An LLM judge audited each feedback text against the very grading prompt it was " +
      "written under. Reported only — flagged feedback never fails a run._",
  );
  lines.push("");
  for (const evalCase of flagged) {
    lines.push(`#### \`${evalCase.questionId}\` #${evalCase.answerIndex}`);
    lines.push("");
    lines.push(...questionAndAnswer(evalCase, questionText.get(evalCase.questionId)));
    for (const repeat of evalCase.repeats) {
      const issues = repeat.judge?.issues ?? [];
      if (issues.length === 0) continue;
      // The repeat's OWN verdict — the feedback was judged against that one, never
      // against the case majority.
      lines.push(`**Repeat #${repeat.repeatIndex + 1} — \`${repeat.got ?? "?"}\`**`);
      lines.push("");
      lines.push(quote(repeat.feedback ?? ""));
      lines.push("");
      for (const issue of issues) {
        lines.push(`- \`${cell(issue.criterion)}\` — ${inline(issue.note)}`);
      }
      lines.push("");
    }
  }
  return lines;
}

/**
 * A tutor case's stable heading: the teacher's `title` when it has one, otherwise its
 * 1-based index plus an excerpt of the FIRST student line — enough to recognise the case
 * in a report without opening the eval file.
 */
function tutorCaseLabel(evalCase: EvalTutorCaseResult): string {
  if (evalCase.title) return `#${evalCase.index + 1} ${cell(evalCase.title)}`;
  const firstStudent = evalCase.conversation.find((turn) => "student" in turn);
  const excerpt = firstStudent && "student" in firstStudent ? inline(firstStudent.student) : "";
  const short = excerpt.length > 60 ? `${excerpt.slice(0, 59)}…` : excerpt;
  return short ? `#${evalCase.index + 1} — ${short}` : `#${evalCase.index + 1}`;
}

/** The scripted conversation as one labeled, verbatim blockquote per turn. */
function conversationBlock(evalCase: EvalTutorCaseResult): string[] {
  const lines = ["**Conversation**", ""];
  for (const turn of evalCase.conversation) {
    const role = "student" in turn ? "student" : "tutor";
    const text = "student" in turn ? turn.student : turn.tutor;
    lines.push(`*${role}*`, "", quote(text), "");
  }
  return lines;
}

/** One ERRORED tutor case: what was asked, and why nothing came back. */
function tutorErrorSection(evalCase: EvalTutorCaseResult): string[] {
  const lines = [`### ${tutorCaseLabel(evalCase)} — error`, ""];
  lines.push(...conversationBlock(evalCase));
  const failure = evalCase.repeats.find((r) => r.error !== undefined);
  if (failure) {
    lines.push("**Error**", "", quote(errorMessage(failure.error)), "");
  }
  return lines;
}

/** `random_number, random_number` — a repeat's tool calls, or `(none)` when it made none. */
function toolCallList(toolCalls: readonly string[] | undefined): string {
  return toolCalls && toolCalls.length > 0
    ? toolCalls.map((name) => `\`${name}\``).join(", ")
    : "(none)";
}

/**
 * The tutor kind's "Missing tool calls" section: every case that declares `required_tools`
 * and had at least one repeat skip one. Per case the required list, what each offending
 * repeat actually called, and which tools were missing there.
 *
 * Its own section rather than a column, for the same reason "Flagged responses" is one:
 * these cases are `ok` and the run PASSED — a missing tool call is a note about the
 * tutor's behavior, never a failure. Cases whose tools all ran stay out entirely; the
 * `--json` report carries every repeat's `toolCalls` for anyone who wants them.
 */
function tutorMissingToolsSection(result: EvalRunResult): string[] {
  const flagged = result.cases.filter(
    (evalCase): evalCase is EvalTutorCaseResult => isTutorCase(evalCase) && evalCase.toolsFlagged,
  );
  if (flagged.length === 0) return [];

  const lines = ["### Missing tool calls", ""];
  lines.push(
    "_These cases require a tool the tutor did not call in every run. Reported only — a " +
      "missing tool call never fails a run, and tools beyond the required ones are fine._",
  );
  lines.push("");
  for (const evalCase of flagged) {
    lines.push(`#### ${tutorCaseLabel(evalCase)}`);
    lines.push("");
    lines.push(`**Required** ${toolCallList(evalCase.requiredTools)}`);
    lines.push("");
    for (const repeat of evalCase.repeats) {
      const missing = repeat.missingTools ?? [];
      if (missing.length === 0) continue;
      lines.push(
        `- Repeat #${repeat.repeatIndex + 1} — missing ${toolCallList(missing)}; ` +
          `called ${toolCallList(repeat.toolCalls)}`,
      );
    }
    lines.push("");
  }
  return lines;
}

/**
 * The tutor kind's "Flagged responses" section — the report's actual deliverable: per
 * flagged case the scripted conversation, the teacher's expectations when it states any,
 * and each flagged repeat's GENERATED RESPONSE verbatim followed by the judge's issues.
 *
 * Clean cases stay out entirely (their generated texts are in the `--json` report), and
 * a flag never means the run failed — the tutor kind is report-only.
 */
function tutorFlaggedSection(result: EvalRunResult): string[] {
  const flagged = result.cases.filter(
    (evalCase): evalCase is EvalTutorCaseResult =>
      isTutorCase(evalCase) && evalCase.feedbackFlagged,
  );
  if (flagged.length === 0) return [];

  const lines = ["### Flagged responses", ""];
  lines.push(
    "_An LLM judge audited each generated response against the tutor's own system " +
      "prompt and, where the case states any, the teacher's expectations. Reported only — " +
      "a flagged response never fails a run._",
  );
  lines.push("");
  for (const evalCase of flagged) {
    lines.push(`#### ${tutorCaseLabel(evalCase)}`);
    lines.push("");
    lines.push(...conversationBlock(evalCase));
    if (evalCase.gradingInstructions) {
      lines.push("**Expectations for this case**", "", quote(evalCase.gradingInstructions), "");
    }
    if (evalCase.requiredTools) {
      lines.push(`**Required tools** ${toolCallList(evalCase.requiredTools)}`, "");
    }
    for (const repeat of evalCase.repeats) {
      const issues = repeat.judge?.issues ?? [];
      if (issues.length === 0) continue;
      lines.push(`**Generated response — repeat #${repeat.repeatIndex + 1}**`);
      lines.push("");
      lines.push(quote(repeat.text ?? ""));
      lines.push("");
      // Context, never a verdict: the tools that ran alongside this response. Shown when
      // the server reported any, or when the case required some (where `(none)` is the
      // interesting fact) — tools beyond the required ones are plain information.
      if (repeat.toolCalls && (repeat.toolCalls.length > 0 || evalCase.requiredTools)) {
        lines.push(`*tool calls: ${toolCallList(repeat.toolCalls)}*`, "");
      }
      for (const issue of issues) {
        lines.push(`- \`${cell(issue.criterion)}\` — ${inline(issue.note)}`);
      }
      lines.push("");
    }
  }
  return lines;
}

/** One file's details section, or `[]` when the file has nothing to report. */
function fileDetails(file: EvalBatchFile): string[] {
  const name = shortSource(file.source);

  if (!file.result) {
    const errors = file.errors ?? [];
    return [
      `## ${cell(name)} — invalid`,
      "",
      "This file was not run; fix the problems below and run it again.",
      "",
      ...errors.map((issue) => `- \`${cell(issue.code)}\` — ${inline(issue.message)}`),
      "",
    ];
  }

  const result = file.result;
  const tutor = result.kind === "tutor";
  const detailed = result.cases.filter(needsDetail);
  const skipped = result.totals.skipped;
  const questionText = new Map(result.questions.map((question) => [question.id, question.text]));
  const flagged = tutor ? tutorFlaggedSection(result) : flaggedSection(result, questionText);
  const missingTools = tutor ? tutorMissingToolsSection(result) : [];
  if (
    detailed.length === 0 &&
    skipped === 0 &&
    !result.aborted &&
    flagged.length === 0 &&
    missingTools.length === 0
  ) {
    return [];
  }

  const lines = [`## ${cell(name)} — \`${cell(result.id)}\``, ""];
  if (result.aborted) {
    lines.push("> [!WARNING]");
    lines.push(`> The run was aborted: ${inline(result.aborted.message)}`);
    lines.push("");
  }
  for (const evalCase of detailed) {
    lines.push(
      ...(isTutorCase(evalCase)
        ? tutorErrorSection(evalCase)
        : caseSection(evalCase, questionText.get(evalCase.questionId))),
    );
  }
  if (skipped > 0) {
    // One line, never one section per case: an aborted 252-case run must not print
    // hundreds of identical "never attempted" blocks.
    const reason = result.aborted ? ` (${inline(result.aborted.message)})` : "";
    lines.push(
      `**${count(skipped)} ${tutor ? "conversation" : "case"}(s) were never attempted**${reason} — the run is incomplete, so it cannot pass.`,
    );
    lines.push("");
  }
  // Last within the file: these are the only sections whose cases usually PASSED, so they
  // must not sit between the file's verdict problems and their summary line. The
  // deterministic tool finding comes before the judge's — it is the harder fact.
  lines.push(...missingTools);
  lines.push(...flagged);
  return lines;
}

/**
 * Render the whole run as Markdown: verdict headline, the run's facts, the overview
 * table, then the details of everything that needs a teacher's attention.
 */
export function renderEvalMarkdownReport(batch: EvalBatchResult, meta: EvalReportMeta): string {
  const lines: string[] = [];
  lines.push(`# Eval report — ${batch.passed ? "✅ passed" : "❌ failed"}`);
  lines.push("");
  lines.push(`- **Generated** ${timestamp(meta.generatedAt)} · novedu-cli ${meta.cliVersion}`);

  const llms = [
    ...new Set(
      batch.files.filter((f) => f.result).map((f) => llmText((f.result as EvalRunResult).llm)),
    ),
  ];
  // Normally one line; a batch whose files declare different models keeps them all
  // rather than picking one and lying about the rest.
  for (const llm of llms) lines.push(`- **LLM** ${llm}`);

  // Only when the judge ran on a DIFFERENT model than the grader — see judgeLlmText.
  const judges = [
    ...new Set(
      batch.files
        .map((file) => (file.result ? judgeLlmText(file.result.llm) : undefined))
        .filter((text): text is string => text !== undefined),
    ),
  ];
  for (const judge of judges) lines.push(`- **Feedback judge** ${judge}`);

  lines.push(
    `- **Run** ${count(batch.totals.files)} file(s), ${count(batch.totals.cases)} case(s) × ` +
      `${count(meta.repeats)} repeat(s), concurrency ${count(meta.concurrency)}`,
  );
  // The tool check's totals line, under the SAME omission rule as the Flagged column's em
  // dash: it appears only when at least one case in the batch declared `required_tools`,
  // so a run that required nothing never prints a reassuring `0`.
  if (batch.files.some((file) => file.result && anyToolsRequired(file.result))) {
    lines.push(
      `- **Missing tool calls** ${count(batch.totals.toolsFlagged)} case(s) did not call a ` +
        "required tool in every run — reported only, never a failure",
    );
  }
  const tokens = batch.totals.usage;
  if (tokens.input || tokens.cachedInput || tokens.output) {
    lines.push(
      `- **Tokens** ${count(tokens.input)} in (${count(tokens.cachedInput)} cached) / ` +
        `${count(tokens.output)} out — successful calls only, so a lower bound`,
    );
  }
  lines.push("");

  const aborted = batch.files.filter((file) => file.result?.aborted);
  if (aborted.length > 0) {
    lines.push("> [!WARNING]");
    lines.push(
      `> The run was ABORTED — ${count(batch.totals.skipped)} case(s) were never graded, ` +
        "so this report is incomplete.",
    );
    lines.push("");
  }

  // Judging degraded: the GRADING half of the run is complete and trustworthy, only the
  // feedback audit stopped — so this is its own warning, never folded into the abort one.
  const degradedAt = batch.files.find((file) => file.result?.judging === "degraded");
  if (degradedAt?.result) {
    lines.push("> [!WARNING]");
    lines.push(
      `> Feedback judging STOPPED during \`${cell(shortSource(degradedAt.source))}\` after ` +
        "3 judge calls failed in a row — everything from there on was graded but NOT " +
        "judged, and shows an em dash rather than a count in the Flagged column. " +
        "Grading was unaffected.",
    );
    lines.push("");
  }

  lines.push("## Overview");
  lines.push("");
  lines.push(...overview(batch));
  lines.push("");

  // The per-file sections stay at `##`, siblings of the overview: a `## Details`
  // wrapper would make every file a child of it and push the cases to `####`, which
  // reads (and renders) worse than the flat file → case nesting.
  const details = batch.files.flatMap((file) => fileDetails(file));
  if (details.length === 0) {
    lines.push(
      "_Nothing else to report. The `--json` report carries every case, including the clean ones._",
    );
    lines.push("");
  } else {
    lines.push(
      "_Below: only the mismatched, errored and unstable cases, plus anything the judge flagged. Clean cases live in the `--json` report._",
    );
    lines.push("");
    lines.push(...details);
  }
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
