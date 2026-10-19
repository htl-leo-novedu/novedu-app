import { afterEach, describe, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

vi.mock("next/link", () => import("@/tests/mocks/next-link"));

// A row's actions in a real browser with the real stylesheet: from `xl` (1280px)
// up every action is an inline icon button and the "…" menu is gone; below it,
// the menu alone. One item list feeds both.
import "@/app/globals.css";
import { CopyIcon, EditIcon, ExternalLinkIcon, StatsIcon } from "@/components/icons";
import { type RowActionItem, RowActions } from "./row-actions";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

afterEach(async () => {
  await page.viewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

const ITEMS: RowActionItem[] = [
  { kind: "link", label: "View stats", href: "/codes/abc", icon: <StatsIcon /> },
  { kind: "link", label: "Open activity", href: "/abc", newTab: true, icon: <ExternalLinkIcon /> },
  { kind: "copy-link", label: "Copy link", path: "/abc", icon: <CopyIcon /> },
  { kind: "link", label: "Edit code", href: "/codes/edit/abc", icon: <EditIcon /> },
];

const LABEL = "Actions for Fractions";

describe("RowActions", () => {
  test("from xl up: inline icon buttons, no menu", async () => {
    const screen = await render(<RowActions label={LABEL} items={ITEMS} />);
    const group = screen.getByRole("group", { name: LABEL });
    await expect.element(group).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: LABEL, exact: true }))
      .not.toBeInTheDocument();

    await expect
      .element(group.getByRole("link", { name: "View stats" }))
      .toHaveAttribute("href", "/codes/abc");
    const open = group.getByRole("link", { name: "Open activity" });
    await expect.element(open).toHaveAttribute("href", "/abc");
    await expect.element(open).toHaveAttribute("target", "_blank");
    await expect
      .element(group.getByRole("link", { name: "Edit code" }))
      .toHaveAttribute("href", "/codes/edit/abc");
  });

  test("copy-link copies the full link", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    try {
      const screen = await render(<RowActions label={LABEL} items={ITEMS} />);
      await screen
        .getByRole("group", { name: LABEL })
        .getByRole("button", { name: "Copy link" })
        .click();
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/abc`);
    } finally {
      writeText.mockRestore();
    }
  });

  test("a disabled action keeps its slot, inert, and says why", async () => {
    const items: RowActionItem[] = [
      ITEMS[0] as RowActionItem,
      {
        kind: "disabled",
        label: "Open activity",
        reason: "only while active",
        icon: <ExternalLinkIcon />,
      },
      ITEMS[2] as RowActionItem,
    ];
    const screen = await render(<RowActions label={LABEL} items={items} />);
    const slot = screen.getByRole("button", { name: "Open activity (only while active)" });
    await expect.element(slot).toBeVisible();
    await expect.element(slot).toBeDisabled();
    await expect.element(slot).toHaveAttribute("title", "Open activity (only while active)");
  });

  test('below xl: the "…" menu alone, holding the same items', async () => {
    await page.viewport(1024, 800);
    const screen = await render(<RowActions label={LABEL} items={ITEMS} />);
    await expect.element(screen.getByRole("group", { name: LABEL })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: LABEL, exact: true });
    await expect.element(trigger).toBeVisible();

    await trigger.click();
    for (const name of ["View stats", "Open activity", "Copy link", "Edit code"])
      await expect.element(screen.getByRole("menuitem", { name })).toBeVisible();
  });
});
