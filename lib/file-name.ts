// Pure name/kind helpers for app-hosted YAML files. Extracted from
// `lib/file-store.ts` so they can be shared by code that must NOT pull in the
// database (the store is server-only): the public GET route, the create action,
// the image store, and client components.
//
// PURE — no imports, no I/O. Safe to import from client components.

/** Allowed file-name shape: letters, digits, underscore, hyphen — no spaces, max 100. */
export const FILE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/** Every kind of app-hosted YAML: the activity kinds plus the `fragment` library. */
export const FILE_KINDS = ["tutor", "fragment", "quiz", "writing", "coding"] as const;

export type FileKind = (typeof FILE_KINDS)[number];

export function isFileKind(value: unknown): value is FileKind {
  return typeof value === "string" && (FILE_KINDS as readonly string[]).includes(value);
}

export type FileNameValidation = { ok: true; name: string } | { ok: false; message: string };

/**
 * Validates and normalizes a raw file-name input (trims surrounding whitespace,
 * then enforces {@link FILE_NAME_PATTERN}). Pure, so the GET route, the create
 * action, and the image store share exactly one definition of a legal name.
 */
export function validateFileName(name: unknown): FileNameValidation {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!FILE_NAME_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message:
        "The name may contain only letters, digits, underscores and hyphens (max 100 characters) — no spaces.",
    };
  }
  return { ok: true, name: trimmed };
}

/** Image content types the app accepts for hosted images. */
export type ImageMime = "image/png" | "image/jpeg" | "image/svg+xml";

export function isImageMime(value: unknown): value is ImageMime {
  return value === "image/png" || value === "image/jpeg" || value === "image/svg+xml";
}

/**
 * Maps a filename or bare extension (with or without a leading dot, any case)
 * to an {@link ImageMime}; returns `null` for anything unrecognized. `jpg`/`jpeg`
 * both map to `image/jpeg`, `svg` to `image/svg+xml`.
 */
export function imageMimeFromExtension(filename: string): ImageMime | null {
  const lastDot = filename.lastIndexOf(".");
  const ext = (lastDot >= 0 ? filename.slice(lastDot + 1) : filename).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

/** Canonical file extension (no dot) for an {@link ImageMime}; `image/jpeg` -> `jpg`. */
export function extensionForImageMime(mime: ImageMime): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/svg+xml":
      return "svg";
  }
}
