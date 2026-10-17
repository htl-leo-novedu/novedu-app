import { loadActivityFrom, resolveInstructions } from "@/lib/activity-load";
import { CODING_NOUN, type Coding, parseCoding } from "@/lib/coding-yaml";
import type { Fetcher, LoadOptions } from "@/lib/prompt-fragments";

// The coding RUNTIME resolution: render the teacher's `instructions` host text (with any
// inline `{{fragment}}` / `{{file}}` markers resolved in place) into the final
// `instructions` — the system prompt the proxy folds into the upstream request
// (`buildUpstreamChatBody`, lib/coding-proxy.ts).
//
// PURE / fetcher-injected, split out of `lib/coding-fetch.ts` so the SAME resolution
// serves both callers with no second implementation:
//
//   - the app (`loadCoding`), through the DB-backed `loadAppHostedYaml`,
//   - the prompt dump / CLI (`loadCodingFrom`), through the CLI's `file:`-aware fetcher.
//
// Assembly lives in this load layer, never in `lib/llm/endpoint.ts` (which stays
// provider-blind + side-effect-free — see docs/coding.md). No DB, no `app/`, no
// `"use server"`.

export type LoadCodingResult = { ok: true; coding: Coding } | { ok: false; message: string };

/**
 * Resolve a leniently parsed coding activity into the runnable one. Per-request
 * streaming hot path: consistency over the referenced fragments only
 * (`validateLibraries: false`); no extra passes. A failure fails closed — the proxy
 * surfaces it as its upstream-load error.
 */
export async function resolveCoding(
  coding: Coding,
  url: string,
  fetcher: Fetcher,
  opts: Pick<LoadOptions, "allowedSchemes"> = {},
): Promise<LoadCodingResult> {
  const resolved = await resolveInstructions(
    coding,
    url,
    fetcher,
    CODING_NOUN,
    opts.allowedSchemes,
  );
  return resolved.ok ? { ok: true, coding: resolved.activity } : resolved;
}

/**
 * Fetch + lenient-parse + `resolveCoding`, all through the CALLER's fetcher — the
 * app-free counterpart of `loadCoding` (`lib/coding-fetch.ts`) used by the prompt dump
 * and the CLI, where there is no database and an activity may live on disk (`file:`).
 */
export function loadCodingFrom(
  url: string,
  fetcher: Fetcher,
  opts: Pick<LoadOptions, "allowedSchemes"> = {},
): Promise<LoadCodingResult> {
  return loadActivityFrom(
    url,
    fetcher,
    CODING_NOUN,
    parseCoding,
    (parsed) => resolveCoding(parsed.coding, url, fetcher, opts),
    opts.allowedSchemes,
  );
}
