import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { NextResponse } from "next/server";
import { emitEvent } from "@/lib/telemetry";

// Small shared pieces of the public LTI route handlers (docs/moodle.md): plain
// text answers with no detail, absolute redirects, Moodle's cached key set and
// the content-free launch telemetry.
//
// SERVER-ONLY.

/** A plain-text answer; never carries a token, a claim or a URL. */
export function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export function notFound(): Response {
  return plain(404, "Not found");
}

/** A `303` to `path` on this deployment's own origin. */
export function seeOther(origin: string, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, origin), 303);
}

const keySets = new Map<string, JWTVerifyGetKey>();

/** Moodle's key set, one cached remote set per URL (jose refetches on an unknown `kid`). */
export function moodleKeySet(jwksUrl: string): JWTVerifyGetKey {
  let keys = keySets.get(jwksUrl);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 10_000 });
    keySets.set(jwksUrl, keys);
  }
  return keys;
}

/** The launch outcome as an event — a reason code only, never an id, name or URL. */
export function launchEvent(outcome: string): void {
  emitEvent("moodle.launch", { "novedu.moodle.outcome": outcome });
}
