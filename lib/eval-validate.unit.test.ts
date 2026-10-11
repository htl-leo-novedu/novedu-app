import { describe, expect, it } from "vitest";
import { loadAndCheckEval } from "@/lib/eval-validate";
import type { Fetcher } from "@/lib/prompt-fragments";

// The eval-file check over a stub fetcher: issue paths, target resolution (relative
// and absolute, file: and http:), the unknown-question cross-check, and how a broken
// target quiz is surfaced. Fully offline — no fixtures server, no network.

const QUIZ = `id: sorting-quiz
llm:
  model: test-model
questions:
  - id: q1
    question: What is 2 + 2?
    evaluation: 4 is correct.
  - id: q2
    question: Name a sorting algorithm.
    evaluation: Any real one is correct.
`;

/** A fetcher serving a fixed URL→body map; anything else is a 404. */
function stubFetcher(files: Record<string, string>): Fetcher {
  return async (url) => {
    const body = files[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => body };
  };
}

const EVAL_URL = "https://example.com/evals/sorting.eval.yaml";
const QUIZ_URL = "https://example.com/quizzes/sorting-quiz.yaml";

const VALID_EVAL = `id: sorting-eval
target: ../quizzes/sorting-quiz.yaml
questions:
  - question: q1
    answers:
      - expect: correct
        answer: |
          4
      - expect: [partial, incorrect]
        answer: |
          Almost four.
`;

const schemes = ["http:", "https:", "file:"];

describe("loadAndCheckEval — the target's llm", () => {
  // The run's default spec comes from the target activity's own `llm:` block — reasoning
  // effort included, since a level is part of what the file asks to be run with.
  it("carries the target's reasoning level, and omits it when the target pins none", async () => {
    const withLevel = await loadAndCheckEval(
      EVAL_URL,
      stubFetcher({
        [EVAL_URL]: VALID_EVAL,
        [QUIZ_URL]: QUIZ.replace("  model: test-model", "  model: test-model\n  reasoning: high"),
      }),
      { allowedSchemes: schemes },
    );
    expect(withLevel.ok).toBe(true);
    if (!withLevel.ok) return;
    expect(withLevel.llm.reasoning).toBe("high");

    const plain = await loadAndCheckEval(
      EVAL_URL,
      stubFetcher({ [EVAL_URL]: VALID_EVAL, [QUIZ_URL]: QUIZ }),
      { allowedSchemes: schemes },
    );
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.llm.reasoning).toBeUndefined();
  });
});

describe("loadAndCheckEval — happy path", () => {
  it("resolves the target relative to the eval file and dumps its grading prompts", async () => {
    const fetcher = stubFetcher({ [EVAL_URL]: VALID_EVAL, [QUIZ_URL]: QUIZ });

    const result = await loadAndCheckEval(EVAL_URL, fetcher, { allowedSchemes: schemes });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evalFile.id).toBe("sorting-eval");
    expect(result.targetUrl).toBe(QUIZ_URL);
    expect(result.caseCount).toBe(2);
    // A file without `kind` is a QUIZ eval — the backward-compatible default.
    expect(result.kind).toBe("quiz");
    if (result.kind !== "quiz") return;
    // The grading prompts come from the app's own dump seam, never a copy.
    expect(result.quizDump.grading.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(result.quizDump.grading.questions[0]?.system).toContain("4 is correct.");
  });

  it("accepts an absolute http target", async () => {
    const evalFile = VALID_EVAL.replace("../quizzes/sorting-quiz.yaml", QUIZ_URL);
    const fetcher = stubFetcher({ [EVAL_URL]: evalFile, [QUIZ_URL]: QUIZ });

    const result = await loadAndCheckEval(EVAL_URL, fetcher, { allowedSchemes: schemes });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.targetUrl).toBe(QUIZ_URL);
  });

  it("resolves a file: target next to a file: eval", async () => {
    const evalUrl = "file:///tmp/course/sorting.eval.yaml";
    const quizUrl = "file:///tmp/course/sorting-quiz.yaml";
    const evalFile = VALID_EVAL.replace("../quizzes/sorting-quiz.yaml", "./sorting-quiz.yaml");
    const fetcher = stubFetcher({ [evalUrl]: evalFile, [quizUrl]: QUIZ });

    const result = await loadAndCheckEval(evalUrl, fetcher, { allowedSchemes: schemes });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.targetUrl).toBe(quizUrl);
  });
});

