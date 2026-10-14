import { describe, expect, it } from "vitest";
import { resolveRelativeUrl } from "@/lib/relative-url";

// `resolveRelativeUrl` is the pure URL-resolution seam shared by image refs and
// the fragment loader: an absolute http(s) ref passes through untouched, anything
// else is resolved against the base (standard URL semantics — the base's
// filename is dropped and `./` / `../` segments apply). The fragment-loader's
// `resolveFragmentUrl` exercises the same behaviour and is covered in
// `lib/tutors/load.unit.test.ts`, so this file owns only the primitive itself.

const BASE = "https://example.com/dir/page.yaml";

describe("resolveRelativeUrl", () => {
  it("returns an absolute http URL as-is", () => {
    expect(resolveRelativeUrl("http://other.example/x.png", BASE)).toBe(
      "http://other.example/x.png",
    );
  });

  it("returns an absolute https URL as-is", () => {
    expect(resolveRelativeUrl("https://other.example/x.png", BASE)).toBe(
      "https://other.example/x.png",
    );
  });

  it("treats the scheme test case-insensitively", () => {
    expect(resolveRelativeUrl("HTTPS://other.example/x.png", BASE)).toBe(
      "HTTPS://other.example/x.png",
    );
  });

  it("resolves a bare relative path against the base's directory", () => {
    expect(resolveRelativeUrl("pic.png", BASE)).toBe("https://example.com/dir/pic.png");
  });

  it("resolves a `./` relative path against the base's directory", () => {
    expect(resolveRelativeUrl("./pic.png", BASE)).toBe("https://example.com/dir/pic.png");
  });

  it("resolves a `../` relative path up a directory", () => {
    expect(resolveRelativeUrl("../assets/pic.png", BASE)).toBe(
      "https://example.com/assets/pic.png",
    );
  });

  it("resolves a root-absolute path against the base's origin", () => {
    expect(resolveRelativeUrl("/top.png", BASE)).toBe("https://example.com/top.png");
  });

  it("throws when a relative ref cannot be resolved (no usable base)", () => {
    expect(() => resolveRelativeUrl("pic.png", "not-a-url")).toThrow();
  });
});
