import {
  type EvalKind,
  type EvalYaml,
  EvalYamlSchema,
  evalKindOf,
  type QuizEvalYaml,
  type TutorEvalYaml,
} from "@/lib/eval-schema";
import {
  dumpPrompts,
  type PromptDumpLlm,
  type QuizPromptDump,
  type TutorPromptDump,
} from "@/lib/prompt-dump";
import {
  error,
  type Fetcher,
  type LoadOptions,
  loadYaml,
  type ValidationError,
  type ValidationWarning,
} from "@/lib/prompt-fragments";
import { loadQuizFrom } from "@/lib/quiz-resolve";
import { loadAndCheckQuiz } from "@/lib/quiz-validate";
import { loadAndBuildTutorPrompt } from "@/lib/tutors";

// The eval-file check: read + parse + schema-validate an eval YAML, resolve its
// `target` activity, load that activity's prompts, and cross-check whatever the eval's
// KIND references in them. ONE function serves both consumers:
//
//   - `novedu-cli validate --kind eval` (offline authoring gate), which additionally
//     asks for `strictTarget` — the SAME strict check `validate --kind quiz` /
//     `--kind tutor` runs. Without it the lenient runtime load below would quietly
//     assert LESS about the target than `--kind <target-kind>` does, which would break
//     the validate contract.
//   - `novedu-cli eval` (the run), which deliberately keeps ONLY the lenient runtime
//     path: what the model really receives is the whole point there.
//
// The prompts come from `dumpPrompts(kind, …)` — the app's own prompt seam
// (`lib/prompt-dump.ts`), never a re-implementation — so an eval runs with
// byte-identical production prompts.
//
// PURE / CLI-safe (`lib/prompt-dump.unit.test.ts` grep-guards it): no `"use server"`,
// no `app/**`, no DB, no `lib/llm/model.ts`.

export interface EvalCheckOptions extends LoadOptions {
  /**
   * Also run the STRICT authoring check on the resolved target — what
   * `validate --kind eval` needs so it asserts exactly as much about the target as
   * validating the target itself would. The `eval` command leaves it off (runtime parity).
   */
  strictTarget?: boolean;
}

/** What every checked eval carries, whatever its kind. */
interface EvalCheckOkBase {
  ok: true;
  /** The eval kind, with the quiz arm's omitted `kind` already resolved. */
  kind: EvalKind;
  /** The `target` resolved against the eval file's own URL. */
  targetUrl: string;
  /** The TARGET activity's own provider/model pair — what the run grades/generates with. */
  llm: PromptDumpLlm;
  /** How many CASES the file declares (golden answers, or conversations). */
  caseCount: number;
  warnings: ValidationWarning[];
}

/** A checked QUIZ eval: golden answers plus the target quiz's grading prompts. */
export interface QuizEvalCheckOk extends EvalCheckOkBase {
  kind: "quiz";
  /** The parsed eval document. (Named `evalFile`: `eval` is a reserved identifier.) */
  evalFile: QuizEvalYaml;
  /** The target quiz's prompt dump — where each case's grading `system` prompt comes from. */
  quizDump: QuizPromptDump;
  /**
   * The RESOLVED quiz's questions as the student sees them — id + the question text
   * (Markdown). Reporting only: the Markdown report (`novedu-cli eval --report`) needs
   * to print the question a mismatched answer belongs to, and the prompt dump carries
   * only the id + the assembled grading prompt. Never gates anything, so a quiz whose
   * text could not be re-read simply yields an empty list.
   */
  quizQuestions: { id: string; text: string }[];
}

/** A checked TUTOR eval: scripted conversations plus the target tutor's system prompt. */
export interface TutorEvalCheckOk extends EvalCheckOkBase {
  kind: "tutor";
  evalFile: TutorEvalYaml;
  /**
   * The target tutor's prompt dump: the assembled system prompt the generated response
   * is judged against, plus the `tools:` grant the eval run binds server-side.
   */
  tutorDump: TutorPromptDump;
}

export type EvalCheckOk = QuizEvalCheckOk | TutorEvalCheckOk;

export type EvalCheckResult =
  | EvalCheckOk
  | { ok: false; errors: ValidationError[]; warnings: ValidationWarning[] };

function fail(errors: ValidationError[], warnings: ValidationWarning[] = []): EvalCheckResult {
  return { ok: false, errors, warnings };
}

/** Zod issues as one error each, the dotted path leading the message. */
function schemaErrors(issues: readonly { path: PropertyKey[]; message: string }[], url: string) {
  return issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return error("EVAL_SCHEMA", path ? `${path}: ${issue.message}` : issue.message, { url });
  });
}

/**
 * Check ONE eval file end to end. `fetcher` is the caller's network seam and
 * `allowedSchemes` the usual SSRF gate (the CLI adds `file:` so an on-disk eval
 * resolves the activity sitting next to it).
 */
