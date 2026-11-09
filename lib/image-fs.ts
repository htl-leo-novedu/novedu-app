import { randomBytes } from "node:crypto";
import { createReadStream, constants as FS_CONSTANTS } from "node:fs";
import { access, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

// The ONE place this app touches the filesystem that holds app-hosted image
// bytes. Everything else (the service, the store, the routes) speaks in opaque
// object KEYS — the `blob_path` value of a `novedu_images` row — and never sees
// a path.
//
// The root is `IMAGE_STORAGE_ROOT`, read INSIDE `verifyImageRoot()` on every
// call, never at module scope: nothing evaluates the root at import time, in
// `next build`, or in the Docker builder stage. The layout under it is
//
//     <root>/.novedu-files-root      the operator-provisioned sentinel
//     <root>/images/<key>/content    one object per image version
//
// The adapter NEVER creates the root, `images/`, or the sentinel, and there is
// no fallback directory: writing into the container when the mounted share is
// away would lose data the moment it comes back. A missing/wrong/unwritable
// root makes every operation return `unavailable`; the rest of the app keeps
// running (docs/images.md).
//
// Publishing an object is exclusive `mkdir` (the no-overwrite reservation),
// a temporary sibling inside that directory, `sync()` + `close()`, then a
// same-directory `rename` to `content`. No file locks anywhere — the App
// Service SMB mount advises against them. Symlinks are never followed: an
// object directory or `content` that is a link is an error, not data.
//
// SERVER-ONLY: uses node:fs. Never import from client components, and never
// from a CLI-bundled module (the `lib/prompt-dump.unit.test.ts` closure guard).

/** The operator-provisioned marker that proves a root is the intended storage root. */
export const SENTINEL_FILE = ".novedu-files-root";
/** Its exact content: the UTF-8 marker plus ONE trailing LF — 16 bytes, nothing else. */
export const SENTINEL_CONTENT = "novedu-files-v1\n";
/** Object keys are server-generated: a lowercase UUID plus the MIME's extension. */
export const OBJECT_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|svg)$/;

/** The object directory holding one image version, and the published file in it. */
const OBJECTS_DIR = "images";
// Every path this module builds or opens lies under the operator-provisioned
// IMAGE_STORAGE_ROOT and is never a build input, so each `path.*` / `fs` call
// carries `/*turbopackIgnore: true*/`. Without it, Next's file tracing reads them
// as references into the project — the whole project for a fully dynamic path, every
// `…images` directory for `path.resolve(root, "images")` — and copies that source
// into the standalone output, and so into every image.
const CONTENT_FILE = "content";

const SENTINEL_BYTES = Buffer.from(SENTINEL_CONTENT, "utf8");

export type RootCheckFailureReason =
  | "unset"
  | "missing"
  | "not-directory"
  | "no-sentinel"
  | "bad-sentinel"
  | "not-writable"
  | "error";

export type RootCheck =
  | { ok: true; root: string }
  | { ok: false; reason: RootCheckFailureReason; root: string | null; detail: string };

/** Storage itself is away (`unavailable`) or misbehaved (`error`) — never a caller mistake. */
export type StorageFailure = { ok: false; reason: "unavailable" | "error"; detail: string };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? ((error as { code?: unknown }).code as string | undefined)
    : undefined;
}

