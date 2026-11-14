import { beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

// The Settings page's "Moodle account" section: unlinking is confirmed first,
// and a failure keeps the dialog open with the message.

const unlinkMoodleAccount = vi.hoisted(() => vi.fn());
vi.mock("@/lib/moodle-actions", () => ({ unlinkMoodleAccount }));

import { MoodleAccount } from "./moodle-account";

beforeEach(() => unlinkMoodleAccount.mockResolvedValue({ ok: true }));

test("says since when the account is linked", async () => {
  const screen = await render(<MoodleAccount linkedAtSeconds={1_794_000_000} />);
  await expect.element(screen.getByText(/linked to a Moodle account since/)).toBeVisible();
});

test("unlink asks first, then unlinks", async () => {
  const screen = await render(<MoodleAccount linkedAtSeconds={1_794_000_000} />);
  await screen.getByRole("button", { name: "Unlink my Moodle account" }).click();
  await expect.element(screen.getByText(/Results already in Moodle stay there/)).toBeVisible();
  expect(unlinkMoodleAccount).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect.element(screen.getByText("Your Moodle account is no longer linked.")).toBeVisible();
  expect(unlinkMoodleAccount).toHaveBeenCalledOnce();
});

test("cancel unlinks nothing; a failure shows the message", async () => {
  const screen = await render(<MoodleAccount linkedAtSeconds={1_794_000_000} />);
  await screen.getByRole("button", { name: "Unlink my Moodle account" }).click();
  await screen.getByRole("button", { name: "Cancel" }).click();
  expect(unlinkMoodleAccount).not.toHaveBeenCalled();

  unlinkMoodleAccount.mockResolvedValue({ ok: false, message: "Could not unlink." });
  await screen.getByRole("button", { name: "Unlink my Moodle account" }).click();
  await screen.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect.element(screen.getByText("Could not unlink.")).toBeVisible();
});
