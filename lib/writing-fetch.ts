import { loadAppHostedYaml } from "@/lib/app-hosted-yaml";
import { type LoadWritingResult, resolveWriting } from "@/lib/writing-resolve";
import { parseWriting, WRITING_NOUN } from "@/lib/writing-yaml";

// Loads + leniently parses the writing YAML behind a (verified) writing URL, via the
// shared `loadAppHostedYaml`, then hands the parsed document to the PURE `resolveWriting`
// (lib/writing-resolve.ts), which renders the teacher's `instructions` host text (with any
// inline `{{fragment}}` markers resolved in place) into the final `instructions`.
// The single definition shared by the render component, the `saveWriting` action, and
// the runtime route's writing branch, so they all read the same activity the same way.
//
// This file owns ONLY the app-hosted/DB seam; the resolution itself is shared verbatim
// with the prompt dump / CLI (`loadWritingFrom`), so a dumped system prompt is the exact
// production one. SERVER-ONLY: touches the database and fetches arbitrary URLs.

export type { LoadWritingResult } from "@/lib/writing-resolve";

export function loadWriting(url: string): Promise<LoadWritingResult> {
  return loadAppHostedYaml(url, WRITING_NOUN, parseWriting, (parsed, { url, fetcher }) =>
    resolveWriting(parsed.writing, url, fetcher),
  );
}
