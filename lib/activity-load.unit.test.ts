import { describe, expect, it, vi } from "vitest";
import {
  asBool,
  asString,
  checkInstructions,
  loadActivity,
  loadActivityFrom,
  parseActivityYaml,
  resolveInstructions,
} from "@/lib/activity-load";
import { EMPTY_FRAGMENT_BLOCK, type Fetcher, type FragmentBlock } from "@/lib/prompt-fragments";
import {
  BROKEN_TEMPLATE_YAML,
  fixtureResponse,
  fragmentFetcher,
  LIB_A_URL,
} from "@/lib/prompt-fragments/test-fixtures";

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

describe("parseActivityYaml", () => {
  const parseOk = (content: string) => {
    const result = parseActivityYaml(content, "gizmo");
    if (!result.ok) throw new Error(result.message);
    return result;
  };

  it("returns the root mapping and the llm block, defaulting the provider to SCCH", () => {
    const result = parseOk("id: g\nllm:\n  model: m\n  imageInput: true\n");
    expect(result.root.id).toBe("g");
    expect(result.llm).toEqual({ model: "m", provider: "SCCH", reasoning: undefined });
  });

  it("carries an explicit provider and reasoning level", () => {
    const result = parseOk("llm:\n  model: m\n  provider: Azure Foundry\n  reasoning: high\n");
    expect(result.llm).toEqual({ model: "m", provider: "Azure Foundry", reasoning: "high" });
  });

  it("coerces a numeric model id (YAML types scalars by value)", () => {
    expect(parseOk("llm:\n  model: 4\n").llm.model).toBe("4");
  });

  it.each([
    ["invalid YAML", ":::not yaml::: [", "This gizmo could not be read — its YAML is not valid."],
    ["a scalar document", "just text", "This gizmo is empty or malformed."],
    ["a list document", "- a\n- b\n", "This gizmo is empty or malformed."],
    ["an empty document", "", "This gizmo is empty or malformed."],
    ["a missing model", "id: g\n", "This gizmo does not specify a model (llm.model)."],
    ["a blank model", "llm:\n  model: '  '\n", "This gizmo does not specify a model (llm.model)."],
    [
      "an unsupported provider",
      "llm:\n  model: m\n  provider: OpenAI\n",
      'This gizmo uses an unsupported llm.provider (use "SCCH", "Azure Foundry" or "OpenRouter").',
    ],
    [
      "an unsupported reasoning level",
      "llm:\n  model: m\n  reasoning: turbo\n",
      "This gizmo uses an unsupported llm.reasoning (one of none, minimal, low, medium, high, xhigh).",
    ],
  ])("rejects %s, naming the kind", (_label, content, message) => {
    expect(parseActivityYaml(content, "gizmo")).toEqual({ ok: false, message });
  });
});

describe("asString / asBool", () => {
  it.each([
    ["text", "text"],
    ["  ", undefined],
    [1, "1"],
    [true, "true"],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [null, undefined],
    [{}, undefined],
  ])("asString(%o) is %o", (value, expected) => {
    expect(asString(value)).toBe(expected);
  });

  it("asBool takes only a literal boolean, else the fallback", () => {
    expect(asBool(false, true)).toBe(false);
    expect(asBool("false", true)).toBe(true);
    expect(asBool(undefined, false)).toBe(false);
  });
});

// The authoring counterpart of `resolveInstructions` (writing, coding).
describe("checkInstructions", () => {
  const TEXT_URL = "https://fixtures.test/tutors/solution.ts";
  const BROKEN_URL = "https://fixtures.test/tutors/broken.yaml";
  const fetcher = fragmentFetcher(
    new Map([
      [TEXT_URL, fixtureResponse("one\ntwo\nthree\n")],
      [BROKEN_URL, fixtureResponse(BROKEN_TEMPLATE_YAML)],
    ]),
  );
  const doc = (instructions: string, fragments: string[] = [], texts: string[] = []) => ({
    fragment_files: fragments.map((url, n) => ({ id: n === 0 ? "lib_a" : `lib_${n}`, url })),
    text_files: texts.map((url) => ({ id: "solution", url })),
    instructions,
  });
  const codes = (result: Awaited<ReturnType<typeof checkInstructions>>) =>
    result.ok ? [] : result.errors.map((e) => e.code);

  it("accepts instructions that place valid fragments and text files", async () => {
    const result = await checkInstructions(
      doc(
        `{{fragment "lib_a.safety_frag"}}\n{{file "solution" from=1 to=2}}`,
        [LIB_A_URL],
        [TEXT_URL],
      ),
      URL_,
      fetcher,
      {},
    );
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it("accepts plain instructions without fetching anything", async () => {
    const neverFetch: Fetcher = async (url) => {
      throw new Error(`Unexpected fetch URL: ${url}`);
    };
    expect(await checkInstructions(doc("Plain {{ prose."), URL_, neverFetch, {})).toEqual({
      ok: true,
      warnings: [],
    });
  });

  it("surfaces a placement error (missing required variable)", async () => {
    const result = await checkInstructions(
      doc(`{{fragment "lib_a.str_frag"}}`, [LIB_A_URL]),
      URL_,
      fetcher,
      {},
    );
    expect(codes(result)).toContain("MISSING_REQUIRED_VARIABLE");
  });

  it("surfaces an out-of-bounds text-file range", async () => {
    const result = await checkInstructions(
      doc(`{{file "solution" from=99}}`, [], [TEXT_URL]),
      URL_,
      fetcher,
      {},
    );
    expect(codes(result)).toContain("TEXT_FILE_RANGE_OUT_OF_BOUNDS");
  });

  it("checks the whole library by default (authoring), but not when told otherwise", async () => {
    // Only `ok_frag` is placed; the library's unplaced `undeclared_frag` is broken.
    const broken = doc(`{{fragment "lib_a.ok_frag" topic="t"}}`, [BROKEN_URL]);
    expect(codes(await checkInstructions(broken, URL_, fetcher, {}))).toContain(
      "FRAGMENT_TEMPLATE_ERROR",
    );
    expect(await checkInstructions(broken, URL_, fetcher, { validateLibraries: false })).toEqual({
      ok: true,
      warnings: [],
    });
  });
});
