"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { appHostedFetcher } from "@/lib/app-hosted-fetcher";
import { resolveAppOrigin } from "@/lib/app-origin";
import {
  createFileForUser,
  type FileServiceResult,
  updateFileForUser,
  validateFileContent,
} from "@/lib/file-service";
import {
  type FileKind,
  getActiveFile,
  isFileKind,
  softDeleteFiles,
  validateFileName,
} from "@/lib/file-store";
import {
  defaultFetcher,
  type Fetcher,
  type ValidationError,
  type ValidationWarning,
} from "@/lib/prompt-fragments";
import { requireTeacherUserId } from "@/lib/student-mode";

// Teacher-only server actions for app-hosted YAML files: thin auth + FormData
// shells around the shared validate-then-store pipeline in `lib/file-service.ts`
// (the bearer API route is the other caller). Each gates with the shared
// `requireTeacherUserId()` and revalidates the list; the service VALIDATES the
// YAML before persisting (an invalid file is rejected — saving and validity are
// coupled by design).
//
// A failure is either a plain `message` (auth, name, store) or the structured
// `errors` from the validator (so the UI can show the full, specific list —
// schema field paths, missing variables, fetch failures — not just a generic
// "failed validation").

export type FileActionFailure =
  | { ok: false; message: string }
  | { ok: false; errors: ValidationError[] };

// A successful save carries the validator's one-line content summary (cloze: the
// gap inventory; null for kinds without one) for the form to show beside "Saved".
export type SaveFileResult = { ok: true; summary: string | null } | FileActionFailure;

// Result of a validate-only action (the standalone "Validate" button): a pass
// carries the non-blocking warnings and the content summary to surface; a failure
// reuses the same shape as a rejected save (a short message or the full structured
// error list).
export type ValidateFileResult =
  | { ok: true; warnings: ValidationWarning[]; summary: string | null }
  | FileActionFailure;

// The shared teacher-gate refusal for these file actions — only the verb
// (create/edit/delete) differs between the call sites.
function gateFailure(verb: string): { ok: false; message: string } {
  return { ok: false, message: `Only teachers can ${verb} files.` };
}

// Collapses the service's failure discriminants to the two shapes the forms
// render: the structured validator errors, or a plain message.
function toActionFailure(result: Exclude<FileServiceResult, { ok: true }>): FileActionFailure {
  return result.reason === "validation"
    ? { ok: false, errors: result.errors }
    : { ok: false, message: result.message };
}

/**
 * Creates a new hosted file (version 1) via `createFileForUser`; on success
 * redirects to its edit page. Called directly (not as a form action) so the
 * create form keeps its entered fields on failure.
 */
export async function createFileAction(input: {
  name: string;
  kind: string;
  content: string;
}): Promise<FileActionFailure> {
  const gate = await requireTeacherUserId();
  if (!gate.ok) return gateFailure("create");

  const result = await createFileForUser(gate.userId, input);
  if (!result.ok) return toActionFailure(result);

  // The service accepted the name, so the (normalizing) re-validation holds.
  const nameValidation = validateFileName(input.name);
  const name = nameValidation.ok ? nameValidation.name : input.name;
  revalidatePath("/files");
  redirect(`/files/edit/${name}`);
}

/**
 * Saves a new version of an existing file via `updateFileForUser` (which
 * re-validates against the file's stored kind and blocks the save if invalid).
 * Called from the edit form's Save button.
 */
export async function updateFileAction(name: string, content: string): Promise<SaveFileResult> {
  const gate = await requireTeacherUserId();
  if (!gate.ok) return gateFailure("edit");

  const result = await updateFileForUser(gate.userId, name, content);
  if (!result.ok) return toActionFailure(result);

  revalidatePath("/files");
  revalidatePath(`/files/edit/${name}`);
  return { ok: true, summary: result.summary };
}

/**
 * Validates a would-be NEW file WITHOUT storing it — backs the create form's
 * standalone "Validate" button so a teacher can check the YAML without writing a
 * throwaway version. Runs the same preamble as `createFileAction` up to (and
 * including) the YAML validation, but never touches the store. Name uniqueness is
 * NOT checked here — that is enforced only at create time (as before).
 */
export async function validateNewFileAction(input: {
  name: string;
  kind: string;
  content: string;
}): Promise<ValidateFileResult> {
  const gate = await requireTeacherUserId();
  if (!gate.ok) return gateFailure("validate");

  const nameValidation = validateFileName(input.name);
  if (!nameValidation.ok) return { ok: false, message: nameValidation.message };
  const name = nameValidation.name;

  if (!isFileKind(input.kind)) {
    return {
      ok: false,
      message: "Choose whether this is a tutor, fragment, quiz, writing, coding or cloze file.",
    };
  }
  if (typeof input.content !== "string" || input.content.trim() === "") {
    return { ok: false, message: "The file is empty — add some YAML before validating." };
  }

  const validation = await validateFileContent(name, input.kind, input.content);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, warnings: validation.warnings, summary: validation.summary };
}

