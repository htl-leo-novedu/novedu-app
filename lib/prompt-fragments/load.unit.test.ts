import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { FetchResponse } from "./fetcher";
import { assembleFragmentPrompt, assembleFragmentPrompts, loadAndValidate } from "./load";
import type { FragmentBlock } from "./schemas";
import { fixtureResponse, LIB_A_URL, LIB_A_YAML } from "./test-fixtures";

// End-to-end coverage of the TEXT-FILE side of the assemble pipeline: parallel fetch
// alongside fragment libraries, the 200 KB cap, verbatim splicing (a literal `{{` in
// course material can never be compiled), the template-semantics opt-in extended to
// `text_files`, and the runtime-clamp vs. authoring-error split on `to` beyond EOF. The
// fragment side is exercised in depth by the tutor tests; here it only proves the two
// lists travel one combined fetch and both land in the prompt.

const BASE_URL = "https://fixtures.test/tutors/activity.yaml";
const COURSE_URL = "https://fixtures.test/tutors/course.md";
const COURSE_BODY = "L1\nL2\nL3\nL4\nL5\n"; // 5 lines, conventional trailing newline
const MAX_TEXT_FILE_BYTES = 200 * 1024;

/** A fetcher serving prebuilt responses per URL; unlisted URLs throw (network-isolation guard). */
function fetcherFor(bodies: Record<string, FetchResponse>, seen?: string[]) {
  return async (url: string): Promise<FetchResponse> => {
    seen?.push(url);
    const res = bodies[url];
    if (!res) throw new Error(`Unexpected fetch URL: ${url}`);
    return res;
  };
}

function block(overrides: Partial<FragmentBlock> = {}): FragmentBlock {
  return { fragment_files: [], text_files: [], ...overrides };
}

describe("assembleFragmentPrompt — text files: parallel fetch", () => {
  it("fetches a text file in parallel with a fragment library, both landing in the prompt", async () => {
    const seen: string[] = [];
    const result = await assembleFragmentPrompt(
      block({
        fragment_files: [{ id: "lib_a", url: LIB_A_URL }],
        text_files: [{ id: "course", url: COURSE_URL }],
      }),
      BASE_URL,
      fetcherFor(
        { [LIB_A_URL]: fixtureResponse(LIB_A_YAML), [COURSE_URL]: fixtureResponse(COURSE_BODY) },
        seen,
      ),
      {},
      '{{fragment "lib_a.safety_frag"}}\n---\n{{file "course"}}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).toContain("LAST-MARKER"); // from the fragment library
    expect(result.prompt).toContain("L1"); // from the text file
    expect(new Set(seen)).toEqual(new Set([LIB_A_URL, COURSE_URL]));
  });
});

describe("assembleFragmentPrompt — text files: 200 KB cap", () => {
  it("accepts a body at the cap boundary", async () => {
    const body = "a".repeat(MAX_TEXT_FILE_BYTES); // exactly the cap — the check is strictly-greater
    const result = await assembleFragmentPrompt(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse(body) }),
      {},
      '{{file "course"}}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompt).toBe(body);
  });

  it("rejects a body one byte over the cap with TEXT_FILE_TOO_LARGE", async () => {
    const body = "a".repeat(MAX_TEXT_FILE_BYTES + 1);
    const result = await assembleFragmentPrompt(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse(body) }),
      {},
      '{{file "course"}}',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.code === "TEXT_FILE_TOO_LARGE");
      expect(err?.fileAlias).toBe("course");
    }
  });
});

describe("assembleFragmentPrompt — text files: verbatim splice (never compiled)", () => {
  it("splices content containing literal {{ and {{fragment}}-looking text untouched", async () => {
    const body = 'Here is a marker: {{fragment "x.y"}} and {{ raw }} braces.\n';
    const result = await assembleFragmentPrompt(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse(body) }),
      {},
      'Material:\n{{file "course"}}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fetched body is inserted as a helper return value — Handlebars never re-parses it.
    expect(result.prompt).toContain('{{fragment "x.y"}}');
    expect(result.prompt).toContain("{{ raw }}");
  });

  it("renders a no-range {{file}} byte-verbatim, trailing newline preserved", async () => {
    const result = await assembleFragmentPrompt(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse(COURSE_BODY) }),
      {},
      '{{file "course"}}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompt).toBe(COURSE_BODY);
  });
});

