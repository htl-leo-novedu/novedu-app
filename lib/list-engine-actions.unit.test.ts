import { beforeEach, expect, it, vi } from "vitest";

// The Classic/New switch: it stores the picked engine (an unknown value reads as
// the default) in the device's cookie and lands on a list route from the fixed
// allow-list — never on a URL taken from the form.

const set = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
);
vi.mock("next/headers", () => ({ cookies: async () => ({ set }) }));
vi.mock("next/navigation", () => ({ redirect }));

import { LIST_ENGINE_COOKIE } from "./list-engine";
import { switchListEngineAction } from "./list-engine-actions";

const submit = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return switchListEngineAction(form);
};

beforeEach(() => {
  set.mockClear();
  redirect.mockClear();
});

it("stores the engine for a year and returns to the bare list", async () => {
  await expect(submit({ engine: "new", list: "/codes" })).rejects.toThrow("redirect:/codes");
  expect(set).toHaveBeenCalledWith(LIST_ENGINE_COOKIE, "new", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
});

it("reads an unknown engine as classic and never redirects off the allow-list", async () => {
  await expect(submit({ engine: "fancy", list: "https://evil.test/" })).rejects.toThrow(
    "redirect:/codes",
  );
  expect(set).toHaveBeenCalledWith(LIST_ENGINE_COOKIE, "classic", expect.anything());
});
