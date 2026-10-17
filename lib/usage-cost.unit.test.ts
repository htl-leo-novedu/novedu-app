import { describe, expect, it } from "vitest";
import {
  baseModelOf,
  estimateCost,
  type ModelPrice,
  openRouterPriceOf,
  openRouterSpendPriceOf,
  UNKNOWN_MODEL,
} from "@/lib/usage-cost";

// The pure core of the cost cards: both SCCH matching steps and the OpenRouter
// spend match over canned Hugging Face / OpenRouter JSON, and the price math. No I/O.

describe("baseModelOf (step 1, Hugging Face)", () => {
  it("reads a string base_model", () => {
    expect(baseModelOf({ cardData: { base_model: "google/gemma-4-31B-it" } }, "RedHatAI/x")).toBe(
      "google/gemma-4-31B-it",
    );
  });

  it("reads a one-element base_model array", () => {
    expect(baseModelOf({ cardData: { base_model: ["Qwen/Qwen3.8-27B"] } }, "Qwen/x")).toBe(
      "Qwen/Qwen3.8-27B",
    );
  });

  it("treats several or zero bases as unmatched", () => {
    expect(baseModelOf({ cardData: { base_model: ["a/b", "c/d"] } }, "x/y")).toBeUndefined();
    expect(baseModelOf({ cardData: { base_model: [] } }, "x/y")).toBeUndefined();
  });

  it("uses the model's own id when it declares no base", () => {
    expect(baseModelOf({ cardData: {} }, "google/gemma-4-31B-it")).toBe("google/gemma-4-31B-it");
    expect(baseModelOf({}, "google/gemma-4-31B-it")).toBe("google/gemma-4-31B-it");
  });

  it("treats a non-string base as unmatched", () => {
    expect(baseModelOf({ cardData: { base_model: 42 } }, "x/y")).toBeUndefined();
  });
});

const LIST = {
  data: [
    {
      id: "google/gemma-4-31b-it",
      hugging_face_id: "google/gemma-4-31B-it",
      pricing: { prompt: "0.0000002", completion: "0.0000004" },
    },
    {
      id: "google/gemma-4-31b-it:free",
      hugging_face_id: "google/gemma-4-31B-it",
      pricing: { prompt: "0", completion: "0" },
    },
    {
      id: "qwen/qwen3.8-27b",
      hugging_face_id: "Qwen/Qwen3.8-27B",
      pricing: { prompt: "0.00000024", completion: "0.0000022", input_cache_read: "0.00000005" },
    },
    { id: "a/one", hugging_face_id: "dup/model", pricing: { prompt: "1", completion: "1" } },
    { id: "b/two", hugging_face_id: "dup/model", pricing: { prompt: "2", completion: "2" } },
    {
      id: "openrouter/auto",
      hugging_face_id: "router/auto",
      pricing: { prompt: "-1", completion: "-1" },
    },
    { id: "no/hf", hugging_face_id: null, pricing: { prompt: "1", completion: "1" } },
    {
      id: "openai/gpt-6-luna",
      hugging_face_id: null,
      pricing: {
        prompt: "0.0000001",
        completion: "0.0000005",
        input_cache_read: "0.00000001",
        input_cache_write: "0.000000125",
      },
    },
    {
      id: "e2e/cached-base",
      hugging_face_id: "e2e/cached-base",
      pricing: { prompt: "0.000001", completion: "0.000002", input_cache_write: "0.00000125" },
    },
  ],
};

describe("openRouterPriceOf (step 2, OpenRouter)", () => {
  it("matches hugging_face_id case-insensitively and skips the :free variant", () => {
    expect(openRouterPriceOf(LIST, "GOOGLE/gemma-4-31b-IT")).toEqual({
      prompt: 0.0000002,
      cacheRead: 0.0000002, // no cache price listed: cached at the input price
      completion: 0.0000004,
    });
  });

  it("uses the listed cache-read price", () => {
    expect(openRouterPriceOf(LIST, "Qwen/Qwen3.8-27B")).toEqual({
      prompt: 0.00000024,
      cacheRead: 0.00000005,
      completion: 0.0000022,
    });
  });

  it("treats several paid matches, no match and unusable prices as unmatched", () => {
    expect(openRouterPriceOf(LIST, "dup/model")).toBeUndefined();
    expect(openRouterPriceOf(LIST, "nobody/model")).toBeUndefined();
    expect(openRouterPriceOf(LIST, "router/auto")).toBeUndefined();
  });

  it("treats a malformed list as unmatched", () => {
    expect(openRouterPriceOf({}, "google/gemma-4-31B-it")).toBeUndefined();
    expect(openRouterPriceOf(null, "google/gemma-4-31B-it")).toBeUndefined();
  });
});

