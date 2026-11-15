import { beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

// The Finish page's "Hand in to Moodle" box in each state: ready (with the
// counts and percentage the server will send), replacing an earlier hand-in,
// working, done, a failure with "Try again", and a refusal without one. The
// action is mocked; its counting lives in lib/moodle-actions.unit.test.ts.

const handInToMoodle = vi.hoisted(() => vi.fn());
vi.mock("@/lib/moodle-actions", () => ({ handInToMoodle }));

import { HandIn } from "./hand-in";

const PROPS = {
  code: "quiz-code1",
  attemptId: "6f1c2d3e-0000-4000-8000-000000000001",
  receipts: [{ slot: 0, questionId: "q1", verdict: "correct" as const, mac: "m" }],
  counts: { correct: 6, partial: 2, incorrect: 1, unanswered: 1 },
  total: 10,
  handedInAt: null,
};

beforeEach(() => {
  handInToMoodle.mockResolvedValue({ ok: true, handedInAt: "2026-11-13T10:21:00Z", percent: 70 });
});

test("ready: shows what Moodle receives and that the teacher sees it", async () => {
  const screen = await render(<HandIn {...PROPS} />);
  await expect.element(screen.getByRole("heading", { name: "Hand in to Moodle" })).toBeVisible();
  await expect
    .element(
      screen.getByText(
        "Moodle receives: 10 questions — 6 correct, 2 partly correct, 1 wrong, 1 not answered (70 %).",
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByText(/Your teacher sees this in Moodle/)).toBeVisible();
  expect(screen.getByText(/You already handed in/).query()).toBeNull();
});

test("replacing: says an earlier hand-in is replaced", async () => {
  const screen = await render(<HandIn {...PROPS} handedInAt="2026-11-12T14:03:00Z" />);
  await expect.element(screen.getByText(/Handing in again replaces it/)).toBeVisible();
});

test("working, then done: the button disappears for this attempt", async () => {
  let finish: (value: unknown) => void = () => {};
  handInToMoodle.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const screen = await render(<HandIn {...PROPS} />);
  await screen.getByRole("button", { name: "Hand in" }).click();
  await expect.element(screen.getByRole("button", { name: /Handing in…/ })).toBeDisabled();
  finish({ ok: true, handedInAt: "2026-11-13T10:21:00Z", percent: 70 });
  await expect.element(screen.getByText(/Handed in to Moodle on .*\(70 %\)/)).toBeVisible();
  expect(screen.getByRole("button").query()).toBeNull();
  expect(handInToMoodle).toHaveBeenCalledExactlyOnceWith({
    code: PROPS.code,
    attemptId: PROPS.attemptId,
    receipts: PROPS.receipts,
  });
});

test("failed: the message and Try again, never an automatic retry", async () => {
  handInToMoodle.mockResolvedValueOnce({
    ok: false,
    message: "Moodle could not be reached right now. Please try again.",
    retry: true,
  });
  const screen = await render(<HandIn {...PROPS} />);
  await screen.getByRole("button", { name: "Hand in" }).click();
  await expect
    .element(screen.getByText("Moodle could not be reached right now. Please try again."))
    .toBeVisible();
  expect(handInToMoodle).toHaveBeenCalledOnce();
  await screen.getByRole("button", { name: "Try again" }).click();
  await expect.element(screen.getByText(/Handed in to Moodle on/)).toBeVisible();
});

test("a rejected call reads as unreachable", async () => {
  handInToMoodle.mockRejectedValueOnce(new Error("offline"));
  const screen = await render(<HandIn {...PROPS} />);
  await screen.getByRole("button", { name: "Hand in" }).click();
  await expect.element(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("code ended: the message without a retry", async () => {
  handInToMoodle.mockResolvedValueOnce({
    ok: false,
    message: "This quiz has ended, so the result can't be handed in.",
    retry: false,
  });
  const screen = await render(<HandIn {...PROPS} />);
  await screen.getByRole("button", { name: "Hand in" }).click();
  await expect
    .element(screen.getByText("This quiz has ended, so the result can't be handed in."))
    .toBeVisible();
  expect(screen.getByRole("button").query()).toBeNull();
});
