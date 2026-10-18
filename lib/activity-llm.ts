import { type ActivityLlm, parseActivityYaml } from "@/lib/activity-load";
import { serverYamlFetcher } from "@/lib/app-hosted-fetcher";
import { withTimeout } from "@/lib/promise-timeout";

// The activity YAML's `llm:` block (provider, model, reasoning), read for display
// only: the `/codes` list's "YAML model" page column (`docs/filtered-lists.md`, "The
// new list engine") — an overridden code's too, so the list shows what its override
// replaces — and the code form's "Activity's LLM" line (`readActivityLlmAction`,
// `docs/codes.md`). App-hosted YAML is read from the database; any other URL is
// fetched live (uncached on purpose, `lib/app-hosted-yaml.ts`), so each load is
// capped and a failure reads as `null`, never as a wrong model.
// SERVER-ONLY.

/** How long one YAML load (fetch AND body) may take before it gives up. */
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
    console.warn(`activity llm: could not read the model of ${fileUrl}`, error);
    return null;
  }
}

/** The `llm:` block of each distinct file among `fileUrls` (keyed by URL), all loaded in parallel. */
export async function yamlModels(fileUrls: string[]): Promise<Map<string, ActivityLlm | null>> {
  const urls = [...new Set(fileUrls)];
  return new Map(
    await Promise.all(urls.map(async (url) => [url, await loadActivityLlm(url)] as const)),
  );
}
