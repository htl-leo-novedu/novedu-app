import { afterEach, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

vi.mock("next/link", () => import("@/tests/mocks/next-link"));

// The new list engine's one menu, in a real browser with the real stylesheet:
// the native popover opens on the trigger, focuses its first item, moves with
// the arrow keys (skipping a disabled item), closes on Escape; it sits in the
// top layer, so a clipping card cannot cut it off; from `md` up it drops from
// the trigger (right- or left-aligned), on a phone it is a full-width bottom sheet.
import "@/app/globals.css";
import { ActionMenu, type ActionMenuItem } from "./action-menu";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

afterEach(async () => {
  await page.viewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

const onSelect = vi.fn();
const ITEMS: ActionMenuItem[] = [
  { kind: "link", label: "View stats", href: "/codes/abc" },
  { kind: "disabled", label: "Open activity", reason: "only while active" },
  { kind: "copy-link", label: "Copy link", path: "/abc" },
  { kind: "button", label: "Run it", onSelect },
];

function Harness() {
  return (
    // A clipping, scrolling card like the list's table card.
    <div style={{ overflow: "hidden", width: 300, height: 40, marginLeft: 400 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <ActionMenu label="Actions for Fractions" items={ITEMS} />
      </div>
    </div>
  );
}

const panel = () => document.querySelector<HTMLElement>('[role="menu"]');
const isOpen = () => panel()?.matches(":popover-open") ?? false;

describe("ActionMenu", () => {
  test("opens on the trigger, focuses the first item, and arrows skip a disabled item", async () => {
    const screen = await render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Actions for Fractions" });
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    const first = screen.getByRole("menuitem", { name: "View stats" });
    await expect.element(first).toHaveFocus();
    await expect
      .element(screen.getByRole("menuitem", { name: /Open activity/ }))
      .toHaveAttribute("aria-disabled", "true");

    await userEvent.keyboard("{ArrowDown}");
    await expect.element(screen.getByRole("menuitem", { name: "Copy link" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    await expect.element(screen.getByRole("menuitem", { name: "Run it" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(first).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(screen.getByRole("menuitem", { name: "Run it" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    await expect.poll(isOpen).toBe(false);
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("escapes the clipping card and drops from the trigger, right-aligned", async () => {
    const screen = await render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Actions for Fractions" });
    await trigger.click();
    await expect.poll(isOpen).toBe(true);

    const menu = panel() as HTMLElement;
    const rect = menu.getBoundingClientRect();
    const anchor = trigger.element().getBoundingClientRect();
    // Taller than the 40px card, yet what is painted at its centre is the menu.
    expect(rect.height).toBeGreaterThan(100);
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(menu.contains(hit)).toBe(true);
    expect(Math.abs(rect.right - anchor.right)).toBeLessThanOrEqual(1);
    expect(rect.top).toBeGreaterThanOrEqual(anchor.bottom);
  });

  test("align=start lines it up with the trigger's left edge instead", async () => {
    const screen = await render(
      <div style={{ marginLeft: 400 }}>
        <ActionMenu label="View" items={ITEMS} align="start">
          View
        </ActionMenu>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "View" });
    await trigger.click();
    await expect.poll(isOpen).toBe(true);
    const rect = (panel() as HTMLElement).getBoundingClientRect();
    expect(
      Math.abs(rect.left - trigger.element().getBoundingClientRect().left),
    ).toBeLessThanOrEqual(1);
  });

  test("is a full-width bottom sheet on a phone", async () => {
    await page.viewport(390, 844);
    const screen = await render(<Harness />);
    await screen.getByRole("button", { name: "Actions for Fractions" }).click();
    await expect.poll(isOpen).toBe(true);

    const rect = (panel() as HTMLElement).getBoundingClientRect();
    expect(Math.round(rect.width)).toBe(390);
    expect(Math.abs(rect.bottom - 844)).toBeLessThanOrEqual(1);
    // The sheet names what it acts on.
    await expect.element(screen.getByText("Actions for Fractions", { exact: true })).toBeVisible();
  });

  test("a button item runs and closes; copy-link copies the full link, then closes", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const screen = await render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Actions for Fractions" });

    await trigger.click();
    await screen.getByRole("menuitem", { name: "Run it" }).click();
    expect(onSelect).toHaveBeenCalledOnce();
    await expect.poll(isOpen).toBe(false);

    await trigger.click();
    await screen.getByRole("menuitem", { name: "Copy link" }).click();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/abc`);
    await expect.element(screen.getByRole("menuitem", { name: "Copied!" })).toBeVisible();
    await expect.poll(isOpen).toBe(false);
  });
});
