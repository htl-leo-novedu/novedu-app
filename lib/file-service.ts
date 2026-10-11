import { appHostedFetcher } from "@/lib/app-hosted-fetcher";
import { resolveAppOrigin } from "@/lib/app-origin";
import {
  createFile,
  type FileKind,
  getActiveFile,
  isFileKind,
  updateFile,
  validateFileName,
} from "@/lib/file-store";
import { filePublicUrl, filesUrlPrefix } from "@/lib/file-url";
import { fileValidators } from "@/lib/file-validators";
import type { Fetcher, ValidationError, ValidationWarning } from "@/lib/prompt-fragments";

// The transport-agnostic validate-then-store pipeline for app-hosted YAML
// files, shared by the web editor's server actions (lib/files-actions.ts,
// cookie session) and the bearer API route (PUT /api/files/<name>,
// docs/api.md). Auth NEVER enters this module — each channel gates itself and
// passes the verified user id in. An invalid file is rejected — saving and
// validity are coupled by design. The `reason` discriminant lets the channels
// map failures differently (form message vs. HTTP 400/409/503).
//
// SERVER-ONLY: uses the database and env configuration. Never import from
// client components.

export type FileServiceResult =
  // `summary` is the validator's one-line content summary (cloze: the gap
  // inventory), null for kinds without one.
  | { ok: true; summary: string | null }
  // The request itself is unacceptable (bad name, unknown kind, empty content,
  // vanished file).
  | { ok: false; reason: "invalid"; message: string }
  // The YAML failed its kind's validator — the full structured error list.
  | { ok: false; reason: "validation"; errors: ValidationError[] }
  // The name is already taken by another active file (create race).
  | { ok: false; reason: "conflict"; message: string }
  // Storage/lookup infrastructure failed — retrying later may work.
  | { ok: false; reason: "unavailable"; message: string };

/** Upsert result: like {@link FileServiceResult} but says what happened, plus kind-mismatch. */
export type UpsertFileServiceResult =
  | { ok: true; action: "created" | "updated"; name: string; kind: FileKind }
  | { ok: false; reason: "kind-mismatch"; message: string }
  | Exclude<FileServiceResult, { ok: true }>;

type ContentValidation =
  | {
      ok: true;
      title: string | null;
      description: string | null;
      summary: string | null;
      warnings: ValidationWarning[];
    }
  | { ok: false; errors: ValidationError[] };

/**
 * Validates a YAML buffer with the SAME core the chat uses, BEFORE anything is
 * stored. The validator is URL-based with an injectable fetcher; we intercept
 * references to app-hosted files (`<origin>/api/files/<name>`) and resolve them
 * WITHOUT a network round-trip:
 *   - the file being saved resolves to its unsaved buffer, and
 *   - a sibling hosted file (`./other` → `<origin>/api/files/other`) resolves
 *     from the database directly — no loopback fetch to our own public origin
 *     (which a container may not even be able to reach), and no fragility around
 *     an exact self-URL string match.
 * Everything else (e.g. a fragment hosted on GitHub) is fetched for real.
 * On success it returns the tutor's title/description (null for fragments) for the
 * denormalized search columns and the validator's one-line content summary (cloze:
 * the gap inventory); on failure, the full structured error list.
 */
export async function validateFileContent(
  name: string,
  kind: FileKind,
  content: string,
): Promise<ContentValidation> {
  let origin: string;
  try {
    origin = await resolveAppOrigin();
  } catch {
    return {
      ok: false,
      errors: [
        {
          code: "INVALID_URL",
          message:
            "Could not determine the app's public address. Set CODE_ORIGIN in the server configuration.",
        },
      ],
    };
  }

  const selfUrl = filePublicUrl(origin, name);
  const prefix = filesUrlPrefix(origin);
  const hostedFetcher = appHostedFetcher(origin);
  const selfFetcher: Fetcher = async (url) => {
    // The file being saved resolves to its UNSAVED buffer; siblings and external
    // fragments go through the shared hosted fetcher (DB for app-hosted, real
    // fetch otherwise).
    if (url.startsWith(prefix)) {
      const refName = decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0] ?? "");
      if (refName === name) return { ok: true, status: 200, text: async () => content };
    }
    return hostedFetcher(url);
  };

  // Layer 2: the validator keyed by FileKind is the single source of truth for
  // both /files save and code-create (see lib/file-validators.ts). It surfaces
  // the title/description for the denormalized search columns; the `anonymous`
  // flag it also carries is unused here (only code-create freezes it).
  const result = await fileValidators[kind].validate(selfUrl, selfFetcher);
  if (!result.ok) return { ok: false, errors: result.errors };
  return {
    ok: true,
    title: result.title,
    description: result.description,
    summary: result.summary,
    warnings: result.warnings,
  };
}

/**
 * Creates a new hosted file (version 1) on behalf of `userId`. Validates the
 * name, the chosen kind, and the YAML; on success stores it.
 */
