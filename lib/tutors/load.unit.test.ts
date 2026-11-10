import { assert, describe, expect, it } from "vitest";
import { type Fetcher, resolveFragmentUrl } from "@/lib/prompt-fragments";
import { loadAndBuildTutorPrompt } from "./load";
import {
  fixtureFetcher,
  fixtureResponse,
  LIB_A_URL,
  LIB_A_YAML,
  LIB_B_URL,
  TUTOR_URL,
  TUTOR_YAML,
} from "./test-fixtures";

describe("loadAndBuildTutorPrompt — happy path", () => {
  it("builds the prompt from the synthetic fixtures with no network", async () => {
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prompt).toContain("FIRST-MARKER"); // prose from a fragment
      expect(result.prompt).toContain("->"); // ASCII diagram, unescaped
      expect(result.model).toBe("test-model"); // from the tutor's llm.model
    }
  });

  it("applies the defaults for omitted reasoning, imageInput, anonymous and tools", async () => {
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher());
    assert(result.ok);
    expect(result.reasoning).toBeUndefined();
    expect(result.imageInput).toBe(true);
    expect(result.anonymous).toBe(true);
    expect(result.tools).toEqual([]);
  });

  it("only fetches the tutor URL and its declared fragment files", async () => {
    const seen: string[] = [];
    const base = fixtureFetcher();
    const spy: Fetcher = (url) => {
      seen.push(url);
      return base(url);
    };
    await loadAndBuildTutorPrompt(TUTOR_URL, spy);
    // The tutor uses relative refs (`lib-a.yaml`); seeing the absolute
    // LIB_A_URL/LIB_B_URL fetched proves they were resolved against TUTOR_URL.
    expect(new Set(seen)).toEqual(new Set([TUTOR_URL, LIB_A_URL, LIB_B_URL]));
  });
});

describe("loadAndBuildTutorPrompt — reasoning level", () => {
  // The tutor declares no `llm.reasoning`; the variant patches the llm block to
  // exercise the field without a second fixture.
  const withReasoning = (value: string) =>
    TUTOR_YAML.replace("  model: test-model", `  model: test-model\n  reasoning: ${value}`);

  it("surfaces an explicit level from the tutor's llm block", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withReasoning("high"))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reasoning).toBe("high");
  });

  it("TUTOR_SCHEMA_ERROR for an unknown level", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withReasoning("turbo"))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("TUTOR_SCHEMA_ERROR");
  });
});

describe("loadAndBuildTutorPrompt — image input flag", () => {
  // The tutor declares no `llm.imageInput`; these variants patch the llm block to
  // exercise the flag without a second fixture.
  const withImageInput = (value: string) =>
    TUTOR_YAML.replace("  model: test-model", `  model: test-model\n  imageInput: ${value}`);

  it("surfaces an explicit imageInput: false opt-out from the tutor's llm block", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withImageInput("false"))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.imageInput).toBe(false);
  });

  it("TUTOR_SCHEMA_ERROR for a non-boolean imageInput", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withImageInput('"yes"'))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("TUTOR_SCHEMA_ERROR");
  });
});

describe("loadAndBuildTutorPrompt — anonymous flag", () => {
  // The tutor declares no `anonymous`; these variants prepend the top-level field
  // to exercise the flag without a second fixture.
  const withAnonymous = (value: string) => `anonymous: ${value}\n${TUTOR_YAML}`;

  it("surfaces an explicit anonymous: false opt-in to chat attribution", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withAnonymous("false"))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.anonymous).toBe(false);
  });

  it("keeps an explicit anonymous: true anonymous", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withAnonymous("true"))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.anonymous).toBe(true);
  });

  it("TUTOR_SCHEMA_ERROR for a non-boolean anonymous", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withAnonymous('"no"'))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("TUTOR_SCHEMA_ERROR");
  });
});

