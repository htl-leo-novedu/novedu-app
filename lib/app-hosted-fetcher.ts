import { resolveAppOriginOr } from "@/lib/app-origin";
import { getActiveFile } from "@/lib/file-store";
import { filesUrlPrefix } from "@/lib/file-url";
import { defaultFetcher, type Fetcher } from "@/lib/prompt-fragments";

// The ONE definition of how an app-hosted file URL (`<origin>/api/files/<name>`)
// resolves: from the DATABASE (via getActiveFile) instead of a network round-trip
// back to our own public origin — which a container may not be able to reach, and
// which is fragile around an exact self-URL string match. Everything else (e.g. a
// file hosted on GitHub) is fetched for real with defaultFetcher.
//
// Shared by every server path that reads activity YAML: the tutor (agent, student
// render, `anonymous` read), the quiz/writing/coding loaders, the save-time buffer
// validator and code creation — so this resolution lives in EXACTLY ONE place (docs/files.md). A plain module (NOT
// "use server") on purpose: a `"use server"` file may only export async actions,
// so the resolver could not be shared from there.
//
// A missing file is a 404; a DB error (`getActiveFile` → undefined) is a 503, so a
// storage outage never reads as "not found".
//
// SERVER-ONLY: touches the database and fetches arbitrary URLs. Never import from
// client components.
export function appHostedFetcher(origin: string): Fetcher {
  const prefix = filesUrlPrefix(origin);
  return async (url) => {
    if (url.startsWith(prefix)) {
      const refName = decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0] ?? "");
      const file = await getActiveFile(refName);
      if (file) return { ok: true, status: 200, text: async () => file.content };
      return { ok: false, status: file === null ? 404 : 503, text: async () => "" };
    }
    return defaultFetcher(url);
  };
}

/**
 * The read/serve path's fetcher: {@link appHostedFetcher} for the app's own origin,
 * resolved LENIENTLY (`resolveAppOriginOr("")`) — when no origin can be determined
 * it degrades to a plain network fetch rather than failing, unlike the authoring
 * validators, which resolve strictly.
 */
export async function serverYamlFetcher(): Promise<Fetcher> {
  return appHostedFetcher(await resolveAppOriginOr(""));
}
