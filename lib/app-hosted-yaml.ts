import { type ActivityLoadFailure, type ActivityResolver, loadActivity } from "@/lib/activity-load";
import { serverYamlFetcher } from "@/lib/app-hosted-fetcher";
import type { Fetcher } from "@/lib/prompt-fragments";

// Loads + leniently parses + resolves the YAML behind a (verified) activity URL — the
// app side of every module's loader (coding / writing / quiz). The fetch → parse →
// resolve flow and its friendly messages are the shared pure `loadActivity`
// (lib/activity-load.ts); this file adds only the server's fetcher.
//
// App-hosted activities (`<origin>/api/files/<name>`) are read straight from the
// database via the SHARED `appHostedFetcher` — the one definition of that
// loopback-avoiding resolution (a container may not be able to reach its own public
// origin). Anything else (e.g. a file hosted on GitHub) is fetched for real, uncached,
// so edits show immediately. Origin is resolved leniently (`serverYamlFetcher`): on
// the read/serve path we degrade to a network fetch rather than hard-failing the way
// the authoring validator does. The `resolve` step receives that SAME fetcher, so a
// fragment ref that is app-hosted resolves from the database too, never a loopback
// fetch (the docs/files.md invariant).
//
// SERVER-ONLY: touches the database and fetches arbitrary URLs.

export async function loadAppHostedYaml<R extends { ok: boolean }>(
  url: string,
  noun: string,
  parse: (content: string) => R,
  resolve: ActivityResolver<R>,
): Promise<R | ActivityLoadFailure> {
  let fetcher: Fetcher;
  try {
    fetcher = await serverYamlFetcher();
  } catch {
    return { ok: false, message: `This ${noun} could not be loaded. Try again.` };
  }
  return loadActivity(url, fetcher, noun, parse, resolve);
}
