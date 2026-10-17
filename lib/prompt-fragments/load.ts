// Shared load/resolve/assemble infrastructure for the document-level fragment
// block every activity kind embeds. The fetcher is injected so this entire pipeline
// is unit-testable without touching the network.
//
// `assembleFragmentPrompts` is the ONE orchestrator: given a `{ fragment_files,
// text_files }` block, a base URL, a `Fetcher`, and `LoadOptions`, it fetches every
// declared library and text file in parallel, (optionally) runs the thorough
// whole-library check, checks consistency, and assembles each host text — returning
// the finished prompt texts or the structured errors. `assembleFragmentPrompt` is its
// single-host wrapper. Tutor, writing, and coding render their one host text; the quiz
// renders two (`instructions` + `discussion.instructions`) in one pass; none of them
// touch Handlebars or `COMPILE_OPTIONS` themselves.

import type { z } from "zod";
import { resolveRelativeUrl } from "@/lib/relative-url";
import { renderFragmentContent } from "./assemble";
import { checkPlacements, resolveAndMerge } from "./consistency";
import {
  error,
  type FragmentCheckResult,
  type ValidationError,
  type ValidationWarning,
} from "./errors";
import type { Fetcher } from "./fetcher";
import { checkFragmentFileValue, checkFragmentTemplates } from "./fragment";
import { parseHostPlacements, renderHostTemplate } from "./host-template";
import { parseYaml, type SchemaErrorCode, validate } from "./parse";
import { type FragmentBlock, type FragmentFile, FragmentFileSchema } from "./schemas";
import { sliceLines } from "./text-files";

/** The 200 KB (UTF-8 bytes) per-file cap on an embedded `text_files:` body — fail closed above it. */
const MAX_TEXT_FILE_BYTES = 200 * 1024;

/**
 * Resolve a fragment-file reference to an absolute URL. An absolute http(s) ref is used
 * as-is; anything else is treated as relative to the activity URL — standard URL resolution
 * drops the activity's filename and appends the relative path (so `my-fragments.yaml`
 * next to `.../tutors/my-tutor.yaml` becomes `.../tutors/my-fragments.yaml`,
 * and `./` / `../` segments work too). Throws if a relative ref is unparseable; the schema
 * already guarantees the only inputs here are http(s) URLs or relative paths.
 */
export function resolveFragmentUrl(ref: string, baseUrl: string): string {
  return resolveRelativeUrl(ref, baseUrl);
}

async function fetchText(
  url: string,
  fetchImpl: Fetcher,
): Promise<{ ok: true; text: string } | { ok: false; error: ValidationError }> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return {
        ok: false,
        error: error("FETCH_FAILED", `Failed to fetch ${url} (HTTP ${res.status})`, {
          url,
          status: res.status,
        }),
      };
    }
    return { ok: true, text: await res.text() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: error("FETCH_FAILED", `Failed to fetch ${url}: ${message}`, { url }),
    };
  }
}

/**
 * Options for {@link assembleFragmentPrompt}, {@link loadYaml} and
 * {@link loadAndCheckFragmentFile}.
 *
 * `allowedSchemes` constrains which URL schemes the activity (and its fragment files)
 * may use, defaulting to http(s) only — the server's SSRF guard. The CLI passes
 * `file:` as well so it can validate an activity/fragment YAML on disk (handed in as a
 * `file://` URL); see `resolveFragmentUrl` for how relative fragment refs then
 * resolve against that local path.
 *
 * `validateLibraries` opts a build INTO the thorough whole-library check: every
 * fragment in every referenced file is strict-rendered against its own `input_schema`
 * (not just the fragments this activity uses). It defaults to `false` because it runs
 * on the HOT PATH (chat start, quiz grading, the coding proxy) where only the assembled
 * prompt is needed; the authoring gates that should be strict — share time, the validate
 * page/API, and the CLI — pass `true`.
 */
export interface LoadOptions {
  allowedSchemes?: string[];
  validateLibraries?: boolean;
}

/** The production URL schemes (http(s)); the CLI adds `file:` for on-disk activities. */
export const DEFAULT_ALLOWED_SCHEMES = ["http:", "https:"];

/**
 * The SSRF scheme check every activity and fragment fetch shares: is `url`'s scheme in
 * `allowedSchemes`? An unparseable URL is never allowed.
 */
