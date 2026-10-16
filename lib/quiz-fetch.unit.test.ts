import { beforeEach, describe, expect, it, vi } from "vitest";

// loadQuiz renders the quiz-level `instructions` host text (with inline `{{fragment}}`
// markers resolved) into the server-only `Quiz.instructionsPreamble`. Hermetic: the
// app-hosted seam is mocked to serve fixture YAML from an in-process map (no DB, no
// network), keyed by URL.

const state = vi.hoisted(() => ({ bodies: {} as Record<string, string>, fetched: [] as string[] }));

vi.mock("@/lib/app-hosted-fetcher", () => ({
  serverYamlFetcher: async () => async (url: string) => {
    state.fetched.push(url);
    const text = state.bodies[url];
    return text === undefined
      ? { ok: false as const, status: 404, text: async () => "" }
      : { ok: true as const, status: 200, text: async () => text };
  },
}));

import { loadQuiz } from "@/lib/quiz-fetch";
import { toPublicQuiz } from "@/lib/quiz-yaml";

const QUIZ_URL = "https://app.test/api/files/quiz";
const LIB_URL = "https://example.com/lib.yaml";
const LIB_YAML = `id: lib
fragments:
  - id: safety
    version: 1
    content: |
      SAFETY-MARKER be kind.
  - id: lang
    input_schema:
      type: object
      required: [language]
      properties:
        language:
          type: string
    content: |
      LANG-MARKER respond in {{language}}.
`;

const quizYaml = (extra = "") => `
id: q
llm:
  model: m
${extra}
questions:
  - id: a
    question: "Q?"
    evaluation: "grade"
`;

// The library reference + an `instructions` host text that places LANG before SAFETY.
const withFragments = (instructions: string) => `fragment_files:
  - id: lib
    url: ${LIB_URL}
instructions: |
${instructions}`;

beforeEach(() => {
  state.bodies = {};
  state.fetched = [];
});

describe("loadQuiz — instructionsPreamble", () => {
  it("renders the instructions host text with fragments placed where their markers sit", async () => {
    state.bodies = {
      [QUIZ_URL]: quizYaml(
        withFragments('  {{fragment "lib.lang" language="German"}}\n\n  {{fragment "lib.safety"}}'),
      ),
      [LIB_URL]: LIB_YAML,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz.instructionsPreamble).toContain("SAFETY-MARKER");
      expect(result.quiz.instructionsPreamble).toContain("LANG-MARKER respond in German.");
      // Textual placement: the lang marker sits before the safety marker.
      expect(result.quiz.instructionsPreamble.indexOf("LANG-MARKER")).toBeLessThan(
        result.quiz.instructionsPreamble.indexOf("SAFETY-MARKER"),
      );
    }
  });

  it("leaves the preamble empty for a plain quiz (no fragments) and does not leak it", async () => {
    state.bodies = { [QUIZ_URL]: quizYaml() };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz.instructionsPreamble).toBe("");
      // The public projection never carries the server-only fragment fields.
      const pub = toPublicQuiz(result.quiz);
      expect(pub).not.toHaveProperty("instructionsPreamble");
      expect(pub).not.toHaveProperty("instructions");
      expect(pub).not.toHaveProperty("fragmentBlock");
    }
  });

  it("fails closed when a referenced fragment library cannot be fetched", async () => {
    state.bodies = {
      // The library URL is intentionally absent → 404 on the fragment fetch.
      [QUIZ_URL]: quizYaml(withFragments('  {{fragment "lib.safety"}}')),
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(false);
  });

  it("does not leak a NON-empty rendered preamble through toPublicQuiz", async () => {
    state.bodies = {
      [QUIZ_URL]: quizYaml(withFragments('  {{fragment "lib.safety"}}')),
      [LIB_URL]: LIB_YAML,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Guard: the preamble really is non-empty, so the projection is exercised on the
      // path that matters (an all-empty preamble would strip trivially).
      expect(result.quiz.instructionsPreamble).toContain("SAFETY-MARKER");
      const pub = toPublicQuiz(result.quiz);
      expect(pub).not.toHaveProperty("instructionsPreamble");
      expect(pub).not.toHaveProperty("fragmentBlock");
      // The server-only fragment text must not appear ANYWHERE in the client projection.
      expect(JSON.stringify(pub)).not.toContain("SAFETY-MARKER");
    }
  });

  it("carries the effective questionCount into the loaded quiz and its projection", async () => {
    state.bodies = { [QUIZ_URL]: `question_count: 7\n${quizYaml()}` };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz.questionCount).toBe(7);
      expect(toPublicQuiz(result.quiz).questionCount).toBe(7);
    }
  });

  it("fails closed when a fragment file URL uses a disallowed scheme (SSRF gate)", async () => {
    // Even though the mocked fetcher WOULD serve this URL, the http(s)-only scheme gate
    // must reject it BEFORE any fetch — the runtime lenient reader skips the Zod URL
    // refine that guards the tutor path, so the gate in `assembleFragmentPrompt` is the
    // structural backstop.
    const BAD_URL = "file:///etc/passwd";
    state.bodies = {
      [BAD_URL]: LIB_YAML,
      [QUIZ_URL]: quizYaml(`fragment_files:
  - id: lib
    url: ${BAD_URL}
instructions: |
  {{fragment "lib.safety"}}`),
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result).toEqual({
      ok: false,
      message: "This quiz's prompt fragments could not be loaded.",
    });
    expect(state.fetched).toEqual([QUIZ_URL]);
  });
});

