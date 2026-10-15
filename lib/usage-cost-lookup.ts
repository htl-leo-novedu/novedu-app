import { baseModelOf, type ModelPrice, openRouterPriceOf } from "@/lib/usage-cost";

// The fetch layer of the usage dashboard's cost estimate (docs/dashboard.md, "Cost
// estimate"): two public GETs, Hugging Face's model API (step 1, SCCH model →
// original model) and OpenRouter's model list (step 2, original model → price).
// The matching rules are the pure lib/usage-cost.ts.
//
// Price metadata, not LLM traffic: nothing here goes through lib/llm/, and the
// requests carry model ids only — no key, no user data. Each response is kept in
// Next's data cache for a day (`next.revalidate`), so only the first view per day
// pays the latency, and a short timeout bounds that. Never throws: a failure is
// `undefined`, which the card shows as "unavailable" (OpenRouter) or as an
// unmatched model (Hugging Face).
//
// The base URLs are overridable so the e2e suite can point them at the fixtures
// server (no outside network in CI). SERVER-ONLY.

const ONE_DAY_SECONDS = 86_400;
const TIMEOUT_MS = 5_000;

const hfApiBase = () =>
  (process.env.USAGE_COST_HF_API_BASE?.trim() || "https://huggingface.co/api").replace(/\/+$/, "");
const openRouterModelsUrl = () =>
  process.env.USAGE_COST_OPENROUTER_MODELS_URL?.trim() || "https://openrouter.ai/api/v1/models";

/** A Hugging Face repo id: `owner/name`, nothing that could reshape the URL path. */
const HF_REPO_ID = /^[\w.-]+\/[\w.-]+$/;

async function getCachedJson(url: string): Promise<{ json: unknown; date: Date | undefined }> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    next: { revalidate: ONE_DAY_SECONDS },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // A cached response keeps the origin's `Date` header: when the prices were fetched.
  const header = res.headers.get("date");
  const date = header ? new Date(header) : undefined;
  return { json: await res.json(), date: date && !Number.isNaN(date.getTime()) ? date : undefined };
}

/** OpenRouter's model list (raw JSON) and when it was fetched. */
export interface OpenRouterModels {
  json: unknown;
  fetchedAt: Date | undefined;
}

/** OpenRouter's public model list, or `undefined` when it cannot be fetched. */
export async function fetchOpenRouterModels(): Promise<OpenRouterModels | undefined> {
  try {
    const { json, date } = await getCachedJson(openRouterModelsUrl());
    return { json, fetchedAt: date };
  } catch (error) {
    console.error("usage-cost-lookup: OpenRouter model list failed", error);
    return undefined;
  }
}

/** Step 1 over the network: the original model of an SCCH model, `undefined` = unmatched. */
export async function fetchBaseModel(model: string): Promise<string | undefined> {
  if (!HF_REPO_ID.test(model)) return undefined;
  try {
    // `fetch` follows the API's redirect for a different-case id.
    const { json } = await getCachedJson(`${hfApiBase()}/models/${model}`);
    return baseModelOf(json, model);
  } catch (error) {
    // A warning, not an error: the model is simply unmatched, and the card says so.
    console.warn(`usage-cost-lookup: Hugging Face lookup of ${model} failed`, error);
    return undefined;
  }
}

/** The OpenRouter price of each model id that matches; the others are missing from the map. */
export async function priceModels(
  models: string[],
  openRouter: OpenRouterModels,
): Promise<Map<string, ModelPrice>> {
  const prices = new Map<string, ModelPrice>();
  await Promise.all(
    [...new Set(models)].map(async (model) => {
      const base = await fetchBaseModel(model);
      const p = base ? openRouterPriceOf(openRouter.json, base) : undefined;
      if (p) prices.set(model, p);
    }),
  );
  return prices;
}