export function schemeAllowed(url: string, allowedSchemes: string[]): boolean {
  try {
    return allowedSchemes.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * The structured form of `schemeAllowed` for the top-level activity load (`loadYaml`)
 * and every fragment-file fetch (`assembleFragmentPrompt`). Returns the error to
 * surface, or `null` when the scheme is allowed.
 */
function schemeGate(url: string, allowedSchemes: string[]): ValidationError | null {
  if (schemeAllowed(url, allowedSchemes)) return null;
  const allowed = allowedSchemes.map((s) => s.replace(/:$/, "")).join("/");
  return error("INVALID_URL", `Provide a valid ${allowed} URL`, { url });
}

/**
 * The shared front of every load: enforce the URL scheme allow-list (SSRF guard),
 * fetch the document, and parse it as YAML — returning the parsed-but-not-yet-schema-
 * validated value or the first structured error. Reused by the activity builders, the
 * standalone fragment checker, and the quiz/writing/coding validators so they all gate
 * schemes identically.
 */
export async function loadYaml(
  url: string,
  fetchImpl: Fetcher,
  opts: LoadOptions = {},
): Promise<{ ok: true; value: unknown } | { ok: false; error: ValidationError }> {
  const schemeError = schemeGate(url, opts.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES);
  if (schemeError) return { ok: false, error: schemeError };

  const fetched = await fetchText(url, fetchImpl);
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const parsed = parseYaml(fetched.text, url);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  return { ok: true, value: parsed.value };
}

/**
 * `loadYaml` + the document's schema in one step — the front of every activity's
 * authoring check (tutor, quiz and its includes, writing, coding). Returns the typed
 * document or the first structured error.
 */
export async function loadAndValidate<T>(
  url: string,
  fetchImpl: Fetcher,
  opts: LoadOptions,
  schema: z.ZodType<T>,
  code: SchemaErrorCode,
): Promise<{ ok: true; data: T } | { ok: false; error: ValidationError }> {
  const yaml = await loadYaml(url, fetchImpl, opts);
  if (!yaml.ok) return yaml;
  return validate<T>(yaml.value, schema, code, url);
}

/** The result of resolving one document-level fragment block into prompt text. */
export type AssembleResult =
  | { ok: true; prompt: string; warnings: ValidationWarning[] }
  | { ok: false; errors: ValidationError[]; warnings: ValidationWarning[] };

/** The result of rendering SEVERAL host texts against one shared fragment block. */
export type AssembleManyResult =
  | { ok: true; prompts: string[]; warnings: ValidationWarning[] }
  | { ok: false; errors: ValidationError[]; warnings: ValidationWarning[] };

/**
 * Render an activity's host text (`tutor_instructions` / `instructions`) into a
 * finished prompt string, inserting each inline `{{fragment "alias.id" …}}` marker in
 * place. Fetches every declared fragment library in parallel (relative refs resolved
 * against `baseUrl`), schema-validates each, (optionally) runs the thorough
 * whole-library check, extracts + checks the placements, then compiles + renders the
 * host template under strict Handlebars.
 *
 * The single seam every activity kind shares — the sole owner of the fetch → validate
 * → check → render pipeline. `hostText` IS the template: fragments appear only where
 * the author placed a marker; there is no ordering concept and no prepend fallback.
 *
 * TEMPLATE-SEMANTICS OPT-IN: an activity that declares NEITHER `fragment_files:` NOR
 * `text_files:` is NEVER compiled — its host text returns byte-verbatim (protecting plain
 * activities and the authoring tutors whose prose contains sample markers as teaching
 * content). Text files are fetched in parallel with the fragment libraries; each is kept
 * as a RAW string (no YAML parse) and spliced verbatim at render — never re-compiled as
 * Handlebars, so a literal `{{` in course material can never execute.
 */
export async function assembleFragmentPrompt(
  block: FragmentBlock,
  baseUrl: string,
  fetchImpl: Fetcher,
  opts: LoadOptions = {},
  hostText = "",
): Promise<AssembleResult> {
  const result = await assembleFragmentPrompts(block, baseUrl, fetchImpl, opts, [hostText]);
  if (!result.ok) return result;
  // One host in ⇒ one prompt out; the `?? ""` only satisfies noUncheckedIndexedAccess.
  return { ok: true, prompt: result.prompts[0] ?? "", warnings: result.warnings };
}

/**
 * The multi-host variant of {@link assembleFragmentPrompt}: renders SEVERAL host texts
 * of the SAME document (e.g. a quiz's `instructions` and `discussion.instructions`)
 * against the document's one fragment block in a single pass — every fragment library
 * and text file is fetched and checked ONCE, placements are parsed per host but
 * consistency-checked in ONE pass over their union (so a library placed in any host
 * counts as used), and each host renders on its own. Any error fails the whole call
 * (fail closed); `prompts` is index-aligned with `hostTexts`. The template-semantics
 * opt-in applies identically: with neither list declared, ALL host texts return
 * byte-verbatim.
 */
export async function assembleFragmentPrompts(
  block: FragmentBlock,
  baseUrl: string,
  fetchImpl: Fetcher,
  opts: LoadOptions = {},
  hostTexts: string[] = [],
): Promise<AssembleManyResult> {
  const warnings: ValidationWarning[] = [];
  const allowedSchemes = opts.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;

  // Neither libraries NOR text files declared ⇒ the host texts are NOT templates. Return
  // them verbatim, without a single fetch and without ever handing them to Handlebars — a
  // literal `{{` in plain prose stays untouched.
  if (block.fragment_files.length === 0 && block.text_files.length === 0) {
    return { ok: true, prompts: [...hostTexts], warnings };
  }

  // --- fragment files + text files (fetched in parallel; surface every failing file at once) ---
  const fragmentSettledPromise = Promise.all(
    block.fragment_files.map(
      async (
        ref,
      ): Promise<
        | { alias: string; file: FragmentFile; url: string }
        | { alias: string; error: ValidationError }
      > => {
        // Relative refs are resolved against the base URL; absolute http(s) refs pass
        // through. Report errors against the resolved URL (the thing actually fetched).
        let fragmentUrl: string;
        try {
          fragmentUrl = resolveFragmentUrl(ref.url, baseUrl);
        } catch {
          return {
            alias: ref.id,
            error: error("INVALID_URL", `Invalid fragment URL: ${ref.url}`, {
              url: ref.url,
              fileAlias: ref.id,
            }),
          };
        }
        // SSRF scheme gate — identical to the top-level `loadYaml`. The runtime lenient
        // readers (quiz/writing/coding) skip the Zod URL refine that guards the tutor
        // path, so this is the single structural guard keeping a fragment ref from
        // targeting a non-http(s) scheme.
        const schemeError = schemeGate(fragmentUrl, allowedSchemes);
        if (schemeError) return { alias: ref.id, error: { ...schemeError, fileAlias: ref.id } };
        const fetched = await fetchText(fragmentUrl, fetchImpl);
        if (!fetched.ok) return { alias: ref.id, error: fetched.error };
        const parsed = parseYaml(fetched.text, fragmentUrl);
        if (!parsed.ok) return { alias: ref.id, error: parsed.error };
        const valid = validate<FragmentFile>(
          parsed.value,
          FragmentFileSchema,
          "FRAGMENT_FILE_SCHEMA_ERROR",
          fragmentUrl,
        );
        if (!valid.ok) return { alias: ref.id, error: { ...valid.error, fileAlias: ref.id } };
        return { alias: ref.id, file: valid.data, url: fragmentUrl };
      },
    ),
  );

  // Text files travel the SAME fetch path — resolve + scheme-gate + fetch — but there is
  // NO YAML parse: the raw body is kept verbatim. The 200 KB (UTF-8 bytes) cap is enforced
  // immediately after fetch, failing closed above it.
  const textSettledPromise = Promise.all(
    block.text_files.map(
      async (
        ref,
      ): Promise<{ alias: string; body: string } | { alias: string; error: ValidationError }> => {
        let fileUrl: string;
        try {
          fileUrl = resolveFragmentUrl(ref.url, baseUrl);
        } catch {
          return {
            alias: ref.id,
            error: error("INVALID_URL", `Invalid text-file URL: ${ref.url}`, {
              url: ref.url,
              fileAlias: ref.id,
            }),
          };
        }
        const schemeError = schemeGate(fileUrl, allowedSchemes);
        if (schemeError) return { alias: ref.id, error: { ...schemeError, fileAlias: ref.id } };
        const fetched = await fetchText(fileUrl, fetchImpl);
        if (!fetched.ok) return { alias: ref.id, error: fetched.error };
        const byteLength = new TextEncoder().encode(fetched.text).length;
        if (byteLength > MAX_TEXT_FILE_BYTES) {
          return {
            alias: ref.id,
            error: error(
              "TEXT_FILE_TOO_LARGE",
              `Text file "${ref.id}" is ${byteLength} bytes, over the ${MAX_TEXT_FILE_BYTES}-byte limit`,
              { url: fileUrl, fileAlias: ref.id },
            ),
          };
        }
        return { alias: ref.id, body: fetched.text };
      },
    ),
  );

  const [fragmentSettled, textSettled] = await Promise.all([
    fragmentSettledPromise,
    textSettledPromise,
  ]);

  const fragmentFilesByAlias = new Map<string, FragmentFile>();
  const fragmentUrlByAlias = new Map<string, string>();
  const textFilesByAlias = new Map<string, string>();
  const fileErrors: ValidationError[] = [];
  for (const result of fragmentSettled) {
    if ("error" in result) fileErrors.push(result.error);
    else {
      fragmentFilesByAlias.set(result.alias, result.file);
      fragmentUrlByAlias.set(result.alias, result.url);
    }
  }
  for (const result of textSettled) {
    if ("error" in result) fileErrors.push(result.error);
    else textFilesByAlias.set(result.alias, result.body);
  }
  if (fileErrors.length > 0) return { ok: false, errors: fileErrors, warnings };

  // --- thorough whole-library check (opt-in; OFF on the hot path) ---
  // Strict-render EVERY fragment in every referenced library against its own
  // input_schema, catching bugs even in fragments this activity never places.
  const libraryErrors: ValidationError[] = [];
  if (opts.validateLibraries) {
    for (const [alias, file] of fragmentFilesByAlias) {
      const checked = checkFragmentTemplates(file, {
        fileAlias: alias,
        url: fragmentUrlByAlias.get(alias),
      });
      libraryErrors.push(...checked.errors);
      warnings.push(...checked.warnings);
    }
  }

  // --- extract inline placements from every host text ---
  // A template that does not even parse (malformed marker, unescaped `{{`) or a
  // marker with a non-literal reference blocks the build — nothing to render. Parse
  // errors are collected across ALL hosts so each surfaces its own marker problems
  // in one pass.
  const parsedHosts = hostTexts.map((hostText) => parseHostPlacements(hostText));
  const parseErrors = parsedHosts.flatMap((parsed) => parsed.errors);
  if (parseErrors.length > 0) {
    return { ok: false, errors: [...libraryErrors, ...parseErrors], warnings };
  }

  // --- placement consistency (resolution + per-placement variable / range validation) ---
  // ONE check over the UNION of all hosts' placements: the structural passes (duplicate
  // aliases, duplicate fragment ids) must not repeat per host, and a library placed in
  // ANY host counts as used (`checkPlacements` is order-independent by contract).
  // `strict` (authoring / CLI) makes a `to` beyond EOF an error too; at runtime it clamps.
  const placementCheck = checkPlacements(
    parsedHosts.flatMap((parsed) => parsed.placements),
    fragmentFilesByAlias,
    block.fragment_files,
    textFilesByAlias,
    block.text_files,
    opts.validateLibraries ?? false,
  );
  warnings.push(...placementCheck.warnings);
  const preRenderErrors = [...libraryErrors, ...placementCheck.errors];
  if (preRenderErrors.length > 0) return { ok: false, errors: preRenderErrors, warnings };

  // --- render each host template (strict Handlebars backstop) ---
  // The fragment resolver shares `resolveAndMerge` with the checker above, so what renders
  // is exactly what was validated. Any resolve error or null content (which should never
  // happen post-check) throws and fails closed as ASSEMBLY_ERROR — so even an argument
  // the AST couldn't see (defense in depth) can never render unvalidated. The file
  // resolver splices the PREFETCHED body verbatim (no range) or via `sliceLines` (with
  // `to` clamped to EOF); file content is NEVER compiled as Handlebars.
  // Like every stage above, render errors are collected across ALL hosts before failing.
  const prompts: string[] = [];
  const renderErrors: ValidationError[] = [];
  for (const hostText of hostTexts) {
    try {
      prompts.push(
        renderHostTemplate(
          hostText,
          (ref, args) => {
            const resolved = resolveAndMerge(ref, args, fragmentFilesByAlias);
            if (resolved.content === null || resolved.errors.length > 0) {
              throw new Error(`Fragment "${ref}" could not be resolved`);
            }
            return renderFragmentContent(resolved.content, resolved.variables);
          },
          (alias, from, to) => {
            const body = textFilesByAlias.get(alias);
            // Defense in depth: a placement the checker passed is always prefetched; a miss
            // here can only be a bug, so throw to fail closed (becomes ASSEMBLY_ERROR).
            if (body === undefined) throw new Error(`Text file "${alias}" was not prefetched`);
            if (from === undefined && to === undefined) return body; // verbatim, byte-identical
            return sliceLines(body, from, to);
          },
        ),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      renderErrors.push(error("ASSEMBLY_ERROR", `Failed to render system prompt: ${message}`));
    }
  }
  if (renderErrors.length > 0) return { ok: false, errors: renderErrors, warnings };
  return { ok: true, prompts, warnings };
}

/**
 * Validate a fragment FILE on its own (the `--kind fragment` / "Fragment library"
 * path): scheme-gate + fetch + parse, then the pure `checkFragmentFileValue`. A
 * fragment library is self-contained, so — unlike an activity — there are no further
 * files to fetch. The caller already knows it asked for a fragment, so this returns
 * a `FragmentCheckResult` directly (no activity `BuildResult`, no kind discriminator).
 */
export async function loadAndCheckFragmentFile(
  url: string,
  fetchImpl: Fetcher,
  opts: LoadOptions = {},
): Promise<FragmentCheckResult> {
  const yaml = await loadYaml(url, fetchImpl, opts);
  if (!yaml.ok) return { ok: false, errors: [yaml.error], warnings: [] };
  return checkFragmentFileValue(yaml.value, url);
}
