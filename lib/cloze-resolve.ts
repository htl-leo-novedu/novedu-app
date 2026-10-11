import { type Cloze, parseCloze } from "@/lib/cloze-yaml";
import {
  assembleFragmentPrompt,
  EMPTY_FRAGMENT_BLOCK,
  type Fetcher,
  type LoadOptions,
} from "@/lib/prompt-fragments";

// The cloze RUNTIME resolution: render the exercise's `instructions` host text (with any
// inline `{{fragment}}` / `{{file}}` markers resolved in place) ONCE into the server-only
// `instructionsPreamble` — the preamble of BOTH the grading and the feedback prompt.
//
// PURE / fetcher-injected, split out of `lib/cloze-fetch.ts` so the SAME resolution
// serves both callers with no second implementation:
//
//   - the app (`loadCloze`), through the DB-backed `loadAppHostedYaml`,
//   - the prompt dump / CLI (`loadClozeFrom`), through the CLI's `file:`-aware fetcher.
//
// No DB, no `app/`, no `"use server"`.

export type LoadClozeResult = { ok: true; cloze: Cloze } | { ok: false; message: string };

const DEFAULT_SCHEMES = ["http:", "https:"];

function schemeAllowed(url: string, allowed: string[]): boolean {
  try {
    return allowed.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Resolve a leniently parsed cloze exercise into the runnable one. Hot path (every page
 * load and every submission): consistency over the referenced fragments only
 * (`validateLibraries: false`); no extra passes.
 */
export async function resolveCloze(
  cloze: Cloze,
  url: string,
  fetcher: Fetcher,
  opts: Pick<LoadOptions, "allowedSchemes"> = {},
): Promise<LoadClozeResult> {
  const resolved = await assembleFragmentPrompt(
    cloze.fragmentBlock,
    url,
    fetcher,
    { validateLibraries: false, allowedSchemes: opts.allowedSchemes ?? DEFAULT_SCHEMES },
    cloze.instructions,
  );
  if (!resolved.ok) {
    // Fail closed — same hard-error path as an unfetchable exercise YAML.
    return { ok: false, message: "This exercise's prompt fragments could not be loaded." };
  }
  return {
    ok: true,
    cloze: {
      ...cloze,
      fragmentBlock: EMPTY_FRAGMENT_BLOCK,
      instructions: undefined,
      instructionsPreamble: resolved.prompt.trimEnd(),
    },
  };
}

/**
 * Fetch + lenient-parse + `resolveCloze`, all through the CALLER's fetcher — the
 * app-free counterpart of `loadCloze` (`lib/cloze-fetch.ts`) used by the prompt dump and
 * the CLI, where there is no database and an exercise may live on disk (`file:`).
 */
export async function loadClozeFrom(
  url: string,
  fetcher: Fetcher,
  opts: Pick<LoadOptions, "allowedSchemes"> = {},
): Promise<LoadClozeResult> {
  const allowedSchemes = opts.allowedSchemes ?? DEFAULT_SCHEMES;
  if (!schemeAllowed(url, allowedSchemes)) {
    return { ok: false, message: `This exercise's URL is not allowed: ${url}` };
  }
  try {
    const res = await fetcher(url);
    if (!res.ok) {
      return res.status === 404
        ? { ok: false, message: "This exercise could not be found." }
        : { ok: false, message: `This exercise could not be loaded (HTTP ${res.status}).` };
    }
    const parsed = parseCloze(await res.text());
    if (!parsed.ok) return parsed;
    return await resolveCloze(parsed.cloze, url, fetcher, { allowedSchemes });
  } catch {
    return { ok: false, message: "This exercise could not be loaded. Try again." };
  }
}