describe("openRouterSpendPriceOf (models run through OpenRouter)", () => {
  it("matches the OpenRouter id case-insensitively and prices new input at the write rate", () => {
    expect(openRouterSpendPriceOf(LIST, "OpenAI/GPT-6-Luna")).toEqual({
      prompt: 0.000000125, // input_cache_write, not prompt
      cacheRead: 0.00000001,
      completion: 0.0000005,
    });
  });

  it("falls back to the input price when the model lists no cache prices", () => {
    expect(openRouterSpendPriceOf(LIST, "no/hf")).toEqual({
      prompt: 1,
      cacheRead: 1,
      completion: 1,
    });
  });

  it("matches the exact id, so a :free variant is its own entry", () => {
    expect(openRouterSpendPriceOf(LIST, "google/gemma-4-31b-it:free")?.prompt).toBe(0);
    expect(openRouterSpendPriceOf(LIST, "google/gemma-4-31b-it")?.prompt).toBe(0.0000002);
  });

  it("treats no match, unusable prices and a malformed list as unmatched", () => {
    expect(openRouterSpendPriceOf(LIST, "nobody/model")).toBeUndefined();
    expect(openRouterSpendPriceOf(LIST, "openrouter/auto")).toBeUndefined();
    expect(openRouterSpendPriceOf({}, "openai/gpt-6-luna")).toBeUndefined();
    expect(openRouterSpendPriceOf(null, "openai/gpt-6-luna")).toBeUndefined();
  });

  it("leaves the SCCH estimate at the plain input price even when a write price is listed", () => {
    expect(openRouterPriceOf(LIST, "e2e/cached-base")?.prompt).toBe(0.000001);
  });
});

describe("estimateCost", () => {
  const PRICES: Record<string, ModelPrice> = {
    "RedHatAI/gemma": { prompt: 0.0000002, cacheRead: 0.0000002, completion: 0.0000004 },
    "Qwen/qwen-fp8": { prompt: 0.00000024, cacheRead: 0.00000005, completion: 0.0000022 },
  };
  const priceOf = (model: string) => PRICES[model];

  it("prices each model and sums per category (the prod reference figures)", () => {
    const estimate = estimateCost(
      [
        {
          model: "RedHatAI/gemma",
          inputNew: 11_218_840,
          inputCached: 51_583_778,
          output: 4_279_068,
        },
        { model: "Qwen/qwen-fp8", inputNew: 5_400_847, inputCached: 7_519_920, output: 1_725_070 },
      ],
      priceOf,
    );
    expect(estimate.inputNew).toBeCloseTo(3.54, 2);
    expect(estimate.inputCached).toBeCloseTo(10.69, 2);
    expect(estimate.output).toBeCloseTo(5.51, 2);
    expect(estimate.total).toBeCloseTo(19.74, 2);
    expect(estimate.unmatched).toEqual([]);
    expect(estimate.pricedTokens).toBe(81_727_523);
  });

  it("leaves unmatched and NULL models out and lists them, largest first", () => {
    const estimate = estimateCost(
      [
        { model: "RedHatAI/gemma", inputNew: 1_000_000, inputCached: 0, output: 0 },
        { model: "foo/Bar-7B-AWQ", inputNew: 100, inputCached: 0, output: 0 },
        { model: null, inputNew: 1_000, inputCached: 500, output: 50 },
      ],
      priceOf,
    );
    expect(estimate.total).toBeCloseTo(0.2, 6);
    expect(estimate.unmatched).toEqual([
      { model: UNKNOWN_MODEL, tokens: 1_550 },
      { model: "foo/Bar-7B-AWQ", tokens: 100 },
    ]);
  });

  it("reports nothing priced when no model matched", () => {
    const estimate = estimateCost(
      [{ model: "x/y", inputNew: 5, inputCached: 0, output: 0 }],
      priceOf,
    );
    expect(estimate.pricedTokens).toBe(0);
    expect(estimate.total).toBe(0);
    expect(estimate.unmatched).toHaveLength(1);
  });

  it("skips rows without tokens", () => {
    const estimate = estimateCost(
      [{ model: "x/y", inputNew: 0, inputCached: 0, output: 0 }],
      priceOf,
    );
    expect(estimate.unmatched).toEqual([]);
  });
});