/**
 * Validates a new version of an EXISTING file WITHOUT storing it — backs the edit
 * form's standalone "Validate" button. Mirrors `updateFileAction`'s preamble (the
 * kind is read from the active row, never trusted from the client) but never writes.
 */
export async function validateExistingFileAction(
  name: string,
  content: string,
): Promise<ValidateFileResult> {
  const gate = await requireTeacherUserId();
  if (!gate.ok) return gateFailure("validate");

  if (typeof content !== "string" || content.trim() === "") {
    return { ok: false, message: "The file is empty — add some YAML before validating." };
  }

  const active = await getActiveFile(name);
  if (active === undefined) {
    return { ok: false, message: "The file could not be checked right now — try again." };
  }
  if (active === null || !isFileKind(active.kind)) {
    return { ok: false, message: "This file no longer exists. Reload the list." };
  }

  const validation = await validateFileContent(name, active.kind, content);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, warnings: validation.warnings, summary: validation.summary };
}

/** The uniform shape every list's "Delete Selected" action returns. */
export type DeleteSelectedResult = { ok: true; deleted: number } | { ok: false; message: string };

/**
 * Bulk soft-delete behind the files list's "Delete Selected" button — the only way
 * to delete a file. Teacher-only; soft-deletes every selected file in one
 * transaction (`softDeleteFiles`). Revalidates the list on success.
 */
export async function deleteSelectedFilesAction(names: string[]): Promise<DeleteSelectedResult> {
  const gate = await requireTeacherUserId();
  if (!gate.ok) return gateFailure("delete");
  const userId = gate.userId;

  const result = await softDeleteFiles(names, userId);
  if (!result.ok) {
    return { ok: false, message: "The files could not be deleted. Try again." };
  }

  revalidatePath("/files");
  return { ok: true, deleted: result.deleted };
}

/**
 * Loads raw YAML by URL for the student GUI, so it can pull in a tutor's
 * referenced fragment files and read their parameters (`input_schema`). Resolves
 * all three URL shapes a `fragment_files[].url` can take:
 *   - absolute http(s) — fetched for real;
 *   - relative (e.g. `simple-fragments.yaml`) — resolved against `baseUrl`, the
 *     tutor's own URL, via `new URL(url, baseUrl)`;
 *   - app-hosted (`<origin>/api/files/<name>`) — served from the DB to avoid a
 *     self-loopback fetch (reusing {@link appHostedFetcher}).
 * Returns the raw text plus the resolved absolute URL.
 *
 * SSRF note: like the save-time validators this fetches an arbitrary
 * user-supplied URL server-side; for this prototype we only restrict the scheme
 * to http(s). A production deployment should additionally allow-list hosts /
 * block private IP ranges and disable redirects.
 */
export async function loadYamlFromUrlAction(input: {
  url: string;
  baseUrl?: string;
}): Promise<{ ok: true; content: string; resolvedUrl: string } | { ok: false; message: string }> {
  const gate = await requireTeacherUserId();
  if (!gate.ok) return gateFailure("load");

  let resolvedUrl: string;
  try {
    resolvedUrl = input.baseUrl ? new URL(input.url, input.baseUrl).toString() : input.url;
  } catch {
    return { ok: false, message: "That URL could not be resolved." };
  }
  if (!/^https?:\/\//i.test(resolvedUrl)) {
    return {
      ok: false,
      message: "Provide a public http(s) URL (or a path relative to the file).",
    };
  }

  // Resolve app-hosted references from the DB; a plain fetch still works for
  // absolute external URLs if the app origin can't be determined.
  let fetcher: Fetcher = defaultFetcher;
  try {
    fetcher = appHostedFetcher(await resolveAppOrigin());
  } catch {
    // origin unknown — keep the plain fetcher
  }

  try {
    const res = await fetcher(resolvedUrl);
    if (!res.ok)
      return { ok: false, message: `The file could not be loaded (HTTP ${res.status}).` };
    return { ok: true, content: await res.text(), resolvedUrl };
  } catch {
    return { ok: false, message: "The file could not be loaded. Check the URL and try again." };
  }
}

/**
 * Loads an app-hosted file's active content by name for the student GUI's edit
 * flow (the file being edited, or a known sibling). Thin wrapper over
 * {@link getActiveFile}.
 */
export async function loadFileFromDbAction(
  name: string,
): Promise<
  | { ok: true; name: string; kind: FileKind; content: string }
  | { ok: false; reason: "not-found" | "error" }
> {
  const gate = await requireTeacherUserId();
  if (!gate.ok) return { ok: false, reason: "error" };

  const file = await getActiveFile(name);
  if (file === undefined) return { ok: false, reason: "error" };
  if (file === null || !isFileKind(file.kind)) return { ok: false, reason: "not-found" };
  return { ok: true, name: file.name, kind: file.kind, content: file.content };
}
