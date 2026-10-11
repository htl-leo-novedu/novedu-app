// The cloze AUTHORING validator — the cloze counterpart to `loadAndCheckQuiz` in
// `lib/quiz-validate`. Strict schema (`ClozeYamlSchema`) + the gap parser
// (`lib/cloze-gaps.ts`: syntax and limits), surfaced as structured
// `ValidationError[]` that BLOCK an invalid save. Wired into the validator seam
// (`lib/file-validators.ts`) and the `@novedu/cli validate --kind cloze` command.
// A successful check reports the gap inventory, which the `/files` editor and the
// CLI show.
//
// PURE / CLI-safe: imports only `lib/prompt-fragments` helpers (the shared
// scheme-gated YAML load, the Zod-validate wrapper, the error model), the Zod schema
// and the pure gap parser — never a DB-backed loader or any server-only module. The
// lenient runtime `parseCloze` (`lib/cloze-yaml.ts`) is separate.
//
// A cloze exercise is ALWAYS anonymous (nothing links a submission to a student), so
// — like coding — this validator carries no anonymity flag; the file-validator seam
// freezes `anonymous: true` onto the code row.

import { type ClozeGap, formatGapInventory, parseClozeGaps } from "@/lib/cloze-gaps";
import {
  assembleFragmentPrompt,
  type Fetcher,
  type LoadOptions,
  loadYaml,
  type ValidationError,
  type ValidationWarning,
  validate,
} from "@/lib/prompt-fragments";
import { type ClozeYaml, ClozeYamlSchema } from "./cloze-schema";
import type { LlmProvider } from "./llm/provider";

/**
 * The result of checking a cloze file. Mirrors `lib/coding-validate`'s
 * `CodingCheckResult` (no anonymity flag — always anonymous), plus the gap inventory.
 */
export type ClozeCheckResult =
  | {
      ok: true;
      clozeId: string;
      model: string;
      /** The LLM provider serving `model` (`llm.provider`, default SCCH). */
      provider: LlmProvider;
      title: string | null;
      gapCount: number;
      /** Every gap in reading order: number, reference answer, hint. */
      gaps: Omit<ClozeGap, "line" | "column">[];
      /** The one-line inventory, e.g. `10 gaps · 1 "is going to" · 3 "starts" (start) · …`. */
      inventory: string;
      warnings: ValidationWarning[];
    }
  | { ok: false; errors: ValidationError[]; warnings: ValidationWarning[] };

/** Check an already-schema-validated cloze value: the gap parser → metadata. */
function checkClozeParsed(cloze: ClozeYaml): ClozeCheckResult {
  const parsed = parseClozeGaps(cloze.text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };
  const gaps = parsed.gaps.map(({ number, reference, hint }) => ({
    number,
    reference,
    ...(hint ? { hint } : {}),
  }));
  return {
    ok: true,
    clozeId: cloze.id,
    model: cloze.llm.model,
    provider: cloze.llm.provider,
    title: cloze.title ?? null,
    gapCount: gaps.length,
    gaps,
    inventory: formatGapInventory(gaps),
    warnings: [],
  };
}

/**
 * Validate a cloze FILE: scheme-gate + fetch + parse (shared `loadYaml`), the schema
 * and the gap parser, then the fragment block's authoring gate over `instructions`
 * (fetch every referenced library, the thorough whole-library check, an assembly
 * dry-run). The web app passes the default http(s)-only schemes; the CLI adds
 * `file:` so a local cloze YAML on disk validates too.
 */
export async function loadAndCheckCloze(
  url: string,
  fetchImpl: Fetcher,
  opts: LoadOptions = {},
): Promise<ClozeCheckResult> {
  const yaml = await loadYaml(url, fetchImpl, opts);
  if (!yaml.ok) return { ok: false, errors: [yaml.error], warnings: [] };

  const valid = validate<ClozeYaml>(yaml.value, ClozeYamlSchema, "CLOZE_SCHEMA_ERROR", url);
  if (!valid.ok) return { ok: false, errors: [valid.error], warnings: [] };

  const checked = checkClozeParsed(valid.data);
  if (!checked.ok) return checked;

  const assembled = await assembleFragmentPrompt(
    { fragment_files: valid.data.fragment_files, text_files: valid.data.text_files },
    url,
    fetchImpl,
    { allowedSchemes: opts.allowedSchemes, validateLibraries: opts.validateLibraries ?? true },
    valid.data.instructions ?? "",
  );
  const warnings = [...checked.warnings, ...assembled.warnings];
  if (!assembled.ok) return { ok: false, errors: assembled.errors, warnings };
  return { ...checked, warnings };
}
