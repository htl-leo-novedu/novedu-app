import { serverYamlFetcher } from "@/lib/app-hosted-fetcher";
import type { Fetcher } from "@/lib/prompt-fragments";

// Loads + leniently parses the YAML behind a (verified) activity URL — the single
// definition every module's loader (coding / writing / quiz) shares, so they all read
// an activity the same way.
//
// App-hosted activities (`<origin>/api/files/<name>`) are read straight from the
// database via the SHARED `appHostedFetcher` — the one definition of that
// loopback-avoiding resolution (a container may not be able to reach its own public
// origin). Anything else (e.g. a file hosted on GitHub) is fetched for real, uncached,
// so edits show immediately. Origin is resolved leniently (`serverYamlFetcher`): on
// the read/serve path we degrade to a network fetch rather than hard-failing the way
// the authoring validator does. The friendly `noun` ("quiz", "coding activity", …)
// personalizes the not-found / could-not-load messages.
//
// SERVER-ONLY: touches the database and fetches arbitrary URLs.

export async function loadAppHostedYaml<R extends { ok: boolean }>(
  url: string,
  parse: (content: string) => R,
  noun: string,
  // Optional async post-parse step, run only when `parse` succeeds. It receives the
  // SAME origin-baked `appHostedFetcher` used for the activity itself (so a fragment
  // ref that is app-hosted resolves from the database, never a loopback fetch —
  // preserving the docs/files.md invariant) and the activity `url` as the base for
  // resolving relative fragment refs. Used by the quiz/writing/coding loaders to
  // fetch + assemble the document-level fragment block into the runtime activity.
  resolve?: (
    parsed: Extract<R, { ok: true }>,
    ctx: { url: string; fetcher: Fetcher },
  ) => Promise<R | { ok: false; message: string }>,
): Promise<R | { ok: false; message: string }> {
  try {
    const fetcher = await serverYamlFetcher();
    const res = await fetcher(url);
    if (!res.ok) {
      return res.status === 404
        ? { ok: false, message: `This ${noun} could not be found.` }
        : { ok: false, message: `This ${noun} could not be loaded (HTTP ${res.status}).` };
    }
    const parsed = parse(await res.text());
    if (resolve && parsed.ok) {
      return resolve(parsed as Extract<R, { ok: true }>, { url, fetcher });
    }
    return parsed;
  } catch {
    return { ok: false, message: `This ${noun} could not be loaded. Try again.` };
  }
}
