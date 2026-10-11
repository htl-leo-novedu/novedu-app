import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runValidate } from "./validate";

// In-process, no network: drive the real validate handler (real loader + real
// file fetcher) over the synthetic fixtures under `test-fixtures/activities/`.
// Runs in CI.
const tutorsDir = fileURLToPath(
  new URL("../../../test-fixtures/activities/tutors/", import.meta.url),
);
const quizzesDir = fileURLToPath(
  new URL("../../../test-fixtures/activities/quizzes/", import.meta.url),
);
const writingsDir = fileURLToPath(
  new URL("../../../test-fixtures/activities/writings/", import.meta.url),
);
const codingDir = fileURLToPath(
  new URL("../../../test-fixtures/activities/coding/", import.meta.url),
);
const clozeDir = fileURLToPath(
  new URL("../../../test-fixtures/activities/cloze/", import.meta.url),
);
const evalsDir = fileURLToPath(
  new URL("../../../test-fixtures/activities/evals/", import.meta.url),
);

describe("runValidate — tutors (local files)", () => {
  it("accepts a valid tutor and reports its model", async () => {
    const outcome = await runValidate(`${tutorsDir}test-tutor.yaml`, "tutor");

    expect(outcome.kind).toBe("tutor");
    expect(outcome.result.ok).toBe(true);
    if (outcome.kind === "tutor" && outcome.result.ok) {
      expect(outcome.result.model).toBe("test-model");
      expect(outcome.result.prompt.length).toBeGreaterThan(0);
    }
  });

  it("rejects a broken tutor with structured errors", async () => {
    const outcome = await runValidate(`${tutorsDir}broken-tutor.yaml`, "tutor");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors.length).toBeGreaterThan(0);
      expect(outcome.result.errors[0]?.code).toBeTruthy();
    }
  });

  it("reports a missing file as a FETCH_FAILED error (no throw)", async () => {
    const outcome = await runValidate(`${tutorsDir}does-not-exist.yaml`, "tutor");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors[0]?.code).toBe("FETCH_FAILED");
    }
  });

  it("accepts a tutor that opts into a built-in tool", async () => {
    const outcome = await runValidate(`${tutorsDir}tools-tutor.yaml`, "tutor");

    expect(outcome.kind).toBe("tutor");
    expect(outcome.result.ok).toBe(true);
    if (outcome.kind === "tutor" && outcome.result.ok) {
      expect(outcome.result.tools).toEqual(["random_number"]);
    }
  });

  it("rejects a tutor naming a tool the catalog does not offer", async () => {
    const outcome = await runValidate(`${tutorsDir}broken-tools-tutor.yaml`, "tutor");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors[0]?.code).toBe("TUTOR_SCHEMA_ERROR");
    }
  });

  // The real-model fixture tutors back e2e chat specs, where a schema break would
  // surface as an opaque chat timeout — and the vision one only in a local
  // @live-llm run. This CI-run check names the break directly.
  it.each(["vision-tutor.yaml", "live-tutor.yaml", "live-tools-tutor.yaml"])(
    "keeps the live e2e fixture %s valid",
    async (fixture) => {
      const outcome = await runValidate(`${tutorsDir}${fixture}`, "tutor");

      expect(outcome.result.ok).toBe(true);
    },
  );
});

describe("runValidate — fragment libraries (local files)", () => {
  it("accepts a valid fragment file and lists its fragments", async () => {
    const outcome = await runValidate(`${tutorsDir}test-fragments-a.yaml`, "fragment");

    expect(outcome.kind).toBe("fragment");
    expect(outcome.result.ok).toBe(true);
    if (outcome.kind === "fragment" && outcome.result.ok) {
      expect(outcome.result.fragmentFileId).toBe("test-fragments-a");
      expect(outcome.result.fragmentIds.length).toBeGreaterThan(0);
    }
  });

  it("rejects a fragment file whose template uses an undeclared variable", async () => {
    const outcome = await runValidate(`${tutorsDir}broken-template-fragments.yaml`, "fragment");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors.some((e) => e.code === "FRAGMENT_TEMPLATE_ERROR")).toBe(true);
    }
  });
});

describe("runValidate — quizzes (local files)", () => {
  it("accepts a valid quiz and reports its model + question count", async () => {
    const outcome = await runValidate(`${quizzesDir}test-quiz.yaml`, "quiz");

    expect(outcome.kind).toBe("quiz");
    expect(outcome.result.ok).toBe(true);
    if (outcome.kind === "quiz" && outcome.result.ok) {
      expect(outcome.result.model).toBe("test-model");
      expect(outcome.result.questionCount).toBeGreaterThan(0);
    }
  });

  it("rejects the committed broken quiz with a QUIZ_SCHEMA_ERROR", async () => {
    const outcome = await runValidate(`${quizzesDir}broken-quiz.yaml`, "quiz");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors[0]?.code).toBe("QUIZ_SCHEMA_ERROR");
    }
  });

  it("reports a missing file as a FETCH_FAILED error (no throw)", async () => {
    const outcome = await runValidate(`${quizzesDir}does-not-exist.yaml`, "quiz");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors[0]?.code).toBe("FETCH_FAILED");
    }
  });
});