export async function loadAndCheckEval(
  url: string,
  fetchImpl: Fetcher,
  opts: EvalCheckOptions = {},
): Promise<EvalCheckResult> {
  const allowedSchemes = opts.allowedSchemes;

  // 1. Read + YAML-parse (shared scheme gate), remapped onto the eval's own codes so a
  // report never mixes eval problems with target problems.
  const yaml = await loadYaml(url, fetchImpl, { allowedSchemes });
  if (!yaml.ok) {
    const code = yaml.error.code === "YAML_PARSE_ERROR" ? "EVAL_PARSE" : "EVAL_READ";
    return fail([error(code, yaml.error.message, { url })]);
  }

  // 2. Schema — a discriminated union of strict objects, so a misspelled key is an
  // error (never a silent no-op) and a `kind: tutor` file reports ITS problems rather
  // than "no union member matched".
  const parsed = EvalYamlSchema.safeParse(yaml.value);
  if (!parsed.success) return fail(schemaErrors(parsed.error.issues, url));
  const evalFile: EvalYaml = parsed.data;
  const kind = evalKindOf(evalFile);

  // 3. Resolve `target` against the EVAL file's own URL, then gate its scheme.
  let targetUrl: string;
  try {
    targetUrl = new URL(evalFile.target, url).href;
  } catch {
    return fail([
      error("EVAL_TARGET_ERROR", `The target "${evalFile.target}" is not a usable URL.`, { url }),
    ]);
  }
  if (allowedSchemes !== undefined) {
    let scheme = "";
    try {
      scheme = new URL(targetUrl).protocol;
    } catch {
      scheme = "";
    }
    if (!allowedSchemes.includes(scheme)) {
      return fail([
        error("EVAL_TARGET_ERROR", `The target URL is not allowed: ${targetUrl}`, {
          url: targetUrl,
        }),
      ]);
    }
  }

  const warnings: ValidationWarning[] = [];

  // 4. Authoring gate on the target (opt-in): the identical strict check
  // `validate --kind <target-kind>` runs, so `validate --kind eval` never asserts less.
  if (opts.strictTarget) {
    const strict =
      kind === "tutor"
        ? // The tutor's strict check IS its full build with `validateLibraries` — the
          // same call `validate --kind tutor` makes.
          await loadAndBuildTutorPrompt(targetUrl, fetchImpl, {
            allowedSchemes,
            validateLibraries: opts.validateLibraries ?? true,
          })
        : await loadAndCheckQuiz(targetUrl, fetchImpl, {
            allowedSchemes,
            validateLibraries: opts.validateLibraries ?? true,
          });
    warnings.push(...strict.warnings);
    if (!strict.ok) return fail(strict.errors, warnings);
  }

  // 5. The RUNTIME load — the prompts exactly as production builds them.
  const dumped = await dumpPrompts(kind, targetUrl, fetchImpl, { allowedSchemes });
  if (!dumped.ok) {
    return fail(
      dumped.errors.map((e) =>
        error("EVAL_TARGET_ERROR", `The target ${kind} could not be loaded: ${e.message}`, {
          url: targetUrl,
        }),
      ),
      warnings,
    );
  }
  const dump = dumped.dump;
  // Belt and braces: the dumper is selected BY the eval's kind, so a mismatch here would
  // be a wiring bug — but a wrong-kind target must fail loudly either way.
  if (dump.kind !== kind) {
    return fail(
      [error("EVAL_TARGET_ERROR", `The target is not a ${kind}.`, { url: targetUrl })],
      warnings,
    );
  }

  if (dump.kind === "tutor" && evalFile.kind === "tutor") {
    // 6a. Cross-check every `required_tools` entry against the TARGET tutor's own grant.
    // The schema already proved the name exists in the catalog; a tool this tutor was
    // never granted simply cannot be called, so the expectation could never be met —
    // an authoring error, and therefore an INVALID FILE (run health) rather than a
    // finding that would quietly report "missing" on every single repeat.
    const granted = new Set(dump.tools);
    const ungranted = evalFile.conversations.flatMap((conversation, index) =>
      (conversation.required_tools ?? [])
        .filter((tool) => !granted.has(tool))
        .map((tool) =>
          error(
            "EVAL_UNGRANTED_TOOL",
            `Conversation #${index + 1} requires the tool "${tool}", but the target tutor's tools are ${dump.tools.length ? dump.tools.map((name) => `"${name}"`).join(", ") : "(none)"}.`,
            { url: targetUrl },
          ),
        ),
    );
    if (ungranted.length > 0) return fail(ungranted, warnings);

    return {
      ok: true,
      kind: "tutor",
      evalFile,
      targetUrl,
      llm: dump.llm,
      tutorDump: dump,
      caseCount: evalFile.conversations.length,
      warnings,
    };
  }
  if (dump.kind !== "quiz" || evalFile.kind === "tutor") {
    // Unreachable (the two kinds are exhaustive and already cross-checked above).
    return fail(
      [error("EVAL_TARGET_ERROR", `The target is not a ${kind}.`, { url: targetUrl })],
      warnings,
    );
  }

  // 6. Cross-check every referenced question id against the RESOLVED pool (so an id
  // imported through `quiz_files` must be spelled with its `"<alias>/<id>"` namespace).
  const known = new Set(dump.grading.questions.map((question) => question.id));
  const unknown = evalFile.questions
    .filter((question) => !known.has(question.question))
    .map((question) =>
      error("EVAL_UNKNOWN_QUESTION", `The target quiz has no question "${question.question}".`, {
        questionId: question.question,
        url: targetUrl,
      }),
    );
  if (unknown.length > 0) return fail(unknown, warnings);

  // 7. The question TEXTS, for the Markdown report only. The prompt dump deliberately
  // carries the assembled grading prompts rather than the source document, so this
  // re-reads the resolved quiz through the SAME runtime loader `dumpPrompts` uses (the
  // `strictTarget` branch above already loads the target twice; a report string is not
  // worth widening the dump contract for). Purely additive: a failure here leaves the
  // list empty and the check itself unaffected.
  const resolved = await loadQuizFrom(targetUrl, fetchImpl, { allowedSchemes });
  const quizQuestions = resolved.ok
    ? resolved.quiz.questions.map((question) => ({ id: question.id, text: question.question }))
    : [];

  return {
    ok: true,
    kind: "quiz",
    evalFile,
    targetUrl,
    llm: dump.llm,
    quizDump: dump,
    quizQuestions,
    caseCount: evalFile.questions.reduce((sum, question) => sum + question.answers.length, 0),
    warnings,
  };
}
