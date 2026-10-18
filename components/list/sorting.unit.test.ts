import { describe, expect, it } from "vitest";
import type { GridColumn } from "./list-grid";
import { describeSort, sortMenuItems } from "./sorting";

// The folded phone list's Sort menu and its one-line order description: the
// default order first (ticked while no column sorts), then each sortable column
// of the view — picking one sorts ascending, picking the active one flips it.
// Every link keeps the filters and drops the page.

type Row = { id: string };
const COLUMNS: GridColumn<Row>[] = [
  { id: "note", header: "Note", sortKey: "note", render: () => null },
  { id: "count", header: "Interactions", render: () => null },
  { id: "until", header: "Valid until", sortKey: "until", render: () => null },
];
const SP = { q: "math", page: "3" };
const sorting = (sort?: { key: string; dir: "asc" | "desc" }) => ({
  pathname: "/codes",
  params: SP,
  sort,
});

describe("describeSort", () => {
  it("names the sorted column with its arrow", () => {
    expect(describeSort(COLUMNS, { key: "note", dir: "asc" })).toBe("Note ↑");
    expect(describeSort(COLUMNS, { key: "until", dir: "desc" })).toBe("Valid until ↓");
  });

  it("falls back to the default label when unsorted or the key is not in the view", () => {
    expect(describeSort(COLUMNS, undefined, "Newest first")).toBe("Newest first");
    expect(describeSort(COLUMNS, { key: "owner", dir: "asc" }, "Newest first")).toBe(
      "Newest first",
    );
  });
});

describe("sortMenuItems", () => {
  it("lists the default order (ticked) and only the sortable columns", () => {
    const items = sortMenuItems(COLUMNS, sorting(), "Newest first");
    expect(items.map((item) => item.label)).toEqual(["Newest first ✓", "Note", "Valid until"]);
  });

  it("sorts a column ascending and keeps the filters, never the page", () => {
    const [, note] = sortMenuItems(COLUMNS, sorting(), "Newest first");
    expect(note).toMatchObject({ kind: "link", href: "/codes?q=math&sort=note" });
  });

  it("flips the active column and shows its direction", () => {
    const [first, note, until] = sortMenuItems(
      COLUMNS,
      sorting({ key: "note", dir: "asc" }),
      "Newest first",
    );
    expect(first).toMatchObject({ label: "Newest first", href: "/codes?q=math" });
    expect(note).toMatchObject({ label: "Note ↑", href: "/codes?q=math&sort=-note" });
    expect(until).toMatchObject({ label: "Valid until", href: "/codes?q=math&sort=until" });

    const [, descending] = sortMenuItems(COLUMNS, sorting({ key: "note", dir: "desc" }));
    expect(descending).toMatchObject({ label: "Note ↓", href: "/codes?q=math&sort=note" });
  });
});
