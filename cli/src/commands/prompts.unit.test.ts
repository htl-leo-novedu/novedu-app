import { fileURLToPath } from "node:url";
import { assert, describe, expect, it } from "vitest";
import { runPrompts } from "./prompts";

// In-process, no network: drive the real prompts handler (real runtime loaders + real
// file fetcher) over the synthetic fixtures under `test-fixtures/activities/`, exactly
// like `validate.unit.test.ts` does. Runs in CI.
const activitiesDir = fileURLToPath(new URL("../../../test-fixtures/activities/", import.meta.url));
const tutorsDir = `${activitiesDir}tutors/`;
const quizzesDir = `${activitiesDir}quizzes/`;
const writingsDir = `${activitiesDir}writings/`;
const codingDir = `${activitiesDir}coding/`;
const clozeDir = `${activitiesDir}cloze/`;

describe("runPrompts — the common envelope", () => {
  it.each([
    ["tutor", `${tutorsDir}test-tutor.yaml`, "test-tutor", "test-model"],
    ["quiz", `${quizzesDir}test-quiz.yaml`, "test-quiz", "test-model"],
    [
      "writing",
      `${writingsDir}test-writing.yaml`,
      "test-writing",
      "RedHatAI/gemma-4-31B-it-FP8-Dynamic",
    ],
    ["coding", `${codingDir}test-coding.yaml`, "test-coding", "test-model"],
    ["cloze", `${clozeDir}test-cloze.yaml`, "test-cloze", "test-model"],
  ] as const)("reports kind/id/llm for a %s", async (kind, path, id, model) => {
    const result = await runPrompts(path, kind);

    assert(result.ok);
    expect(result.dump.kind).toBe(kind);
    expect(result.dump.id).toBe(id);
    expect(result.dump.llm.provider).toBe("SCCH");
    expect(result.dump.llm.model).toBe(model);
  });

  it("reports a missing file as a structured error (no throw)", async () => {
    const result = await runPrompts(`${quizzesDir}does-not-exist.yaml`, "quiz");

    assert(!result.ok);
    expect(result.errors[0]?.code).toBe("ACTIVITY_LOAD_FAILED");
  });

  it("surfaces a broken tutor's validation errors", async () => {
    const result = await runPrompts(`${tutorsDir}broken-tutor.yaml`, "tutor");

    assert(!result.ok);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("runPrompts — tutor", () => {
  it("dumps the assembled system prompt (and [] tools without an opt-in)", async () => {
    const result = await runPrompts(`${tutorsDir}test-tutor.yaml`, "tutor");

    assert(result.ok);
    assert(result.dump.kind === "tutor");
    expect(result.dump.system.length).toBeGreaterThan(0);
    expect(result.dump.tools).toEqual([]);
  });

  it("dumps the opted-in built-in tools — they ship to the model with the prompt", async () => {
    const result = await runPrompts(`${tutorsDir}tools-tutor.yaml`, "tutor");

    assert(result.ok);
    assert(result.dump.kind === "tutor");
    expect(result.dump.tools).toEqual(["random_number"]);
  });
});

describe("runPrompts — quiz", () => {
  it("dumps one grading prompt per question plus the discussion block", async () => {
    const result = await runPrompts(`${quizzesDir}test-quiz.yaml`, "quiz");

    assert(result.ok);
    assert(result.dump.kind === "quiz");
    const { grading, discussion } = result.dump;

    expect(grading.questions.map((q) => q.id)).toEqual(["q1"]);
    expect(grading.questions[0]?.system).toContain("You are grading a student's open-ended answer");
    // The question text and the server-only evaluation criteria are both in there.
    expect(grading.questions[0]?.system).toContain("What is **2 + 2**?");
    expect(grading.questions[0]?.system).toContain("The answer is 4.");
    expect(grading.questions[0]?.imageInput).toBe(false);

    expect(grading.userMessageTemplate).toBe("The student's answer:\n\n{answer}");
    expect(grading.userMessagePhotosOnly).toBe(
      "The student answered with the attached photo(s) only.",
    );
    expect(grading.responseSchema).toMatchObject({
      properties: { result: { enum: ["correct", "partial", "incorrect"] } },
    });

    expect(discussion.system).toContain("You are helping a student understand");
    expect(discussion.seedMessages).toEqual({
      question: "Answer the following question: {question}",
      answer: "{answer}",
      verdict: "Your answer is {verdictLabel}. {feedback}",
    });
    expect(discussion.verdictLabels).toEqual({
      correct: "correct",
      partial: "partly correct",
      incorrect: "wrong",
    });
  });

  it("renders the quiz's fragment-backed preamble into every grading prompt", async () => {
    // fragments-quiz.yaml places `{{fragment "shared.persona" …}}` in its `instructions`;
    // the dump must show it RESOLVED, exactly as the grader would receive it.
    const result = await runPrompts(`${quizzesDir}fragments-quiz.yaml`, "quiz");

    assert(result.ok);
    assert(result.dump.kind === "quiz");
    const system = result.dump.grading.questions[0]?.system ?? "";
    expect(system).not.toContain("{{fragment");
    expect(system).toContain("geometry");
    // The preamble comes FIRST, ahead of the grading frame.
    expect(system.indexOf("geometry")).toBeLessThan(
      system.indexOf("You are grading a student's open-ended answer"),
    );
    expect(result.dump.discussion.system).toContain("geometry");
  });

  it("resolves photo-answer questions' effective imageInput", async () => {
    const result = await runPrompts(`${quizzesDir}vision-quiz.yaml`, "quiz");

    assert(result.ok);
    assert(result.dump.kind === "quiz");
    expect(result.dump.grading.questions.some((q) => q.imageInput)).toBe(true);
  });
});

describe("runPrompts — writing", () => {
  it("dumps the coach's system prompt", async () => {
    const result = await runPrompts(`${writingsDir}test-writing.yaml`, "writing");

    assert(result.ok);
    assert(result.dump.kind === "writing");
    expect(result.dump.system).toContain("You are a writing coach.");
  });

  it("renders inline fragments into the system prompt", async () => {
    const result = await runPrompts(`${writingsDir}fragments-writing.yaml`, "writing");

    assert(result.ok);
    assert(result.dump.kind === "writing");
    expect(result.dump.system).not.toContain("{{fragment");
    expect(result.dump.system).toContain("essay writing");
  });
});

describe("runPrompts — cloze", () => {
  it("dumps both calls' system prompts, user-message wrappers and output schemas", async () => {
    const result = await runPrompts(`${clozeDir}test-cloze.yaml`, "cloze");

    assert(result.ok);
    assert(result.dump.kind === "cloze");
    expect(result.dump.gapCount).toBe(3);
    expect(result.dump.grading.system).toContain('⟦2 · reference "starts" · hint "start"⟧');
    expect(result.dump.feedback.system).toContain("never re-grade");
    expect(result.dump.grading.userMessageTemplate).toContain("{answers}");
    expect(result.dump.feedback.userMessageTemplate).toContain("{answers}");
    expect(result.dump.grading.responseSchema).toMatchObject({ properties: { gaps: {} } });
    expect(result.dump.feedback.responseSchema).toMatchObject({ properties: { patterns: {} } });
  });
});

describe("runPrompts — coding", () => {
  it("dumps the instructions and what the proxy injects upstream", async () => {
    const result = await runPrompts(`${codingDir}test-coding.yaml`, "coding");

    assert(result.ok);
    assert(result.dump.kind === "coding");
    expect(result.dump.system).toContain("You are a coding buddy");
    // With no client system message the proxy prepends one carrying exactly this text.
    expect(result.dump.upstreamSystemMessage).toBe(result.dump.system);
  });
});
