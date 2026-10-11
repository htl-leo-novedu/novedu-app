import { describe, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import { clozeGapPlaceholder } from "@/lib/cloze-types";

// The cloze teacher detail body (app/[code]/_cloze/cloze-detail-view.tsx): "First
// submissions" (the largest per-gap total), the answer key with a verdict bar per gap,
// the per-gap table with counts and percentages, stale rows hidden behind a note, and
// the load-failure fallback listing the stored counts. The loading server component
// (`ClozeDetail`) only feeds it plain data; the counts store is unit-tested apart.

vi.mock("next/link", () => import("@/tests/mocks/next-link"));

import { type ClozeDetailData, ClozeDetailView } from "@/app/[code]/_cloze/cloze-detail-view";

const EXERCISE: ClozeDetailData["exercise"] = {
  ok: true,
  text: [
    `Sue ${clozeGapPlaceholder(1)} start next week.`,
    "",
    `The class ${clozeGapPlaceholder(2)} at nine${clozeGapPlaceholder(3)} on Sunday.`,
  ].join("\n"),
  gaps: [
    { number: 1, reference: "is going to" },
    { number: 2, reference: "starts", hint: "start" },
    { number: 3, reference: "" },
  ],
};

function data(overrides: Partial<ClozeDetailData> = {}): ClozeDetailData {
  return {
    fileUrl: "https://example.com/api/files/sue",
    validFrom: null,
    validUntil: null,
    llm: { model: "gemma-4" },
    exercise: EXERCISE,
    counts: [
      { gap: 1, reference: "is going to", correct: 3, partial: 0, incorrect: 1 },
      { gap: 2, reference: "starts", correct: 1, partial: 2, incorrect: 1 },
    ],
    ...overrides,
  };
}

/** The table's body rows as arrays of cell texts. */
function tableRows(container: HTMLElement): string[][] {
  const table = container.querySelector('[data-testid="cloze-gap-table"] table');
  return [...(table?.querySelectorAll("tbody tr") ?? [])].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim() ?? ""),
  );
}

describe("ClozeDetailView", () => {
  test("shows first submissions, the answer key with bars, and the table", async () => {
    const screen = await render(<ClozeDetailView data={data()} />);

    await expect.element(screen.getByTestId("cloze-first-submissions")).toHaveTextContent("4");
    await expect
      .element(screen.getByText(/Counts each first submission, including teachers' test runs/))
      .toBeVisible();

    // The answer key: each gap with its reference, hint, bar and n.
    const gap2 = screen.getByTestId("cloze-key-gap-2");
    await expect.element(gap2).toHaveTextContent("starts");
    await expect.element(gap2).toHaveTextContent("(start)");
    await expect.element(gap2).toHaveTextContent("n=4");
    await expect
      .element(gap2.getByRole("img"))
      .toHaveAccessibleName("1 correct, 2 partial, 1 wrong of 4");
    const segments = gap2.element().querySelectorAll("[data-verdict]");
    expect([...segments].map((s) => s.getAttribute("data-verdict"))).toEqual([
      "correct",
      "partial",
      "incorrect",
    ]);
    await expect
      .element(screen.getByTestId("cloze-key-gap-3").getByRole("img"))
      .toHaveAccessibleName("no submissions yet");

    expect(tableRows(screen.container)).toEqual([
      ["1", "is going to", "3 · 75%", "0 · 0%", "1 · 25%", "4"],
      ["2", "starts(start)", "1 · 25%", "2 · 50%", "1 · 25%", "4"],
      ["3", "(empty)", "No submissions yet", "", "", "0"],
    ]);
    expect(screen.container.querySelector('[data-testid="cloze-stale-note"]')).toBeNull();
  });

  test("hides rows of changed or renumbered gaps and says so", async () => {
    const screen = await render(
      <ClozeDetailView
        data={data({
          counts: [
            { gap: 1, reference: "is going to", correct: 2, partial: 0, incorrect: 0 },
            // Gap 2's reference was "start" before the teacher changed it.
            { gap: 2, reference: "start", correct: 0, partial: 0, incorrect: 9 },
            // A gap that no longer exists.
            { gap: 4, reference: "will", correct: 5, partial: 0, incorrect: 0 },
          ],
        })}
      />,
    );

    expect(tableRows(screen.container)).toEqual([
      ["1", "is going to", "2 · 100%", "0 · 0%", "0 · 0%", "2"],
      ["2", "starts(start)", "No submissions yet", "", "", "0"],
      ["3", "(empty)", "No submissions yet", "", "", "0"],
    ]);
    await expect
      .element(screen.getByTestId("cloze-stale-note"))
      .toHaveTextContent("statistics start from zero");
  });

  test("falls back to the stored counts when the exercise cannot be loaded", async () => {
    const screen = await render(
      <ClozeDetailView
        data={data({
          llm: undefined,
          exercise: { ok: false, message: "The file could not be fetched." },
        })}
      />,
    );

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("This exercise could not be loaded");
    await expect.element(screen.getByText("The file could not be fetched.")).toBeVisible();
    expect(screen.container.querySelector('[data-testid^="cloze-key-gap"]')).toBeNull();
    expect(tableRows(screen.container)).toEqual([
      ["1", "is going to", "3 · 75%", "0 · 0%", "1 · 25%", "4"],
      ["2", "starts", "1 · 25%", "2 · 50%", "1 · 25%", "4"],
    ]);
    await expect.element(screen.getByTestId("cloze-first-submissions")).toHaveTextContent("4");
  });

  test("says when the statistics are unavailable, and shows no counts anywhere", async () => {
    const screen = await render(<ClozeDetailView data={data({ counts: undefined })} />);
    await expect.element(screen.getByTestId("cloze-first-submissions")).toHaveTextContent("—");
    await expect
      .element(
        screen.getByText("The statistics could not be loaded right now. Try again in a moment."),
      )
      .toBeVisible();
    await expect.element(screen.getByTestId("cloze-key-gap-1")).toHaveTextContent("n=—");
    expect(tableRows(screen.container)).toEqual([
      ["1", "is going to", "—", "—", "—", "—"],
      ["2", "starts(start)", "—", "—", "—", "—"],
      ["3", "(empty)", "—", "—", "—", "—"],
    ]);
    expect(screen.container.textContent).not.toContain("No submissions yet");
  });
});