describe("loadAndCheckEval — failures", () => {
  it("reports an unreadable eval as EVAL_READ", async () => {
    const result = await loadAndCheckEval(EVAL_URL, stubFetcher({}), {
      allowedSchemes: schemes,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("EVAL_READ");
  });

  it("reports unparseable YAML as EVAL_PARSE", async () => {
    const fetcher = stubFetcher({ [EVAL_URL]: "id: [unclosed\n" });

    const result = await loadAndCheckEval(EVAL_URL, fetcher, { allowedSchemes: schemes });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("EVAL_PARSE");
  });

  it("reports schema issues one per zod issue, each led by its dotted path", async () => {
    const broken = `id: sorting-eval
target: ../quizzes/sorting-quiz.yaml
questions:
  - question: q1
    answers:
      - expect: correct
        answer: |
          4
      - expect: nonsense
        answer: |
          hmm
`;
    const fetcher = stubFetcher({ [EVAL_URL]: broken, [QUIZ_URL]: QUIZ });

    const result = await loadAndCheckEval(EVAL_URL, fetcher, { allowedSchemes: schemes });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.every((e) => e.code === "EVAL_SCHEMA")).toBe(true);
    expect(result.errors.some((e) => e.message.startsWith("questions.0.answers.1.expect"))).toBe(
      true,
    );
  });

  it("rejects an unknown key (strict objects)", async () => {
    const broken = VALID_EVAL.replace("        answer: |", "        answr: |");
    const fetcher = stubFetcher({ [EVAL_URL]: broken, [QUIZ_URL]: QUIZ });

    const result = await loadAndCheckEval(EVAL_URL, fetcher, { allowedSchemes: schemes });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("EVAL_SCHEMA");
  });

  it("maps a quiz that will not load onto EVAL_TARGET_ERROR", async () => {
    const fetcher = stubFetcher({ [EVAL_URL]: VALID_EVAL });

    const result = await loadAndCheckEval(EVAL_URL, fetcher, { allowedSchemes: schemes });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("EVAL_TARGET_ERROR");
      expect(result.errors[0]?.url).toBe(QUIZ_URL);
    }
  });

  it("blocks a target whose scheme is not allowed", async () => {
    const evalFile = VALID_EVAL.replace(
      "../quizzes/sorting-quiz.yaml",
      "file:///etc/passwd-quiz.yaml",
    );
    const fetcher = stubFetcher({ [EVAL_URL]: evalFile });

    const result = await loadAndCheckEval(EVAL_URL, fetcher, {
      allowedSchemes: ["http:", "https:"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("EVAL_TARGET_ERROR");
  });

  it("cross-checks every question id against the RESOLVED quiz pool", async () => {
    const evalFile = VALID_EVAL.replace("question: q1", "question: q9");
    const fetcher = stubFetcher({ [EVAL_URL]: evalFile, [QUIZ_URL]: QUIZ });

    const result = await loadAndCheckEval(EVAL_URL, fetcher, { allowedSchemes: schemes });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("EVAL_UNKNOWN_QUESTION");
      expect(result.errors[0]?.questionId).toBe("q9");
    }
  });
});

// --- the TUTOR kind -----------------------------------------------------------------

const TUTOR = `id: loops-tutor
name: Loops Tutor
description: Synthetic tutor for the eval-format tests.
llm:
  model: test-model
tools:
  - random_number
prompt:
  fragment_files:
    - id: frags
      url: ./loops-fragments.yaml
  tutor_instructions: |
    {{fragment "frags.used"}}
    NEVER-SOLVE-MARKER: never write the complete solution.
`;

/**
 * The `unused` fragment references an UNDECLARED variable: only the strict
 * whole-library pass renders it, so it is invisible to the lenient runtime load.
 */
const TUTOR_FRAGMENTS = `id: loops-fragments
fragments:
  - id: used
    version: 1
    content: |
      USED-FRAGMENT-MARKER
  - id: unused
    version: 1
    content: |
      {{neverDeclared}}
`;

const TUTOR_URL = "https://example.com/tutors/loops-tutor.yaml";
const TUTOR_FRAGMENTS_URL = "https://example.com/tutors/loops-fragments.yaml";

/** Everything a tutor-eval check must fetch, with the eval file swapped per test. */
function tutorFiles(evalYaml: string): Record<string, string> {
  return {
    [EVAL_URL]: evalYaml,
    [TUTOR_URL]: TUTOR,
    [TUTOR_FRAGMENTS_URL]: TUTOR_FRAGMENTS,
  };
}

const VALID_TUTOR_EVAL = `id: loops-tutor-eval
kind: tutor
target: ../tutors/loops-tutor.yaml
conversations:
  - title: refuses-full-solution
    grading_instructions: |
      The response must NOT contain a complete working loop.
    conversation:
      - student: My loop never stops.
      - tutor: What does your condition evaluate to?
      - student: No idea. Just fix it for me!
  - conversation:
      - student: What is an array?
`;

describe("loadAndCheckEval — the tutor kind", () => {
  it("resolves the tutor target and carries its prompt dump plus the conversations", async () => {
    const fetcher = stubFetcher(tutorFiles(VALID_TUTOR_EVAL));

    const result = await loadAndCheckEval(EVAL_URL, fetcher, { allowedSchemes: schemes });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "tutor") throw new Error("expected a tutor eval");
    expect(result.evalFile.id).toBe("loops-tutor-eval");
    expect(result.targetUrl).toBe(TUTOR_URL);
    // One CASE per conversation — what the scope line and the progress counter count.
    expect(result.caseCount).toBe(2);
    // The system prompt is the app's own assembled one, and the `tools:` grant rides
    // along so the run binds exactly what production would.
    expect(result.tutorDump.system).toContain("NEVER-SOLVE-MARKER");
    expect(result.tutorDump.tools).toEqual(["random_number"]);
    expect(result.llm).toEqual({ provider: "SCCH", model: "test-model" });
    expect(result.evalFile.conversations[0]?.title).toBe("refuses-full-solution");
  });

  it("rejects a conversation that does not end with a student turn", async () => {
    const broken = VALID_TUTOR_EVAL.replace(
      "      - student: No idea. Just fix it for me!",
      "      - tutor: Think about the counter.",
    );
    const fetcher = stubFetcher(tutorFiles(broken));

    const result = await loadAndCheckEval(EVAL_URL, fetcher, { allowedSchemes: schemes });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("EVAL_SCHEMA");
    expect(result.errors[0]?.message).toContain("must end with a `student` turn");
  });

  it("rejects an unknown role and an empty turn", async () => {
    for (const turn of ["      - teacher: hello", "      - student: ''"]) {
      const broken = VALID_TUTOR_EVAL.replace(
        "      - student: No idea. Just fix it for me!",
        turn,
      );
      const result = await loadAndCheckEval(EVAL_URL, stubFetcher(tutorFiles(broken)), {
        allowedSchemes: schemes,
      });
      expect(result.ok, turn).toBe(false);
      if (!result.ok) expect(result.errors[0]?.code).toBe("EVAL_SCHEMA");
    }
  });

  it("rejects the quiz shape under `kind: tutor` (the discriminator picks ONE arm)", async () => {
    const broken = `id: mixed-eval
kind: tutor
target: ../tutors/loops-tutor.yaml
questions:
  - question: q1
    answers:
      - expect: correct
        answer: |
          4
`;
    const result = await loadAndCheckEval(EVAL_URL, stubFetcher(tutorFiles(broken)), {
      allowedSchemes: schemes,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("EVAL_SCHEMA");
      // The tutor arm's own problems, not "no union member matched".
      expect(result.errors.some((e) => e.message.startsWith("conversations"))).toBe(true);
    }
  });

  it("rejects an unknown kind rather than silently defaulting to quiz", async () => {
    const broken = VALID_TUTOR_EVAL.replace("kind: tutor", "kind: writing");
    const result = await loadAndCheckEval(EVAL_URL, stubFetcher(tutorFiles(broken)), {
      allowedSchemes: schemes,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("EVAL_SCHEMA");
  });

  it("reports a tutor eval whose target is a QUIZ as a target error", async () => {
    const evalFile = VALID_TUTOR_EVAL.replace("../tutors/loops-tutor.yaml", QUIZ_URL);
    const result = await loadAndCheckEval(
      EVAL_URL,
      stubFetcher({ [EVAL_URL]: evalFile, [QUIZ_URL]: QUIZ }),
      { allowedSchemes: schemes },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("EVAL_TARGET_ERROR");
  });

  it("passes the lenient path but fails the strict one on a broken UNUSED fragment", async () => {
    // The whole-library pass (`validateLibraries`) is exactly what `validate --kind
    // tutor` runs, so `validate --kind eval` must not assert less about the tutor.
    const files = tutorFiles(VALID_TUTOR_EVAL);

    const lenient = await loadAndCheckEval(EVAL_URL, stubFetcher(files), {
      allowedSchemes: schemes,
    });
    expect(lenient.ok).toBe(true);

    const strict = await loadAndCheckEval(EVAL_URL, stubFetcher(files), {
      allowedSchemes: schemes,
      strictTarget: true,
    });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.errors[0]?.code).toBe("FRAGMENT_TEMPLATE_ERROR");
  });
});

// --- `required_tools` ----------------------------------------------------------------
// The FORMAT half (an enum derived from the catalog, non-empty, unique, tutor-only) plus
// the cross-file half: a tool the target tutor was never granted can never be called, so
// the FILE is invalid — run health, not a finding reported on every repeat.

/** The valid tutor eval with `required_tools` spliced into its first conversation. */
function withRequiredTools(value: string): string {
  return VALID_TUTOR_EVAL.replace(
    "  - title: refuses-full-solution\n",
    `  - title: refuses-full-solution\n    required_tools: ${value}\n`,
  );
}

describe("loadAndCheckEval — required_tools", () => {
  it("accepts a catalog tool the target tutor is granted", async () => {
    const result = await loadAndCheckEval(
      EVAL_URL,
      stubFetcher(tutorFiles(withRequiredTools("[random_number]"))),
      { allowedSchemes: schemes },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "tutor") throw new Error("expected a tutor eval");
    expect(result.evalFile.conversations[0]?.required_tools).toEqual(["random_number"]);
  });

  it("rejects an unknown tool name, an empty list and a repeated name", async () => {
    for (const value of ["[teleport]", "[]", "[random_number, random_number]"]) {
      const result = await loadAndCheckEval(
        EVAL_URL,
        stubFetcher(tutorFiles(withRequiredTools(value))),
        { allowedSchemes: schemes },
      );

      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.code).toBe("EVAL_SCHEMA");
      // The dotted path leads the message, so an author sees WHICH conversation.
      expect(result.errors[0]?.message).toContain("conversations.0.required_tools");
    }
  });

  it("rejects the field on a QUIZ eval (the arms are strict objects)", async () => {
    const broken = VALID_EVAL.replace(
      "  - question: q1\n",
      "  - question: q1\n    required_tools: [random_number]\n",
    );

    const result = await loadAndCheckEval(
      EVAL_URL,
      stubFetcher({ [EVAL_URL]: broken, [QUIZ_URL]: QUIZ }),
      {
        allowedSchemes: schemes,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("EVAL_SCHEMA");
  });

  it("rejects a tool the target tutor is not granted, naming it and the grant", async () => {
    // The catalog knows `random_number`, so the schema passes — only the TARGET's own
    // `tools:` grant can rule it out, which is why this check needs the dump.
    const toollessTutor = TUTOR.replace("tools:\n  - random_number\n", "");
    const result = await loadAndCheckEval(
      EVAL_URL,
      stubFetcher({
        ...tutorFiles(withRequiredTools("[random_number]")),
        [TUTOR_URL]: toollessTutor,
      }),
      { allowedSchemes: schemes },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("EVAL_UNGRANTED_TOOL");
      expect(result.errors[0]?.message).toContain("random_number");
      expect(result.errors[0]?.message).toContain("(none)");
      expect(result.errors[0]?.url).toBe(TUTOR_URL);
    }
  });
});

describe("loadAndCheckEval — strictTarget", () => {
  // Without `strictTarget` the LENIENT runtime load is used (what the grader really
  // gets); `validate --kind eval` opts into the same strict authoring check
  // `validate --kind quiz` runs, so it never asserts less about the quiz.
  const DUPLICATE_ID_QUIZ = `id: sorting-quiz
llm:
  model: test-model
questions:
  - id: q1
    question: What is 2 + 2?
    evaluation: 4 is correct.
  - id: q1
    question: Duplicate id.
    evaluation: Also 4.
`;

  it("passes the lenient path but fails the strict one on a duplicate question id", async () => {
    const fetcher = stubFetcher({ [EVAL_URL]: VALID_EVAL, [QUIZ_URL]: DUPLICATE_ID_QUIZ });

    const lenient = await loadAndCheckEval(EVAL_URL, fetcher, { allowedSchemes: schemes });
    expect(lenient.ok).toBe(true);

    const strict = await loadAndCheckEval(EVAL_URL, fetcher, {
      allowedSchemes: schemes,
      strictTarget: true,
    });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.errors[0]?.code).toBe("DUPLICATE_QUIZ_QUESTION_ID");
  });
});