describe("assembleFragmentPrompt — template-semantics opt-in", () => {
  it("compiles a document that declares ONLY text_files (no fragment_files)", async () => {
    const result = await assembleFragmentPrompt(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse("BODY") }),
      {},
      'PRE {{file "course"}} POST',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompt).toBe("PRE BODY POST");
  });

  it("returns host text byte-verbatim when NEITHER list is declared (no fetch, never compiled)", async () => {
    const hostText = 'A literal {{file "course"}} and {{fragment "a.b"}} stay put.';
    const result = await assembleFragmentPrompt(
      block(),
      BASE_URL,
      () => {
        throw new Error("should not fetch");
      },
      {},
      hostText,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompt).toBe(hostText);
  });
});

describe("assembleFragmentPrompt — line-range: runtime clamp vs. authoring error", () => {
  it("runtime clamps a `to` beyond EOF (validateLibraries off succeeds with a clamped slice)", async () => {
    const result = await assembleFragmentPrompt(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse(COURSE_BODY) }),
      {}, // validateLibraries defaults false → runtime
      '{{file "course" from=4 to=99}}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompt).toBe("L4\nL5"); // clamped to EOF
  });

  it("authoring errors on a `to` beyond EOF (validateLibraries on fails)", async () => {
    const result = await assembleFragmentPrompt(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse(COURSE_BODY) }),
      { validateLibraries: true },
      '{{file "course" from=4 to=99}}',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain("TEXT_FILE_RANGE_OUT_OF_BOUNDS");
    }
  });

  it("a `from` beyond EOF fails closed even at runtime (an empty splice would drop material)", async () => {
    const result = await assembleFragmentPrompt(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse(COURSE_BODY) }),
      {},
      '{{file "course" from=99}}',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain("TEXT_FILE_RANGE_OUT_OF_BOUNDS");
    }
  });
});

describe("assembleFragmentPrompt — text files: URL resolution & failures", () => {
  it("resolves a relative text-file URL against the base URL", async () => {
    const seen: string[] = [];
    const result = await assembleFragmentPrompt(
      block({ text_files: [{ id: "course", url: "course.md" }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse(COURSE_BODY) }, seen),
      {},
      '{{file "course"}}',
    );
    expect(result.ok).toBe(true);
    // Seeing the ABSOLUTE COURSE_URL fetched proves `course.md` resolved against BASE_URL.
    expect(seen).toContain(COURSE_URL);
  });

  it("fails closed when a text file cannot be fetched", async () => {
    const result = await assembleFragmentPrompt(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse("", { ok: false, status: 404 }) }),
      {},
      '{{file "course"}}',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("FETCH_FAILED");
  });

  it("fails closed on an alias declared in BOTH lists (one shared namespace)", async () => {
    const result = await assembleFragmentPrompt(
      block({
        fragment_files: [{ id: "shared", url: LIB_A_URL }],
        text_files: [{ id: "shared", url: COURSE_URL }],
      }),
      BASE_URL,
      fetcherFor({ [LIB_A_URL]: fixtureResponse(LIB_A_YAML), [COURSE_URL]: fixtureResponse("x") }),
      {},
      '{{file "shared"}}',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain("DUPLICATE_TEXT_FILE_ALIAS");
    }
  });
});

describe("assembleFragmentPrompt — same text file placed twice with different ranges", () => {
  it("resolves each placement independently against the same prefetched body", async () => {
    const result = await assembleFragmentPrompt(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse(COURSE_BODY) }),
      {},
      '{{file "course" from=1 to=2}}\n===\n{{file "course" from=4}}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompt).toBe("L1\nL2\n===\nL4\nL5");
  });
});

