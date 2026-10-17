import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
// The real stylesheet: the chevron is made of Tailwind utilities.
import "@/app/globals.css";
import { Select } from "@/components/ui/input";

// Chrome draws a native select's arrow flush against the right edge of the
// rounded field and ignores padding for it, so `Select` hides the native arrow
// and draws its own chevron inside a wider right padding. Pins that, and that
// a caller's width stays a delta.

test("draws its own chevron inside the right padding, not the native arrow", async () => {
  const screen = await render(
    <Select aria-label="Pick" className="w-80">
      <option>OpenRouter · GPT-6 Luna (medium)</option>
    </Select>,
  );
  const select = screen.getByRole("combobox", { name: "Pick" }).element();
  const style = getComputedStyle(select);

  expect(style.appearance).toBe("none");
  expect(Number.parseFloat(style.paddingRight)).toBeGreaterThanOrEqual(32);
  expect(style.backgroundImage).toContain("linear-gradient");
  expect(style.backgroundRepeat).toBe("no-repeat, no-repeat");
  expect(select.getBoundingClientRect().width).toBe(320);
});
