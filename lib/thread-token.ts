import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Thread-ownership tokens: the chat page (app/[code]/page.tsx) generates the
// Mastra thread id server-side and signs (code, userId, threadId); the chat
// runtime route refuses any thread-touching request whose token does not match
// the requesting user's session. This is what keeps students from reading or
// continuing each other's chats — Mastra itself does NOT bind threads to a
// resource (its getThreadById ignores the resourceId and saveThread silently
// rebinds it), and storing an ownership table would break the anonymity
// promise for `anonymous: true` tutors. A stateless HMAC proves ownership
// without persisting anything.
//
// The tutor chat keeps its current `{ threadId, token }` pair in the tab's
// `sessionStorage` so a reload can resume the conversation
// (lib/tutor-thread-storage.ts). That is safe because the token grants nothing
// beyond what the tab already held: it verifies only against the SESSION user,
// so a copied pair is useless to any other account, and the browser can never
// mint one. The resume itself is further bounded server-side by an idle limit
// (lib/tutor-history-gate.ts), and sign-out clears the stored pairs.
//
// Pure functions — the secret is always passed in — so sign/verify are
// unit-testable; `getThreadTokenSecret()` is the production secret.
//
// SERVER-ONLY: uses node:crypto and handles the signing secret. Never import
// from client components.

/**
 * The shape of a thread id accepted from a client: a belt-and-braces check before any
 * lookup or HMAC. The server issues UUIDs; the token, not this pattern, proves ownership.
 */
export const THREAD_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export interface ThreadTokenPayload {
  /** The tutor code the chat was opened under. */
  code: string;
  /** Session user id (`novedu_user.id`) of the signed-in student. */
  userId: string;
  /** The server-generated Mastra thread id. */
  threadId: string;
}

// JSON-encoding the triple as an array is injective for arbitrary strings —
// no separator can collide with content (the session user id is treated as
// opaque; do not assume it avoids any particular character).
export function canonicalThreadPayload({ code, userId, threadId }: ThreadTokenPayload): string {
  return JSON.stringify([code, userId, threadId]);
}

export function signThreadToken(payload: ThreadTokenPayload, secret: string): string {
  return createHmac("sha256", secret).update(canonicalThreadPayload(payload)).digest("hex");
}

function safeEqualHex(candidate: string, expected: string): boolean {
  // Reject non-hex up front: Buffer.from(.., "hex") silently stops at the first
  // invalid character, which would otherwise accept e.g. `<sig>zz`.
  if (!/^[0-9a-f]+$/i.test(candidate)) return false;
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies a token (typically the client-sent `x-thread-token` header, so
 * `unknown`) against the payload the SERVER believes in — in particular the
 * userId always comes from the current session, which is why a leaked
 * token+threadId pair is useless to anyone but its owner.
 */
export function verifyThreadToken(
  token: unknown,
  payload: ThreadTokenPayload,
  secret: string,
): boolean {
  if (typeof token !== "string" || token === "") return false;
  return safeEqualHex(token, signThreadToken(payload, secret));
}

/**
 * A fresh server-generated thread id for `(code, userId)` and its ownership token,
 * signed with the production secret — what every chat surface hands the browser.
 */
export function newThread(code: string, userId: string): { threadId: string; threadToken: string } {
  const threadId = randomUUID();
  return {
    threadId,
    threadToken: signThreadToken({ code, userId, threadId }, getThreadTokenSecret()),
  };
}

// Purpose-bound key derived from AUTH_SECRET (already required by Auth.js, so
// no extra ops configuration) — the derivation keeps thread tokens in their
// own key domain instead of signing with the session secret directly.
let cachedSecret: string | undefined;

export function getThreadTokenSecret(): string {
  if (cachedSecret !== undefined) return cachedSecret;
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) {
    throw new Error("AUTH_SECRET is not set — required to sign thread-ownership tokens");
  }
  cachedSecret = createHmac("sha256", authSecret).update("novedu:thread-token:v1").digest("hex");
  return cachedSecret;
}

/** Clears the memoized secret — for unit tests only. */
export function resetThreadTokenSecretForTests(): void {
  cachedSecret = undefined;
}
