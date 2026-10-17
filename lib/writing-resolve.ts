import { loadActivityFrom, resolveInstructions } from "@/lib/activity-load";
import type { Fetcher, LoadOptions } from "@/lib/prompt-fragments";
import { parseWriting, WRITING_NOUN, type Writing } from "@/lib/writing-yaml";

// The writing RUNTIME resolution: render the teacher's `instructions` host text (with any
// inline `{{fragment}}` / `{{file}}` markers resolved in place) into the final
// `instructions` — the system prompt the feedback agent runs with.
//
// PURE / fetcher-injected, split out of `lib/writing-fetch.ts` so the SAME resolution
// serves both callers with no second implementation:
//
//   - the app (`loadWriting`), through the DB-backed `loadAppHostedYaml`,
//   - the prompt dump / CLI (`loadWritingFrom`), through the CLI's `file:`-aware fetcher.
//
// No DB, no `app/`, no `"use server"`.

export type LoadWritingResult = { ok: true; writing: Writing } | { ok: false; message: string };

/**
 * Resolve a leniently parsed writing activity into the runnable one. `url` is the
 * activity's own URL (the base for relative fragment refs); `fetcher` the network seam.
 */
export async function resolveWriting(
  writing: Writing,
  url: string,
  fetcher: Fetcher,
  opts: Pick<LoadOptions, "allowedSchemes"> = {},
): Promise<LoadWritingResult> {
  const resolved = await resolveInstructions(
    writing,
    url,
    fetcher,
    WRITING_NOUN,
    opts.allowedSchemes,
  );
  return resolved.ok ? { ok: true, writing: resolved.activity } : resolved;
}

/**
 * Fetch + lenient-parse + `resolveWriting`, all through the CALLER's fetcher — the
 * app-free counterpart of `loadWriting` (`lib/writing-fetch.ts`) used by the prompt dump
 * and the CLI, where there is no database and an activity may live on disk (`file:`).
 */
export function loadWritingFrom(
  url: string,
  fetcher: Fetcher,
  opts: Pick<LoadOptions, "allowedSchemes"> = {},
): Promise<LoadWritingResult> {
  return loadActivityFrom(
    url,
    fetcher,
    WRITING_NOUN,
    parseWriting,
    (parsed) => resolveWriting(parsed.writing, url, fetcher, opts),
    opts.allowedSchemes,
  );
}