describe("runValidate — writing activities (local files)", () => {
  it("accepts a valid writing activity and reports its model", async () => {
    const outcome = await runValidate(`${writingsDir}test-writing.yaml`, "writing");

    expect(outcome.kind).toBe("writing");
    expect(outcome.result.ok).toBe(true);
    if (outcome.kind === "writing" && outcome.result.ok) {
      expect(outcome.result.model).toBe("RedHatAI/gemma-4-31B-it-FP8-Dynamic");
    }
  });

  it("rejects the committed broken writing activity with a WRITING_SCHEMA_ERROR", async () => {
    const outcome = await runValidate(`${writingsDir}broken-writing.yaml`, "writing");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors[0]?.code).toBe("WRITING_SCHEMA_ERROR");
    }
  });
});

describe("runValidate — coding activities (local files)", () => {
  it("accepts a valid coding activity and reports its model", async () => {
    const outcome = await runValidate(`${codingDir}test-coding.yaml`, "coding");

    expect(outcome.kind).toBe("coding");
    expect(outcome.result.ok).toBe(true);
    if (outcome.kind === "coding" && outcome.result.ok) {
      expect(outcome.result.model).toBe("test-model");
      expect(outcome.result.codingId).toBe("test-coding");
    }
  });

  it("rejects the committed broken coding activity with a CODING_SCHEMA_ERROR", async () => {
    const outcome = await runValidate(`${codingDir}broken-coding.yaml`, "coding");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors[0]?.code).toBe("CODING_SCHEMA_ERROR");
    }
  });

  it("reports a missing file as a FETCH_FAILED error (no throw)", async () => {
    const outcome = await runValidate(`${codingDir}does-not-exist.yaml`, "coding");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors[0]?.code).toBe("FETCH_FAILED");
    }
  });
});

describe("runValidate — cloze exercises (local files)", () => {
  it("accepts a valid cloze exercise and reports its gap inventory", async () => {
    const outcome = await runValidate(`${clozeDir}test-cloze.yaml`, "cloze");

    expect(outcome.kind).toBe("cloze");
    expect(outcome.result.ok).toBe(true);
    if (outcome.kind === "cloze" && outcome.result.ok) {
      expect(outcome.result.clozeId).toBe("test-cloze");
      expect(outcome.result.gapCount).toBe(3);
      expect(outcome.result.inventory).toBe(
        '3 gaps · 1 "is going to" · 2 "starts" (start) · 3 (empty)',
      );
    }
  });

  it("rejects the committed broken cloze exercise with located gap errors", async () => {
    const outcome = await runValidate(`${clozeDir}broken-cloze.yaml`, "cloze");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors.map((e) => [e.code, e.line])).toEqual([
        ["CLOZE_GAP_SYNTAX", 1],
        ["CLOZE_GAP_SYNTAX", 3],
      ]);
    }
  });
});

describe("runValidate — evals (local files)", () => {
  it("accepts a valid eval and reports its target + case count", async () => {
    const outcome = await runValidate(`${evalsDir}test-eval.yaml`, "eval");

    expect(outcome.kind).toBe("eval");
    expect(outcome.result.ok).toBe(true);
    if (outcome.kind === "eval" && outcome.result.ok) {
      expect(outcome.result.evalFile.id).toBe("test-eval");
      expect(outcome.result.targetUrl).toMatch(/quizzes\/test-quiz\.yaml$/);
      expect(outcome.result.caseCount).toBe(2);
      // The target's grading prompts come from the app's own dump seam.
      expect(outcome.result.kind).toBe("quiz");
      if (outcome.result.kind === "quiz") {
        expect(outcome.result.quizDump.grading.questions[0]?.id).toBe("q1");
      }
    }
  });

  it("rejects the committed broken eval with EVAL_SCHEMA errors", async () => {
    const outcome = await runValidate(`${evalsDir}broken-eval.yaml`, "eval");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors[0]?.code).toBe("EVAL_SCHEMA");
    }
  });

  it("reports a missing eval file as an EVAL_READ error (no throw)", async () => {
    const outcome = await runValidate(`${evalsDir}does-not-exist.yaml`, "eval");

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.errors[0]?.code).toBe("EVAL_READ");
    }
  });
});
