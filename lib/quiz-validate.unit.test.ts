import { assert, describe, expect, it, vi } from "vitest";
import { parse as parseYamlText } from "yaml";
import type { Fetcher } from "@/lib/prompt-fragments";
import { checkQuizValue, loadAndCheckQuiz } from "@/lib/quiz-validate";

// The quiz AUTHORING validator: the strict schema gate + the duplicate-question-id
// pass. Pure, no network — a fixture Fetcher returns YAML text in-process.

const URL_ = "https://example.com/quiz.yaml";
const fetcherFor =
  (text: string, ok = true): Fetcher =>
  async () => ({ ok, status: ok ? 200 : 404, text: async () => text });

const VALID = `
id: capitals
name: "Capitals"
title: "Capitals Quiz"
anonymous: false
shuffle: false
llm:
  model: some-model
discussion:
  instructions: "Be kind."
questions:
  - id: a
    title: "A"
    question: "What is the capital of France?"
    evaluation: "Paris. correct|incorrect."
    image:
      hosted: true
      src: a-map
      alt: A map.
  - id: b
    question: "What is the capital of Italy?"
    evaluation: "Rome. correct|incorrect."
`;

describe("loadAndCheckQuiz — positive", () => {
  it("accepts a valid quiz and reports its metadata", async () => {
    const result = await loadAndCheckQuiz(URL_, fetcherFor(VALID));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quizId).toBe("capitals");
      expect(result.model).toBe("some-model");
      expect(result.provider).toBe("SCCH"); // llm.provider defaults to SCCH
      expect(result.questionCount).toBe(2);
      expect(result.anonymous).toBe(false);
      expect(result.title).toBe("Capitals Quiz");
    }
  });

  it("accepts and reports an explicit llm.provider", async () => {
    const foundry = `
id: q
llm:
  model: gpt-5.4-mini
  provider: Azure Foundry
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`;
    const result = await loadAndCheckQuiz(URL_, fetcherFor(foundry));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe("Azure Foundry");
  });

  it("accepts the two-level imageInput flags (llm-level default + per-question override)", async () => {
    const withImages = `
id: q
llm:
  model: m
  imageInput: true
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
    imageInput: false
`;
    const result = await loadAndCheckQuiz(URL_, fetcherFor(withImages));
    expect(result.ok).toBe(true);
  });

  it("defaults anonymous to TRUE and title to null when omitted", async () => {
    const minimal = `
id: q
llm:
  model: m
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`;
    const result = await loadAndCheckQuiz(URL_, fetcherFor(minimal));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.anonymous).toBe(true);
      expect(result.title).toBeNull();
    }
  });
});

