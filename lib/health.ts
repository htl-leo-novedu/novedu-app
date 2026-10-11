import { lookup } from "node:dns/promises";
import { mastra } from "@/app/mastra";
import { databaseHost } from "@/lib/db/pool";
import { verifyImageRoot } from "@/lib/image-fs";
import {
  foundryBearerToken,
  foundryConfigured,
  foundryModelsUrl,
} from "@/lib/llm/foundry-endpoint";
import {
  openrouterAuthHeader,
  openrouterBase,
  openrouterConfigured,
  openrouterKeyUrl,
  openrouterModelsUrl,
} from "@/lib/llm/openrouter-endpoint";
import { withTimeout } from "@/lib/promise-timeout";

// Server-side health probes behind the teacher-only /api/health endpoint. Each
// probe is independent and never throws — failures become `ok: false` /
// `error` results so a broken dependency can't take the health page down with
// it. The probes are fetched one-by-one from the (client) health dashboard so
// a slow or timing-out dependency never delays the others.

const TIMEOUT_MS = 8_000;

export interface HealthIndicator {
  ok: boolean;
  /** Human-readable outcome, shown next to the OK/Failed badge. */
  detail: string;
}

export interface HostInfo {
  fqdn: string | null;
  ips: string[];
  /** Set when the FQDN could not be determined or DNS resolution failed. */
  error?: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A real round-trip through the Mastra storage: querying a thread by an id that
 * never exists still opens a pooled connection, authenticates and runs SQL —
 * exactly the path the tutor's memory uses.
 */
export async function checkDb(): Promise<HealthIndicator> {
  const storage = mastra.getStorage();
  if (!storage) {
    return { ok: false, detail: "Not configured (DATABASE_URL is missing)." };
  }
  try {
    const memory = await withTimeout(
      Promise.resolve(storage.getStore("memory")),
      "Storage init",
      TIMEOUT_MS,
    );
    if (!memory) return { ok: false, detail: "Storage exposes no memory domain." };
    await withTimeout(
      memory.getThreadById({ threadId: "health-check-probe" }),
      "Database query",
      TIMEOUT_MS,
    );
    return { ok: true, detail: "Round-trip query succeeded." };
  } catch (e) {
    return { ok: false, detail: errorMessage(e) };
  }
}

/** Live model listing against the SCCH endpoint — the same call scch.ts makes. */
export async function checkScch(): Promise<HealthIndicator> {
  const baseUrl = process.env.SCCH_BASE_URL;
  const apiKey = process.env.SCCH_API_KEY;
  if (!baseUrl || !apiKey) {
    return { ok: false, detail: "Not configured (SCCH_BASE_URL or SCCH_API_KEY is missing)." };
  }
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, detail: `Model listing failed (HTTP ${res.status}).` };
    const json = (await res.json()) as { data?: { id: string }[] };
    return { ok: true, detail: `${json.data?.length ?? 0} models available.` };
  } catch (e) {
    return { ok: false, detail: errorMessage(e) };
  }
}

/**
 * Two-stage Foundry probe covering what is most likely misconfigured: Entra
 * token acquisition (proves the Managed Identity / `az login` identity holds the
 * `Cognitive Services OpenAI User` role) and endpoint reachability (a model
 * listing with that token, mirroring the SCCH probe).
 */
