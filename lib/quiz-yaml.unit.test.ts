import { assert, describe, expect, it } from "vitest";
import { parseQuiz, type Quiz, toPublicQuiz } from "@/lib/quiz-yaml";

const VALID = `
id: countries-basics
name: "Countries"
title: "World Geography Quiz"
description: |
  A short quiz.
anonymous: false
shuffle: false
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
discussion:
  instructions: |
    Be a friendly tutor.
questions:
  - id: capital-australia
    title: "Capital of Australia"
    question: |
      What is the **capital** of Australia?
    evaluation: |
      The correct answer is Canberra.
  - id: continents-count
    question: |
      How many continents are there?
    evaluation: |
      Seven.
`;

describe("parseQuiz", () => {
  it("parses a complete quiz", () => {
    const result = parseQuiz(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const q = result.quiz;
    expect(q.id).toBe("countries-basics");
    expect(q.title).toBe("World Geography Quiz");
    expect(q.anonymous).toBe(false);
    expect(q.shuffle).toBe(false);
    expect(q.model).toBe("RedHatAI/gemma-4-31B-it-FP8-Dynamic");
    expect(q.discussionInstructions).toContain("friendly tutor");
    expect(q.questions).toHaveLength(2);
    expect(q.questions[0]?.evaluation).toContain("Canberra");
  });

  it("defaults anonymous and shuffle to true when omitted", () => {
    const result = parseQuiz(`
llm:
  model: m
questions:
  - id: a
    question: Q
    evaluation: E
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.anonymous).toBe(true);
    expect(result.quiz.shuffle).toBe(true);
  });

  // Lenient by design: a stored quiz with a key the strict authoring schema rejects
  // (lib/quiz-validate.ts) keeps running for the codes already handed out.
  it("ignores a key it does not know, so a stored quiz keeps running", () => {
    const result = parseQuiz(`
immediate_feedback: false
llm:
  model: m
questions:
  - id: a
    question: Q
    evaluation: E
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz).not.toHaveProperty("immediateFeedback");
  });

  // The shared prefix (YAML, llm.model/provider/reasoning) is covered by
  // lib/activity-load.unit.test.ts; this proves the wiring and the noun.
  it("carries the llm block and names itself in an llm failure", () => {
    const pinned = parseQuiz(
      "llm:\n  model: m\n  provider: OpenRouter\n  reasoning: high\nquestions:\n  - id: a\n    question: Q\n    evaluation: E\n",
    );
    expect(pinned.ok && pinned.quiz).toMatchObject({
      model: "m",
      provider: "OpenRouter",
      reasoning: "high",
    });
    expect(parseQuiz("questions:\n  - id: a\n    question: Q\n    evaluation: E\n")).toEqual({
      ok: false,
      message: "This quiz does not specify a model (llm.model).",
    });
  });

  it.each([
    ["no questions", "llm:\n  model: m\n"],
    [
      "no complete questions",
      "llm:\n  model: m\nquestions:\n  - id: a\n    question: Q\n", // no evaluation
    ],
  ])("rejects %s with a friendly message", (_label, content) => {
    const result = parseQuiz(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.message).toBe("string");
  });

  it("accepts numeric scalar ids/titles (YAML types them by value)", () => {
    // A teacher writing the natural `- id: 1` must not lose the question: the
    // YAML parser hands `1` over as a number, which must still be a usable id.
    const result = parseQuiz(`
llm:
  model: m
questions:
  - id: 1
    title: 2024
    question: Q1
    evaluation: E1
  - id: 2
    question: Q2
    evaluation: E2
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.questions.map((q) => q.id)).toEqual(["1", "2"]);
    expect(result.quiz.questions[0]?.title).toBe("2024");
  });

  it("parses a question's content image (hosted default false, alt + credit carried)", () => {
    const result = parseQuiz(`
llm:
  model: m
questions:
  - id: a
    question: Q
    evaluation: E
    image:
      hosted: true
      src: diagram
      alt: A diagram
      credit: CC BY 4.0
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.questions[0]?.image).toEqual({
      hosted: true,
      src: "diagram",
      alt: "A diagram",
      credit: "CC BY 4.0",
    });
  });

  it("defaults a question image's hosted flag to false and omits a missing alt", () => {
    const result = parseQuiz(`
llm:
  model: m
questions:
  - id: a
    question: Q
    evaluation: E
    image:
      src: ./pic.png
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.questions[0]?.image).toEqual({ hosted: false, src: "./pic.png" });
  });

  it("leaves image undefined when the question has none", () => {
    const result = parseQuiz(`
llm:
  model: m
questions:
  - id: a
    question: Q
    evaluation: E
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.questions[0]?.image).toBeUndefined();
  });

  it("drops a malformed image (no usable src) but keeps the question", () => {
    const result = parseQuiz(`
llm:
  model: m
questions:
  - id: a
    question: Q
    evaluation: E
    image:
      alt: orphan alt
  - id: b
    question: Q2
    evaluation: E2
    image: not-an-object
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.questions.map((q) => q.id)).toEqual(["a", "b"]);
    expect(result.quiz.questions[0]?.image).toBeUndefined();
    expect(result.quiz.questions[1]?.image).toBeUndefined();
  });

  it("defaults imageInput to false and carries the two-level flags", () => {
    const defaulted = parseQuiz(VALID);
    assert(defaulted?.ok);
    expect(defaulted.quiz.imageInput).toBe(false);
    expect(defaulted.quiz.questions[0]?.imageInput).toBeUndefined();

    const result = parseQuiz(`
llm:
  model: m
  imageInput: true
questions:
  - id: a
    question: Q
    evaluation: E
  - id: b
    question: Q2
    evaluation: E2
    imageInput: false
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.imageInput).toBe(true);
    expect(result.quiz.questions[0]?.imageInput).toBeUndefined();
    expect(result.quiz.questions[1]?.imageInput).toBe(false);
  });

  it("falls back on malformed imageInput values instead of failing the quiz", () => {
    const result = parseQuiz(`
llm:
  model: m
  imageInput: "yes"
questions:
  - id: a
    question: Q
    evaluation: E
    imageInput: 1
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.imageInput).toBe(false);
    expect(result.quiz.questions[0]?.imageInput).toBeUndefined();
  });

  it("lifts a valid question_count and ignores malformed ones (default: pool once)", () => {
    const counted = parseQuiz(`
llm:
  model: m
question_count: 30
questions:
  - id: a
    question: Q
    evaluation: E
`);
    expect(counted.ok && counted.quiz.questionCount).toBe(30);

    for (const malformed of ['"30"', "0", "-2", "1.5", "true"]) {
      const result = parseQuiz(`
llm:
  model: m
question_count: ${malformed}
questions:
  - id: a
    question: Q
    evaluation: E
`);
      expect(result.ok, `question_count: ${malformed}`).toBe(true);
      if (result.ok) expect(result.quiz.questionCount).toBeUndefined();
    }
  });

  it("lifts quiz_files through as-is for loadQuiz to resolve fail-closed", () => {
    const result = parseQuiz(`
llm:
  model: m
quiz_files:
  - id: intro
    url: ./intro-quiz.yaml
questions:
  - id: a
    question: Q
    evaluation: E
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.quizFiles).toEqual([{ id: "intro", url: "./intro-quiz.yaml" }]);
  });

  it("accepts zero own questions when quiz_files is declared, rejects when absent", () => {
    const withIncludes = parseQuiz(`
llm:
  model: m
quiz_files:
  - id: intro
    url: ./intro-quiz.yaml
`);
    expect(withIncludes.ok).toBe(true);
    if (withIncludes.ok) expect(withIncludes.quiz.questions).toEqual([]);

    const withoutIncludes = parseQuiz(`
llm:
  model: m
questions: []
`);
    expect(withoutIncludes.ok).toBe(false);
  });

  it("skips incomplete and duplicate-id questions", () => {
    const result = parseQuiz(`
llm:
  model: m
questions:
  - id: a
    question: Q1
    evaluation: E1
  - id: a
    question: Q1-dup
    evaluation: E1-dup
  - id: b
    question: Q2
    # missing evaluation -> skipped
  - id: c
    question: Q3
    evaluation: E3
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.questions.map((q) => q.id)).toEqual(["a", "c"]);
  });
});

describe("toPublicQuiz", () => {
  it("strips evaluation prompts and server-only fields", () => {
    const result = parseQuiz(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pub = toPublicQuiz(result.quiz);
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain("Canberra"); // evaluation text must not leak
    expect(serialized).not.toContain("gemma"); // model must not leak
    expect(serialized).not.toContain("friendly tutor"); // discussion instructions must not leak
    for (const q of pub.questions) {
      expect(q).not.toHaveProperty("evaluation");
    }
    expect(pub.questions).toHaveLength(2);
    expect(pub.title).toBe("World Geography Quiz");
    expect(pub.shuffle).toBe(false);
  });

  it("does not carry the anonymous flag to the client", () => {
    const quiz: Quiz = {
      id: "x",
      anonymous: false,
      shuffle: true,
      model: "m",
      provider: "SCCH",
      imageInput: false,
      fragmentBlock: { fragment_files: [], text_files: [] },
      quizFiles: [],
      instructionsPreamble: "",
      questions: [{ id: "a", question: "Q", evaluation: "E" }],
    };
    expect(toPublicQuiz(quiz)).not.toHaveProperty("anonymous");
  });

  it("strips each question's sourcePreamble (server-only, like evaluation)", () => {
    const quiz: Quiz = {
      id: "x",
      anonymous: true,
      shuffle: true,
      model: "m",
      provider: "SCCH",
      imageInput: false,
      fragmentBlock: { fragment_files: [], text_files: [] },
      quizFiles: [],
      instructionsPreamble: "",
      questions: [
        {
          id: "intro/q1",
          question: "Q",
          evaluation: "E",
          sourcePreamble: "SOURCE-PREAMBLE grade in German.",
        },
      ],
    };
    const pub = toPublicQuiz(quiz);
    expect(pub.questions[0]).not.toHaveProperty("sourcePreamble");
    expect(JSON.stringify(pub)).not.toContain("SOURCE-PREAMBLE");
  });

  it("carries the EFFECTIVE questionCount (authored value, else the pool size)", () => {
    const base: Quiz = {
      id: "x",
      anonymous: true,
      shuffle: true,
      model: "m",
      provider: "SCCH",
      imageInput: false,
      fragmentBlock: { fragment_files: [], text_files: [] },
      quizFiles: [],
      instructionsPreamble: "",
      questions: [
        { id: "a", question: "Q", evaluation: "E" },
        { id: "b", question: "Q", evaluation: "E" },
      ],
    };
    expect(toPublicQuiz(base).questionCount).toBe(2); // default: pool size
    expect(toPublicQuiz({ ...base, questionCount: 30 }).questionCount).toBe(30); // drill mode
    expect(toPublicQuiz({ ...base, questionCount: 1 }).questionCount).toBe(1);
  });

  it("carries the raw ImageRef through unchanged (it holds no secret)", () => {
    const image = { hosted: true, src: "diagram", alt: "A diagram" };
    const quiz: Quiz = {
      id: "x",
      anonymous: true,
      shuffle: true,
      model: "m",
      provider: "SCCH",
      imageInput: false,
      fragmentBlock: { fragment_files: [], text_files: [] },
      quizFiles: [],
      instructionsPreamble: "",
      questions: [{ id: "a", question: "Q", evaluation: "E", image }],
    };
    const pub = toPublicQuiz(quiz);
    expect(pub.questions[0]?.image).toEqual(image);
  });

  it("resolves each question's EFFECTIVE imageInput (override beats quiz level)", () => {
    const quiz: Quiz = {
      id: "x",
      anonymous: true,
      shuffle: true,
      model: "m",
      provider: "SCCH",
      imageInput: true,
      fragmentBlock: { fragment_files: [], text_files: [] },
      quizFiles: [],
      instructionsPreamble: "",
      questions: [
        { id: "inherits", question: "Q", evaluation: "E" },
        { id: "opts-out", question: "Q", evaluation: "E", imageInput: false },
      ],
    };
    const pub = toPublicQuiz(quiz);
    expect(pub.questions.map((q) => q.imageInput)).toEqual([true, false]);

    const optIn = toPublicQuiz({
      ...quiz,
      imageInput: false,
      questions: [{ id: "opts-in", question: "Q", evaluation: "E", imageInput: true }],
    });
    expect(optIn.questions[0]?.imageInput).toBe(true);
  });
});
