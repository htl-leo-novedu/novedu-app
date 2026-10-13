import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Command } from "commander";
import { type CodingCheckResult, loadAndCheckCoding } from "@/lib/coding-validate";
import { type EvalCheckResult, loadAndCheckEval } from "@/lib/eval-validate";
import {
  type BuildResult,
  type FragmentCheckResult,
  loadAndCheckFragmentFile,
} from "@/lib/prompt-fragments";
import { loadAndCheckQuiz, type QuizCheckResult } from "@/lib/quiz-validate";
import { loadAndBuildTutorPrompt } from "@/lib/tutors";
import { loadAndCheckWriting, type WritingCheckResult } from "@/lib/writing-validate";
import { cliFetcher, signInErrors } from "../file-fetcher";
import {
  formatCodingResult,
  formatEvalResult,
  formatFragmentResult,
  formatQuizResult,
  formatResult,
  formatWritingResult,
} from "../format";

/** What the input YAML is validated AS — declared by the caller, never auto-detected. */
export type ValidateKind = "tutor" | "fragment" | "quiz" | "writing" | "coding" | "eval";

/** Every kind the `--kind` flag accepts (used for the option help + guard). */
export const VALIDATE_KINDS: readonly ValidateKind[] = [
  "tutor",
  "fragment",
  "quiz",
  "writing",
  "coding",
  "eval",
];

/** The CLI-local outcome: the raw core result tagged with the kind that produced it, so the command can pick a formatter without re-deriving it. */
export type ValidateOutcome =
  | { kind: "tutor"; result: BuildResult }
  | { kind: "fragment"; result: FragmentCheckResult }
  | { kind: "quiz"; result: QuizCheckResult }
  | { kind: "writing"; result: WritingCheckResult }
  | { kind: "coding"; result: CodingCheckResult }
  | { kind: "eval"; result: EvalCheckResult };

/**
 * Turn the CLI argument into a URL the tutor core understands: an http(s) URL is
 * used as-is; anything else is treated as a filesystem path and converted to an
 * absolute `file://` URL.
 */
export function toUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return pathToFileURL(resolve(pathOrUrl)).href;
}

/**
 * The validate command's pure core: run the requested pipeline over a local file or
 * public URL. `file:` is allowed in addition to http(s) so local YAML can be
 * validated (the web app deliberately stays http(s)-only). As an authoring tool, the
 * tutor path runs the THOROUGH check (`validateLibraries`), so every fragment in every
 * referenced library is rendered — not just the ones the tutor uses.
 */
export function runValidate(pathOrUrl: string, kind: ValidateKind): Promise<ValidateOutcome> {
  const url = toUrl(pathOrUrl);
  const allowedSchemes = ["http:", "https:", "file:"];
  switch (kind) {
    case "fragment":
      return loadAndCheckFragmentFile(url, cliFetcher, { allowedSchemes }).then((result) => ({
        kind,
        result,
      }));
    case "quiz":
      return loadAndCheckQuiz(url, cliFetcher, { allowedSchemes }).then((result) => ({
        kind,
        result,
      }));
    case "writing":
      return loadAndCheckWriting(url, cliFetcher, { allowedSchemes }).then((result) => ({
        kind,
        result,
      }));
    case "coding":
      return loadAndCheckCoding(url, cliFetcher, { allowedSchemes }).then((result) => ({
        kind,
        result,
      }));
    case "eval":
      // `strictTarget` runs the SAME strict quiz check `--kind quiz` runs on the
      // resolved target, so validating an eval never asserts less about its quiz.
      return loadAndCheckEval(url, cliFetcher, {
        allowedSchemes,
        validateLibraries: true,
        strictTarget: true,
      }).then((result) => ({ kind, result }));
    default:
      return loadAndBuildTutorPrompt(url, cliFetcher, {
        allowedSchemes,
        validateLibraries: true,
      }).then((result) => ({ kind, result }));
  }
}

export function registerValidate(program: Command): void {
  program
    .command("validate")
    .description(
      "Validate a tutor (default), fragment library, quiz, writing, coding or eval YAML by local path or public http(s) URL",
    )
    .argument(
      "<pathOrUrl>",
      "path to a tutor, fragment, quiz, writing, coding or eval YAML file, or a public http(s) URL",
    )
    .option(
      "--kind <kind>",
      `what the file is: ${VALIDATE_KINDS.map((k) => `'${k}'`).join(", ")} ('tutor' is the default)`,
      "tutor",
    )
    .option("--json", "print the raw validation result as JSON")
    .addHelpText(
      "after",
      `
Examples:
  # Validate a tutor (also strict-renders every fragment in every referenced library)
  $ novedu-cli validate ./activities/tutors/my-tutor.yaml

  # Validate a fragment library on its own
  $ novedu-cli validate ./activities/tutors/my-fragments.yaml --kind fragment

  # Validate a quiz, a writing activity, or a coding activity
  $ novedu-cli validate ./activities/quizzes/my-quiz.yaml --kind quiz
  $ novedu-cli validate ./activities/writings/my-writing.yaml --kind writing
  $ novedu-cli validate ./activities/coding/my-coding.yaml --kind coding

  # Validate a golden-answer eval (also strict-checks the quiz it targets)
  $ novedu-cli validate ./my-quiz.eval.yaml --kind eval

  # Machine-readable output for CI
  $ novedu-cli validate https://example.com/tutor.yaml --json`,
    )
    .action(async (pathOrUrl: string, options: { kind?: string; json?: boolean }) => {
      if (options.kind !== undefined && !VALIDATE_KINDS.includes(options.kind as ValidateKind)) {
        console.error(
          `Invalid --kind "${options.kind}": expected ${VALIDATE_KINDS.map((k) => `"${k}"`).join(", ")}.`,
        );
        process.exitCode = 1;
        return;
      }
      const kind = (options.kind ?? "tutor") as ValidateKind;
      const outcome = await runValidate(pathOrUrl, kind);
      // A refused uploaded file names the sign-in that fixes it.
      if (!outcome.result.ok) outcome.result.errors.push(...signInErrors());
      if (options.json) {
        console.log(JSON.stringify(outcome.result, null, 2));
      } else {
        console.log(formatOutcome(outcome, pathOrUrl));
      }
      // Non-zero exit on failure so the CLI is usable as a CI/pre-commit gate.
      process.exitCode = outcome.result.ok ? 0 : 1;
    });
}

/** Pick the formatter for the outcome's kind (each result type has its own renderer). */
function formatOutcome(outcome: ValidateOutcome, source: string): string {
  switch (outcome.kind) {
    case "fragment":
      return formatFragmentResult(outcome.result, source);
    case "quiz":
      return formatQuizResult(outcome.result, source);
    case "writing":
      return formatWritingResult(outcome.result, source);
    case "coding":
      return formatCodingResult(outcome.result, source);
    case "eval":
      return formatEvalResult(outcome.result, source);
    default:
      return formatResult(outcome.result, source);
  }
}