// --- quiz_files live includes ------------------------------------------------------
// A compound quiz pulls ALL questions of the referenced quiz files, fresh on every
// load: ids are namespaced "<alias>/<id>", each imported question travels with its
// SOURCE quiz's rendered `instructions` preamble and source-effective imageInput,
// and relative image paths absolutize against the SOURCE url. Fail-closed on any
// structural problem — the final exam must never silently shrink.

const CHAPTERS = "https://chapters.example";
const INTRO_URL = `${CHAPTERS}/0010-introduction-quiz.yaml`;
const LOOPS_URL = `${CHAPTERS}/0020-loops-quiz.yaml`;

const INTRO_QUIZ = `
id: intro
llm:
  model: chapter-model
  imageInput: true
instructions: |
  INTRO-PREAMBLE grade gently.
questions:
  - id: q1
    question: "Intro Q1?"
    evaluation: "intro grade 1"
    image:
      src: ./figures/pic.png
  - id: q2
    question: "Intro Q2?"
    evaluation: "intro grade 2"
    imageInput: false
`;

const LOOPS_QUIZ = `
id: loops
llm:
  model: other-model
questions:
  - id: q1
    question: "Loops Q1?"
    evaluation: "loops grade 1"
    image:
      hosted: true
      src: loop-diagram
  - id: q2
    question: "Loops Q2?"
    evaluation: "loops grade 2"
    image:
      src: https://static.example/abs.png
`;

const compoundYaml = (extra = "") => `
id: final
llm:
  model: final-model
quiz_files:
  - id: intro
    url: ${INTRO_URL}
  - id: loops
    url: ${LOOPS_URL}
${extra}
questions:
  - id: own
    question: "Own Q?"
    evaluation: "own grade"
`;

