import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

// Mock the router: the entry form navigates client-side to /<code>.
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { CodeEntryForm } from "@/app/code-entry";
import { extractCode } from "@/lib/code-input";

test("extractCode accepts bare codes, full URLs, and rejects garbage", () => {
  expect(extractCode("a1b2c3d4e5")).toBe("a1b2c3d4e5");
  expect(extractCode("  A1B2C3D4E5  ")).toBe("a1b2c3d4e5"); // trims + lowercases
  expect(extractCode("https://chat.example.org/a1b2c3d4e5")).toBe("a1b2c3d4e5");
  expect(extractCode("http://localhost:3000/a1b2c3d4e5/")).toBe("a1b2c3d4e5");
  // Memorable codes (hyphens, shorter) are accepted too.
  expect(extractCode("bio-101")).toBe("bio-101");
  expect(extractCode("")).toBeUndefined();
  expect(extractCode("https://chat.example.org/")).toBeUndefined();
  expect(extractCode("not a code!")).toBeUndefined();
  expect(extractCode("x".repeat(33))).toBeUndefined(); // over 32 chars
});

test("submitting a valid code navigates to /<code>", async () => {
  push.mockClear();
  const screen = await render(<CodeEntryForm />);

  await screen.getByLabelText("Code").fill("A1B2C3D4E5");
  await screen.getByRole("button", { name: "Open" }).click();

  expect(push).toHaveBeenCalledWith("/a1b2c3d4e5");
});

test("a pasted URL is reduced to its code", async () => {
  push.mockClear();
  const screen = await render(<CodeEntryForm />);

  await screen.getByLabelText("Code").fill("https://chat.example.org/a1b2c3d4e5");
  await screen.getByRole("button", { name: "Open" }).click();

  expect(push).toHaveBeenCalledWith("/a1b2c3d4e5");
});

test("malformed input shows a format hint instead of navigating", async () => {
  push.mockClear();
  const screen = await render(<CodeEntryForm />);

  await screen.getByLabelText("Code").fill("nope!");
  await screen.getByRole("button", { name: "Open" }).click();

  expect(push).not.toHaveBeenCalled();
  await expect.element(screen.getByText(/letters\/digits\/hyphens/)).toBeVisible();

  // The hint clears as soon as the input changes.
  await screen.getByLabelText("Code").fill("a");
  expect(screen.getByText(/letters\/digits\/hyphens/).query()).toBeNull();
});
