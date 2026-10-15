import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

// The shared explanation tooltip (WCAG 1.4.13): shown on hover and on keyboard
// focus, hoverable (the pointer may move onto it), dismissible with Escape. Needs
// the real stylesheet: the tooltip is positioned absolutely.
import "@/app/globals.css";
import { HelpTip } from "@/components/help-tip";

const tooltip = () => document.querySelector<HTMLElement>('[role="tooltip"]');

async function renderTip(icon?: "info" | "help") {
  const screen = await render(
    <div style={{ padding: "8px 300px 120px 8px" }}>
      Estimated cost{" "}
      <HelpTip label="About this estimate" icon={icon}>
        These are not real costs.
      </HelpTip>
    </div>,
  );
  return screen.getByRole("button", { name: "About this estimate" });
}

test("describes the button and stays hidden until asked", async () => {
  const button = await renderTip();
  await expect.element(button).toHaveAccessibleDescription("These are not real costs.");
  expect(tooltip()?.hidden).toBe(true);
});

test("hover shows it; moving onto it keeps it open; leaving hides it", async () => {
  const button = await renderTip("help");
  await button.hover();
  expect(tooltip()?.hidden).toBe(false);
  await page.elementLocator(tooltip() as Element).hover();
  await new Promise((resolve) => setTimeout(resolve, 300)); // past the grace period
  expect(tooltip()?.hidden).toBe(false);
  await page.elementLocator(document.body).hover({ position: { x: 1, y: 1 } });
  await expect.poll(() => tooltip()?.hidden).toBe(true);
});

test("Escape dismisses it, from a hover and from keyboard focus", async () => {
  const button = await renderTip("help");
  await button.hover();
  expect(tooltip()?.hidden).toBe(false);
  await userEvent.keyboard("{Escape}");
  expect(tooltip()?.hidden).toBe(true);

  await page.elementLocator(document.body).hover({ position: { x: 1, y: 1 } });
  await userEvent.tab();
  expect(tooltip()?.hidden).toBe(false);
  await userEvent.keyboard("{Escape}");
  expect(tooltip()?.hidden).toBe(true);
  await userEvent.tab();
  expect(tooltip()?.hidden).toBe(true);
});
