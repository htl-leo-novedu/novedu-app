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
