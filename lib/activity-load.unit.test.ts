import { describe, expect, it, vi } from "vitest";
import { loadActivity, loadActivityFrom, resolveInstructions } from "@/lib/activity-load";
import { EMPTY_FRAGMENT_BLOCK, type Fetcher, type FragmentBlock } from "@/lib/prompt-fragments";
import { fixtureResponse, fragmentFetcher, LIB_A_URL } from "@/lib/prompt-fragments/test-fixtures";

// The shared fetch → parse → resolve load behind every lenient activity kind (quiz,
// writing, coding — app side via `loadAppHostedYaml`, CLI side via `load<Kind>From`).
// Each kind's own tests cover only its parser/resolver wiring; the load skeleton and its
// messages are covered here once.

type Parsed = { ok: true; text: string } | { ok: false; message: string };

const URL_ = "https://app.test/api/files/activity";

const parse = (content: string): Parsed =>
  content === "BAD" ? { ok: false, message: "parse failed" } : { ok: true, text: content };

const passThrough = async (parsed: { ok: true; text: string }) => parsed;

function fetcherFor(body: string, init: { ok?: boolean; status?: number } = {}): Fetcher {
  return async () => fixtureResponse(body, init);
}

describe("loadActivity", () => {
  it("parses and resolves a fetched activity", async () => {
    const resolve = vi.fn(async (parsed: { ok: true; text: string }) => ({
      ok: true as const,
      text: `${parsed.text}+resolved`,
    }));
    const fetcher = fetcherFor("BODY");
    const result = await loadActivity(URL_, fetcher, "gizmo", parse, resolve);
    expect(result).toEqual({ ok: true, text: "BODY+resolved" });
    // The resolver gets the activity URL (base for relative refs) and the same fetcher.
    expect(resolve).toHaveBeenCalledWith({ ok: true, text: "BODY" }, { url: URL_, fetcher });
  });

  it("names the kind in the not-found message on a 404", async () => {
    const result = await loadActivity(
      URL_,
      fetcherFor("", { ok: false, status: 404 }),
      "gizmo",
      parse,
      passThrough,
    );
    expect(result).toEqual({ ok: false, message: "This gizmo could not be found." });
  });

  it("names the HTTP status for any other failed response", async () => {
    const result = await loadActivity(
      URL_,
      fetcherFor("", { ok: false, status: 500 }),
      "gizmo",
      parse,
      passThrough,
    );
    expect(result).toEqual({ ok: false, message: "This gizmo could not be loaded (HTTP 500)." });
  });

  it("asks to try again when the fetch throws", async () => {
    const fetcher: Fetcher = async () => {
      throw new Error("network down");
    };
    const result = await loadActivity(URL_, fetcher, "gizmo", parse, passThrough);
    expect(result).toEqual({ ok: false, message: "This gizmo could not be loaded. Try again." });
  });

  it("returns the parser's message and never resolves an unparseable activity", async () => {
    const resolve = vi.fn(passThrough);
    const result = await loadActivity(URL_, fetcherFor("BAD"), "gizmo", parse, resolve);
    expect(result).toEqual({ ok: false, message: "parse failed" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("asks to try again when the resolver throws", async () => {
    const result = await loadActivity(URL_, fetcherFor("BODY"), "gizmo", parse, async () => {
      throw new Error("resolver bug");
    });
    expect(result).toEqual({ ok: false, message: "This gizmo could not be loaded. Try again." });
  });

  it("returns the resolver's failure as is", async () => {
    const result = await loadActivity(URL_, fetcherFor("BODY"), "gizmo", parse, async () => ({
      ok: false as const,
      message: "resolve failed",
    }));
    expect(result).toEqual({ ok: false, message: "resolve failed" });
  });
});

describe("loadActivityFrom", () => {
  it("refuses a URL whose scheme is not allowed, before any fetch", async () => {
    const fetcher = vi.fn(fetcherFor("BODY"));
    const result = await loadActivityFrom(
      "file:///tmp/a.yaml",
      fetcher,
      "gizmo",
      parse,
      passThrough,
    );
    expect(result).toEqual({
      ok: false,
      message: "This gizmo's URL is not allowed: file:///tmp/a.yaml",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads a URL whose scheme the caller allows (the CLI's file:)", async () => {
    const result = await loadActivityFrom(
      "file:///tmp/a.yaml",
      fetcherFor("BODY"),
      "gizmo",
      parse,
      passThrough,
      ["file:"],
    );
    expect(result).toEqual({ ok: true, text: "BODY" });
  });
});

describe("resolveInstructions", () => {
  const block = (urls: string[]): FragmentBlock => ({
    fragment_files: urls.map((url) => ({ id: "lib_a", url })),
    text_files: [],
  });

  it("renders the inline fragments into instructions and clears the block", async () => {
    const result = await resolveInstructions(
      {
        fragmentBlock: block([LIB_A_URL]),
        instructions: `{{fragment "lib_a.safety_frag"}}\n\nINSTRUCTIONS-MARKER`,
        extra: "kept",
      },
      URL_,
      fragmentFetcher(),
      "gizmo",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { instructions } = result.activity;
    expect(instructions.indexOf("LAST-MARKER")).toBeGreaterThanOrEqual(0);
    expect(instructions.indexOf("LAST-MARKER")).toBeLessThan(
      instructions.indexOf("INSTRUCTIONS-MARKER"),
    );
    expect(result.activity.fragmentBlock).toEqual(EMPTY_FRAGMENT_BLOCK);
    // Every other field of the kind's activity passes through.
    expect(result.activity.extra).toBe("kept");
  });

  it("leaves instructions byte-identical when no fragment block is declared", async () => {
    const result = await resolveInstructions(
      { fragmentBlock: EMPTY_FRAGMENT_BLOCK, instructions: "INSTRUCTIONS-MARKER only." },
      URL_,
      fragmentFetcher(),
      "gizmo",
    );
    expect(result).toEqual({
      ok: true,
      activity: { fragmentBlock: EMPTY_FRAGMENT_BLOCK, instructions: "INSTRUCTIONS-MARKER only." },
    });
  });

  it("fails closed, naming the kind, when a fragment library cannot be fetched", async () => {
    const missing = "https://fixtures.test/tutors/missing.yaml";
    const result = await resolveInstructions(
      { fragmentBlock: block([missing]), instructions: `{{fragment "lib_a.safety_frag"}}` },
      URL_,
      fragmentFetcher(new Map([[missing, fixtureResponse("", { ok: false, status: 404 })]])),
      "gizmo",
    );
    expect(result).toEqual({
      ok: false,
      message: "This gizmo's prompt fragments could not be loaded.",
    });
  });
});