describe("loadAndBuildTutorPrompt — tools opt-in", () => {
  // The fixture declares no `tools:`; these variants prepend the top-level field.
  const withTools = (yamlList: string) => `tools:${yamlList}\n${TUTOR_YAML}`;

  it("surfaces an explicit random_number opt-in", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withTools("\n  - random_number"))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tools).toEqual(["random_number"]);
  });

  it("UNMENTIONED_TOOL warning when the prompt never names a granted tool", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withTools("\n  - random_number"))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    assert(result.ok);
    const warning = result.warnings.find((w) => w.code === "UNMENTIONED_TOOL");
    expect(warning?.message).toContain('"random_number"');
    expect(warning?.message).toContain("https://docs.novedu.at/20-building-activities/03-tutors/");
  });

  it("no UNMENTIONED_TOOL warning once tutor_instructions names the tool", async () => {
    const yaml = withTools("\n  - board").replace(
      "tutor_instructions: |",
      "tutor_instructions: |\n    Use the Board tool to draw.",
    );
    expect(yaml).toContain("Use the Board tool");
    const overrides = new Map([[TUTOR_URL, fixtureResponse(yaml)]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    assert(result.ok);
    expect(result.warnings.map((w) => w.code)).not.toContain("UNMENTIONED_TOOL");
  });

  it("accepts an explicitly empty tools list", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withTools(" []"))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tools).toEqual([]);
  });

  it("TUTOR_SCHEMA_ERROR for an unknown tool name", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withTools("\n  - radix_conversion"))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("TUTOR_SCHEMA_ERROR");
  });

  it("TUTOR_SCHEMA_ERROR for a non-list tools value", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withTools(" random_number"))]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("TUTOR_SCHEMA_ERROR");
  });
});

describe("loadAndBuildTutorPrompt — title & description", () => {
  it("surfaces the tutor's title and description for the welcome screen", async () => {
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.title).toBe("Functional Test Tutor");
      expect(result.description).toContain("Synthetic tutor");
    }
  });

  it("leaves title undefined when the tutor omits it (description stays required)", async () => {
    const withoutTitle = TUTOR_YAML.replace(/^title: .*\n/m, "");
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withoutTitle)]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.title).toBeUndefined();
      expect(result.description.length).toBeGreaterThan(0);
    }
  });
});

describe("loadAndBuildTutorPrompt — example questions", () => {
  // The fixture's exampleQuestions block sits between `description:` and `llm:`.
  const withoutExampleQuestions = () =>
    TUTOR_YAML.replace(/^exampleQuestions:[\s\S]*?(?=^llm:)/m, "");

  it("surfaces the tutor's example questions for the welcome screen", async () => {
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exampleQuestions).toHaveLength(2);
      expect(result.exampleQuestions[0]).toEqual({
        title: "First example",
        question: "What is the first example question?",
      });
    }
  });

  it("normalizes an omitted exampleQuestions field to an empty array", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse(withoutExampleQuestions())]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.exampleQuestions).toEqual([]);
  });

  it("TUTOR_SCHEMA_ERROR for an example question with an empty title", async () => {
    const broken = `${withoutExampleQuestions().replace(
      /^llm:/m,
      'exampleQuestions:\n  - title: ""\n    question: "How does this work?"\nllm:',
    )}`;
    const overrides = new Map([[TUTOR_URL, fixtureResponse(broken)]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("TUTOR_SCHEMA_ERROR");
  });
});

describe("resolveFragmentUrl", () => {
  it("returns an absolute http(s) ref unchanged", () => {
    expect(resolveFragmentUrl(LIB_A_URL, TUTOR_URL)).toBe(LIB_A_URL);
    expect(resolveFragmentUrl("http://example.com/x.yaml", TUTOR_URL)).toBe(
      "http://example.com/x.yaml",
    );
  });

  it("resolves a bare filename against the tutor's directory (filename dropped)", () => {
    expect(resolveFragmentUrl("lib-a.yaml", TUTOR_URL)).toBe(LIB_A_URL);
  });

  it("resolves ./ and ../ segments", () => {
    expect(resolveFragmentUrl("./lib-a.yaml", TUTOR_URL)).toBe(LIB_A_URL);
    // TUTOR_URL lives in `.../tutors/`; `../` steps up to the parent directory.
    expect(resolveFragmentUrl("../other/x.yaml", TUTOR_URL)).toBe(
      "https://fixtures.test/other/x.yaml",
    );
  });

  it("lets an absolute ref to a different host override the base", () => {
    expect(resolveFragmentUrl("https://other.example/z.yaml", TUTOR_URL)).toBe(
      "https://other.example/z.yaml",
    );
  });
});

