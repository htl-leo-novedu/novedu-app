import { ApiAuthError, requireBearerTeacher } from "@/lib/api-auth";
import { resolveAppOriginOr } from "@/lib/app-origin";
import { listFiles } from "@/lib/file-store";
import { filePublicUrl } from "@/lib/file-url";
import { recordError } from "@/lib/telemetry";

// CLI/API bearer route listing app-hosted YAML files (docs/api.md) with the
// /files list's filters, keeping this channel's own `mine` param (the page
// spells that narrowing `?owner=`). Lives BESIDE the public per-name
// GET (app/api/files/[name]/route.ts) under the /api/files prefix that is
// already excluded from the proxy.ts session gate, so this handler's ONLY
// access control is requireBearerTeacher. Active versions only, WITHOUT
// content (the public per-name GET serves that).
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * Lists active files: `q` contains-matches name/title/description, `mine`
 * defaults ON (`mine=0` widens to all teachers' files; the page's equivalent is
 * `?owner=`). Bare JSON array,
 * newest first; `url` is the file's public download URL and `createdAt` the
 * active version's write time (ISO 8601 UTC).
 */
export async function GET(request: Request) {
  try {
    const user = await requireBearerTeacher(request);

    const params = new URL(request.url).searchParams;
    const q = (params.get("q") ?? "").trim();
    const onlyMine = params.get("mine") !== "0"; // default ON; "0" turns it off

    // No `paging`: this route deliberately returns the full match set (the CLI
    // consumes it whole), so the store runs no COUNT and emits no OFFSET/FETCH.
    const result = await listFiles({
      search: q || undefined,
      createdBy: onlyMine ? user.userId : undefined,
    });
    if (result === undefined) {
      return json({ message: "Files could not be loaded right now. Try again in a moment." }, 503);
    }

    const origin = await resolveAppOriginOr("");
    return json(
      result.rows.map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        title: entry.title,
        description: entry.description,
        createdBy: entry.createdBy,
        ownerName: entry.ownerName,
        createdAt: entry.validFrom.toISOString(),
        url: filePublicUrl(origin, entry.name),
      })),
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
