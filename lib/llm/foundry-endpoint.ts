import { getBearerTokenProvider } from "@azure/identity";
import { buildCognitiveServicesCredential } from "@/lib/azure-credential";
import { withTimeout } from "@/lib/promise-timeout";

// No-side-effect access to the Azure Foundry (Azure OpenAI) v1 OpenAI-compatible
// endpoint — the Foundry counterpart to `lib/scch-endpoint.ts`, shared by the
// coding-proxy path (`lib/llm/endpoint.ts`), the agent path (`lib/llm/model.ts`),
// and the health probe. Importing this module constructs NOTHING (no credential,
// no network): the URL getters throw on a missing `AZURE_FOUNDRY_ENDPOINT` only
// when called, so an SCCH-only deployment never notices this file exists.
//
// Auth is Entra, not an API key: `foundryBearerToken()` lazily creates ONE
// `getBearerTokenProvider` for the process over `buildCognitiveServicesCredential()`
// — the Foundry service principal (client secret or certificate) when configured,
// else the chain of `az login` locally and Managed Identity on Azure; whichever
// identity it is needs the `Cognitive Services OpenAI User` role on the resource
// (lib/azure-credential.ts). The provider caches the token and refreshes it
// before its ~60-minute expiry, so callers just await a fresh bearer per request
// and never hold a token themselves. `https://ai.azure.com/.default` would work
// as the scope too; the Cognitive Services one is the canonical scope for
// `*.openai.azure.com` resources.
//
// SERVER-ONLY.

const FOUNDRY_SCOPE = "https://cognitiveservices.azure.com/.default";

/**
 * Azure Foundry is an OPTIONAL provider: this is the ONE check surfaces use to
 * decide whether Foundry-specific UI (e.g. the /health rows) exists at all — an
 * SCCH-only deployment must not display a red indicator for a provider it
 * deliberately does not configure.
 */
export function foundryConfigured(): boolean {
  return !!process.env.AZURE_FOUNDRY_ENDPOINT;
}

function foundryEndpoint(): string {
  const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT;
  if (!endpoint) throw new Error("AZURE_FOUNDRY_ENDPOINT is not set");
  // Tolerate a trailing slash on the configured resource endpoint.
  return endpoint.replace(/\/+$/, "");
}

// The v1 API surface: deployment name goes in the request's `model` field and no
// `api-version` query parameter is needed.
export const foundryV1Base = (): string => `${foundryEndpoint()}/openai/v1`;

export const foundryChatCompletionsUrl = (): string => `${foundryV1Base()}/chat/completions`;

export const foundryModelsUrl = (): string => `${foundryV1Base()}/models`;

let tokenProvider: (() => Promise<string>) | undefined;

// `AzureCliCredential` shells out to `az` with no subprocess timeout, the
// Managed Identity leg retries IMDS, and a service principal calls the Entra
// token endpoint, so an unbounded acquisition can stall a request forever. 15 s
// clears a cold `az` run plus the IMDS retry budget while keeping every caller
// (coding proxy, agent fetch, health probe) bounded, whichever credential is used.
export const FOUNDRY_TOKEN_TIMEOUT_MS = 15_000;

export function foundryBearerToken(): Promise<string> {
  tokenProvider ??= getBearerTokenProvider(buildCognitiveServicesCredential(), FOUNDRY_SCOPE);
  return withTimeout(tokenProvider(), "Entra token acquisition", FOUNDRY_TOKEN_TIMEOUT_MS);
}
