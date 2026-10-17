// The coding AUTHORING validator — the coding counterpart to `loadAndCheckWriting`
// in `lib/writing-validate`. Strict schema (`CodingYamlSchema`) surfaced as
// structured `ValidationError[]` that BLOCK an invalid save. Wired into the
// validator seam (`lib/file-validators.ts`) and the `@novedu/cli validate --kind
// coding` command.
//
// PURE / CLI-safe: imports only the shared load/check steps (`lib/prompt-fragments`,
// `lib/activity-load`) and the Zod schema — never
// `lib/coding-fetch` (DB-backed) or any server-only module. The lenient runtime
// `parseCoding` (`lib/coding-yaml.ts`) is unchanged and separate.
//
// Coding is ALWAYS anonymous (there are no in-app conversations to attribute), so
// — unlike quiz/writing — this validator carries no anonymity flag;
// the file-validator seam freezes `anonymous: true` onto the code row.

import { checkInstructions } from "@/lib/activity-load";
import {
  type Fetcher,
  type LoadOptions,
  loadAndValidate,
  type ValidationError,
  type ValidationWarning,
  validate,
} from "@/lib/prompt-fragments";
import { type CodingYaml, CodingYamlSchema } from "./coding-schema";
import type { LlmProvider } from "./llm/provider";

/**
 * The result of checking a coding file. Mirrors `lib/writing-validate`'s
 * `WritingCheckResult`, minus the anonymity flag (coding is always anonymous). It
 * carries the display title the validator seam denormalizes onto the code row.
 */
export type CodingCheckResult =
  | {
      ok: true;
      codingId: string;
      model: string;
      /** The LLM provider serving `model` (`llm.provider`, default SCCH). */
      provider: LlmProvider;
      title: string | null;
      warnings: ValidationWarning[];
    }
  | { ok: false; errors: ValidationError[]; warnings: ValidationWarning[] };

/**
 * Extract metadata from an already-schema-validated coding value. Split from
 * `checkCodingValue` so `loadAndCheckCoding` can reuse the single `validate` it already
 * ran (no second parse of the same document against the same schema).
 */
function checkCodingParsed(coding: CodingYaml): Extract<CodingCheckResult, { ok: true }> {
  return {
    ok: true,
    codingId: coding.id,
    model: coding.llm.model,
    provider: coding.llm.provider,
    title: coding.title ?? null,
    warnings: [],
  };
}

/**
 * Validate an already-parsed coding value against its schema, then extract metadata.
 * Pure (the parsed value is passed in); `loadAndCheckCoding` wraps it with fetch +
 * YAML parse.
 */
export function checkCodingValue(parsed: unknown, url?: string): CodingCheckResult {
  const valid = validate<CodingYaml>(parsed, CodingYamlSchema, "CODING_SCHEMA_ERROR", url);
  if (!valid.ok) return { ok: false, errors: [valid.error], warnings: [] };
  return checkCodingParsed(valid.data);
}

/**
 * Validate a coding FILE: scheme-gate + fetch + parse + schema (shared
 * `loadAndValidate`), metadata, then the fragment block's authoring gate over
 * `instructions` (shared `checkInstructions`). The web app passes the default
 * http(s)-only schemes; the CLI adds `file:` so a local coding YAML on disk validates too.
 */
export async function loadAndCheckCoding(
  url: string,
  fetchImpl: Fetcher,
  opts: LoadOptions = {},
): Promise<CodingCheckResult> {
  const valid = await loadAndValidate(
    url,
    fetchImpl,
    opts,
    CodingYamlSchema,
    "CODING_SCHEMA_ERROR",
  );
  if (!valid.ok) return { ok: false, errors: [valid.error], warnings: [] };
  const checked = await checkInstructions(valid.data, url, fetchImpl, opts);
  if (!checked.ok) return checked;
  return { ...checkCodingParsed(valid.data), warnings: checked.warnings };
}
