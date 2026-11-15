import { appHostedFetcher } from "@/lib/app-hosted-fetcher";
import { resolveAppOrigin } from "@/lib/app-origin";
import { validateCodeFile } from "@/lib/code-modules/registry";
import { isCodeModule } from "@/lib/code-modules/types";
import { type CodeEntry, createCode, getCode, validateCodeRequest } from "@/lib/code-store";
import { providerUnavailableReason } from "@/lib/llm/availability";
import type { ValidationError } from "@/lib/prompt-fragments";

// The transport-agnostic "create a code" pipeline, shared by the web form's
// server action (lib/code-actions.ts, cookie session) and the bearer API route
// (app/api/codes/route.ts, docs/api.md). Auth NEVER enters this module — each
// channel gates itself and passes the verified user id in. The result's
// `reason` discriminant lets the channels map failures differently (form
// message vs. HTTP 400/503) without re-deriving what went wrong.
//
// SERVER-ONLY: uses the database and env configuration. Never import from
// client components.

export type CreateCodeServiceResult =
  | { ok: true; entry: CodeEntry; shareUrl: string }
  // The request itself is unacceptable (bad module/URL/window/note/override).
  | { ok: false; reason: "invalid"; message: string }
  // The activity YAML failed the module's validator — the FULL structured error
  // list (codes, field paths, missing variables), the same actionable detail
  // the files pages show.
  | { ok: false; reason: "validation"; errors: ValidationError[] }
  // Storage/lookup infrastructure failed — retrying later may work.
  | { ok: false; reason: "unavailable"; message: string };

/**
 * Creates a code for an activity (`module`) + file + availability window on
 * behalf of `userId`. The stored row is the only artifact — there is no
 * stateless fallback, so a storage failure is a hard error. All inputs arrive
 * raw (`unknown`): FormData fields and JSON body values run through the exact
 * same checks.
 */
export async function createCodeForUser(
  userId: string,
  input: {
    module: unknown;
    file: unknown;
    /** Window start as a unix-seconds string, or blank/absent for "no start". */
    start: unknown;
    /** Window end as a unix-seconds string, or blank/absent for "no end". */
    end: unknown;
    note: unknown;
    llmProvider: unknown;
    llmModel: unknown;
    /** The override pair's optional reasoning level; blank/absent for none. */
    llmReasoning: unknown;
    /** The Moodle hand-in switch (quiz only); absent means off. */
    moodle?: unknown;
  },
): Promise<CreateCodeServiceResult> {
  const module = input.module;
  if (!isCodeModule(module)) {
    return { ok: false, reason: "invalid", message: "Pick which activity this code is for." };
  }

  const validation = validateCodeRequest({
    file: input.file,
    start: input.start,
    end: input.end,
    note: input.note,
    llmProvider: input.llmProvider,
    llmModel: input.llmModel,
    llmReasoning: input.llmReasoning,
    moodle: input.moodle,
    module,
  });
  if (!validation.ok) return { ok: false, reason: "invalid", message: validation.message };

  // An override naming a provider this server has not configured must fail NOW,
  // not when the first student opens the code — the same save-time gate the
  // Layer-2 validators run for the YAML's own provider.
  if (validation.payload.llm) {
    const unavailable = providerUnavailableReason(validation.payload.llm.provider);
    if (unavailable) return { ok: false, reason: "invalid", message: unavailable };
  }

  let origin: string;
  try {
    origin = await resolveAppOrigin();
  } catch {
    return {
      ok: false,
      reason: "unavailable",
      message:
        "Could not determine the app's public address. Set CODE_ORIGIN in the server configuration.",
    };
  }

  // Catch broken activities at create time, not when the first student opens the
  // code. The module reuses its Layer-2 validator — a strict structural gate for
  // every module (for tutor, the THOROUGH whole-library gate). The app-hosted
  // fetcher resolves app-hosted file URLs from the DB directly (no loopback).
  const result = await validateCodeFile(
    module,
    validation.payload.fileUrl,
    appHostedFetcher(origin),
  );
  if (!result.ok) return { ok: false, reason: "validation", errors: result.errors };

  // Freeze the activity's anonymity flag onto the row at create time. `result` is
  // the just-validated YAML's metadata; a later edit to it will not change the
  // stored value (documented behavior). The validator defaults it to true.
  const stored = await createCode(userId, {
    module,
    fileUrl: validation.payload.fileUrl,
    validFrom: validation.payload.validFrom,
    validUntil: validation.payload.validUntil,
    note: validation.payload.note,
    origin,
    anonymous: result.anonymous,
    llm: validation.payload.llm,
    moodle: validation.payload.moodle,
  });
  if (!stored.stored) {
    return {
      ok: false,
      reason: "unavailable",
      message: "The code could not be stored. Try again, or contact the operator.",
    };
  }

  // Read the row back so the result carries the authoritative entry (including
  // the DB-written createdAt) — the API returns it verbatim.
  const entry = await getCode(stored.code);
  if (!entry) {
    return {
      ok: false,
      reason: "unavailable",
      message: "The code was stored but could not be read back. Check the codes list.",
    };
  }

  return { ok: true, entry, shareUrl: `${origin}/${entry.code}` };
}