export async function checkFoundry(): Promise<HealthIndicator> {
  if (!foundryConfigured()) {
    return { ok: false, detail: "Not configured (AZURE_FOUNDRY_ENDPOINT is missing)." };
  }
  let token: string;
  try {
    token = await withTimeout(foundryBearerToken(), "Entra token acquisition", TIMEOUT_MS);
  } catch (e) {
    return { ok: false, detail: `Entra token acquisition failed: ${errorMessage(e)}` };
  }
  try {
    const res = await fetch(foundryModelsUrl(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, detail: `Model listing failed (HTTP ${res.status}).` };
    const json = (await res.json()) as { data?: { id: string }[] };
    return { ok: true, detail: `${json.data?.length ?? 0} models available.` };
  } catch (e) {
    return { ok: false, detail: errorMessage(e) };
  }
}

/**
 * Two-stage OpenRouter probe. OpenRouter's model listing is public — it answers
 * 200 for any key or none — so it proves reachability only. The key is proved
 * first by the key-info endpoint, which rejects an invalid key with a 401; the
 * listing then supplies the model count.
 */
export async function checkOpenRouter(): Promise<HealthIndicator> {
  if (!openrouterConfigured()) {
    return { ok: false, detail: "Not configured (OPENROUTER_API_KEY is missing)." };
  }
  try {
    const headers = { Authorization: openrouterAuthHeader() };
    const keyRes = await fetch(openrouterKeyUrl(), {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!keyRes.ok) {
      return { ok: false, detail: `API key rejected (HTTP ${keyRes.status}).` };
    }
    const res = await fetch(openrouterModelsUrl(), {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, detail: `Model listing failed (HTTP ${res.status}).` };
    const json = (await res.json()) as { data?: { id: string }[] };
    return { ok: true, detail: `${json.data?.length ?? 0} models available.` };
  } catch (e) {
    return { ok: false, detail: errorMessage(e) };
  }
}

/**
 * Verifies the configured image storage root (`IMAGE_STORAGE_ROOT`): present,
 * a directory, carrying the exact sentinel bytes, with a writable `images/`
 * subdirectory (`verifyImageRoot`, `lib/image-fs.ts`). Never throws; `detail`
 * always names the root path so a reused dev server with the wrong root is
 * diagnosable from this probe alone.
 */
export async function checkImageStorage(): Promise<HealthIndicator> {
  try {
    const check = await withTimeout(verifyImageRoot(), "Image root check", TIMEOUT_MS);
    if (check.ok) {
      return { ok: true, detail: `Root ${check.root} — sentinel verified, writable.` };
    }
    if (check.reason === "unset") {
      return { ok: false, detail: "IMAGE_STORAGE_ROOT is not set." };
    }
    return { ok: false, detail: `Root ${check.root}: ${check.detail}` };
  } catch (e) {
    return { ok: false, detail: errorMessage(e) };
  }
}

/** DNS-resolve a host. Pure DNS — succeeds even when a firewall blocks TCP. */
async function resolveHost(fqdn: string | null, missingHint: string): Promise<HostInfo> {
  if (!fqdn) return { fqdn: null, ips: [], error: missingHint };
  try {
    const addresses = await withTimeout(
      lookup(fqdn, { all: true }),
      `DNS lookup for ${fqdn}`,
      TIMEOUT_MS,
    );
    return { fqdn, ips: addresses.map((a) => a.address) };
  } catch (e) {
    return { fqdn, ips: [], error: errorMessage(e) };
  }
}

function scchFqdn(): string | null {
  const baseUrl = process.env.SCCH_BASE_URL;
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

export async function resolveDbHost(): Promise<HostInfo> {
  return resolveHost(databaseHost(), "No database host (DATABASE_URL missing or unparseable).");
}

export async function resolveScchHost(): Promise<HostInfo> {
  return resolveHost(scchFqdn(), "No SCCH host (SCCH_BASE_URL missing or unparseable).");
}

function foundryFqdn(): string | null {
  const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT;
  if (!endpoint) return null;
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
}

export async function resolveFoundryHost(): Promise<HostInfo> {
  return resolveHost(
    foundryFqdn(),
    "No Foundry host (AZURE_FOUNDRY_ENDPOINT missing or unparseable).",
  );
}

// The OpenRouter base always has a value (the public host is the default), so
// this only comes back null when an OPENROUTER_BASE_URL override is unparseable.
function openrouterFqdn(): string | null {
  try {
    return new URL(openrouterBase()).hostname;
  } catch {
    return null;
  }
}

export async function resolveOpenRouterHost(): Promise<HostInfo> {
  return resolveHost(openrouterFqdn(), "No OpenRouter host (OPENROUTER_BASE_URL is unparseable).");
}
