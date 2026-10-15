// Pure core of the usage dashboard's cost estimate (docs/dashboard.md, "Cost
// estimate"): what the SCCH tokens of a window would cost at OpenRouter's list
// prices for the same models. Two matching steps over already-fetched JSON plus
// the price math — no I/O, no `Date.now()`, so every rule is unit-testable. The
// fetch layer is lib/usage-cost-lookup.ts.
//
// The anti-goal is a GUESSED price: a model that cannot be matched with
// confidence is never priced by a fuzzy name match. It is left out and listed as
// unmatched, so the card can say so.

/** SCCH tokens of one model over the window (the store's `GROUP BY model` row). */
export interface ModelTokens {
  /** The recorded model id (a Hugging Face repo id on SCCH); NULL = not recorded. */
  model: string | null;
  inputNew: number;
  inputCached: number;
  output: number;
}

/** OpenRouter list prices in USD per token. */
export interface ModelPrice {
  prompt: number;
  /** Cached input; OpenRouter's `prompt` when the model lists no cache price. */
  cacheRead: number;
  completion: number;
}

/** One SCCH model the estimate had to leave out. */
export interface UnmatchedModel {
  /** The model id, or `UNKNOWN_MODEL` for rows without one. */
  model: string;
  /** All tokens (new + cached + output) left out of the estimate. */
  tokens: number;
}

/** The estimate in USD, split by token category. */
export interface CostEstimate {
  inputNew: number;
  inputCached: number;
  output: number;
  total: number;
  /** Tokens that were priced; 0 = nothing could be priced, so there is no estimate. */
  pricedTokens: number;
  /** Models left out, largest first; empty when everything was priced. */
  unmatched: UnmatchedModel[];
}

export const UNKNOWN_MODEL = "(unknown model)";

/**
 * Step 1: the original model behind an SCCH model, from the Hugging Face model
 * API's JSON (`GET /api/models/<id>`). `cardData.base_model` may be a string or
 * an array; exactly one base is a match, an empty or longer list is not. A model
 * that declares no base is itself the original, so its own id is returned. One
 * step only: a quantization of a quantization lands on a model OpenRouter does
 * not list and so stays unmatched. `undefined` = unmatched.
 */
export function baseModelOf(hfModel: unknown, ownId: string): string | undefined {
  const cardData = (hfModel as { cardData?: { base_model?: unknown } } | null)?.cardData;
  const base = cardData?.base_model;
  if (base === undefined || base === null) return ownId;
  if (typeof base === "string") return base.trim() || undefined;
  if (Array.isArray(base) && base.length === 1 && typeof base[0] === "string") {
    return base[0].trim() || undefined;
  }
  return undefined;
}

/** A per-token price string from OpenRouter, or `undefined` when unusable. */
function price(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const n = Number(value);
  // OpenRouter lists `-1` for routers whose price is not fixed.
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Step 2: the price of a Hugging Face model on OpenRouter, from the JSON of
 * `GET /api/v1/models`. The entry must name the model as its `hugging_face_id`
 * (case-insensitive); `:free` variants are skipped. Several paid matches are
 * ambiguous and so unmatched, as is an entry without a usable price.
 * `undefined` = unmatched.
 */
export function openRouterPriceOf(openRouterModels: unknown, hfId: string): ModelPrice | undefined {
  const data = (openRouterModels as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  const wanted = hfId.toLowerCase();
  const matches = data.filter(
    (m: { id?: unknown; hugging_face_id?: unknown }) =>
      typeof m?.hugging_face_id === "string" &&
      m.hugging_face_id.toLowerCase() === wanted &&
      !(typeof m.id === "string" && m.id.endsWith(":free")),
  );
  if (matches.length !== 1) return undefined;
  const pricing = (matches[0] as { pricing?: Record<string, unknown> }).pricing ?? {};
  const prompt = price(pricing.prompt);
  const completion = price(pricing.completion);
  if (prompt === undefined || completion === undefined) return undefined;
  return { prompt, cacheRead: price(pricing.input_cache_read) ?? prompt, completion };
}

/**
 * Prices each model's tokens and sums them per category. `priceOf` answers the
 * matched price of a model id; a NULL model is never priced. Models without a
 * price (or with no tokens at all) are skipped; the unpriced ones with tokens
 * come back in `unmatched`, largest first.
 */
export function estimateCost(
  rows: ModelTokens[],
  priceOf: (model: string) => ModelPrice | undefined,
): CostEstimate {
  const estimate: CostEstimate = {
    inputNew: 0,
    inputCached: 0,
    output: 0,
    total: 0,
    pricedTokens: 0,
    unmatched: [],
  };
  for (const row of rows) {
    const tokens = row.inputNew + row.inputCached + row.output;
    if (tokens <= 0) continue;
    const p = row.model === null ? undefined : priceOf(row.model);
    if (!p) {
      estimate.unmatched.push({ model: row.model ?? UNKNOWN_MODEL, tokens });
      continue;
    }
    estimate.inputNew += row.inputNew * p.prompt;
    estimate.inputCached += row.inputCached * p.cacheRead;
    estimate.output += row.output * p.completion;
    estimate.pricedTokens += tokens;
  }
  estimate.total = estimate.inputNew + estimate.inputCached + estimate.output;
  estimate.unmatched.sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  return estimate;
}
