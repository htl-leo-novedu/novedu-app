import { createHmac } from "node:crypto";
import { type JWTPayload, type JWTVerifyGetKey, jwtVerify, SignJWT } from "jose";
import { CODE_PATTERN } from "@/lib/code-store";
import type { MoodleConnection } from "@/lib/moodle-config";

// The LTI 1.3 launch, as pure functions (docs/moodle.md): the three short-lived
// signed tokens Novedu hands itself across Moodle's redirects, the checks on
// Moodle's signed launch message, the deep-linking answer's claims, and the
// arrival decision. Everything stateful (the request, the cookie, the database)
// stays in the route handlers and actions that call these.
//
// No table and no cookie carries the login state: Moodle's launch is a
// cross-site POST that a `SameSite=Lax` cookie would not survive, so the
// `state` is itself a signed, expiring token. The arrival travels in a signed
// cookie, never in the address (a reference in the address would be a bearer
// reference).
//
// SERVER-ONLY: derives keys from AUTH_SECRET. Never import from client components.

export const LTI = "https://purl.imsglobal.org/spec/lti/claim/";
export const LTI_DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";
export const LTI_AGS = "https://purl.imsglobal.org/spec/lti-ags/claim/";
export const LEARNER_ROLE = "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner";

/** The arrival cookie: `HttpOnly`, `SameSite=Lax`, `Path=/lti`, 15 minutes. */
export const ARRIVAL_COOKIE = "novedu-lti-arrival";
export const ARRIVAL_TTL_SECONDS = 15 * 60;
const STATE_TTL_SECONDS = 10 * 60;
const PICK_TTL_SECONDS = 15 * 60;

// --- the three tokens -------------------------------------------------------------------

/** Each token has its own key, derived from AUTH_SECRET under its own label. */
export type MoodleTokenPurpose = "state" | "pick" | "arrival";

const TTL: Record<MoodleTokenPurpose, number> = {
  state: STATE_TTL_SECONDS,
  pick: PICK_TTL_SECONDS,
  arrival: ARRIVAL_TTL_SECONDS,
};

/** The key of one token purpose, derived the way `getThreadTokenSecret()` derives its own. */
export function moodleTokenKey(purpose: MoodleTokenPurpose, authSecret: string): Uint8Array {
  return createHmac("sha256", authSecret).update(`novedu:moodle-${purpose}:v1`).digest();
}

function productionKey(purpose: MoodleTokenPurpose): Uint8Array {
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) throw new Error("AUTH_SECRET is not set — required to sign Moodle tokens");
  return moodleTokenKey(purpose, authSecret);
}

export interface StateToken {
  nonce: string;
}

export interface PickToken {
  /** Moodle's `deep_link_return_url` (inside the issuer). */
  returnUrl: string;
  /** Moodle's opaque `data` value, echoed back when present. */
  data: string | null;
}

export interface ArrivalToken {
  /** The Moodle user id (`sub`). */
  sub: string;
  /** The Moodle display name, or `null` when Moodle shares none. */
  name: string | null;
  /** The Moodle username (`ext.user_username`), when Moodle sends it. */
  username: string | null;
  code: string;
  /** The Moodle course title, shown on the confirmation page only. */
  course: string | null;
  /** The activity's grade column (AGS line item) — inside the issuer. */
  lineitem: string;
}

type TokenPayload = {
  state: StateToken;
  pick: PickToken;
  arrival: ArrivalToken;
};

