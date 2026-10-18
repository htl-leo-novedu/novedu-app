import { type ActivityLlm, parseActivityYaml } from "@/lib/activity-load";
import { serverYamlFetcher } from "@/lib/app-hosted-fetcher";
import type { CodeListRow } from "@/lib/code-store";
import { withTimeout } from "@/lib/promise-timeout";

// The `/codes` list's "Model" page column (see `docs/filtered-lists.md`, "The new
// list engine"): the model each visible code runs on — its override when it holds
// one, else the activity YAML's `llm:` block. Computed only when the view shows the
// column. App-hosted YAML is read from the database; any other URL is fetched live
// (uncached on purpose, `lib/app-hosted-yaml.ts`), so each load is capped and a
// failure reads as `null` ("—"), never as a wrong model. SERVER-ONLY.

/** How long one YAML load (fetch AND body) may take before the cell gives up. */
export const MODEL_LOAD_TIMEOUT_MS = 10_000;

/** The `llm:` block of the activity at `fileUrl`, or `null` when it can't be read. Never throws. */
export async function loadActivityLlm(fileUrl: string): Promise<ActivityLlm | null> {
  try {
    return await withTimeout(
      (async () => {
        const fetcher = await serverYamlFetcher();
        const res = await fetcher(fileUrl);
        if (!res.ok) return null;
        // Every activity kind, tutors included, carries the same `llm:` block.
        const parsed = parseActivityYaml(await res.text(), "activity");
        return parsed.ok ? parsed.llm : null;
      })(),
      "Activity YAML load",
      MODEL_LOAD_TIMEOUT_MS,
    );
  } catch (error) {
    console.warn(`codes list: could not read the model of ${fileUrl}`, error);
    return null;
  }
}

/**
 * The effective model of each code (keyed by code): the override as stored, else
 * its YAML's. Each distinct YAML is loaded once, all in parallel; overrides load
 * nothing.
 */
export async function effectiveModels(
  entries: Pick<CodeListRow, "code" | "fileUrl" | "llm">[],
): Promise<Map<string, ActivityLlm | null>> {
  const urls = [...new Set(entries.filter((e) => !e.llm).map((e) => e.fileUrl))];
  const loaded = new Map(
    await Promise.all(urls.map(async (url) => [url, await loadActivityLlm(url)] as const)),
  );
  return new Map(entries.map((e) => [e.code, e.llm ?? loaded.get(e.fileUrl) ?? null]));
}
