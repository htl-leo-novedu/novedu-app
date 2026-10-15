import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("next/link", () => import("@/tests/mocks/next-link"));

// ListTable's sticky mode (the usage dashboard's token table): with the card's
// height capped, the header and the footer row stay in view while the body rows
// scroll beneath them, and their opaque background hides the rows. Pure CSS, so
// this needs the real stylesheet.
import "@/app/globals.css";
import { type ListColumn, ListTable } from "@/components/data-list";

interface Row {
  id: string;
}

const ROWS: Row[] = Array.from({ length: 60 }, (_, i) => ({ id: `row-${i}` }));
const COLUMNS: ListColumn<Row>[] = [
  { header: "Row", render: (r) => r.id, footer: "Total" },
  { header: "Value", kind: "numeric", render: () => "1", footer: "60" },
];

test("the header and the footer stay in view while the body scrolls", async () => {
  const screen = await render(
    <ListTable rows={ROWS} getRowKey={(r) => r.id} columns={COLUMNS} sticky className="max-h-80" />,
  );
  const header = screen.getByRole("columnheader", { name: "Row" }).element();
  const footer = screen.getByRole("cell", { name: "Total" }).element();
  const card = header.closest("div") as HTMLElement;
  expect(card.scrollHeight).toBeGreaterThan(card.clientHeight); // it does scroll

  const inView = (el: Element) => {
    const box = card.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
  };
  expect(inView(header)).toBe(true);
  expect(inView(footer)).toBe(true);

  card.scrollTop = card.scrollHeight / 2;
  await expect.poll(() => inView(header) && inView(footer)).toBe(true);
  card.scrollTop = card.scrollHeight;
  await expect.poll(() => inView(header) && inView(footer)).toBe(true);

  // Opaque: the pinned cells paint a background image over the card colour.
  expect(getComputedStyle(header).backgroundImage).not.toBe("none");
  expect(getComputedStyle(footer).position).toBe("sticky");
});
