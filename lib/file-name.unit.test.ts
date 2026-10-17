import { describe, expect, it } from "vitest";
import {
  extensionForImageMime,
  FILE_KINDS,
  FILE_NAME_PATTERN,
  imageMimeFromExtension,
  isFileKind,
  isImageMime,
  validateFileName,
} from "@/lib/file-name";

// The pure name/kind helpers are shared by the file store, the API routes and the
// image store, so pin their behavior.

describe("validateFileName", () => {
  it("accepts letters, digits, underscore and hyphen (trimming surrounding space)", () => {
    expect(validateFileName("  my-file_1  ")).toEqual({ ok: true, name: "my-file_1" });
  });

  it("rejects spaces, punctuation, emptiness and non-strings", () => {
    for (const bad of ["bad name", "with.dot", "slash/name", "", "   ", 42, null, undefined]) {
      expect(validateFileName(bad as unknown)).toMatchObject({ ok: false });
    }
  });

  it("rejects names longer than 100 characters", () => {
    expect(validateFileName("a".repeat(101))).toMatchObject({ ok: false });
    expect(validateFileName("a".repeat(100))).toEqual({ ok: true, name: "a".repeat(100) });
  });

  it("matches FILE_NAME_PATTERN", () => {
    expect(FILE_NAME_PATTERN.test("ok_name-1")).toBe(true);
    expect(FILE_NAME_PATTERN.test("not ok")).toBe(false);
  });
});

describe("isFileKind", () => {
  it("is true exactly for the listed kinds", () => {
    expect(FILE_KINDS).toEqual(["tutor", "fragment", "quiz", "writing", "coding"]);
    for (const kind of FILE_KINDS) expect(isFileKind(kind)).toBe(true);
    expect(isFileKind("other")).toBe(false);
    expect(isFileKind("Tutor")).toBe(false);
    expect(isFileKind(undefined)).toBe(false);
    expect(isFileKind(["tutor"])).toBe(false);
  });
});

// The image MIME helpers gate what the upload flow accepts and how the server
// picks a blob extension, so pin their branches (they are otherwise only
// exercised by the CI-excluded @live-storage e2e).
describe("isImageMime", () => {
  it("accepts exactly png, jpeg and svg+xml", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("image/jpeg")).toBe(true);
    expect(isImageMime("image/svg+xml")).toBe(true);
  });

  it("rejects other types, casing and non-strings", () => {
    for (const bad of [
      "image/gif",
      "image/jpg",
      "IMAGE/PNG",
      "text/plain",
      "",
      1,
      null,
      undefined,
    ]) {
      expect(isImageMime(bad as unknown)).toBe(false);
    }
  });
});

describe("imageMimeFromExtension", () => {
  it("maps a bare extension to its MIME, case-insensitively", () => {
    expect(imageMimeFromExtension("png")).toBe("image/png");
    expect(imageMimeFromExtension("PNG")).toBe("image/png");
    expect(imageMimeFromExtension("svg")).toBe("image/svg+xml");
  });

  it("maps jpg and jpeg both to image/jpeg", () => {
    expect(imageMimeFromExtension("jpg")).toBe("image/jpeg");
    expect(imageMimeFromExtension("jpeg")).toBe("image/jpeg");
  });

  it("reads the extension from a filename (last dot wins, any case)", () => {
    expect(imageMimeFromExtension("diagram.PNG")).toBe("image/png");
    expect(imageMimeFromExtension("my.photo.jpeg")).toBe("image/jpeg");
    expect(imageMimeFromExtension(".svg")).toBe("image/svg+xml");
  });

  it("returns null for unknown or missing extensions", () => {
    expect(imageMimeFromExtension("gif")).toBeNull();
    expect(imageMimeFromExtension("noextension")).toBeNull();
    expect(imageMimeFromExtension("archive.tar.gz")).toBeNull();
    expect(imageMimeFromExtension("")).toBeNull();
  });
});

describe("extensionForImageMime", () => {
  it("returns the canonical dotless extension (jpeg -> jpg) and round-trips", () => {
    expect(extensionForImageMime("image/png")).toBe("png");
    expect(extensionForImageMime("image/jpeg")).toBe("jpg");
    expect(extensionForImageMime("image/svg+xml")).toBe("svg");
    expect(imageMimeFromExtension(extensionForImageMime("image/png"))).toBe("image/png");
    expect(imageMimeFromExtension(extensionForImageMime("image/svg+xml"))).toBe("image/svg+xml");
  });
});
