"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createFileForUser,
  type FileServiceResult,
  updateFileForUser,
  validateFileContent,
} from "@/lib/file-service";
import { getActiveFile, isFileKind, softDeleteFiles, validateFileName } from "@/lib/file-store";
import type { ValidationError, ValidationWarning } from "@/lib/prompt-fragments";
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

export type SaveFileResult = { ok: true } | FileActionFailure;

// Result of a validate-only action (the standalone "Validate" button): a pass
// carries the non-blocking warnings to surface; a failure reuses the same shape
// as a rejected save (a short message or the full structured error list).
export type ValidateFileResult = { ok: true; warnings: ValidationWarning[] } | FileActionFailure;

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
  return { ok: true };
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
      message: "Choose whether this is a tutor, fragment, quiz, writing or coding file.",
    };
  }
  if (typeof input.content !== "string" || input.content.trim() === "") {
    return { ok: false, message: "The file is empty — add some YAML before validating." };
  }

  const validation = await validateFileContent(name, input.kind, input.content);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, warnings: validation.warnings };
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
  return { ok: true, warnings: validation.warnings };
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