function isEnoent(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Verifies the configured root before every operation: set, present, a
 * directory, carrying the exact sentinel bytes, with a readable AND writable
 * `images/` subdirectory. Never creates anything, never throws. `detail` always
 * names the root path — the health probe and the e2e mismatch check read it.
 */
export async function verifyImageRoot(): Promise<RootCheck> {
  const configured = process.env.IMAGE_STORAGE_ROOT;
  const root = typeof configured === "string" ? configured.trim() : "";
  if (root === "") {
    return { ok: false, reason: "unset", root: null, detail: "IMAGE_STORAGE_ROOT is not set." };
  }

  try {
    let rootStat: Awaited<ReturnType<typeof stat>>;
    try {
      rootStat = await stat(/*turbopackIgnore: true*/ root);
    } catch (error) {
      if (isEnoent(error)) {
        return { ok: false, reason: "missing", root, detail: `${root} does not exist.` };
      }
      throw error;
    }
    if (!rootStat.isDirectory()) {
      return { ok: false, reason: "not-directory", root, detail: `${root} is not a directory.` };
    }

    const sentinelPath = path.join(/*turbopackIgnore: true*/ root, SENTINEL_FILE);
    let sentinelStat: Awaited<ReturnType<typeof stat>>;
    try {
      sentinelStat = await stat(/*turbopackIgnore: true*/ sentinelPath);
    } catch (error) {
      if (isEnoent(error)) {
        return {
          ok: false,
          reason: "no-sentinel",
          root,
          detail: `${root} carries no ${SENTINEL_FILE} marker file.`,
        };
      }
      throw error;
    }
    if (!sentinelStat.isFile()) {
      return {
        ok: false,
        reason: "no-sentinel",
        root,
        detail: `${root}: ${SENTINEL_FILE} is not a regular file.`,
      };
    }
    // Size first, so a huge file is never read into memory to be rejected.
    if (sentinelStat.size !== SENTINEL_BYTES.byteLength) {
      return {
        ok: false,
        reason: "bad-sentinel",
        root,
        detail: `${root}: ${SENTINEL_FILE} does not carry the expected marker bytes.`,
      };
    }
    const sentinel = await readFile(/*turbopackIgnore: true*/ sentinelPath);
    if (!sentinel.equals(SENTINEL_BYTES)) {
      return {
        ok: false,
        reason: "bad-sentinel",
        root,
        detail: `${root}: ${SENTINEL_FILE} does not carry the expected marker bytes.`,
      };
    }

    try {
      await access(
        path.join(/*turbopackIgnore: true*/ root, OBJECTS_DIR),
        FS_CONSTANTS.R_OK | FS_CONSTANTS.W_OK,
      );
    } catch (error) {
      return {
        ok: false,
        reason: "not-writable",
        root,
        detail: `${root}/${OBJECTS_DIR} is not readable and writable (${message(error)}).`,
      };
    }

    return { ok: true, root };
  } catch (error) {
    return { ok: false, reason: "error", root, detail: `${root}: ${message(error)}` };
  }
}

type ResolvedKey = { ok: true; objectDir: string; contentPath: string } | { ok: false };

/**
 * Maps an object key to its directory beneath `<root>/images`, rejecting
 * anything that is not a server-generated key. Client-supplied names never
 * reach here; this is the belt-and-braces containment check.
 */
function resolveObjectDir(root: string, key: unknown): ResolvedKey {
  if (typeof key !== "string" || key === "") return { ok: false };
  if (key.includes("\0") || key.includes("/") || key.includes("\\")) return { ok: false };
  if (key === "." || key === ".." || key.includes("..")) return { ok: false };
  if (path.isAbsolute(key)) return { ok: false };
  if (!OBJECT_KEY_PATTERN.test(key)) return { ok: false };

  const objectsDir = path.resolve(/*turbopackIgnore: true*/ root, OBJECTS_DIR);
  const objectDir = path.resolve(/*turbopackIgnore: true*/ objectsDir, key);
  if (!objectDir.startsWith(objectsDir + path.sep)) return { ok: false };
  return {
    ok: true,
    objectDir,
    contentPath: path.join(/*turbopackIgnore: true*/ objectDir, CONTENT_FILE),
  };
}

function unavailable(check: RootCheck & { ok: false }): StorageFailure {
  return { ok: false, reason: "unavailable", detail: check.detail };
}

/** Removes a half-written object directory. Failure is logged, never surfaced. */
async function discardObjectDir(objectDir: string): Promise<void> {
  try {
    await rm(/*turbopackIgnore: true*/ objectDir, { recursive: true, force: true });
  } catch (error) {
    console.error("image-fs: discarding a half-written object failed", objectDir, error);
  }
}

export type WriteObjectResult =
  | { ok: true; byteLength: number }
  | {
      ok: false;
      reason: "invalid-key" | "exists" | "empty" | "too-large" | "source";
      detail: string;
    }
  | StorageFailure;

/**
 * Publishes ONE new object under `key`, streaming at most `maxBytes` — never
 * overwrites: the object directory is reserved with an exclusive `mkdir`, so a
 * key already in use answers `exists` and the existing object is untouched. The
 * bytes land in a temporary sibling that is synced, closed and only then
 * renamed to `content`; every failure path removes the whole directory, so a
 * reader never sees a partial object.
 */
export async function writeNewObject(
  key: string,
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<WriteObjectResult> {
  const check = await verifyImageRoot();
  if (!check.ok) return unavailable(check);

  const resolved = resolveObjectDir(check.root, key);
  if (!resolved.ok) return { ok: false, reason: "invalid-key", detail: "Malformed object key." };
  const { objectDir, contentPath } = resolved;

  try {
    // Non-recursive on purpose: EEXIST is the reservation failing, which is the
    // whole point — `mkdir(…, { recursive: true })` would silently succeed.
    await mkdir(/*turbopackIgnore: true*/ objectDir);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      // A LINK where the object directory belongs is never data we may write
      // through — refuse it as a storage error rather than treating it as a
      // taken key.
      const linked = await lstat(/*turbopackIgnore: true*/ objectDir).catch(() => null);
      if (linked?.isSymbolicLink()) {
        return { ok: false, reason: "error", detail: "The object path is a symbolic link." };
      }
      return { ok: false, reason: "exists", detail: "The object key is already in use." };
    }
    return { ok: false, reason: "error", detail: message(error) };
  }

  const tempPath = path.join(
    /*turbopackIgnore: true*/ objectDir,
    `.tmp-${randomBytes(6).toString("hex")}`,
  );
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(/*turbopackIgnore: true*/ tempPath, "wx");
  } catch (error) {
    await discardObjectDir(objectDir);
    return { ok: false, reason: "error", detail: message(error) };
  }

  const closeQuietly = async () => {
    try {
      await handle.close();
    } catch {
      // The directory is about to go; a failing close changes nothing.
    }
  };

  const reader = source.getReader();
  // Every abandoned attempt takes the whole reservation with it, so a reader can
  // never meet a partial object and the key stays free for a retry.
  const abandon = async () => {
    await reader.cancel().catch(() => {});
    await closeQuietly();
    await discardObjectDir(objectDir);
  };

  let byteLength = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      // A failing SOURCE is the caller's problem (a browser upload cut short),
      // reported apart from a failing filesystem below.
      await abandon();
      return { ok: false, reason: "source", detail: message(error) };
    }
    if (chunk.done) break;

    byteLength += chunk.value.byteLength;
    if (byteLength > maxBytes) {
      await abandon();
      return { ok: false, reason: "too-large", detail: `More than ${maxBytes} bytes.` };
    }
    try {
      await handle.write(chunk.value);
    } catch (error) {
      await abandon();
      return { ok: false, reason: "error", detail: message(error) };
    }
  }

  if (byteLength === 0) {
    await closeQuietly();
    await discardObjectDir(objectDir);
    return { ok: false, reason: "empty", detail: "The source produced no bytes." };
  }

  try {
    await handle.sync();
    await handle.close();
    // The directory was just reserved, so nothing may sit at `content` yet —
    // anything there (a link above all) means the publish must not proceed.
    const existing = await lstat(/*turbopackIgnore: true*/ contentPath).catch((error) =>
      isEnoent(error) ? null : Promise.reject(error),
    );
    if (existing) throw new Error("An object already occupies the content path.");
    await rename(/*turbopackIgnore: true*/ tempPath, contentPath);
  } catch (error) {
    await closeQuietly();
    await discardObjectDir(objectDir);
    return { ok: false, reason: "error", detail: message(error) };
  }

  return { ok: true, byteLength };
}

