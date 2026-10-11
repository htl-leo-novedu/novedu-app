import { afterEach, describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

// The season calendar's interaction and phone layout in a real browser. The
// layout case needs the real stylesheet (the utilities live in app/_home, so
// they are generated); without it the calendar's overflow containment could
// never be measured (docs/testing.md → layout tests).
import "@/app/globals.css";
import { PageBody } from "@/components/page-main";
import { heatmap } from "@/lib/achievements/derive";
import type { BadgeItem, CalendarCell } from "@/lib/home-data";
import { SeasonCalendar } from "./season-calendar";

const TODAY = "2026-10-01"; // a Thursday: Fri–Sun are future
const EMPTY_DAY = {
  userMessages: 0,
  quizAnswers: 0,
  writingSaves: 0,
  codingRequests: 0,
  clozeSubmissions: 0,
  codingHours: 0,
};
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

function badge(id: string, name: string, extra: Partial<BadgeItem> = {}): BadgeItem {
  return {
    id,
    name,
    criterion: `criterion of ${name}`,
    icon: "flame",
    family: "rhythm",
    xp: 20,
    earned: true,
    isNew: false,
    ...extra,
  };
}

function cells(): CalendarCell[] {
  const map = heatmap(
    [
      { ...EMPTY_DAY, date: "2026-09-29", activeHours: 3 },
      { ...EMPTY_DAY, date: TODAY, activeHours: 1 },
    ],
    TODAY,
  );
  return map.cells.map((cell) => ({
    ...cell,
    pins:
      cell.date === "2026-09-29"
        ? [
            badge("weekly-streak-2", "Two in a Row", { qualifiedOn: cell.date }),
            badge("week-days-3", "Three-Day Week", { qualifiedOn: cell.date, isNew: true }),
          ]
        : [],
  }));
}

function renderCalendar() {
  const map = heatmap([], TODAY);
  return render(
    <SeasonCalendar cells={cells()} monthStarts={map.monthStarts} label="Activity calendar" />,
  );
}

const grid = () => page.getByRole("group", { name: "Activity calendar" });
const live = () => document.querySelector('[data-testid="calendar-live"]')?.textContent ?? "";
const tooltip = () => document.querySelector<HTMLElement>('[role="tooltip"]');

afterEach(async () => {
  await page.viewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

describe("keyboard", () => {
  test("focusing the grid puts the cursor on today; arrows move by a day and a week", async () => {
    await renderCalendar();
    await userEvent.tab();
    await expect.element(grid()).toHaveFocus();
    expect(live()).toBe("Thu 1 Oct, 1 active hour");

    await userEvent.keyboard("{ArrowUp}");
    expect(live()).toBe("Wed 30 Sep, Not active");
    await userEvent.keyboard("{ArrowUp}");
    expect(live()).toBe(
      "Tue 29 Sep, 3 active hours. Two in a Row, criterion of Two in a Row; Three-Day Week, criterion of Three-Day Week. Earned Tue 29 Sep",
    );
    await userEvent.keyboard("{ArrowLeft}");
    expect(live()).toBe("Tue 22 Sep, Not active");
    await userEvent.keyboard("{ArrowRight}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(live()).toBe("Fri 2 Oct");

    const cursor = document.querySelector('[data-date="2026-10-02"]');
    expect(cursor?.className).toContain("outline-brand-deep");
    expect(tooltip()?.hidden).toBe(false);
    expect(tooltip()?.textContent).toBe("Fri 2 Oct");
  });

  test("the cursor stops at the grid's edges", async () => {
    await renderCalendar();
    await userEvent.tab();
    await userEvent.keyboard(
      "{ArrowRight}{ArrowRight}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}",
    );
    expect(live()).toBe("Sun 4 Oct");
  });

  test("blur clears the cursor and the tooltip", async () => {
    await renderCalendar();
    await userEvent.tab();
    await userEvent.tab(); // on to the first pin
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true }); // off the grid
    expect(document.querySelector(".outline-brand-deep")).toBeNull();
    expect(tooltip()?.hidden).toBe(true);
  });
});

describe("pins and details", () => {
  test("a pin is a focusable button named by its badges; focus shows them", async () => {
    await renderCalendar();
    const pin = page.getByRole("button", {
      name: "Two in a Row, earned Tue 29 Sep; Three-Day Week, earned Tue 29 Sep, new since your last visit",
    });
    await expect.element(pin).toBeVisible();
    expect(pin.element().textContent).toBe("2"); // the stacked count
    (pin.element() as HTMLElement).focus();
    await expect.element(pin).toHaveFocus();
    expect(tooltip()?.textContent).toContain("Three-Day Week · criterion of Three-Day Week");
    expect(tooltip()?.textContent).toContain("Earned Tue 29 Sep");
  });

  test("hovering a day shows its details; leaving the grid hides them", async () => {
    await renderCalendar();
    await page
      .elementLocator(document.querySelector('[data-date="2026-10-01"]') as Element)
      .hover();
    expect(tooltip()?.hidden).toBe(false);
    expect(tooltip()?.textContent).toBe("Thu 1 Oct1 active hour");
    await page.elementLocator(document.body).hover({ position: { x: 1, y: 1 } });
    await expect.poll(() => tooltip()?.hidden).toBe(true);
  });

  test("the tooltip is hoverable: moving onto it keeps it open, leaving it hides it", async () => {
    await renderCalendar();
    await page
      .elementLocator(document.querySelector('[data-date="2026-10-01"]') as Element)
      .hover();
    await page.elementLocator(tooltip() as Element).hover();
    await new Promise((resolve) => setTimeout(resolve, 300)); // past the grace period
    expect(tooltip()?.hidden).toBe(false);
    await page.elementLocator(document.body).hover({ position: { x: 1, y: 1 } });
    await expect.poll(() => tooltip()?.hidden).toBe(true);
  });

  test("Escape dismisses the tooltip, from a hover and from the keyboard cursor", async () => {
    await renderCalendar();
    await page
      .elementLocator(document.querySelector('[data-date="2026-10-01"]') as Element)
      .hover();
    expect(tooltip()?.hidden).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(tooltip()?.hidden).toBe(true);

    await userEvent.tab();
    expect(tooltip()?.hidden).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(tooltip()?.hidden).toBe(true);
    // The cursor stays: the next arrow shows the next day.
    await userEvent.keyboard("{ArrowUp}");
    expect(tooltip()?.hidden).toBe(false);
  });

  test("a tap on a day shows the same details", async () => {
    await renderCalendar();
    document.querySelector<HTMLElement>('[data-date="2026-09-30"]')?.click();
    await expect.poll(() => tooltip()?.textContent).toBe("Wed 30 Sep" + "Not active");
  });
});

// The scroller's `overflow-x-auto` keeps the grid inside the card; without it
// the grid spills out and the scroll check fails.
describe("phone layout (390 px)", () => {
  test("the calendar scrolls inside its card, never widens the page, and starts at today", async () => {
    await page.viewport(390, 800);
    const { container } = await render(
      <div style={{ height: 800, display: "flex", flexDirection: "column" }}>
        <PageBody>
          <section
            data-testid="card"
            className="rounded-xl border border-foreground/15 bg-card px-4 pt-5 pb-4"
          >
            <SeasonCalendar
              cells={cells()}
              monthStarts={heatmap([], TODAY).monthStarts}
              label="Activity calendar"
            />
          </section>
        </PageBody>
      </div>,
    );
    const card = container.querySelector<HTMLElement>('[data-testid="card"]');
    const today = container.querySelector<HTMLElement>('[data-date="2026-10-01"]');
    const scroller = card?.firstElementChild as HTMLElement | null;
    if (!card || !today || !scroller) throw new Error("calendar not rendered");

    // The card fits the phone: the page does not widen.
    expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    // The grid is wider than the card and scrolls inside it…
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    // …starting at today's week, which is fully visible on screen.
    await expect.poll(() => scroller.scrollLeft).toBeGreaterThan(0);
    const cell = today.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    expect(cell.left).toBeGreaterThanOrEqual(box.left);
    expect(cell.right).toBeLessThanOrEqual(Math.min(box.right, 390));
    // Phone cells keep their tappable 20px size.
    expect(Math.round(cell.width)).toBe(20);
  });
});
