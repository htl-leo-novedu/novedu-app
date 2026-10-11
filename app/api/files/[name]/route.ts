import { ApiAuthError, requireBearerTeacher } from "@/lib/api-auth";
import { resolveAppOriginOr } from "@/lib/app-origin";
import { upsertFileForUser } from "@/lib/file-service";
import { getActiveFile, validateFileName } from "@/lib/file-store";
import { filePublicUrl } from "@/lib/file-url";
import { recordError } from "@/lib/telemetry";

// GET is a PUBLIC, unauthenticated endpoint — deliberately excluded from the
// access gate in proxy.ts — that serves the LATEST version of an app-hosted
// YAML file as raw text. The URL `https://<origin>/api/files/<name>` therefore
// drops straight into the existing tutor-code flow: the chat loader fetches it
// server-side with no session, and teachers may share it publicly. Soft-deleted
// or unknown files 404.
//
// PUT is a CLI/API bearer upsert (docs/api.md): it rides the same proxy
// exclusion but gates ITSELF with requireBearerTeacher — the public/GET-only
// nature of the URL never extends to writes.
//
// force-dynamic + `Cache-Control: no-store` so edits are visible immediately —
// the tutor-code flow re-fetches the tutor URL on every chat open and message and
// must never see a stale version (matching the "no caching by design" of the
// tutor-code loader).
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  // Reject malformed names without a database round-trip.
  if (!validateFileName(name).ok) {
    return new Response("Not found", { status: 404 });
  }

  const file = await getActiveFile(name);
  if (file === undefined) {
    // Database unreachable — transient, not a missing file.
    return new Response("File lookup failed", { status: 503 });
  }
  if (file === null) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(file.content, {
    status: 200,
    headers: {
      "Content-Type": "text/yaml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * Upserts a file (docs/api.md): create when the name is free (`kind` then
 * required), a new version when it exists (a supplied `kind` must match the
 * stored one — a mismatch is a loud 409, never silently ignored). JSON body
 * `{ kind?, content }`; runs the identical validation pipeline as the web
 * editor via `upsertFileForUser`. 200 `{ name, kind, url, action }`, 400
 * `{ message | errors }`, 409 `{ message }` (kind mismatch / name race), 503
 * when storage is unavailable.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ name: string }> }) {
  try {
    const user = await requireBearerTeacher(request);
    const { name } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ message: "The request body must be JSON." }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return json({ message: "The request body must be a JSON object." }, 400);
    }
    const { kind, content } = body as Record<string, unknown>;
    if (kind !== undefined && typeof kind !== "string") {
      return json(
        { message: "kind must be a string (tutor, fragment, quiz, writing, coding or cloze)." },
        400,
      );
    }
    if (typeof content !== "string") {
      return json({ message: "content must be a string of YAML." }, 400);
    }

    const result = await upsertFileForUser(user.userId, { name, kind, content });
    if (!result.ok) {
      if (result.reason === "validation") return json({ errors: result.errors }, 400);
      const status =
        result.reason === "kind-mismatch" || result.reason === "conflict"
          ? 409
          : result.reason === "unavailable"
            ? 503
            : 400;
      return json({ message: result.message }, status);
    }

    const origin = await resolveAppOriginOr("");
    return json(
      {
        name: result.name,
        kind: result.kind,
        url: filePublicUrl(origin, result.name),
        action: result.action,
      },
      200,
    );
  } catch (error) {
    if (error instanceof ApiAuthError) {
      // Generic body; the validation detail stays server-side (telemetry).
      // `{ message }` is the ONE failure key on the bearer channel (docs/api.md).
      return Response.json(
        { message: error.message },
        { status: error.status, headers: { ...NO_STORE, "WWW-Authenticate": "Bearer" } },
      );
    }
    recordError(error, { "novedu.area": "api-files" });
    return json({ message: "Internal server error" }, 500);
  }
}
