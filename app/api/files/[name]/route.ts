import { ApiAuthError, requireBearerTeacher } from "@/lib/api-auth";
import { resolveAppOriginOr } from "@/lib/app-origin";
import { upsertFileForUser } from "@/lib/file-service";
import { getActiveFile, validateFileName } from "@/lib/file-store";
import { filePublicUrl } from "@/lib/file-url";
import { recordError } from "@/lib/telemetry";

// GET serves the LATEST version of an app-hosted YAML file as raw text — to a
// TEACHER BEARER only (`novedu-cli validate` / `prompts` / `eval` on an uploaded
// file). Uploaded files may hold an exam's questions and server-only grading
// prompts, so nobody else reads them: the server's own loaders never come here,
// they read `<origin>/api/files/<name>` straight from the database
// (`appHostedFetcher`, docs/files.md). The gate runs FIRST — no name check and no
// store lookup before it — so the route is no existence oracle. Soft-deleted or
// unknown files 404.
//
// PUT is a CLI/API bearer upsert (docs/api.md). Both ride the proxy exclusion for
// `api/files` and gate THEMSELVES with requireBearerTeacher.
//
// force-dynamic + `Cache-Control: no-store` so edits are visible immediately.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

// Generic body; the validation detail stays server-side (telemetry). `{ message }`
// is the ONE failure key on the bearer channel (docs/api.md).
function authErrorResponse(error: ApiAuthError): Response {
  return Response.json(
    { message: error.message },
    { status: error.status, headers: { ...NO_STORE, "WWW-Authenticate": "Bearer" } },
  );
}

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  try {
    await requireBearerTeacher(request);
    const { name } = await params;

    // Reject malformed names without a database round-trip.
    if (!validateFileName(name).ok) {
      return new Response("Not found", { status: 404, headers: NO_STORE });
    }

    const file = await getActiveFile(name);
    if (file === undefined) {
      // Database unreachable — transient, not a missing file.
      return new Response("File lookup failed", { status: 503, headers: NO_STORE });
    }
    if (file === null) {
      return new Response("Not found", { status: 404, headers: NO_STORE });
    }

    return new Response(file.content, {
      status: 200,
      headers: { "Content-Type": "text/yaml; charset=utf-8", ...NO_STORE },
    });
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error);
    recordError(error, { "novedu.area": "api-files" });
    return json({ message: "Internal server error" }, 500);
  }
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
        { message: "kind must be a string (tutor, fragment, quiz, writing or coding)." },
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
    if (error instanceof ApiAuthError) return authErrorResponse(error);
    recordError(error, { "novedu.area": "api-files" });
    return json({ message: "Internal server error" }, 500);
  }
}