describe("loadQuiz — quiz_files includes", () => {
  it("merges every include's questions with namespaced ids, in declared order", async () => {
    state.bodies = {
      [QUIZ_URL]: compoundYaml(),
      [INTRO_URL]: INTRO_QUIZ,
      [LOOPS_URL]: LOOPS_QUIZ,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.questions.map((q) => q.id)).toEqual([
      "own",
      "intro/q1",
      "intro/q2",
      "loops/q1",
      "loops/q2",
    ]);
    // The consumed include list is cleared — the merged pool is the single truth.
    expect(result.quiz.quizFiles).toEqual([]);
    // The compound's own top level governs: its model, its (absent) preamble.
    expect(result.quiz.model).toBe("final-model");
  });

  it("supports a compound quiz with ZERO own questions and relative include URLs", async () => {
    const rootRelative = `
id: final
llm:
  model: final-model
quiz_files:
  - id: intro
    url: ./intro.yaml
`;
    state.bodies = {
      [QUIZ_URL]: rootRelative,
      // ./intro.yaml resolves against the compound quiz's own URL.
      "https://app.test/api/files/intro.yaml": INTRO_QUIZ,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz.questions.map((q) => q.id)).toEqual(["intro/q1", "intro/q2"]);
    }
  });

  it("renders each imported question's sourcePreamble from the SOURCE quiz", async () => {
    // The source declares a RELATIVE fragment library — it must resolve against the
    // SOURCE's own URL (chapters.example), not the compound quiz's.
    const introWithFragments = `
id: intro
llm:
  model: chapter-model
fragment_files:
  - id: lib
    url: ./lib.yaml
instructions: |
  {{fragment "lib.safety"}}
questions:
  - id: q1
    question: "Intro Q1?"
    evaluation: "intro grade 1"
`;
    state.bodies = {
      [QUIZ_URL]: compoundYaml(),
      [INTRO_URL]: introWithFragments,
      [`${CHAPTERS}/lib.yaml`]: LIB_YAML,
      [LOOPS_URL]: LOOPS_QUIZ,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.quiz.questions.map((q) => [q.id, q]));
    expect(byId.get("intro/q1")?.sourcePreamble).toContain("SAFETY-MARKER");
    // Questions from a source WITHOUT instructions carry no preamble; own ones never do.
    expect(byId.get("loops/q1")?.sourcePreamble).toBeUndefined();
    expect(byId.get("own")?.sourcePreamble).toBeUndefined();
  });

  it("materializes the SOURCE-effective imageInput as an explicit per-question boolean", async () => {
    state.bodies = {
      [QUIZ_URL]: compoundYaml(),
      [INTRO_URL]: INTRO_QUIZ,
      [LOOPS_URL]: LOOPS_QUIZ,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.quiz.questions.map((q) => [q.id, q]));
    // intro: quiz-level imageInput true — q1 inherits it, q2 overrides to false.
    expect(byId.get("intro/q1")?.imageInput).toBe(true);
    expect(byId.get("intro/q2")?.imageInput).toBe(false);
    // The COMPOUND quiz's own imageInput (false) must not re-interpret imports:
    // the public projection keeps the source-effective values.
    const pub = toPublicQuiz(result.quiz);
    const pubById = new Map(pub.questions.map((q) => [q.id, q]));
    expect(pubById.get("intro/q1")?.imageInput).toBe(true);
    expect(pubById.get("own")?.imageInput).toBe(false);
  });

  it("absolutizes relative image paths against the SOURCE url; hosted/absolute pass through", async () => {
    state.bodies = {
      [QUIZ_URL]: compoundYaml(),
      [INTRO_URL]: INTRO_QUIZ,
      [LOOPS_URL]: LOOPS_QUIZ,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.quiz.questions.map((q) => [q.id, q]));
    expect(byId.get("intro/q1")?.image).toEqual({
      hosted: false,
      src: `${CHAPTERS}/figures/pic.png`,
    });
    expect(byId.get("loops/q1")?.image).toEqual({ hosted: true, src: "loop-diagram" });
    expect(byId.get("loops/q2")?.image).toEqual({
      hosted: false,
      src: "https://static.example/abs.png",
    });
  });

  it("fails closed on an unfetchable include", async () => {
    state.bodies = {
      [QUIZ_URL]: compoundYaml(),
      [INTRO_URL]: INTRO_QUIZ,
      // LOOPS_URL intentionally absent → 404.
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"loops"');
  });

  it("fails closed on an include that does not parse as a quiz", async () => {
    state.bodies = {
      [QUIZ_URL]: compoundYaml(),
      [INTRO_URL]: "id: broken\n# no llm, no questions",
      [LOOPS_URL]: LOOPS_QUIZ,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"intro"');
  });

  it("fails closed on a nested include (one level deep only)", async () => {
    const nested = `
id: intro
llm:
  model: m
quiz_files:
  - id: deeper
    url: ./deeper.yaml
questions:
  - id: q1
    question: "Q?"
    evaluation: "grade"
`;
    state.bodies = {
      [QUIZ_URL]: compoundYaml(),
      [INTRO_URL]: nested,
      [LOOPS_URL]: LOOPS_QUIZ,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("nested");
  });

  it("fails closed on a duplicate include alias", async () => {
    const duplicated = `
id: final
llm:
  model: final-model
quiz_files:
  - id: intro
    url: ${INTRO_URL}
  - id: intro
    url: ${LOOPS_URL}
`;
    state.bodies = {
      [QUIZ_URL]: duplicated,
      [INTRO_URL]: INTRO_QUIZ,
      [LOOPS_URL]: LOOPS_QUIZ,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(false);
  });

  it("fails closed on a malformed alias (dot or slash) or a non-http(s) include URL", async () => {
    for (const entry of [
      "  - id: bad.alias\n    url: https://chapters.example/x.yaml",
      "  - id: bad/alias\n    url: https://chapters.example/x.yaml",
      "  - id: intro\n    url: file:///etc/passwd",
    ]) {
      state.bodies = {
        [QUIZ_URL]: `\nid: final\nllm:\n  model: m\nquiz_files:\n${entry}\n`,
        "https://chapters.example/x.yaml": INTRO_QUIZ,
        "file:///etc/passwd": INTRO_QUIZ,
      };
      const result = await loadQuiz(QUIZ_URL);
      expect(result.ok, entry).toBe(false);
    }
  });

  it("never leaks a sourcePreamble (or any include machinery) through toPublicQuiz", async () => {
    const introWithFragments = `
id: intro
llm:
  model: chapter-model
instructions: |
  INTRO-SECRET-PREAMBLE the expected tone.
questions:
  - id: q1
    question: "Intro Q1?"
    evaluation: "INTRO-SECRET-EVALUATION"
`;
    state.bodies = {
      [QUIZ_URL]: compoundYaml(),
      [INTRO_URL]: introWithFragments,
      [LOOPS_URL]: LOOPS_QUIZ,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Guard: the preamble really is on the server-side question.
    expect(result.quiz.questions.find((q) => q.id === "intro/q1")?.sourcePreamble).toContain(
      "INTRO-SECRET-PREAMBLE",
    );
    const serialized = JSON.stringify(toPublicQuiz(result.quiz));
    expect(serialized).not.toContain("INTRO-SECRET-PREAMBLE");
    expect(serialized).not.toContain("INTRO-SECRET-EVALUATION");
    expect(serialized).not.toContain("quizFiles");
  });
});

describe("loadQuiz — discussion.instructions as a second host text", () => {
  it("renders discussion.instructions markers against the SAME fragment block", async () => {
    state.bodies = {
      [QUIZ_URL]: quizYaml(`fragment_files:
  - id: lib
    url: ${LIB_URL}
instructions: |
  {{fragment "lib.safety"}}
discussion:
  instructions: |
    {{fragment "lib.lang" language="French"}}`),
      [LIB_URL]: LIB_YAML,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz.instructionsPreamble).toContain("SAFETY-MARKER");
      expect(result.quiz.discussionInstructions).toContain("LANG-MARKER respond in French.");
      // Each host renders independently — no cross-bleed between the two.
      expect(result.quiz.discussionInstructions).not.toContain("SAFETY-MARKER");
    }
  });

  it("fails the whole load when a discussion.instructions marker is broken", async () => {
    state.bodies = {
      [QUIZ_URL]: quizYaml(`fragment_files:
  - id: lib
    url: ${LIB_URL}
discussion:
  instructions: |
    {{fragment "missing.frag"}}`),
      [LIB_URL]: LIB_YAML,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result).toEqual({
      ok: false,
      message: "This quiz's prompt fragments could not be loaded.",
    });
  });

  it("keeps discussion.instructions byte-verbatim on a plain quiz (no lists declared)", async () => {
    state.bodies = {
      [QUIZ_URL]: quizYaml(`discussion:
  instructions: "A literal {{fragment \\"a.b\\"}} stays put."`),
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz.discussionInstructions).toBe('A literal {{fragment "a.b"}} stays put.');
    }
  });

  it("collapses a whitespace-only rendered discussion guidance back to undefined", async () => {
    // A fragment whose content is blank renders to nothing but the surrounding
    // newlines — that must read as "no discussion guidance", not an empty string.
    state.bodies = {
      [QUIZ_URL]: quizYaml(`fragment_files:
  - id: lib
    url: ${LIB_URL}
discussion:
  instructions: |
    {{fragment "lib.blank"}}`),
      [LIB_URL]: `${LIB_YAML}  - id: blank
    version: 1
    content: "   "
`,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quiz.discussionInstructions).toBeUndefined();
  });

  it("ignores an INCLUDED chapter's broken discussion.instructions at runtime", async () => {
    // Deliberate asymmetry: `resolveInclude` renders only the chapter's `instructions`
    // (the compound quiz governs the discussion), so a chapter marker the AUTHORING gate
    // rejects (`checkInclude`) must NOT fail a runtime compound load. Pins the leniency
    // so a future change to `resolveInclude` cannot silently break live compound quizzes.
    const introBrokenDiscussion = `
id: intro
llm:
  model: chapter-model
fragment_files:
  - id: lib
    url: ${LIB_URL}
instructions: |
  {{fragment "lib.safety"}}
discussion:
  instructions: |
    {{fragment "lib.does-not-exist"}}
questions:
  - id: q1
    question: "Intro Q1?"
    evaluation: "intro grade 1"
`;
    state.bodies = {
      [QUIZ_URL]: compoundYaml(),
      [INTRO_URL]: introBrokenDiscussion,
      [LIB_URL]: LIB_YAML,
      [LOOPS_URL]: LOOPS_QUIZ,
    };
    const result = await loadQuiz(QUIZ_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The chapter's `instructions` preamble still travels with its questions.
    expect(result.quiz.questions.find((q) => q.id === "intro/q1")?.sourcePreamble).toContain(
      "SAFETY-MARKER",
    );
  });
});
