import { loadAppHostedYaml } from "@/lib/app-hosted-yaml";
import { type LoadClozeResult, resolveCloze } from "@/lib/cloze-resolve";
import { parseCloze } from "@/lib/cloze-yaml";

// Loads + leniently parses the cloze YAML behind a (verified) code's file_url, via the
// shared `loadAppHostedYaml`, then hands the parsed document to the PURE `resolveCloze`
// (lib/cloze-resolve.ts), which renders the `instructions` preamble ONCE for both
// prompts. The single definition the student page, `gradeCloze`, `explainCloze` and the
// teacher detail share, so they all read the same exercise the same way — uncached, so
// a fix to the YAML applies to the next page load and the next submission.
//
// This file owns ONLY the app-hosted/DB seam; the resolution itself is shared verbatim
// with the prompt dump / CLI (`loadClozeFrom`), so a dumped prompt is the exact
// production one. SERVER-ONLY: touches the database and fetches arbitrary URLs.

export type { LoadClozeResult } from "@/lib/cloze-resolve";

export function loadCloze(url: string): Promise<LoadClozeResult> {
  return loadAppHostedYaml(url, parseCloze, "exercise", (parsed, { url, fetcher }) =>
    resolveCloze(parsed.cloze, url, fetcher),
  );
}