describe("loadAndBuildTutorPrompt — fragment URL resolution", () => {
  // Rewrite the (relative) fixture refs back to absolute to prove absolute still works.
  const absoluteTutorBody = TUTOR_YAML.replace("lib-a.yaml", LIB_A_URL).replace(
    "lib-b.yaml",
    LIB_B_URL,
  );

  it("still supports absolute fragment refs", async () => {
    const seen: string[] = [];
    const overrides = new Map([[TUTOR_URL, fixtureResponse(absoluteTutorBody)]]);
    const base = fixtureFetcher(overrides);
    const spy: Fetcher = (url) => {
      seen.push(url);
      return base(url);
    };
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, spy);
    expect(result.ok).toBe(true);
    expect(new Set(seen)).toEqual(new Set([TUTOR_URL, LIB_A_URL, LIB_B_URL]));
  });

  it("supports a mix of absolute and relative refs in one tutor", async () => {
    // lib_a → absolute URL, lib_b → left relative.
    const mixedBody = TUTOR_YAML.replace("lib-a.yaml", LIB_A_URL);
    const overrides = new Map([[TUTOR_URL, fixtureResponse(mixedBody)]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(true);
  });

  it("TUTOR_SCHEMA_ERROR for an absolute non-http(s) fragment ref", async () => {
    const ftpBody = TUTOR_YAML.replace("lib-a.yaml", "ftp://example.com/frag.yaml");
    const overrides = new Map([[TUTOR_URL, fixtureResponse(ftpBody)]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("TUTOR_SCHEMA_ERROR");
  });
});

describe("loadAndBuildTutorPrompt — failures", () => {
  it("INVALID_URL for a non-http(s) URL (no fetch attempted)", async () => {
    const result = await loadAndBuildTutorPrompt("ftp://example.com/t.yaml", () => {
      throw new Error("should not fetch");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("INVALID_URL");
  });

  it("FETCH_FAILED when the tutor URL returns non-2xx", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse("", { ok: false, status: 404 })]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("FETCH_FAILED");
      expect(result.errors[0]?.status).toBe(404);
    }
  });

  it("FETCH_FAILED when the fetcher throws (network down)", async () => {
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, () =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("FETCH_FAILED");
  });

  it("YAML_PARSE_ERROR for a malformed tutor body", async () => {
    const overrides = new Map([[TUTOR_URL, fixtureResponse("foo: [1, 2")]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("YAML_PARSE_ERROR");
  });

  it("FRAGMENT_FILE_SCHEMA_ERROR for a default whose type mismatches its property", async () => {
    // A boolean property with a string default must be rejected at schema validation.
    const badFragmentFile = [
      "id: lib-a",
      "fragments:",
      "  - id: str_frag",
      "    version: 1",
      "    input_schema:",
      "      type: object",
      "      properties:",
      "        flag:",
      "          type: boolean",
      '          default: "not a boolean"',
      "    content: hi",
    ].join("\n");
    const overrides = new Map([[LIB_A_URL, fixtureResponse(badFragmentFile)]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain("FRAGMENT_FILE_SCHEMA_ERROR");
    }
  });

  it("reports every failing fragment file, not just the first", async () => {
    const overrides = new Map([
      [LIB_A_URL, fixtureResponse("", { ok: false, status: 500 })],
      [LIB_B_URL, fixtureResponse("", { ok: false, status: 503 })],
    ]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const failedUrls = result.errors.filter((e) => e.code === "FETCH_FAILED").map((e) => e.url);
      expect(failedUrls).toContain(LIB_A_URL);
      expect(failedUrls).toContain(LIB_B_URL);
    }
  });
});

describe("loadAndBuildTutorPrompt — inline placement", () => {
  it("renders each fragment where its marker sits (textual order, prose between)", async () => {
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.prompt.indexOf("FIRST-MARKER"); // str_frag — placed first
    const middle = result.prompt.indexOf("TUTOR-INSTRUCTIONS-MARKER"); // tutor prose, in the middle
    const last = result.prompt.indexOf("LAST-MARKER"); // safety_frag — placed last
    expect(first).toBeGreaterThanOrEqual(0);
    expect(middle).toBeGreaterThan(first);
    expect(last).toBeGreaterThan(middle);
    // Supplied list items and the unescaped ASCII diagram render verbatim.
    expect(result.prompt).toContain("ITEM-ALPHA");
    expect(result.prompt).toContain("[head] -> [ A");
  });

  it("leaves host text byte-verbatim when the tutor declares no fragment_files (never compiled)", async () => {
    const noFragmentsTutor = [
      "id: plain",
      "name: Plain",
      "description: A plain tutor.",
      "llm:",
      "  model: test-model",
      "prompt:",
      "  tutor_instructions: |",
      '    A literal {{fragment "x.y"}} marker and {{unescaped}} braces stay put.',
    ].join("\n");
    const overrides = new Map([[TUTOR_URL, fixtureResponse(noFragmentsTutor)]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).toContain('{{fragment "x.y"}}');
    expect(result.prompt).toContain("{{unescaped}}");
  });
});

describe("loadAndBuildTutorPrompt — text files", () => {
  // A tutor that declares NO fragment_files but a `text_files` entry under `prompt:` and
  // embeds it with a {{file}} marker. The presence of text_files alone opts the host text
  // into template semantics, so the marker is resolved (spliced verbatim) at render.
  const SOLUTION_URL = "https://fixtures.test/tutors/solution.ts";
  const SOLUTION_BODY =
    "export const first = 1;\nexport const second = 2;\nexport const third = 3;\n";
  const tutorWithTextFile = [
    "id: tt",
    'name: "Text Tutor"',
    'description: "Uses a sample solution file."',
    "llm:",
    "  model: test-model",
    "prompt:",
    "  text_files:",
    "    - id: solution",
    `      url: ${SOLUTION_URL}`,
    "  tutor_instructions: |",
    "    Reference solution:",
    '    {{file "solution" from=1 to=2}}',
  ].join("\n");

  const textFetcher = (): Fetcher => async (url) => {
    if (url === TUTOR_URL) return fixtureResponse(tutorWithTextFile);
    if (url === SOLUTION_URL) return fixtureResponse(SOLUTION_BODY);
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  it("assembles a prompt with the embedded text-file excerpt spliced in", async () => {
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, textFetcher());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).toContain("Reference solution:");
    expect(result.prompt).toContain("export const first = 1;");
    expect(result.prompt).toContain("export const second = 2;");
    // from=1 to=2 excludes the third line.
    expect(result.prompt).not.toContain("export const third = 3;");
  });
});

describe("loadAndBuildTutorPrompt — validateLibraries (thorough whole-library check)", () => {
  // Append an UNUSED fragment with a broken template (it references a variable its
  // input_schema never declares) to a real referenced library. The tutor never
  // references this fragment, so it only matters under the whole-library check.
  const libAWithBrokenUnused = () =>
    `${LIB_A_YAML}
  - id: broken_unused
    content: |
      You forgot to declare {{undeclared_var}}.
`;

  it("passes when every referenced library is fully valid (synthetic fixtures)", async () => {
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(), {
      validateLibraries: true,
    });
    expect(result.ok).toBe(true);
  });

  it("does NOT check unused fragments when the option is off (chat hot path unaffected)", async () => {
    const overrides = new Map([[LIB_A_URL, fixtureResponse(libAWithBrokenUnused())]]);
    // The broken fragment is unused; the default (hot-path) build still succeeds.
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides));
    expect(result.ok).toBe(true);
  });

  it("FRAGMENT_TEMPLATE_ERROR (with fileAlias) for a broken unused fragment when on", async () => {
    const overrides = new Map([[LIB_A_URL, fixtureResponse(libAWithBrokenUnused())]]);
    const result = await loadAndBuildTutorPrompt(TUTOR_URL, fixtureFetcher(overrides), {
      validateLibraries: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.code === "FRAGMENT_TEMPLATE_ERROR");
      expect(err?.fragmentId).toBe("broken_unused");
      expect(err?.fileAlias).toBe("lib_a");
    }
  });
});