describe("assembleFragmentPrompts — several host texts, one shared block", () => {
  it("renders each host text against ONE fetch pass, prompts index-aligned", async () => {
    const seen: string[] = [];
    const result = await assembleFragmentPrompts(
      block({
        fragment_files: [{ id: "lib_a", url: LIB_A_URL }],
        text_files: [{ id: "course", url: COURSE_URL }],
      }),
      BASE_URL,
      fetcherFor(
        { [LIB_A_URL]: fixtureResponse(LIB_A_YAML), [COURSE_URL]: fixtureResponse(COURSE_BODY) },
        seen,
      ),
      {},
      ['{{fragment "lib_a.safety_frag"}}', 'Discuss with care.\n{{file "course" from=1 to=1}}', ""],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompts).toHaveLength(3);
    expect(result.prompts[0]).toContain("LAST-MARKER");
    expect(result.prompts[1]).toBe("Discuss with care.\nL1");
    expect(result.prompts[2]).toBe("");
    // Each declared file was fetched exactly ONCE, not once per host text.
    expect(seen.filter((u) => u === LIB_A_URL)).toHaveLength(1);
    expect(seen.filter((u) => u === COURSE_URL)).toHaveLength(1);
  });

  it("collects errors ACROSS hosts and fails the whole call (fail closed)", async () => {
    const result = await assembleFragmentPrompts(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse(COURSE_BODY) }),
      {},
      // Host 1 is fine; hosts 2 + 3 each reference an undeclared alias.
      ['{{file "course"}}', '{{file "missing"}}', '{{file "also_missing"}}'],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Both broken hosts surface their own error in the ONE failing result.
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("a library used only by the SECOND host is not flagged unused (union check)", async () => {
    const result = await assembleFragmentPrompts(
      block({ fragment_files: [{ id: "lib_a", url: LIB_A_URL }] }),
      BASE_URL,
      fetcherFor({ [LIB_A_URL]: fixtureResponse(LIB_A_YAML) }),
      {},
      ["no markers here", '{{fragment "lib_a.safety_frag"}}'],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.map((w) => w.code)).not.toContain("UNUSED_FRAGMENT_FILE");
    }
  });

  it("parse failure in ANY host fails the whole call", async () => {
    const result = await assembleFragmentPrompts(
      block({ text_files: [{ id: "course", url: COURSE_URL }] }),
      BASE_URL,
      fetcherFor({ [COURSE_URL]: fixtureResponse(COURSE_BODY) }),
      {},
      ['{{file "course"}}', "broken {{"],
    );
    expect(result.ok).toBe(false);
  });

  it("returns ALL host texts byte-verbatim when NEITHER list is declared (never compiled)", async () => {
    const hosts = ["plain with a literal {{ inside", '{{fragment "lib_a.safety_frag"}}'];
    const result = await assembleFragmentPrompts(
      block(),
      BASE_URL,
      fetcherFor({}), // any fetch would throw — proves zero network
      {},
      hosts,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompts).toEqual(hosts);
  });
});

// The front of every activity's authoring check (tutor, quiz + its includes, writing,
// coding): scheme gate → fetch → YAML → the document's schema, first error wins.
describe("loadAndValidate", () => {
  const Doc = z.strictObject({ id: z.string() });
  const load = (url: string, body: FetchResponse) =>
    loadAndValidate(url, fetcherFor({ [url]: body }), {}, Doc, "WRITING_SCHEMA_ERROR");

  it("returns the typed document", async () => {
    expect(await load(BASE_URL, fixtureResponse("id: doc\n"))).toEqual({
      ok: true,
      data: { id: "doc" },
    });
  });

  it.each([
    ["a disallowed scheme", "file:///etc/passwd", fixtureResponse("id: doc\n"), "INVALID_URL"],
    ["a failed fetch", BASE_URL, fixtureResponse("", { ok: false, status: 404 }), "FETCH_FAILED"],
    ["invalid YAML", BASE_URL, fixtureResponse("id: c\n  bad: : :"), "YAML_PARSE_ERROR"],
    ["a schema mismatch", BASE_URL, fixtureResponse("idd: doc\n"), "WRITING_SCHEMA_ERROR"],
  ])("reports %s as its structured error", async (_label, url, body, code) => {
    const result = await load(url, body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it("attaches the URL and the Zod issues to a schema error", async () => {
    const result = await load(BASE_URL, fixtureResponse("idd: doc\n"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.url).toBe(BASE_URL);
      expect(result.error.zodIssues).toBeTruthy();
    }
  });
});
