import { parse as parseYamlText } from "yaml";
import {
  DEFAULT_PROVIDER,
  type LlmProvider,
  parseLenientProvider,
  parseLenientReasoningLevel,
  REASONING_LEVELS,
  type ReasoningLevel,
} from "@/lib/llm/provider";
import {
  assembleFragmentPrompt,
  DEFAULT_ALLOWED_SCHEMES,
  EMPTY_FRAGMENT_BLOCK,
  type Fetcher,
  type FragmentBlock,
  schemeAllowed,
} from "@/lib/prompt-fragments";

// The runtime load every activity kind with a lenient parser (quiz, writing, coding)
// shares: fetch the YAML, turn a 404 / other HTTP status / network error into a friendly
// message, parse it leniently, then resolve it into the runnable activity. The kind
// supplies only its parser, its resolver and the `noun` ("quiz", "writing activity", …)
// its messages name.
//
// Two callers per kind, one implementation:
//   - the app (`load<Kind>` in `lib/<kind>-fetch.ts`, via `loadAppHostedYaml`), whose
//     URL comes from a verified code row;
//   - the prompt dump / CLI (`load<Kind>From`), which first gates the URL's scheme
//     (`loadActivityFrom`) because the CLI also reads `file:` URLs.
//
// The same kinds share the start of their lenient parser too (`parseActivityYaml`,
// below): YAML → mapping → the `llm` block.
//
// PURE / fetcher-injected and CLI-bundled: no DB, no `app/`, no `"use server"`.

export type ActivityLoadFailure = { ok: false; message: string };

/**
 * The kind's post-parse step, run only when `parse` succeeds: `url` is the base for
 * relative fragment refs, `fetcher` the same seam the activity itself was read through.
 */
export type ActivityResolver<R extends { ok: boolean }> = (
  parsed: Extract<R, { ok: true }>,
  ctx: { url: string; fetcher: Fetcher },
) => Promise<R | ActivityLoadFailure>;

/** The fetch → parse → resolve load, with the friendly not-found / could-not-load texts. */
export async function loadActivity<R extends { ok: boolean }>(
  url: string,
  fetcher: Fetcher,
  noun: string,
  parse: (content: string) => R,
  resolve: ActivityResolver<R>,
): Promise<R | ActivityLoadFailure> {
  try {
    const res = await fetcher(url);
    if (!res.ok) {
      return res.status === 404
        ? { ok: false, message: `This ${noun} could not be found.` }
        : { ok: false, message: `This ${noun} could not be loaded (HTTP ${res.status}).` };
    }
    const parsed = parse(await res.text());
    if (!parsed.ok) return parsed;
    return await resolve(parsed as Extract<R, { ok: true }>, { url, fetcher });
  } catch {
    return { ok: false, message: `This ${noun} could not be loaded. Try again.` };
  }
}

/** `loadActivity` behind the URL scheme gate — the CLI / prompt-dump entry point. */
export async function loadActivityFrom<R extends { ok: boolean }>(
  url: string,
  fetcher: Fetcher,
  noun: string,
  parse: (content: string) => R,
  resolve: ActivityResolver<R>,
  allowedSchemes: string[] = DEFAULT_ALLOWED_SCHEMES,
): Promise<R | ActivityLoadFailure> {
  if (!schemeAllowed(url, allowedSchemes)) {
    return { ok: false, message: `This ${noun}'s URL is not allowed: ${url}` };
  }
  return loadActivity(url, fetcher, noun, parse, resolve);
}

/**
 * Resolve an activity whose ONE host text is `instructions` (writing, coding): render it
 * with its inline `{{fragment}}` / `{{file}}` markers against the document's fragment
 * block, then clear the block so no unresolved copy lingers. Hot path:
 * `validateLibraries: false`. Fails closed with the kind's own message.
 */
export async function resolveInstructions<
  T extends { fragmentBlock: FragmentBlock; instructions: string },
>(
  activity: T,
  url: string,
  fetcher: Fetcher,
  noun: string,
  allowedSchemes: string[] = DEFAULT_ALLOWED_SCHEMES,
): Promise<{ ok: true; activity: T } | ActivityLoadFailure> {
  const resolved = await assembleFragmentPrompt(
    activity.fragmentBlock,
    url,
    fetcher,
    { validateLibraries: false, allowedSchemes },
    activity.instructions,
  );
  if (!resolved.ok) {
    return { ok: false, message: `This ${noun}'s prompt fragments could not be loaded.` };
  }
  return {
    ok: true,
    activity: { ...activity, fragmentBlock: EMPTY_FRAGMENT_BLOCK, instructions: resolved.prompt },
  };
}

// ---- The lenient parse prefix ------------------------------------------------------
//
// Every lenient parser (`parseQuiz`, `parseWriting`, `parseCoding`) starts the same way:
// YAML → a mapping → the `llm` block. `parseActivityYaml` is that prefix; the kind then
// reads its own fields off `root` with `asString` / `asBool`. Lenient on purpose — the
// student path gets a friendly message, never a crash; the strict authoring gate is the
// kind's Zod schema.

/** The `llm` block every lenient activity carries. SERVER-ONLY. */
export interface ActivityLlm {
  model: string;
  /** `llm.provider`, default SCCH. */
  provider: LlmProvider;
  /** `llm.reasoning`; absent ⇒ no reasoning effort is pinned. */
  reasoning?: ReasoningLevel;
}

/**
 * A trimmed non-empty string, or `undefined`. YAML types unquoted scalars by value, so
 * `id: 1` arrives as a number and `id: true` as a boolean: a finite number / boolean is
 * coerced to its string form rather than silently dropped (a teacher writing the natural
 * `- id: 1` must not lose the whole question). NaN/Infinity stay rejected — `String()`
 * of them would only produce a confusing "NaN"/"Infinity".
 */
export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() !== "" ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/** A literal boolean, else `fallback`. */
export function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Parse an activity's YAML text down to its root mapping and its `llm` block, with the
 * kind's `noun` in each friendly failure message.
 */
export function parseActivityYaml(
  content: string,
  noun: string,
): { ok: true; root: Record<string, unknown>; llm: ActivityLlm } | ActivityLoadFailure {
  let doc: unknown;
  try {
    doc = parseYamlText(content);
  } catch {
    return { ok: false, message: `This ${noun} could not be read — its YAML is not valid.` };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, message: `This ${noun} is empty or malformed.` };
  }
  const root = doc as Record<string, unknown>;

  const llm = root.llm as Record<string, unknown> | undefined;
  const model = asString(llm?.model);
  if (!model) {
    return { ok: false, message: `This ${noun} does not specify a model (llm.model).` };
  }

  // Missing ⇒ SCCH; present-but-invalid is rejected so a Foundry-intended activity
  // never silently runs against SCCH.
  const provider =
    llm?.provider === undefined ? DEFAULT_PROVIDER : parseLenientProvider(llm.provider);
  if (!provider) {
    return {
      ok: false,
      message: `This ${noun} uses an unsupported llm.provider (use "SCCH", "Azure Foundry" or "OpenRouter").`,
    };
  }

  // Absent ⇒ no reasoning effort is pinned; present-but-invalid is rejected so an
  // activity never silently runs at the model's default effort.
  const reasoning =
    llm?.reasoning === undefined ? undefined : parseLenientReasoningLevel(llm.reasoning);
  if (llm?.reasoning !== undefined && !reasoning) {
    return {
      ok: false,
      message: `This ${noun} uses an unsupported llm.reasoning (one of ${REASONING_LEVELS.join(", ")}).`,
    };
  }

  return { ok: true, root, llm: { model, provider, reasoning } };
}