export async function createFileForUser(
  userId: string,
  input: { name: string; kind: string; content: string },
): Promise<FileServiceResult> {
  const nameValidation = validateFileName(input.name);
  if (!nameValidation.ok) return { ok: false, reason: "invalid", message: nameValidation.message };
  const name = nameValidation.name;

  if (!isFileKind(input.kind)) {
    return {
      ok: false,
      reason: "invalid",
      message: "Choose whether this is a tutor, fragment, quiz, writing, coding or cloze file.",
    };
  }
  if (typeof input.content !== "string" || input.content.trim() === "") {
    return {
      ok: false,
      reason: "invalid",
      message: "The file is empty — add some YAML before creating it.",
    };
  }

  const validation = await validateFileContent(name, input.kind, input.content);
  if (!validation.ok) return { ok: false, reason: "validation", errors: validation.errors };

  const stored = await createFile(
    {
      name,
      kind: input.kind,
      content: input.content,
      title: validation.title,
      description: validation.description,
    },
    userId,
  );
  if (!stored.ok) {
    return stored.reason === "name-taken"
      ? {
          ok: false,
          reason: "conflict",
          message: "A file with that name already exists. Choose another name.",
        }
      : {
          ok: false,
          reason: "unavailable",
          message: "The file could not be stored. Try again, or contact the operator.",
        };
  }

  return { ok: true, summary: validation.summary };
}

/**
 * Saves a new version of an existing file on behalf of `userId`. Re-validates
 * against the file's STORED kind and blocks the save if invalid.
 */
export async function updateFileForUser(
  userId: string,
  name: string,
  content: string,
): Promise<FileServiceResult> {
  if (typeof content !== "string" || content.trim() === "") {
    return {
      ok: false,
      reason: "invalid",
      message: "The file is empty — add some YAML before saving.",
    };
  }

  const active = await getActiveFile(name);
  if (active === undefined) {
    return {
      ok: false,
      reason: "unavailable",
      message: "The file could not be checked right now — try again.",
    };
  }
  if (active === null || !isFileKind(active.kind)) {
    return {
      ok: false,
      reason: "invalid",
      message: "This file no longer exists. Reload the list.",
    };
  }

  const validation = await validateFileContent(name, active.kind, content);
  if (!validation.ok) return { ok: false, reason: "validation", errors: validation.errors };

  const result = await updateFile(
    name,
    { content, title: validation.title, description: validation.description },
    userId,
  );
  if (!result.ok) {
    return result.reason === "not-found"
      ? {
          ok: false,
          reason: "invalid",
          message: "The file changed or was removed by someone else. Reload and try again.",
        }
      : { ok: false, reason: "unavailable", message: "The file could not be saved. Try again." };
  }

  return { ok: true, summary: validation.summary };
}

/**
 * Create-or-update by name — the CLI/API composition (`PUT /api/files/<name>`).
 * Dispatches on whether an active file with the name exists:
 *   - ABSENT → create; `kind` is then required (a missing one fails, naming the
 *     six kinds).
 *   - EXISTS → update, validating against the STORED kind; a supplied `kind`
 *     that mismatches the stored one fails LOUDLY (an agent that thinks a file
 *     is a quiz while it is stored as a tutor must find out) — it is never
 *     silently ignored.
 * The web editor keeps its explicit create/update split; only the API uses this.
 */
export async function upsertFileForUser(
  userId: string,
  input: { name: string; kind?: string; content: string },
): Promise<UpsertFileServiceResult> {
  const nameValidation = validateFileName(input.name);
  if (!nameValidation.ok) return { ok: false, reason: "invalid", message: nameValidation.message };
  const name = nameValidation.name;

  const active = await getActiveFile(name);
  if (active === undefined) {
    return {
      ok: false,
      reason: "unavailable",
      message: "The file could not be checked right now — try again.",
    };
  }

  if (active === null) {
    if (input.kind === undefined) {
      return {
        ok: false,
        reason: "invalid",
        message: `No file named "${name}" exists yet — pass its kind (tutor, fragment, quiz, writing, coding or cloze) to create it.`,
      };
    }
    const created = await createFileForUser(userId, {
      name,
      kind: input.kind,
      content: input.content,
    });
    if (!created.ok) return created;
    // createFileForUser only accepts a real FileKind, so the narrow always holds.
    return isFileKind(input.kind)
      ? { ok: true, action: "created", name, kind: input.kind }
      : { ok: false, reason: "invalid", message: "Unknown file kind." };
  }

  if (!isFileKind(active.kind)) {
    return {
      ok: false,
      reason: "invalid",
      message: "This file no longer exists. Reload the list.",
    };
  }
  if (input.kind !== undefined && input.kind !== active.kind) {
    return {
      ok: false,
      reason: "kind-mismatch",
      message: `"${name}" is stored as a ${active.kind} file, not ${input.kind}. A file's kind is frozen at create time.`,
    };
  }

  const updated = await updateFileForUser(userId, name, input.content);
  if (!updated.ok) return updated;
  return { ok: true, action: "updated", name, kind: active.kind };
}