describe("loadAndCheckQuiz — negative", () => {
  it("rejects a fetch failure as FETCH_FAILED (no throw)", async () => {
    const result = await loadAndCheckQuiz(URL_, fetcherFor("", false));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("FETCH_FAILED");
  });

  it("rejects invalid YAML as YAML_PARSE_ERROR", async () => {
    const result = await loadAndCheckQuiz(URL_, fetcherFor("id: q\n  bad: : :"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("YAML_PARSE_ERROR");
  });

  it("rejects a disallowed URL scheme as INVALID_URL", async () => {
    const result = await loadAndCheckQuiz("file:///etc/passwd", fetcherFor(VALID));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("INVALID_URL");
  });
});

describe("checkQuizValue — schema errors", () => {
  const check = (yaml: string) => checkQuizValue(parseYamlText(yaml), URL_);

  it("rejects a missing llm.model", () => {
    const result = check(`
id: q
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("QUIZ_SCHEMA_ERROR");
  });

  it("rejects a quiz with no questions and no includes (QUIZ_NO_QUESTIONS)", () => {
    // An empty `questions` passes the schema (quiz_files may supply the pool);
    // the resolved-pool check is what rejects a truly empty quiz.
    const result = check(`
id: q
llm:
  model: m
questions: []
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("QUIZ_NO_QUESTIONS");
  });

  it("rejects a non-positive or non-integer question_count", () => {
    for (const bad of ["0", "-3", "1.5", '"30"']) {
      const result = check(`
id: q
llm:
  model: m
question_count: ${bad}
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`);
      expect(result.ok, `question_count: ${bad}`).toBe(false);
      if (!result.ok) expect(result.errors[0]?.code).toBe("QUIZ_SCHEMA_ERROR");
    }
  });

  it("accepts a valid question_count (may exceed the pool — drill mode)", () => {
    const result = check(`
id: q
llm:
  model: m
question_count: 30
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`);
    expect(result.ok).toBe(true);
  });

  it("rejects a quiz_files alias containing a dot or a slash (schema pattern)", () => {
    for (const alias of ["bad.alias", "bad/alias"]) {
      const result = check(`
id: q
llm:
  model: m
quiz_files:
  - id: ${alias}
    url: ./other.yaml
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`);
      expect(result.ok, alias).toBe(false);
      if (!result.ok) expect(result.errors[0]?.code).toBe("QUIZ_SCHEMA_ERROR");
    }
  });

  it("rejects an own question id containing '/' (QUIZ_QUESTION_ID_RESERVED_SLASH)", () => {
    const result = check(`
id: q
llm:
  model: m
questions:
  - id: intro/q1
    question: "Q?"
    evaluation: "grade"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("QUIZ_QUESTION_ID_RESERVED_SLASH");
      expect(result.errors[0]?.questionId).toBe("intro/q1");
    }
  });

  it("rejects a duplicate quiz_files alias (DUPLICATE_QUIZ_INCLUDE_ALIAS)", () => {
    const result = check(`
id: q
llm:
  model: m
quiz_files:
  - id: intro
    url: ./a.yaml
  - id: intro
    url: ./b.yaml
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("DUPLICATE_QUIZ_INCLUDE_ALIAS");
      expect(result.errors[0]?.fileAlias).toBe("intro");
    }
  });

  it("rejects an unsupported llm.provider", () => {
    const result = check(`
id: q
llm:
  model: m
  provider: OpenAI
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("QUIZ_SCHEMA_ERROR");
  });

  it("rejects a question missing its evaluation", () => {
    const result = check(`
id: q
llm:
  model: m
questions:
  - id: a
    question: "Q?"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("QUIZ_SCHEMA_ERROR");
  });

  it("rejects a non-boolean imageInput", () => {
    const result = check(`
id: q
llm:
  model: m
  imageInput: "yes"
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("QUIZ_SCHEMA_ERROR");
  });

  it("rejects an unrecognized (misspelled) key", () => {
    const result = check(`
id: q
naem: typo
llm:
  model: m
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("QUIZ_SCHEMA_ERROR");
      expect(result.errors[0]?.zodIssues).toBeTruthy();
    }
  });
});

describe("checkQuizValue — duplicate question ids", () => {
  it("rejects a duplicate question id with DUPLICATE_QUIZ_QUESTION_ID", () => {
    const result = checkQuizValue(
      parseYamlText(`
id: q
llm:
  model: m
questions:
  - id: dup
    question: "Q1?"
    evaluation: "grade"
  - id: dup
    question: "Q2?"
    evaluation: "grade"
`),
      URL_,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("DUPLICATE_QUIZ_QUESTION_ID");
      expect(result.errors[0]?.questionId).toBe("dup");
    }
  });
});

// --- document-level prompt fragments (the authoring gate for quiz fragments) -------

const LIB_URL = "https://example.com/lib.yaml";
const LIB_YAML = `id: lib
fragments:
  - id: safety
    version: 1
    content: |
      Always be safe and kind.
  - id: lang
    version: 1
    input_schema:
      type: object
      required: [language]
      properties:
        language:
          type: string
    content: |
      Respond in {{language}}.
`;

// A fetcher serving distinct bodies per URL (quiz + its fragment library).
const fetcherMap =
  (bodies: Record<string, string>): Fetcher =>
  async (url) => {
    const text = bodies[url];
    return text === undefined
      ? { ok: false, status: 404, text: async () => "" }
      : { ok: true, status: 200, text: async () => text };
  };

// The quiz declares its fragment library via `fragment_files:` and expresses WHICH
// fragments it uses with inline `{{fragment}}` markers in the `instructions` host text.
const quizWithFragments = (instructions: string) => `
id: q
llm:
  model: m
fragment_files:
  - id: lib
    url: ${LIB_URL}
instructions: |
${instructions}
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`;

describe("loadAndCheckQuiz — fragments", () => {
  it("accepts a quiz that pulls in valid fragments", async () => {
    const quiz = quizWithFragments(
      '  {{fragment "lib.safety"}}\n  {{fragment "lib.lang" language="German"}}',
    );
    const result = await loadAndCheckQuiz(URL_, fetcherMap({ [URL_]: quiz, [LIB_URL]: LIB_YAML }));
    expect(result.ok).toBe(true);
  });

  it("a plain quiz (no fragments) is valid and fetches only the quiz itself", async () => {
    const plain = `
id: q
llm:
  model: m
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`;
    const fetcher = vi.fn(fetcherMap({ [URL_]: plain }));
    const result = await loadAndCheckQuiz(URL_, fetcher);
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([URL_]);
  });

  it.each([
    ["FRAGMENT_NOT_FOUND", "a missing fragment id", '{{fragment "lib.nope"}}'],
    ["UNKNOWN_FRAGMENT_FILE_ALIAS", "an undeclared file alias", '{{fragment "other.safety"}}'],
    ["MISSING_REQUIRED_VARIABLE", "a required variable left out", '{{fragment "lib.lang"}}'],
    [
      "VARIABLE_TYPE_MISMATCH",
      "a variable of the wrong type",
      '{{fragment "lib.lang" language=(array "not" "a" "string")}}',
    ],
  ])("%s for %s", async (code, _label, marker) => {
    const quiz = quizWithFragments(`  ${marker}`);
    const result = await loadAndCheckQuiz(URL_, fetcherMap({ [URL_]: quiz, [LIB_URL]: LIB_YAML }));
    assert(!result.ok);
    expect(result.errors.map((e) => e.code)).toContain(code);
  });

  it("still catches duplicate question ids alongside a valid fragment block", async () => {
    const quiz = `
id: q
llm:
  model: m
fragment_files:
  - id: lib
    url: ${LIB_URL}
instructions: |
  {{fragment "lib.safety"}}
questions:
  - id: dup
    question: "Q1?"
    evaluation: "grade"
  - id: dup
    question: "Q2?"
    evaluation: "grade"
`;
    const result = await loadAndCheckQuiz(URL_, fetcherMap({ [URL_]: quiz, [LIB_URL]: LIB_YAML }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("DUPLICATE_QUIZ_QUESTION_ID");
  });
});

// --- document-level text files ({{file "alias"}}) — authoring gate (validateLibraries: true)
const TEXT_URL = "https://example.com/course.md";
const COURSE_BODY = "L1\nL2\nL3\n"; // 3 logical lines

const quizWithTextFile = (instructions: string) => `
id: q
llm:
  model: m
text_files:
  - id: course
    url: ${TEXT_URL}
instructions: |
${instructions}
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`;

describe("loadAndCheckQuiz — text files", () => {
  it("accepts a quiz that embeds a text file with an in-bounds {{file}} marker", async () => {
    const quiz = quizWithTextFile('  Material:\n  {{file "course" from=1 to=2}}');
    const result = await loadAndCheckQuiz(
      URL_,
      fetcherMap({ [URL_]: quiz, [TEXT_URL]: COURSE_BODY }),
    );
    expect(result.ok).toBe(true);
  });

  it("TEXT_FILE_RANGE_OUT_OF_BOUNDS for a `from` past end-of-file", async () => {
    const quiz = quizWithTextFile('  {{file "course" from=99}}');
    const result = await loadAndCheckQuiz(
      URL_,
      fetcherMap({ [URL_]: quiz, [TEXT_URL]: COURSE_BODY }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain("TEXT_FILE_RANGE_OUT_OF_BOUNDS");
    }
  });
});

// --- quiz_files live includes (the deep authoring gate) ----------------------------

const BASE = "https://example.com/final-quiz.yaml";
const INTRO_URL = "https://example.com/intro.yaml";

const INTRO_QUIZ = `
id: intro
llm:
  model: chapter-model
questions:
  - id: q1
    question: "Q1?"
    evaluation: "grade 1"
  - id: q2
    question: "Q2?"
    evaluation: "grade 2"
`;

const compound = (files: string, ownQuestions = "") => `
id: final
llm:
  model: final-model
quiz_files:
${files}
${ownQuestions}
`;

describe("loadAndCheckQuiz — quiz_files includes", () => {
  it("accepts a compound quiz (relative include URL) and reports the RESOLVED pool size", async () => {
    const quiz = compound(
      "  - id: intro\n    url: ./intro.yaml",
      'questions:\n  - id: own\n    question: "Own?"\n    evaluation: "grade"',
    );
    const result = await loadAndCheckQuiz(
      BASE,
      fetcherMap({ [BASE]: quiz, [INTRO_URL]: INTRO_QUIZ }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.questionCount).toBe(3); // 1 own + 2 imported
  });

  it("accepts a compound quiz with ZERO own questions (includes supply the pool)", async () => {
    const quiz = compound("  - id: intro\n    url: ./intro.yaml");
    const result = await loadAndCheckQuiz(
      BASE,
      fetcherMap({ [BASE]: quiz, [INTRO_URL]: INTRO_QUIZ }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.questionCount).toBe(2);
  });

  it("QUIZ_INCLUDE_UNREADABLE for an unfetchable include (alias + URL carried)", async () => {
    const quiz = compound("  - id: intro\n    url: ./missing.yaml");
    const result = await loadAndCheckQuiz(BASE, fetcherMap({ [BASE]: quiz }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("QUIZ_INCLUDE_UNREADABLE");
      expect(result.errors[0]?.fileAlias).toBe("intro");
      expect(result.errors[0]?.url).toBe("https://example.com/missing.yaml");
    }
  });

  it("QUIZ_INCLUDE_UNREADABLE wraps a schema failure inside the included quiz", async () => {
    const broken = `
id: intro
questions:
  - id: q1
    question: "Q1?"
    evaluation: "grade"
`; // no llm.model → schema error inside the include
    const quiz = compound("  - id: intro\n    url: ./intro.yaml");
    const result = await loadAndCheckQuiz(BASE, fetcherMap({ [BASE]: quiz, [INTRO_URL]: broken }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("QUIZ_INCLUDE_UNREADABLE");
      expect(result.errors[0]?.fileAlias).toBe("intro");
    }
  });

  it("QUIZ_INCLUDE_UNREADABLE wraps duplicate question ids inside the included quiz", async () => {
    const withDup = `
id: intro
llm:
  model: m
questions:
  - id: dup
    question: "Q1?"
    evaluation: "grade"
  - id: dup
    question: "Q2?"
    evaluation: "grade"
`;
    const quiz = compound("  - id: intro\n    url: ./intro.yaml");
    const result = await loadAndCheckQuiz(BASE, fetcherMap({ [BASE]: quiz, [INTRO_URL]: withDup }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("QUIZ_INCLUDE_UNREADABLE");
      expect(result.errors[0]?.message).toContain("dup");
    }
  });

  it("QUIZ_INCLUDE_UNREADABLE wraps a broken fragment block inside the included quiz", async () => {
    const withBadFragments = `
id: intro
llm:
  model: m
fragment_files:
  - id: lib
    url: ./nowhere.yaml
instructions: |
  {{fragment "lib.safety"}}
questions:
  - id: q1
    question: "Q1?"
    evaluation: "grade"
`;
    const quiz = compound("  - id: intro\n    url: ./intro.yaml");
    const result = await loadAndCheckQuiz(
      BASE,
      fetcherMap({ [BASE]: quiz, [INTRO_URL]: withBadFragments }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("QUIZ_INCLUDE_UNREADABLE");
  });

  it("QUIZ_INCLUDE_NESTED when an included quiz itself declares quiz_files", async () => {
    const nested = `
id: intro
llm:
  model: m
quiz_files:
  - id: deeper
    url: ./deeper.yaml
questions:
  - id: q1
    question: "Q1?"
    evaluation: "grade"
`;
    const quiz = compound("  - id: intro\n    url: ./intro.yaml");
    const result = await loadAndCheckQuiz(BASE, fetcherMap({ [BASE]: quiz, [INTRO_URL]: nested }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("QUIZ_INCLUDE_NESTED");
      expect(result.errors[0]?.fileAlias).toBe("intro");
    }
  });

  it("surfaces EVERY broken include at once, in declared order", async () => {
    const quiz = compound(
      "  - id: one\n    url: ./missing-one.yaml\n  - id: two\n    url: ./missing-two.yaml",
    );
    const result = await loadAndCheckQuiz(BASE, fetcherMap({ [BASE]: quiz }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.fileAlias)).toEqual(["one", "two"]);
    }
  });
});

describe("loadAndCheckQuiz — discussion.instructions as a second host text", () => {
  const withDiscussion = (discussionInstructions: string) => `
id: q
llm:
  model: m
fragment_files:
  - id: lib
    url: ${LIB_URL}
discussion:
  instructions: |
${discussionInstructions}
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`;

  it("accepts valid markers inside discussion.instructions", async () => {
    const quiz = withDiscussion('    {{fragment "lib.lang" language="German"}}');
    const result = await loadAndCheckQuiz(URL_, fetcherMap({ [URL_]: quiz, [LIB_URL]: LIB_YAML }));
    expect(result.ok).toBe(true);
  });

  it("blocks the save on a broken marker in discussion.instructions", async () => {
    const quiz = withDiscussion('    {{fragment "lib.nope"}}');
    const result = await loadAndCheckQuiz(URL_, fetcherMap({ [URL_]: quiz, [LIB_URL]: LIB_YAML }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("FRAGMENT_NOT_FOUND");
  });

  it("QUIZ_INCLUDE_UNREADABLE wraps a broken discussion.instructions inside an included quiz", async () => {
    const brokenInclude = `
id: intro
llm:
  model: m
fragment_files:
  - id: lib
    url: ${LIB_URL}
discussion:
  instructions: |
    {{fragment "lib.nope"}}
questions:
  - id: q1
    question: "Q1?"
    evaluation: "grade"
`;
    const quiz = compound("  - id: intro\n    url: ./intro.yaml");
    const result = await loadAndCheckQuiz(
      BASE,
      fetcherMap({ [BASE]: quiz, [INTRO_URL]: brokenInclude, [LIB_URL]: LIB_YAML }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("QUIZ_INCLUDE_UNREADABLE");
      expect(result.errors[0]?.fileAlias).toBe("intro");
    }
  });
});
