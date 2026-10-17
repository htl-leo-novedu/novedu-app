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
