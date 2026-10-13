import type { Command } from "commander";
import {
  dumpPrompts,
  PROMPT_KINDS,
  type PromptDumpResult,
  type PromptKind,
  promptSections,
} from "@/lib/prompt-dump";
import { cliFetcher, signInErrors } from "../file-fetcher";
import { formatPromptDump } from "../format";
import { toUrl } from "./validate";

// `novedu-cli prompts <pathOrUrl> [--kind …] [--json]` — print the EXACT LLM prompts an
// activity YAML produces. Offline and sign-in-free, exactly like `validate`, and sharing
// its argument conventions (local path or file:/http(s) URL, caller-declared `--kind`,
// exit 0/1, human summary by default, `--json` for the full dump).
//
// All prompt assembly lives behind the app's own seam (`lib/prompt-dump.ts`), which calls
// the same builders and loaders production runs — this command only picks a kind and
// renders. Never re-derive a prompt here.

export { PROMPT_KINDS, type PromptKind } from "@/lib/prompt-dump";

/**
 * The command's pure core: dump the prompts of a local file or public URL. `file:` is
 * allowed in addition to http(s) so an on-disk activity dumps (the web app deliberately
 * stays http(s)-only), and relative `fragment_files` / `quiz_files` resolve against the
 * activity's own location.
 *
 * This is the RUNTIME path — the lenient loaders the app runs when a student opens the
 * activity — so the output is what the model really receives. Use `validate` for the
 * strict authoring gate.
 */
export function runPrompts(pathOrUrl: string, kind: PromptKind): Promise<PromptDumpResult> {
  return dumpPrompts(kind, toUrl(pathOrUrl), cliFetcher, {
    allowedSchemes: ["http:", "https:", "file:"],
  });
}

export function registerPrompts(program: Command): void {
  program
    .command("prompts")
    .description(
      "Print the exact LLM prompts a tutor (default), quiz, writing or coding YAML produces",
    )
    .argument(
      "<pathOrUrl>",
      "path to a tutor, quiz, writing or coding YAML file, or a public http(s) URL",
    )
    .option(
      "--kind <kind>",
      `what the file is: ${PROMPT_KINDS.map((k) => `'${k}'`).join(", ")} ('tutor' is the default)`,
      "tutor",
    )
    .option("--json", "print the full prompt dump as JSON")
    .addHelpText(
      "after",
      `
Examples:
  # The tutor's assembled system prompt (fragments resolved in place)
  $ novedu-cli prompts ./activities/tutors/my-tutor.yaml

  # Every grading prompt of a quiz, plus its discussion prompt, as JSON
  $ novedu-cli prompts ./activities/quizzes/my-quiz.yaml --kind quiz --json

  # A writing activity's coach prompt / a coding activity's injected system prompt
  $ novedu-cli prompts ./activities/writings/my-writing.yaml --kind writing
  $ novedu-cli prompts ./activities/coding/my-coding.yaml --kind coding

  # One question's grading prompt, straight out of the JSON dump
  $ novedu-cli prompts ./my-quiz.yaml --kind quiz --json | jq -r '.grading.questions[0].system'`,
    )
    .action(async (pathOrUrl: string, options: { kind?: string; json?: boolean }) => {
      if (options.kind !== undefined && !PROMPT_KINDS.includes(options.kind as PromptKind)) {
        console.error(
          `Invalid --kind "${options.kind}": expected ${PROMPT_KINDS.map((k) => `"${k}"`).join(", ")}.`,
        );
        process.exitCode = 1;
        return;
      }
      const kind = (options.kind ?? "tutor") as PromptKind;
      const result = await runPrompts(pathOrUrl, kind);
      if (!result.ok) {
        // Failures follow the CLI's JSON-on-stderr convention.
        // A refused uploaded file names the sign-in that fixes it.
        const errors = [...result.errors, ...signInErrors()];
        console.error(JSON.stringify({ errors }, null, 2));
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        // The envelope is the dump itself: `{ kind, id, llm, … }`.
        console.log(JSON.stringify(result.dump, null, 2));
      } else {
        console.log(formatPromptDump(result.dump, promptSections(result.dump), pathOrUrl));
      }
      process.exitCode = 0;
    });
}
