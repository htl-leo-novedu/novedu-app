import { fileURLToPath } from "node:url";
import { assert, describe, expect, it } from "vitest";
import {
  buildClozeFeedbackMessage,
  buildClozeFeedbackPrompt,
  CLOZE_FEEDBACK_MESSAGE_TEMPLATE,
} from "./cloze-feedback-prompt";
import {
  buildClozeGradingMessage,
  buildClozeGradingPrompt,
  CLOZE_GRADING_MESSAGE_TEMPLATE,
  formatGapMarker,
} from "./cloze-grading-prompt";
import { CLOZE_FEEDBACK_SCHEMA, CLOZE_GRADING_SCHEMA } from "./cloze-output-schemas";
import { loadClozeFrom } from "./cloze-resolve";
import { dumpPrompts, toResponseJsonSchema } from "./prompt-dump";
import type { Fetcher } from "./prompt-fragments";

// Both cloze prompt builders, their user-message wrappers and the prompt dump: the dump
// must be BYTE-IDENTICAL to what the builders produce for the same file (it calls them).

const FIXTURE = new URL(
  "../test-fixtures/activities/cloze/test-cloze.yaml",
  import.meta.url,
).toString();

// A file:-only fetcher, like the CLI's (no network).
const fileFetcher: Fetcher = async (url) => {
  const { readFile } = await import("node:fs/promises");
  try {
    return new Response(await readFile(fileURLToPath(url), "utf8"), { status: 200 });
  } catch {
    return new Response("", { status: 404 });
  }
};
const opts = { allowedSchemes: ["file:"] };

describe("formatGapMarker", () => {
  it("quotes the reference and hint, and spells out an empty reference", () => {
    expect(formatGapMarker({ number: 3, reference: "starts", hint: "start" })).toBe(
      '⟦3 · reference "starts" · hint "start"⟧',
    );
    expect(formatGapMarker({ number: 4, reference: "" })).toBe(
      '⟦4 · reference "" (nothing belongs here)⟧',
    );
    expect(formatGapMarker({ number: 5, reference: 'say "hi"' })).toBe(
      '⟦5 · reference "say \\"hi\\""⟧',
    );
  });
});

describe("cloze prompts", async () => {
  const loaded = await loadClozeFrom(FIXTURE, fileFetcher, opts);
  assert(loaded.ok);
  const cloze = loaded.cloze;

  it("the grading prompt carries the criteria and every reference, in order", () => {
    const prompt = buildClozeGradingPrompt(cloze);
    expect(prompt).toContain("Correct: the reference word.");
    expect(prompt).toContain('Sue ⟦1 · reference "is going to"⟧ start next week.');
    expect(prompt).toContain('The class ⟦2 · reference "starts" · hint "start"⟧ at nine.');
    expect(prompt.indexOf("Correct: the reference word.")).toBeLessThan(prompt.indexOf("Sue ⟦1"));
  });

  it("the feedback prompt carries the criteria, the references and the no-re-grading frame", () => {
    const prompt = buildClozeFeedbackPrompt(cloze);
    expect(prompt).toContain("Correct: the reference word.");
    expect(prompt).toContain('⟦3 · reference "" (nothing belongs here)⟧');
    expect(prompt).toContain("never re-grade");
  });

  it("prepends the rendered preamble to both prompts", () => {
    const withPreamble = { ...cloze, instructionsPreamble: "PREAMBLE" };
    expect(buildClozeGradingPrompt(withPreamble).startsWith("PREAMBLE\n\n")).toBe(true);
    expect(buildClozeFeedbackPrompt(withPreamble).startsWith("PREAMBLE\n\n")).toBe(true);
  });

  it("the user messages wrap the answers as a JSON list, `$` sequences kept literal", () => {
    const grading = buildClozeGradingMessage([{ gap: 2, answer: "start $& now" }]);
    expect(grading.startsWith(CLOZE_GRADING_MESSAGE_TEMPLATE.split("{answers}")[0] ?? "")).toBe(
      true,
    );
    expect(JSON.parse(grading.slice(grading.indexOf("\n[") + 1))).toEqual([
      { gap: 2, answer: "start $& now" },
    ]);
    const feedback = buildClozeFeedbackMessage([{ gap: 1, answer: "", verdict: "incorrect" }]);
    expect(feedback.startsWith(CLOZE_FEEDBACK_MESSAGE_TEMPLATE.split("{answers}")[0] ?? "")).toBe(
      true,
    );
    expect(JSON.parse(feedback.slice(feedback.indexOf("\n[") + 1))).toEqual([
      { gap: 1, answer: "", verdict: "incorrect" },
    ]);
  });

  it("the dump is byte-identical to the production builders, with both schemas", async () => {
    const result = await dumpPrompts("cloze", FIXTURE, fileFetcher, opts);
    assert(result.ok);
    assert(result.dump.kind === "cloze");
    expect(result.dump.id).toBe("test-cloze");
    expect(result.dump.gapCount).toBe(3);
    expect(result.dump.grading.system).toBe(buildClozeGradingPrompt(cloze));
    expect(result.dump.feedback.system).toBe(buildClozeFeedbackPrompt(cloze));
    expect(result.dump.grading.userMessageTemplate).toBe(CLOZE_GRADING_MESSAGE_TEMPLATE);
    expect(result.dump.feedback.userMessageTemplate).toBe(CLOZE_FEEDBACK_MESSAGE_TEMPLATE);
    expect(result.dump.grading.responseSchema).toEqual(toResponseJsonSchema(CLOZE_GRADING_SCHEMA));
    expect(result.dump.feedback.responseSchema).toEqual(
      toResponseJsonSchema(CLOZE_FEEDBACK_SCHEMA),
    );
    expect(result.dump.grading.responseSchema).toMatchObject({
      properties: { gaps: { type: "array" } },
    });
    expect(result.dump.feedback.responseSchema).toMatchObject({
      properties: { patterns: { type: "array" }, gap_notes: { type: "array" } },
    });
  });
});
