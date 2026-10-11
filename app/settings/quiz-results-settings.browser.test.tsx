import { beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

// The Settings page's "Quiz results" section: the switch saves at once and rolls
// back with a message when the save fails; deleting the saved results is
// confirmed first and resets the count. The actions are mocked; their
// validation lives in lib/user-settings-actions.unit.test.ts.

const updateUserSettings = vi.hoisted(() => vi.fn());
const deleteMyQuizResults = vi.hoisted(() => vi.fn());
vi.mock("@/lib/user-settings-actions", () => ({ updateUserSettings, deleteMyQuizResults }));

import { QuizResultsSettings } from "./quiz-results-settings";

beforeEach(() => {
  updateUserSettings.mockResolvedValue({ ok: true });
  deleteMyQuizResults.mockResolvedValue({ ok: true, deleted: 4 });
});

test("the switch reflects the setting, carries the notice, and saves a flip", async () => {
  const screen = await render(
    <QuizResultsSettings initialSaveQuizResults={false} initialSaved={0} />,
  );
  const toggle = screen.getByRole("switch", {
    name: "Save my quiz and exercise results for my personal statistics",
  });
  await expect.element(toggle).toHaveAttribute("aria-checked", "false");
  await expect.element(toggle).toHaveAccessibleDescription(/your teacher cannot/);

  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-checked", "true");
  expect(updateUserSettings).toHaveBeenCalledExactlyOnceWith({ saveQuizResults: true });
});

test("a failed save rolls the switch back and says why", async () => {
  updateUserSettings.mockResolvedValue({ ok: false, message: "Could not save." });
  const screen = await render(<QuizResultsSettings initialSaveQuizResults initialSaved={0} />);
  const toggle = screen.getByRole("switch");
  await toggle.click();
  await expect.element(screen.getByText("Could not save.")).toBeVisible();
  await expect.element(toggle).toHaveAttribute("aria-checked", "true");
});

test("deleting the saved results is confirmed first, then the count resets", async () => {
  const screen = await render(<QuizResultsSettings initialSaveQuizResults initialSaved={4} />);
  await expect.element(screen.getByText("You have 4 saved results.")).toBeVisible();

  await screen.getByRole("button", { name: "Delete my saved results" }).click();
  await expect.element(screen.getByText(/Badges you have already earned stay/)).toBeVisible();
  expect(deleteMyQuizResults).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Delete", exact: true }).click();

  await expect.element(screen.getByText("You have no saved results.")).toBeVisible();
  expect(deleteMyQuizResults).toHaveBeenCalledTimes(1);
  await expect
    .element(screen.getByRole("button", { name: "Delete my saved results" }))
    .toBeDisabled();
});

test("Cancel deletes nothing; a failed delete keeps the dialog with its message", async () => {
  const screen = await render(
    <QuizResultsSettings initialSaveQuizResults={false} initialSaved={2} />,
  );
  await screen.getByRole("button", { name: "Delete my saved results" }).click();
  await screen.getByRole("button", { name: "Cancel" }).click();
  expect(deleteMyQuizResults).not.toHaveBeenCalled();

  deleteMyQuizResults.mockResolvedValue({ ok: false, message: "Could not delete." });
  await screen.getByRole("button", { name: "Delete my saved results" }).click();
  await screen.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.element(screen.getByText("Could not delete.")).toBeVisible();
  await expect.element(screen.getByText("You have 2 saved results.")).toBeInTheDocument();
});

test("a lost call (rejected action) never leaves a control stuck", async () => {
  updateUserSettings.mockRejectedValue(new Error("network down"));
  deleteMyQuizResults.mockRejectedValue(new Error("network down"));
  const screen = await render(
    <QuizResultsSettings initialSaveQuizResults={false} initialSaved={2} />,
  );

  const toggle = screen.getByRole("switch");
  await toggle.click();
  await expect.element(screen.getByText(/settings could not be saved/)).toBeVisible();
  await expect.element(toggle).toHaveAttribute("aria-checked", "false");
  await expect.element(toggle).toBeEnabled();

  await screen.getByRole("button", { name: "Delete my saved results" }).click();
  await screen.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.element(screen.getByText(/results could not be deleted/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
});