/** Signs `payload` for `purpose` (HS256, its own TTL). `key` defaults to the production key. */
export async function signMoodleToken<P extends MoodleTokenPurpose>(
  purpose: P,
  payload: TokenPayload[P],
  key: Uint8Array = productionKey(purpose),
): Promise<string> {
  return new SignJWT({ ...payload, typ: purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL[purpose]}s`)
    .sign(key);
}

/**
 * The payload of a valid, unexpired token of `purpose`, or `undefined` for
 * anything else (missing, tampered, expired, another purpose's token).
 */
export async function verifyMoodleToken<P extends MoodleTokenPurpose>(
  purpose: P,
  token: unknown,
  key: Uint8Array = productionKey(purpose),
): Promise<TokenPayload[P] | undefined> {
  if (typeof token !== "string" || token === "" || token.length > 8192) return undefined;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (payload.typ !== purpose) return undefined;
    return readPayload(purpose, payload);
  } catch {
    return undefined;
  }
}

function readPayload<P extends MoodleTokenPurpose>(
  purpose: P,
  payload: JWTPayload,
): TokenPayload[P] | undefined {
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const optional = (value: unknown) => (typeof value === "string" ? value : null);
  if (purpose === "state") {
    const nonce = text(payload.nonce);
    return nonce ? ({ nonce } as TokenPayload[P]) : undefined;
  }
  if (purpose === "pick") {
    const returnUrl = text(payload.returnUrl);
    return returnUrl ? ({ returnUrl, data: optional(payload.data) } as TokenPayload[P]) : undefined;
  }
  const sub = text(payload.sub);
  const code = text(payload.code);
  const lineitem = text(payload.lineitem);
  if (!sub || !code || !lineitem || !CODE_PATTERN.test(code)) return undefined;
  return {
    sub,
    name: optional(payload.name),
    username: optional(payload.username),
    code,
    course: optional(payload.course),
    lineitem,
  } as TokenPayload[P];
}

// --- Moodle's launch message ------------------------------------------------------------

/**
 * Whether `url` lies inside the configured Moodle (same origin, under the
 * Plattform-ID's path). Keeps the later server-side calls and the deep-linking
 * answer from being pointed anywhere else.
 */
export function insideIssuer(url: unknown, issuer: string): url is string {
  if (typeof url !== "string") return false;
  try {
    const target = new URL(url);
    const base = new URL(issuer);
    if (target.origin !== base.origin) return false;
    const prefix = base.pathname.replace(/\/+$/, "");
    return prefix === "" || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
  } catch {
    return false;
  }
}

export type LaunchMessage =
  | { kind: "deep-link"; pick: PickToken }
  | {
      kind: "resource";
      /** `custom.novedu_code` when it matches the code pattern, else `null`. */
      code: string | null;
      learner: boolean;
      /** The arrival, when the launch carries a grade column. */
      arrival: Omit<ArrivalToken, "code"> | null;
    }
  | { kind: "refused"; reason: LaunchRefusal };

export type LaunchRefusal =
  | "token"
  | "nonce"
  | "deployment"
  | "version"
  | "message-type"
  | "return-url"
  | "lineitem";

/**
 * Verifies Moodle's `id_token` (signature against Moodle's key set, issuer,
 * audience = client id, expiry) and then the LTI claims. `keys` is Moodle's key
 * set — `createRemoteJWKSet(connection.jwksUrl)` in production.
 */
export async function readLaunch(
  idToken: unknown,
  connection: MoodleConnection,
  expectedNonce: string,
  keys: JWTVerifyGetKey,
): Promise<LaunchMessage> {
  if (typeof idToken !== "string" || idToken === "") return refused("token");
  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(idToken, keys, {
      issuer: connection.issuer,
      audience: connection.clientId,
      algorithms: ["RS256"],
    }));
  } catch {
    return refused("token");
  }
  return checkLaunchClaims(claims, connection, expectedNonce);
}

/** The claim checks after the signature was verified. Pure. */
export function checkLaunchClaims(
  claims: JWTPayload,
  connection: MoodleConnection,
  expectedNonce: string,
): LaunchMessage {
  if (claims.nonce !== expectedNonce) return refused("nonce");
  if (claims[`${LTI}deployment_id`] !== connection.deploymentId) return refused("deployment");
  if (claims[`${LTI}version`] !== "1.3.0") return refused("version");

  const type = claims[`${LTI}message_type`];
  if (type === "LtiDeepLinkingRequest") {
    const settings = record(claims[`${LTI_DL}deep_linking_settings`]);
    const returnUrl = settings.deep_link_return_url;
    if (!insideIssuer(returnUrl, connection.issuer)) return refused("return-url");
    const data = typeof settings.data === "string" ? settings.data : null;
    return { kind: "deep-link", pick: { returnUrl, data } };
  }
  if (type !== "LtiResourceLinkRequest") return refused("message-type");

  const customCode = record(claims[`${LTI}custom`]).novedu_code;
  const code =
    typeof customCode === "string" && CODE_PATTERN.test(customCode.trim())
      ? customCode.trim()
      : null;
  const roles = claims[`${LTI}roles`];
  const learner = Array.isArray(roles) && roles.includes(LEARNER_ROLE);

  const lineitem = record(claims[`${LTI_AGS}endpoint`]).lineitem;
  if (lineitem !== undefined && !insideIssuer(lineitem, connection.issuer)) {
    return refused("lineitem");
  }
  const sub = typeof claims.sub === "string" && claims.sub !== "" ? claims.sub : null;

  return {
    kind: "resource",
    code,
    learner,
    arrival:
      typeof lineitem === "string" && sub
        ? {
            sub,
            name: displayName(claims),
            username: stringOrNull(record(claims[`${LTI}ext`]).user_username),
            course: stringOrNull(record(claims[`${LTI}context`]).title),
            lineitem,
          }
        : null,
  };
}

function refused(reason: LaunchRefusal): LaunchMessage {
  return { kind: "refused", reason };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function displayName(claims: JWTPayload): string | null {
  const name = stringOrNull(claims.name);
  if (name) return name;
  const parts = [stringOrNull(claims.given_name), stringOrNull(claims.family_name)].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

// --- the deep-linking answer --------------------------------------------------------------

/**
 * The claims of the `LtiDeepLinkingResponse` for one picked code: a resource
 * link to Novedu's launch URL carrying `novedu_code`, with a grade column of
 * maximum 100. Signed with the tool key by the caller (`aud` = the issuer).
 */
export function deepLinkingResponseClaims(input: {
  connection: MoodleConnection;
  origin: string;
  code: string;
  note: string;
  data: string | null;
  nonce: string;
}): JWTPayload {
  const title = `Novedu: ${input.note.trim() || input.code}`;
  return {
    iss: input.connection.clientId,
    nonce: input.nonce,
    [`${LTI}message_type`]: "LtiDeepLinkingResponse",
    [`${LTI}version`]: "1.3.0",
    [`${LTI}deployment_id`]: input.connection.deploymentId,
    ...(input.data === null ? {} : { [`${LTI_DL}data`]: input.data }),
    [`${LTI_DL}content_items`]: [
      {
        type: "ltiResourceLink",
        title,
        url: `${input.origin}/api/lti/launch`,
        custom: { novedu_code: input.code },
        lineItem: { scoreMaximum: 100, label: title },
      },
    ],
  };
}

// --- the arrival decision ---------------------------------------------------------------

/** Who holds which link, read by the session user and the arrival's Moodle id. */
export interface LinkState {
  /** The Moodle user id this Novedu user is linked to, or `null`. */
  ownMoodleUserId: string | null;
  /** The Novedu user linked to the arriving Moodle user id, or `null`. */
  moodleUserOwner: string | null;
}

export type ArrivalDecision =
  | "linked"
  | "confirm"
  | "mismatch-moodle"
  | "mismatch-novedu"
  | "no-name"
  | "expired";

/**
 * What happens to an arrival for the signed-in `sessionUserId`. No arrival →
 * expired; both sides linked to each other → linked; the Moodle account linked
 * to someone else → mismatch-moodle; this Novedu account linked to another
 * Moodle account → mismatch-novedu; no name to confirm with → no-name; else the
 * confirmation page.
 */
export function decideArrival(
  sessionUserId: string,
  arrival: ArrivalToken | undefined,
  links: LinkState,
): ArrivalDecision {
  if (!arrival) return "expired";
  if (links.ownMoodleUserId === arrival.sub && links.moodleUserOwner === sessionUserId) {
    return "linked";
  }
  if (links.moodleUserOwner !== null && links.moodleUserOwner !== sessionUserId) {
    return "mismatch-moodle";
  }
  if (links.ownMoodleUserId !== null && links.ownMoodleUserId !== arrival.sub) {
    return "mismatch-novedu";
  }
  if (!arrival.name) return "no-name";
  return "confirm";
}

/** The `/lti/done` states: every non-happy outcome of an arrival, plus a declined link. */
export const DONE_STATES = [
  "expired",
  "mismatch-moodle",
  "mismatch-novedu",
  "no-name",
  "declined",
] as const;
export type DoneState = (typeof DONE_STATES)[number];

export function isDoneState(value: unknown): value is DoneState {
  return typeof value === "string" && (DONE_STATES as readonly string[]).includes(value);
}

/** The `/lti/done` address for `state` (and the code when known — pattern-checked). */
export function donePath(state: DoneState, code: string | null | undefined): string {
  const params = new URLSearchParams({ state });
  if (code && CODE_PATTERN.test(code)) params.set("code", code);
  return `/lti/done?${params}`;
}
