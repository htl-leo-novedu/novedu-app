// High-level tutor orchestration: URL → fetch → validate tutor schema → render the
// `tutor_instructions` host text (with its inline `{{fragment}}` markers) via the
// shared `assembleFragmentPrompt` → wrap the tutor metadata into a single
// `BuildResult`. All fragment fetch/placement-check/render lives in
// `@/lib/prompt-fragments`; this file adds only the tutor-specific glue. The fetcher is
// injected so the pipeline is unit-testable without touching the network.

import {
  assembleFragmentPrompt,
  type BuildResult,
  type Fetcher,
  type LoadOptions,
  loadAndValidate,
  type ValidationWarning,
} from "@/lib/prompt-fragments";
import { TutorSchema } from "./schemas";

export async function loadAndBuildTutorPrompt(
  url: string,
  fetchImpl: Fetcher,
  opts: LoadOptions = {},
): Promise<BuildResult> {
  const warnings: ValidationWarning[] = [];

  // --- tutor definition ---
  const tutorValid = await loadAndValidate(url, fetchImpl, opts, TutorSchema, "TUTOR_SCHEMA_ERROR");
  if (!tutorValid.ok) return { ok: false, errors: [tutorValid.error], warnings };
  const tutor = tutorValid.data;

  // --- render tutor_instructions as the host template (fragments placed inline) ---
  const assembled = await assembleFragmentPrompt(
    tutor.prompt,
    url,
    fetchImpl,
    opts,
    tutor.prompt.tutor_instructions,
  );
  warnings.push(...assembled.warnings);
  if (!assembled.ok) return { ok: false, errors: assembled.errors, warnings };
  warnings.push(...unmentionedToolWarnings(tutor.tools, assembled.prompt));

  // Surface the tutor's model alongside the prompt so consumers (the chat route)
  // don't have to re-parse the YAML to learn which model to drive.
  return {
    ok: true,
    id: tutor.id,
    prompt: assembled.prompt,
    model: tutor.llm.model,
    provider: tutor.llm.provider,
    reasoning: tutor.llm.reasoning,
    imageInput: tutor.llm.imageInput ?? true,
    tools: tutor.tools,
    anonymous: tutor.anonymous ?? true,
    title: tutor.title,
    description: tutor.description,
    exampleQuestions: tutor.exampleQuestions ?? [],
    warnings,
  };
}

/** The teacher guide's tutor chapter: built-in tools and the prompt paragraph each one needs. */
const TOOLS_GUIDE_URL = "https://docs.novedu.at/20-building-activities/03-tutors/";

/**
 * One warning per granted tool the assembled prompt never names. The platform
 * never mentions tools in the prompt (docs/tutor-tools.md), so a grant the author
 * forgot to explain is a tool the model rarely calls. A plain, case-insensitive
 * substring check: any mention ("the board tool", "whiteboard") counts.
 */
export function unmentionedToolWarnings(
  tools: readonly string[],
  prompt: string,
): ValidationWarning[] {
  const text = prompt.toLowerCase();
  return tools
    .filter((tool) => !text.includes(tool.toLowerCase()))
    .map((tool) => ({
      code: "UNMENTIONED_TOOL" as const,
      message: `The tutor is granted the "${tool}" tool, but its prompt never mentions it. Novedu does not tell the model about its tools: say in tutor_instructions when to use "${tool}". The teacher guide has a recommended paragraph for each built-in tool: ${TOOLS_GUIDE_URL}`,
    }));
}
