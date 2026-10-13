import { ApiAuthError, requireBearerTeacher } from "@/lib/api-auth";
import { resolveAppOriginOr } from "@/lib/app-origin";
import { parseModuleParam } from "@/lib/code-modules/types";
import { createCodeForUser } from "@/lib/code-service";
import { type CodeEntry, listCodes } from "@/lib/code-store";
import { recordError } from "@/lib/telemetry";

// CLI/API bearer routes for codes (docs/api.md): list codes with the /codes
// page's exact filters, and mint a code through the SAME pipeline as the web
// form (lib/code-service.ts). Excluded from the proxy.ts session gate (a CLI
// has no cookie); the ONLY access control is requireBearerTeacher — creating
// and listing codes is role-gated, not owner-gated, mirroring the web model.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function authErrorResponse(error: ApiAuthError): Response {
  // Generic body; the validation detail stays server-side (telemetry).
  // `{ message }` is the ONE failure key on the bearer channel (docs/api.md).
  return Response.json(
    { message: error.message },
    { status: error.status, headers: { ...NO_STORE, "WWW-Authenticate": "Bearer" } },
  );
}

// The wire shape of one code: the stored entry plus the shareable `url`, with
// Date fields as ISO 8601 UTC strings (or null for an open window bound). The
// origin is the request-time resolved app origin — NEVER the stored row's
// `origin` column (operator-only; a code created on localhost must yield a
// production share URL from the production API). `ownerName` is the creator's
// display name (`novedu_user.name`, null when unknown) — the same name the /codes
// list shows every teacher.
function toWire(entry: CodeEntry, origin: string, ownerName: string | null) {
  return {
    code: entry.code,
    url: `${origin}/${entry.code}`,
    module: entry.module,
    note: entry.note,
    fileUrl: entry.fileUrl,
    anonymous: entry.anonymous,
    validFrom: entry.validFrom?.toISOString() ?? null,
    validUntil: entry.validUntil?.toISOString() ?? null,
    llm: entry.llm,
    createdBy: entry.createdBy,
    ownerName,
    createdAt: entry.createdAt.toISOString(),
  };
}

// A window bound must carry an EXPLICIT offset (`Z` or ±hh[:]mm) — a naive
// datetime string would silently be interpreted in the server's timezone, so it
// is rejected instead. Blank/absent means "no bound" (open-ended code).
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

function isoToUnixSeconds(
  value: unknown,
  field: string,
): { ok: true; seconds: string } | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") return { ok: true, seconds: "" };
  const parsed = typeof value === "string" && EXPLICIT_OFFSET.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(parsed)) {
    return {
      ok: false,
      message: `${field} must be an ISO 8601 datetime with an explicit offset, e.g. 2026-07-07T08:00:00Z or 2026-07-07T10:00:00+02:00.`,
    };
  }
  return { ok: true, seconds: String(Math.floor(parsed / 1000)) };
}

/**
 * Lists codes: `q` contains-matches note/code, `mine` defaults ON (`mine=0`
 * widens to all teachers), `module` narrows to one activity. Bare JSON array,
 * newest first. `mine` is the BEARER channel's ownership param and is unchanged
 * by the /codes page's owner dropdown, which spells the same narrowing `?owner=`
 * (docs/filtered-lists.md).
 */
export async function GET(request: Request) {
  try {
    const user = await requireBearerTeacher(request);

    const params = new URL(request.url).searchParams;
    const q = (params.get("q") ?? "").trim();
    const onlyMine = params.get("mine") !== "0"; // default ON; "0" turns it off
    const moduleFilter = parseModuleParam(params.get("module") ?? undefined);

    // No `paging`: this route deliberately returns the full match set (the CLI
    // consumes it whole), so the store runs no COUNT and emits no OFFSET/FETCH.
    const result = await listCodes({
      search: q || undefined,
      createdBy: onlyMine ? user.userId : undefined,
      module: moduleFilter,
    });
    if (result === undefined) {
      return json({ message: "Codes could not be loaded right now. Try again in a moment." }, 503);
    }

    const origin = await resolveAppOriginOr("");
    return json(
      result.rows.map((entry) => toWire(entry, origin, entry.ownerName)),
      200,
    );
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error);
    recordError(error, { "novedu.area": "api-codes" });
    return json({ message: "Internal server error" }, 500);
  }
}

/**
 * Mints a code. JSON body
 * `{ module, fileUrl, validFrom?, validUntil?, note?, llm?: { provider, model, reasoning? } }`;
 * the window bounds are ISO 8601 with an explicit offset. Runs the identical
 * validation pipeline as the web form and answers 201 with the stored code (same
 * shape as GET), 400 with `{ message }` or `{ errors }` (the structured
 * validator detail), or 503 when storage is unavailable.
 */
export async function POST(request: Request) {
  try {
    const user = await requireBearerTeacher(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ message: "The request body must be JSON." }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return json({ message: "The request body must be a JSON object." }, 400);
    }
    const { module, fileUrl, validFrom, validUntil, note, llm } = body as Record<string, unknown>;

    const start = isoToUnixSeconds(validFrom, "validFrom");
    if (!start.ok) return json({ message: start.message }, 400);
    const end = isoToUnixSeconds(validUntil, "validUntil");
    if (!end.ok) return json({ message: end.message }, 400);

    if (llm !== undefined && llm !== null && typeof llm !== "object") {
      return json({ message: "llm must be an object with provider and model." }, 400);
    }
    const override = (llm ?? {}) as Record<string, unknown>;

    const result = await createCodeForUser(user.userId, {
      module,
      file: fileUrl,
      start: start.seconds,
      end: end.seconds,
      note: note ?? "",
      llmProvider: override.provider ?? "",
      llmModel: override.model ?? "",
      llmReasoning: override.reasoning ?? "",
    });
    if (!result.ok) {
      if (result.reason === "validation") return json({ errors: result.errors }, 400);
      return json({ message: result.message }, result.reason === "unavailable" ? 503 : 400);
    }

    const origin = await resolveAppOriginOr("");
    return json(toWire(result.entry, origin, user.name), 201);
  } catch (error) {
    if (error instanceof ApiAuthError) return authErrorResponse(error);
    recordError(error, { "novedu.area": "api-codes" });
    return json({ message: "Internal server error" }, 500);
  }
}