export type InspectObjectResult =
  | { ok: true; exists: true; byteLength: number }
  | { ok: true; exists: false }
  | StorageFailure;

/**
 * Existence and byte length of one object. Absence is DATA (`exists: false`);
 * an unreadable or link-shaped object is an `error`, never absence — a
 * reconciliation tool must be able to tell the two apart.
 */
export async function inspectObject(key: string): Promise<InspectObjectResult> {
  const check = await verifyImageRoot();
  if (!check.ok) return unavailable(check);

  const resolved = resolveObjectDir(check.root, key);
  if (!resolved.ok) return { ok: false, reason: "error", detail: "Malformed object key." };

  try {
    const info = await lstat(/*turbopackIgnore: true*/ resolved.contentPath);
    if (info.isSymbolicLink()) {
      return { ok: false, reason: "error", detail: "The object content is a symbolic link." };
    }
    if (!info.isFile()) {
      return { ok: false, reason: "error", detail: "The object content is not a regular file." };
    }
    return { ok: true, exists: true, byteLength: info.size };
  } catch (error) {
    if (isEnoent(error)) return { ok: true, exists: false };
    return { ok: false, reason: "error", detail: message(error) };
  }
}

export type OpenObjectResult =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | { ok: true; missing: true }
  | StorageFailure;

/**
 * Opens one object for streaming. A row whose object is gone reads as `missing`
 * (a 404 for the caller); anything else is a failure.
 */
export async function openObject(key: string): Promise<OpenObjectResult> {
  const check = await verifyImageRoot();
  if (!check.ok) return unavailable(check);

  const resolved = resolveObjectDir(check.root, key);
  if (!resolved.ok) return { ok: false, reason: "error", detail: "Malformed object key." };

  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(/*turbopackIgnore: true*/ resolved.contentPath);
  } catch (error) {
    if (isEnoent(error)) return { ok: true, missing: true };
    return { ok: false, reason: "error", detail: message(error) };
  }
  if (info.isSymbolicLink()) {
    return { ok: false, reason: "error", detail: "The object content is a symbolic link." };
  }
  if (!info.isFile()) {
    return { ok: false, reason: "error", detail: "The object content is not a regular file." };
  }

  try {
    const stream = Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ resolved.contentPath));
    return { ok: true, stream: stream as ReadableStream<Uint8Array> };
  } catch (error) {
    return { ok: false, reason: "error", detail: message(error) };
  }
}

export type DeleteObjectResult = { ok: true; existed: boolean } | StorageFailure;

/**
 * Removes one object, directory and all. IDEMPOTENT: an object that is already
 * gone is `{ ok: true, existed: false }`, not an error — the store logs that as
 * a reconciliation note and keeps its own result.
 */
export async function deleteObject(key: string): Promise<DeleteObjectResult> {
  const check = await verifyImageRoot();
  if (!check.ok) return unavailable(check);

  const resolved = resolveObjectDir(check.root, key);
  if (!resolved.ok) return { ok: false, reason: "error", detail: "Malformed object key." };

  let existed = true;
  try {
    await lstat(/*turbopackIgnore: true*/ resolved.objectDir);
  } catch (error) {
    if (!isEnoent(error)) return { ok: false, reason: "error", detail: message(error) };
    existed = false;
  }

  try {
    await rm(/*turbopackIgnore: true*/ resolved.objectDir, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, reason: "error", detail: message(error) };
  }
  return { ok: true, existed };
}
