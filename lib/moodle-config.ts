import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import {
  calculateJwkThumbprint,
  exportJWK,
  exportSPKI,
  type JWK,
  type JWTPayload,
  SignJWT,
} from "jose";
import { recordError } from "@/lib/telemetry";

// The Moodle connection and Novedu's own LTI key (docs/moodle.md).
//
// Moodle hand-in is server configuration, never edited in the app: the private
// key `MOODLE_LTI_PRIVATE_KEY` (PKCS#8 PEM) plus the three values Moodle shows
// after the admin registered Novedu — `MOODLE_LTI_ISSUER` (Moodle's
// Plattform-ID), `MOODLE_LTI_CLIENT_ID`, `MOODLE_LTI_DEPLOYMENT_ID`. Moodle's
// three endpoints are derived from the Plattform-ID with Moodle's fixed paths.
//
// The feature is AVAILABLE only when the key loads AND all three values are set
// (`moodleAvailable()`); every Moodle code path asks through it. The key alone
// is enough for the public key set, because the admin registers Novedu before
// Moodle's values exist. One or two of the three values set is a configuration
// error: warned once by NAME, never a value, and treated as not available. An
// unparsable key fails at its first use, counts as not available and is never
// logged.
//
// SERVER-ONLY: handles the private key. Never import from client components.

export interface MoodleConnection {
  /** Moodle's Plattform-ID, without a trailing slash. */
  issuer: string;
  clientId: string;
  deploymentId: string;
  /** `<issuer>/mod/lti/certs.php` — Moodle's key set. */
  jwksUrl: string;
  /** `<issuer>/mod/lti/token.php` — the grade service's token endpoint. */
  tokenUrl: string;
  /** `<issuer>/mod/lti/auth.php` — the OIDC authorization endpoint. */
  authUrl: string;
}

const CONNECTION_VARIABLES = [
  "MOODLE_LTI_ISSUER",
  "MOODLE_LTI_CLIENT_ID",
  "MOODLE_LTI_DEPLOYMENT_ID",
] as const;

let warnedPartial = false;

function readVariable(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * The configured connection, or `undefined` when none (or only part of one) is
 * set. Pure apart from the environment and the one-time warning.
 */
export function moodleConnection(): MoodleConnection | undefined {
  const [issuerRaw, clientId, deploymentId] = CONNECTION_VARIABLES.map(readVariable);
  const missing = CONNECTION_VARIABLES.filter((_, i) => ![issuerRaw, clientId, deploymentId][i]);
  if (missing.length === CONNECTION_VARIABLES.length) return undefined;
  if (missing.length > 0 || !issuerRaw || !clientId || !deploymentId) {
    warnOnce(`moodle: the connection is incomplete — ${missing.join(", ")} not set`);
    return undefined;
  }
  const issuer = normaliseIssuer(issuerRaw);
  if (!issuer) {
    warnOnce("moodle: MOODLE_LTI_ISSUER is not an http(s) address");
    return undefined;
  }
  return {
    issuer,
    clientId,
    deploymentId,
    jwksUrl: `${issuer}/mod/lti/certs.php`,
    tokenUrl: `${issuer}/mod/lti/token.php`,
    authUrl: `${issuer}/mod/lti/auth.php`,
  };
}

function normaliseIssuer(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.search || url.hash) return undefined;
    return raw.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function warnOnce(message: string): void {
  if (warnedPartial) return;
  warnedPartial = true;
  console.warn(message);
}

/** Whether a private key is configured at all (it may still fail to load). */
export function moodleKeyConfigured(): boolean {
  return readVariable("MOODLE_LTI_PRIVATE_KEY") !== undefined;
}

interface ToolKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
  publicJwk: JWK;
}

let cached: { pem: string; key: Promise<ToolKey | undefined> } | undefined;

/**
 * A `.env` file often carries the PEM on one line with `\n` escapes; accept
 * both that and real line breaks.
 */
function readPem(): string | undefined {
  const raw = readVariable("MOODLE_LTI_PRIVATE_KEY");
  return raw?.replace(/\\n/g, "\n");
}

async function loadKey(pem: string): Promise<ToolKey | undefined> {
  try {
    const privateKey = createPrivateKey({ key: pem, format: "pem" });
    if (privateKey.asymmetricKeyType !== "rsa") throw new Error("not an RSA key");
    const publicKey = createPublicKey(privateKey);
    const jwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(jwk);
    return {
      privateKey,
      publicKey,
      kid,
      publicJwk: { ...jwk, kid, alg: "RS256", use: "sig" },
    };
  } catch {
    // Never the error itself: it may quote the key material.
    const failure = new Error("moodle: MOODLE_LTI_PRIVATE_KEY could not be loaded");
    console.error(failure.message);
    recordError(failure, { op: "moodle-key" });
    return undefined;
  }
}

/** The tool key, memoised per configured value; `undefined` without a usable key. */
export async function toolKey(): Promise<ToolKey | undefined> {
  const pem = readPem();
  if (!pem) return undefined;
  if (cached?.pem !== pem) cached = { pem, key: loadKey(pem) };
  return cached.key;
}

/**
 * The connection when the feature is available (a usable key AND the complete
 * connection), else `undefined`. The one availability check.
 */
export async function moodleAvailable(): Promise<MoodleConnection | undefined> {
  const connection = moodleConnection();
  if (!connection) return undefined;
  return (await toolKey()) ? connection : undefined;
}

/** The public key as a JWK set, or `undefined` without a usable key. */
export async function publicJwks(): Promise<{ keys: JWK[] } | undefined> {
  const key = await toolKey();
  return key ? { keys: [key.publicJwk] } : undefined;
}

/** The public key as SPKI PEM (Moodle's "RSA key" variant), or `undefined`. */
export async function publicKeyPem(): Promise<string | undefined> {
  const key = await toolKey();
  return key ? exportSPKI(key.publicKey) : undefined;
}

/**
 * Signs `claims` with the tool key (RS256, the thumbprint as `kid`, 5 minutes,
 * a random `jti`). Throws without a usable key — callers check availability
 * first.
 */
export async function signWithToolKey(claims: JWTPayload, audience: string): Promise<string> {
  const key = await toolKey();
  if (!key) throw new Error("moodle: no usable tool key");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(crypto.randomUUID())
    .setAudience(audience)
    .sign(key.privateKey);
}

/** Resets the memoised key and the one-time warning — for unit tests only. */
export function resetMoodleConfigForTests(): void {
  cached = undefined;
  warnedPartial = false;
}
