import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

// The access gate. In Next.js 16 the `middleware` convention was renamed to
// `proxy` (Node.js runtime). It checks that a session cookie is PRESENT — no
// signature check, no database call — so an unauthenticated visitor is bounced
// to `/sign-in` cheaply.
//
// The cookie prefix is repeated from `auth.ts` rather than imported: importing
// `auth.ts` here would pull the database pool and the provider credentials into
// the gate. Keep the two literals in sync.
//
// It is NOT the authorization boundary. Every page, server action and route
// handler behind it re-establishes the session itself — `getSession()` /
// `requireEffectiveTeacher()` on the cookie channel, `requireBearerUser()` on the
// CLI/API channel. A garbage or expired cookie therefore reaches the page, which
// renders signed-out with the status bar's "Sign in" button as the way back
// (`getSession()` returns null).
export function proxy(request: NextRequest) {
  if (getSessionCookie(request, { cookiePrefix: "novedu" })) return NextResponse.next();
  const url = new URL("/sign-in", request.url);
  url.searchParams.set("callbackURL", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Protect everything (pages + /api/copilotkit) EXCEPT the
  // better-auth endpoints (needed to sign in, and to run the device flow the CLI
  // polls), the /sign-in page itself (redirecting it to itself would loop), the
  // public /api/version
  // build-identity probe (CD triage — see app/api/version/route.ts), the public
  // /api/files YAML-hosting endpoint (served without a session so the tutor-code
  // loader can fetch it — see app/api/files/[name]/route.ts), and static assets.
  // The public /api/coding OpenAI-compatible coding routes (chat/completions and
  // models) are gated by the per-user API key (key row + code row re-checked every
  // request), not by a session — an external coding agent has none — so they
  // are excluded here too (see app/api/coding/v1/**/route.ts). The one entry is
  // anchored with a path boundary (`api/coding(?:/|$)`) so the exclusion covers the
  // routes under `/api/coding/` without silently widening to a future, unrelated
  // `/api/coding-*` route.
  // The /api/me identity probe, the /api/codes list/create endpoints and the
  // per-code conversation export under them (creator-only), the
  // /api/reports list/detail/resolve endpoints, the /api/eval eval endpoints —
  // grade, judge and respond, all bounded by the one `api/eval(?:/|$)` entry
  // (teacher-only; docs/cli-eval.md) — and the /api/images list/upload
  // endpoints (all teacher-only; unlike /api/files there is NO public GET
  // under that prefix) are
  // CLI/API bearer-token routes: they self-gate via requireBearerUser /
  // requireBearerTeacher (lib/api-auth.ts) and a CLI has no session
  // cookie, so they must not hit the cookie gate (see docs/api.md). Every future
  // bearer route gets its own explicit, path-bounded exclusion like these —
  // never a blanket prefix. (The bearer PUT /api/files/<name> and GET /api/files
  // ride the existing /api/files exclusion and self-gate the same way.)
  // Image BYTES are served by GET /api/image-content/<id>, which deliberately
  // has NO exclusion: it is a cookie-session route, so it belongs under this
  // gate — and the `api/images(?:/|$)` boundary above keeps it there.
  // The app icons (`app/favicon.ico`, `app/icon.svg`, `app/apple-icon.png`) are
  // static assets every page links to, the signed-out /sign-in included, so
  // they are excluded; `icon.svg` / `apple-icon.png` are anchored to the exact
  // file so no route can ride them.
  // Without a matcher the proxy would also run on _next/static, blocking CSS/JS.
  // Every API exclusion is anchored with a path boundary (`(?:/|$)`) so none
  // can silently widen to a future sibling route (e.g. a hypothetical
  // /api/files-export must NOT ride the /api/files exclusion past the cookie
  // gate).
  matcher: [
    "/((?!api/auth(?:/|$)|sign-in(?:/|$)|api/version(?:/|$)|api/files(?:/|$)|api/coding(?:/|$)|api/me(?:/|$)|api/codes(?:/|$)|api/reports(?:/|$)|api/images(?:/|$)|api/eval(?:/|$)|_next/static|_next/image|favicon.ico|icon\\.svg$|apple-icon\\.png$).*)",
  ],
};
