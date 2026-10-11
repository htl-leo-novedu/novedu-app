// No-side-effect access to the OpenRouter OpenAI-compatible endpoint — the
// OpenRouter counterpart to `lib/scch-endpoint.ts` and `lib/llm/foundry-endpoint.ts`,
// shared by the coding-proxy path (`lib/llm/endpoint.ts`) and the agent path
// (`lib/llm/model.ts`). Deliberately IMPORT-FREE (like `lib/scch-endpoint.ts`):
// importing this module constructs nothing and reads nothing, so the lean public
// coding route can pull it in without dragging anything along.
//
// Auth is a plain static API key (`OPENROUTER_API_KEY`) — no Entra, no credential
// chain. The base URL is fixed unless `OPENROUTER_BASE_URL` overrides it (a proxy,
// a self-hosted gateway); it already includes `/v1`, so endpoint URLs are
// `${base}/<path>`, exactly like SCCH.
//
// SERVER-ONLY.

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter is an OPTIONAL provider (like Azure Foundry): this is the ONE check
 * surfaces use to decide whether it is usable on this server at all. The base URL
 * has a default, so the KEY is what makes the provider configured.
 */
export function openrouterConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

/**
 * The `/v1` base. Never throws — an unset `OPENROUTER_BASE_URL` falls back to the
 * public host; a trailing slash on the override is tolerated.
 */
export function openrouterBase(): string {
  const base = process.env.OPENROUTER_BASE_URL?.replace(/\/+$/, "");
  return base || DEFAULT_OPENROUTER_BASE_URL;
}

export const openrouterChatCompletionsUrl = (): string => `${openrouterBase()}/chat/completions`;

export const openrouterModelsUrl = (): string => `${openrouterBase()}/models`;

/**
 * The current key's own info. Unlike the model listing (public — it answers
 * 200 for any key or none), this rejects an invalid key with a 401, so it is
 * what proves the key.
 */
export const openrouterKeyUrl = (): string => `${openrouterBase()}/key`;

/**
 * The API ROOT (the base without its `/v1`) — for an SDK that appends its own
 * versioned path (the TypeSafe SDK behind `lib/llm/jev-client.ts` adds
 * `/v1/systemone`). Same override as `openrouterBase()`, so a proxy serves both.
 */
export const openrouterApiRoot = (): string => openrouterBase().replace(/\/v1$/, "");

/** Throws on a missing key (the coding route maps that to its 500 config path). */
export function openrouterAuthHeader(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  return `Bearer ${key}`;
}
