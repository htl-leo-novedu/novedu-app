import { loadAppHostedYaml } from "@/lib/app-hosted-yaml";
import {
  CODING_MODEL_ID,
  type CodingConnectionProps,
  codingBaseUrl,
  DEFAULT_CODING_MODEL_NAME,
} from "@/lib/coding-connection";
import { type LoadCodingResult, resolveCoding } from "@/lib/coding-resolve";
import { CODING_NOUN, parseCoding } from "@/lib/coding-yaml";

// Loads + leniently parses the coding YAML behind a (verified) code's file_url, via the
// shared `loadAppHostedYaml`, hands the parsed document to the PURE `resolveCoding`
// (lib/coding-resolve.ts) for fragment assembly, and derives the non-secret connection
// props the three render surfaces hand to `<CodingConnection>`. The single definition the
// OpenAI-compatible proxy route and the student/teacher surfaces all use, so they read
// the same activity the same way.
//
// This file owns ONLY the app-hosted/DB seam; the resolution itself is shared verbatim
// with the prompt dump / CLI (`loadCodingFrom`), so a dumped system prompt is the exact
// production one. SERVER-ONLY: touches the database and fetches URLs.

export type { LoadCodingResult } from "@/lib/coding-resolve";

export function loadCoding(url: string): Promise<LoadCodingResult> {
  return loadAppHostedYaml(url, CODING_NOUN, parseCoding, (parsed, { url, fetcher }) =>
    resolveCoding(parsed.coding, url, fetcher),
  );
}

/**
 * Derives `<CodingConnection>`'s props from a loaded activity, so the student page,
 * teacher detail, and create/edit result share one derivation (base URL + model-name
 * fallback). The real model + the teacher's prompt never appear here — only `title` (as
 * a display name), the caller's personal `nvk-…` key (minted via
 * `getOrCreateCodingKey`), and the generic model id reach the client.
 */
export function codingConnectionProps(
  loaded: LoadCodingResult,
  origin: string,
  apiKey: string,
): CodingConnectionProps {
  return {
    baseUrl: codingBaseUrl(origin),
    apiKey,
    modelId: CODING_MODEL_ID,
    modelName: loaded.ok
      ? (loaded.coding.title ?? DEFAULT_CODING_MODEL_NAME)
      : DEFAULT_CODING_MODEL_NAME,
  };
}
