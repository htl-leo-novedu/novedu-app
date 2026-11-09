import { openObject } from "@/lib/image-fs";
import { IMAGE_ID_PATTERN } from "@/lib/image-ref";
import { getActiveImageById } from "@/lib/image-store";
import { getSession } from "@/lib/session";

// The ONE route that serves app-hosted image bytes: same-origin and
// COOKIE-SESSION authenticated, `<id>` being the immutable `novedu_images`
// version row id. A browser `<img>` sends the session cookie by itself, which
// is why no signature, query token or expiry exists here.
//
// It sits behind the default proxy.ts cookie gate with NO matcher exemption,
// and the handler still calls `getSession()` itself — the gate is a redirect
// convenience, this check is the access control.
//
// The policy, verbatim from the design: teacher-hosted images are SHARED
// AUTHENTICATED ASSETS, not private per-teacher, per-user or per-code
// resources. Any signed-in Novedu user who possesses an active row URL may read
// it, including after the activity code that displayed it expires; the URL
// alone is insufficient without a valid session. This route therefore runs NO
// `checkCode()`, verifies NO thread token, and writes NO user↔code link — the
// quiz page still runs `checkCode()` before it ever hands out a URL.
//
// The active row is re-read on EVERY request, a conditional one included, so a
// deleted or replaced image stops being served immediately; a replacement gets
// a new row id, so the old URL stays dead. `Cache-Control: private, no-cache`
// plus a strong `ETag` over the immutable row id lets a browser keep a private
// copy it must revalidate, and no shared cache may store it.
//
// SVG renders only through `<img src>`: `nosniff` plus a sandboxing CSP on
// EVERY response means direct navigation to an SVG cannot execute in the
// application document (docs/images.md).
export const dynamic = "force-dynamic";

// On every response, success or failure — a 404 that could be sniffed into an
// active document would defeat the point.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
};

function failure(status: number, message: string): Response {
  return Response.json(
    { message },
    { status, headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store" } },
  );
}

/**
 * Streams one image version's bytes to a signed-in user. 200 with
 * `Content-Type` (the row's stored MIME, never sniffed),
 * `Cache-Control: private, no-cache` and `ETag: "<id>"`; 304 for a matching
 * `If-None-Match`, but only after the session check and the active-row lookup
 * both pass. 401 without a session, 404 for a malformed id, a closed/unknown
 * row or a missing object, 503 when the database or the storage root is
 * unavailable.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession();
  } catch (error) {
    console.error("image-content: session lookup failed", error);
    return failure(503, "Images are unavailable right now. Try again in a moment.");
  }
  if (!session) return failure(401, "Unauthorized");

  const { id } = await params;
  if (!IMAGE_ID_PATTERN.test(id)) return failure(404, "Not found");

  const row = await getActiveImageById(id);
  if (row === undefined) {
    return failure(503, "Images are unavailable right now. Try again in a moment.");
  }
  if (row === null) return failure(404, "Not found");

  const cacheHeaders = {
    ...SECURITY_HEADERS,
    "Content-Type": row.mimeType,
    "Cache-Control": "private, no-cache",
    ETag: `"${id}"`,
  };

  // Revalidation is cheap but never free of the checks above: a closed row 404s
  // a conditional request exactly as it 404s a plain one.
  if ((request.headers.get("if-none-match") ?? "").includes(`"${id}"`)) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }

  const opened = await openObject(row.blobPath);
  if (!opened.ok) {
    console.error("image-content: opening the object failed", row.blobPath, opened.detail);
    return failure(503, "Images are unavailable right now. Try again in a moment.");
  }
  if ("missing" in opened) return failure(404, "Not found");

  return new Response(opened.stream, { status: 200, headers: cacheHeaders });
}
