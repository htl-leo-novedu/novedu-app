import { beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { type ClozePublic, clozeGapPlaceholder } from "@/lib/cloze-types";

// The cloze runner (app/[code]/_cloze/cloze-runner.tsx): the gaps as real inputs in
// reading order, the counter, the empty-gap confirmation, the verdict chips that show
// as soon as `gradeCloze` returns (before the feedback), both failure states with
// their retry, and Try again → a "Practice round" with `round: "retry"` and a fresh
// attempt id, and the "save this result" offer — only after a first round with an
// answer, saving through `saveClozeResult`. The server actions are mocked; their
// verification, the pre-pass, the grounding, the token and the save's validations live
// in lib/cloze-actions.unit.test.ts.

const gradeCloze = vi.hoisted(() => vi.fn());
const explainCloze = vi.hoisted(() => vi.fn());
const saveClozeResult = vi.hoisted(() => vi.fn());
// The shared save offer imports the quiz's action as its default; it must never run.
const saveQuizResult = vi.hoisted(() => vi.fn());
vi.mock("@/lib/quiz-actions", () => ({ saveQuizResult }));
vi.mock("next/link", () => import("@/tests/mocks/next-link"));
vi.mock("@/lib/cloze-actions", () => ({ gradeCloze, explainCloze, saveClozeResult }));

import { ClozeRunner } from "@/app/[code]/_cloze/cloze-runner";

const CODE = "a1b2c3d4e5";

// Three gaps: one in the first paragraph, two (one with a hint) in a list.
const CLOZE: ClozePublic = {
  title: "Sue's fresh start",
  description: "Use **future forms**.",
  text: [
    "## A plan",
    "",
    `Sue ${clozeGapPlaceholder(1)} start next week.`,
    "",
    `- The class ${clozeGapPlaceholder(2)} at nine.`,
    `- Nothing here${clozeGapPlaceholder(3)} really.`,
  ].join("\n"),
  gaps: [{ number: 1 }, { number: 2, hint: "start" }, { number: 3 }],
};

const GRADED = {
  ok: true,
  verdicts: ["incorrect", "partial", "correct"],
  references: ["is going to", "starts", ""],
  resultToken: "token-1",
};

const FEEDBACK = {
  ok: true,
  patterns: [
    {
      title: "Plans already made",
      explanation: "Two of your answers miss the plan.",
      gaps: [1, 2],
      nextTime: "Look for decisions made earlier.",
    },
  ],
  gapNotes: [{ gap: 2, note: "Add the -s ending." }],
};

/** A promise the test resolves by hand, to look at the state in between. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  gradeCloze.mockReset().mockResolvedValue(GRADED);
  explainCloze.mockReset().mockResolvedValue(FEEDBACK);
});

async function fillAll(screen: Awaited<ReturnType<typeof render>>) {
  await screen.getByRole("textbox", { name: "Gap 1" }).fill("will");
  await screen.getByRole("textbox", { name: "Gap 2" }).fill("start");
  await screen.getByRole("textbox", { name: "Gap 3" }).fill(",");
}

test("renders the text with one labelled input per gap, in reading order, with its hint", async () => {
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await expect.element(screen.getByRole("heading", { name: "Sue's fresh start" })).toBeVisible();
  await expect.element(screen.getByText("Complete the whole text")).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "A plan" })).toBeVisible();
  await expect.element(screen.getByText("(start)")).toBeVisible();
  await expect.element(screen.getByText("Anonymous activity")).toBeVisible();

  await screen.getByRole("textbox", { name: "Gap 1" }).click();
  await userEvent.tab();
  await expect.element(screen.getByRole("textbox", { name: "Gap 2" })).toHaveFocus();
  await userEvent.tab();
  await expect.element(screen.getByRole("textbox", { name: "Gap 3" })).toHaveFocus();
  await expect
    .element(screen.getByRole("textbox", { name: "Gap 2" }))
    .toHaveAccessibleDescription("(start)");
});

test("counts the filled gaps; typing keeps the focus in the gap", async () => {
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await expect.element(screen.getByText("0 / 3")).toBeVisible();
  await screen.getByRole("textbox", { name: "Gap 2" }).click();
  await userEvent.keyboard("starts");
  await expect.element(screen.getByRole("textbox", { name: "Gap 2" })).toHaveValue("starts");
  await expect.element(screen.getByRole("textbox", { name: "Gap 2" })).toHaveFocus();
  await expect.element(screen.getByText("1 / 3")).toBeVisible();
  // Whitespace alone is not an answer.
  await screen.getByRole("textbox", { name: "Gap 1" }).fill("   ");
  await expect.element(screen.getByText("1 / 3")).toBeVisible();
});

test("empty gaps ask for confirmation before submitting", async () => {
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await screen.getByRole("textbox", { name: "Gap 1" }).fill("will");
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await expect.element(screen.getByText("2 gaps are empty — submit anyway?")).toBeVisible();
  expect(gradeCloze).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Keep editing" }).click();
  await expect.element(screen.getByRole("button", { name: "Submit exercise" })).toBeVisible();
  expect(gradeCloze).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await screen.getByRole("button", { name: "Submit anyway" }).click();
  await expect.element(screen.getByText("Your feedback")).toBeVisible();
  expect(gradeCloze).toHaveBeenCalledWith(
    expect.objectContaining({ code: CODE, round: "first", answers: ["will", "", ""] }),
  );
});

test("verdict chips show before the feedback; the feedback then fills in", async () => {
  const explained = deferred<typeof FEEDBACK>();
  explainCloze.mockReturnValue(explained.promise);
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await fillAll(screen);
  await screen.getByRole("button", { name: "Submit exercise" }).click();

  // Step 1 is back: chips, counts and the selected (first wrong) gap — no patterns yet.
  await expect
    .element(screen.getByRole("button", { name: "Gap 1: will — Wrong" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(screen.getByRole("button", { name: "Gap 2: start — Partly correct" }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Gap 3: , — Correct" })).toBeVisible();
  await expect
    .element(screen.getByTestId("cloze-counts"))
    .toHaveTextContent("1correct1partial1wrong");
  await expect.element(screen.getByText("Submitted · 3 gaps")).toBeVisible();
  await expect.element(screen.getByText("Looking for patterns in your answers…")).toBeVisible();
  await expect.element(screen.getByTestId("cloze-gap-panel")).toHaveTextContent("is going to");
  expect(explainCloze).toHaveBeenCalledWith({
    code: CODE,
    attemptId: gradeCloze.mock.calls[0]?.[0].attemptId,
    answers: ["will", "start", ","],
    verdicts: GRADED.verdicts,
    resultToken: "token-1",
  });

  // Step 2: the pattern, its gap chips select a gap, and the gap's note shows.
  explained.resolve(FEEDBACK);
  await expect.element(screen.getByRole("heading", { name: "Plans already made" })).toBeVisible();
  await expect.element(screen.getByText("Look for decisions made earlier.")).toBeVisible();
  await screen.getByRole("button", { name: "Gap 2", exact: true }).click();
  const panel = screen.getByTestId("cloze-gap-panel");
  await expect.element(panel.getByRole("heading", { name: "Gap 2" })).toBeVisible();
  await expect.element(panel).toHaveTextContent("Partly correct");
  await expect.element(panel).toHaveTextContent("starts");
  await expect.element(panel).toHaveTextContent("Add the -s ending.");

  // An empty reference reads "(leave empty)".
  await screen.getByRole("button", { name: "Gap 3: , — Correct" }).click();
  await expect.element(panel).toHaveTextContent("(leave empty)");
});

test("all gaps correct: no feedback call", async () => {
  gradeCloze.mockResolvedValue({ ...GRADED, verdicts: ["correct", "correct", "correct"] });
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await fillAll(screen);
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await expect.element(screen.getByText("All 3 gaps correct.")).toBeVisible();
  expect(explainCloze).not.toHaveBeenCalled();
});

test("no surviving pattern over several misses says so", async () => {
  gradeCloze.mockResolvedValue({ ...GRADED, verdicts: ["incorrect", "partial", "incorrect"] });
  explainCloze.mockResolvedValue({ ok: true, patterns: [], gapNotes: [] });
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await fillAll(screen);
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await expect
    .element(screen.getByText("Your mistakes don't share a common cause — see each gap below."))
    .toBeVisible();
});

test("a failed grading keeps the answers and lets the student submit again", async () => {
  gradeCloze.mockResolvedValueOnce({
    ok: false,
    message: "Couldn't check your answers — try again.",
  });
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await fillAll(screen);
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't check your answers — try again.");
  await expect.element(screen.getByRole("textbox", { name: "Gap 1" })).toHaveValue("will");
  expect(explainCloze).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await expect.element(screen.getByText("Your feedback")).toBeVisible();
  expect(gradeCloze).toHaveBeenCalledTimes(2);
});

test("a failed feedback keeps the verdicts and retries only the feedback", async () => {
  explainCloze.mockResolvedValueOnce({
    ok: false,
    message: "Couldn't load the feedback — try again.",
  });
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await fillAll(screen);
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't load the feedback — try again.");
  await expect.element(screen.getByRole("button", { name: "Gap 1: will — Wrong" })).toBeVisible();

  await screen.getByRole("button", { name: "Retry" }).click();
  await expect.element(screen.getByRole("heading", { name: "Plans already made" })).toBeVisible();
  expect(gradeCloze).toHaveBeenCalledTimes(1);
  expect(explainCloze).toHaveBeenCalledTimes(2);
});

test("a rejected call (e.g. a dropped connection) reaches the same failure states", async () => {
  gradeCloze.mockRejectedValueOnce(new Error("Failed to fetch"));
  explainCloze.mockRejectedValueOnce(new Error("Failed to fetch"));
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await fillAll(screen);
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't check your answers — try again.");
  await expect.element(screen.getByRole("textbox", { name: "Gap 1" })).toHaveValue("will");

  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't load the feedback — try again.");
  await screen.getByRole("button", { name: "Retry" }).click();
  await expect.element(screen.getByRole("heading", { name: "Plans already made" })).toBeVisible();
});

test("the results screen swaps the task box for a reading note", async () => {
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await expect.element(screen.getByText("future forms")).toBeVisible();
  await fillAll(screen);
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await expect
    .element(screen.getByTestId("cloze-results-note"))
    .toHaveTextContent('A possible answer" is an example, not the only acceptable wording.');
  await expect.element(screen.getByText("future forms")).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Try again" }).click();
  await expect.element(screen.getByText("future forms")).toBeVisible();
});

test("Try again clears the gaps for a practice round with a fresh attempt", async () => {
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await expect.element(screen.getByText("Practice round")).not.toBeInTheDocument();
  await fillAll(screen);
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await screen.getByRole("button", { name: "Try again" }).click();

  await expect.element(screen.getByText("Practice round")).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Gap 1" })).toHaveValue("");
  await expect.element(screen.getByRole("textbox", { name: "Gap 1" })).toHaveFocus();
  await expect.element(screen.getByText("0 / 3")).toBeVisible();

  await fillAll(screen);
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await expect.element(screen.getByText("Your feedback")).toBeVisible();
  await expect.element(screen.getByText("Practice round")).toBeVisible();
  const [first, retry] = gradeCloze.mock.calls.map(([input]) => input);
  expect(first.round).toBe("first");
  expect(retry.round).toBe("retry");
  expect(retry.attemptId).not.toBe(first.attemptId);
});

test("a first round offers the save and saves the counts through saveClozeResult", async () => {
  saveClozeResult.mockResolvedValue({ ok: true, saved: true });
  gradeCloze.mockResolvedValue({ ...GRADED, verdicts: ["incorrect", "partial", "incorrect"] });
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await screen.getByRole("textbox", { name: "Gap 1" }).fill("will");
  await screen.getByRole("textbox", { name: "Gap 2" }).fill("start");
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await screen.getByRole("button", { name: "Submit anyway" }).click();

  await screen.getByRole("button", { name: "This time" }).click();
  await expect.element(screen.getByText(/Saved to your personal statistics/)).toBeVisible();
  // Gap 3 was left empty and is wrong: "unanswered", not "incorrect".
  expect(saveClozeResult).toHaveBeenCalledWith({
    code: CODE,
    attemptId: gradeCloze.mock.calls[0]?.[0].attemptId,
    counts: { correct: 0, partial: 1, incorrect: 1, unanswered: 1 },
    total: 3,
    mode: "this-time",
  });
  expect(saveQuizResult).not.toHaveBeenCalled();
});

test("no save offer for a practice round or when nothing was answered", async () => {
  gradeCloze.mockResolvedValue({ ...GRADED, verdicts: ["incorrect", "incorrect", "correct"] });
  const screen = await render(<ClozeRunner code={CODE} cloze={CLOZE} autoSave={false} />);
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await screen.getByRole("button", { name: "Submit anyway" }).click();
  await expect.element(screen.getByText("Your feedback")).toBeVisible();
  await expect.element(screen.getByText(/Save this result/)).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Try again" }).click();
  await fillAll(screen);
  await screen.getByRole("button", { name: "Submit exercise" }).click();
  await expect.element(screen.getByText("Your feedback")).toBeVisible();
  await expect.element(screen.getByText("Practice round")).toBeVisible();
  await expect.element(screen.getByText(/Save this result/)).not.toBeInTheDocument();
  expect(saveClozeResult).not.toHaveBeenCalled();
});
