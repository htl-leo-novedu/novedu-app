import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("next/link", () => import("@/tests/mocks/next-link"));

// The new list engine's controls and table together, in a real browser with
// the real stylesheet: the filter drawer and its chips, the tri-state select-all,
// the bulk bar taking the toolbar's place without moving the table, a bulk
// delete, and the phone layout — folded rows, the Sort button, and the bulk bar
// floating at the bottom with its actions behind a sheet. The real server
// action and DB delete are the e2e spec's (`e2e/codes-list-engine.spec.ts`).
import "@/app/globals.css";
import { ActionMenu } from "./action-menu";
import { FilterChips, FilterGroup, FilterPill } from "./filters";
import { ListControls } from "./list-controls";
import { type GridColumn, ListGrid } from "./list-grid";
import { type BulkAction, ListSelection } from "./selection";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

interface Row {
  id: string;
  note: string;
  owner: string;
}
const ROWS: Row[] = [
  { id: "a1", note: "Fractions", owner: "Ada" },
  { id: "b2", note: "Algebra", owner: "Grace" },
  { id: "c3", note: "Geometry", owner: "Ada" },
];
const COLUMNS: GridColumn<Row>[] = [
  { id: "note", header: "Note", sortKey: "note", render: (row) => row.note },
  { id: "owner", header: "Owner", render: (row) => row.owner, fact: (row) => row.owner },
  { id: "id", header: "Code", render: (row) => row.id, fact: (row) => `Code ${row.id}` },
];

function Harness({ action, filterCount = 2 }: { action: BulkAction; filterCount?: number }) {
  return (
    <ListSelection allIds={ROWS.map((row) => row.id)}>
      <ListControls
        search={<input aria-label="Search codes" className="h-9" />}
        sortMenu={
          <ActionMenu
            label="Sort"
            items={[{ kind: "link", label: "Note", href: "/codes?sort=note" }]}
          >
            Sort
          </ActionMenu>
        }
        filterCount={filterCount}
        drawer={
          <FilterGroup label="Status">
            <FilterPill href="/codes?status=active" active>
              Active
            </FilterPill>
            <FilterPill href="/codes?status=expired" active={false}>
              Expired
            </FilterPill>
          </FilterGroup>
        }
        chips={
          <FilterChips
            chips={[
              { label: "Active", removeHref: "/codes" },
              { label: "Tutor", removeHref: "/codes?status=active" },
            ].slice(0, filterCount)}
            clearHref="/codes"
          />
        }
        clearHref="/codes"
        itemNoun="code"
        bulkActions={[
          {
            label: "Delete",
            pendingLabel: "Deleting",
            action,
            destructive: true,
            confirm: "delete",
          },
        ]}
      />
      <ListGrid
        rows={ROWS}
        columns={COLUMNS}
        rowKey={(row) => row.id}
        rowLabel={(row) => row.note}
        rowMenu={(row) => (
          <ActionMenu
            label={`Actions for ${row.note}`}
            items={[{ kind: "link", label: "View", href: `/codes/${row.id}` }]}
          />
        )}
        folded={{ title: (row) => row.note, meta: (row) => <span>meta {row.id}</span> }}
        sorting={{ pathname: "/codes", params: {}, sort: { key: "note", dir: "asc" } }}
        sortLabel="Note ↑"
      />
    </ListSelection>
  );
}

const confirmSpy = vi.spyOn(window, "confirm");

beforeEach(() => {
  refresh.mockClear();
  confirmSpy.mockReset().mockReturnValue(true);
});

afterEach(async () => {
  await page.viewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

const ok: BulkAction = async () => ({ ok: true });

describe("desktop", () => {
  test("Filters opens the drawer in place of the chips; Done closes it", async () => {
    const screen = await render(<Harness action={ok} />);
    const filters = screen.getByRole("button", { name: /Filters/ });
    const chips = screen.getByRole("list", { name: "Active filters" });
    await expect.element(filters).toHaveAttribute("aria-expanded", "false");
    await expect.element(filters).toHaveTextContent("2");
    await expect.element(chips).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Remove filter Active" }))
      .toHaveAttribute("href", "/codes");

    await filters.click();
    const drawer = screen.getByRole("region", { name: "Filters" });
    await expect.element(drawer).toBeVisible();
    await expect.element(filters).toHaveAttribute("aria-expanded", "true");
    await expect.element(chips).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("link", { name: "Active" }))
      .toHaveAttribute("aria-current", "true");
    await expect
      .element(drawer.getByRole("link", { name: "Clear all" }))
      .toHaveAttribute("href", "/codes");

    await screen.getByRole("button", { name: "Done" }).click();
    await expect.element(drawer).not.toBeInTheDocument();
    await expect.element(screen.getByRole("list", { name: "Active filters" })).toBeVisible();
  });

  test("no filter: no badge, no chips, no Clear all", async () => {
    const screen = await render(<Harness action={ok} filterCount={0} />);
    await expect
      .element(screen.getByRole("button", { name: /Filters/ }))
      .toHaveTextContent(/^Filters$/);
    await expect
      .element(screen.getByRole("list", { name: "Active filters" }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: /Filters/ }).click();
    await expect.element(screen.getByRole("link", { name: "Clear all" })).not.toBeInTheDocument();
  });

  test("select-all is tri-state and folded rows stay hidden", async () => {
    const screen = await render(<Harness action={ok} />);
    const all = screen.getByRole("checkbox", { name: "Select all rows on this page" });
    const input = all.element() as HTMLInputElement;
    await expect.element(screen.getByText("meta a1")).not.toBeVisible();

    await screen.getByRole("checkbox", { name: "Select Algebra" }).click();
    await expect.poll(() => input.indeterminate).toBe(true);
    await expect.element(all).not.toBeChecked();

    await all.click();
    await expect.poll(() => input.indeterminate).toBe(false);
    await expect.element(all).toBeChecked();
    for (const note of ["Fractions", "Algebra", "Geometry"]) {
      await expect.element(screen.getByRole("checkbox", { name: `Select ${note}` })).toBeChecked();
    }

    await all.click();
    await expect
      .element(screen.getByRole("checkbox", { name: "Select Fractions" }))
      .not.toBeChecked();
  });

  test("the bulk bar takes the toolbar's place without moving the table", async () => {
    const screen = await render(<Harness action={ok} />);
    const table = screen.getByRole("table").element();
    const before = table.getBoundingClientRect().top;
    await expect
      .element(screen.getByRole("button", { name: "Sort", includeHidden: true }))
      .not.toBeVisible();

    await screen.getByRole("checkbox", { name: "Select Fractions" }).click();
    const bar = screen.getByRole("region", { name: "Bulk actions" });
    await expect.element(bar).toHaveTextContent("1 selected");
    await expect
      .element(screen.getByRole("textbox", { name: "Search codes", includeHidden: true }))
      .not.toBeVisible();
    expect(table.getBoundingClientRect().top).toBe(before);

    await screen.getByRole("button", { name: "Clear selection" }).click();
    await expect.element(bar).not.toBeInTheDocument();
    await expect.element(screen.getByRole("textbox", { name: "Search codes" })).toBeVisible();
  });

  test("Delete confirms with the count, runs once over the selection, then clears", async () => {
    const action = vi.fn<BulkAction>(async () => ({ ok: true }));
    const screen = await render(<Harness action={action} />);
    await screen.getByRole("checkbox", { name: "Select Fractions" }).click();
    await screen.getByRole("checkbox", { name: "Select Geometry" }).click();

    await screen.getByRole("button", { name: "Delete" }).click();
    expect(confirmSpy).toHaveBeenCalledWith(
      "Delete 2 codes?\n\nThis permanently deletes them and cannot be undone.",
    );
    await expect.poll(() => action.mock.calls).toEqual([[["a1", "c3"]]]);
    await expect.poll(() => refresh.mock.calls.length).toBe(1);
    await expect
      .element(screen.getByRole("region", { name: "Bulk actions" }))
      .not.toBeInTheDocument();
  });

  test("a cancelled confirm runs nothing; a failure keeps the selection and says why", async () => {
    const action = vi.fn<BulkAction>(async () => ({ ok: false, message: "Could not delete." }));
    const screen = await render(<Harness action={action} />);
    await screen.getByRole("checkbox", { name: "Select Algebra" }).click();

    confirmSpy.mockReturnValueOnce(false);
    await screen.getByRole("button", { name: "Delete" }).click();
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/^Delete 1 code\?/));
    expect(action).not.toHaveBeenCalled();

    await screen.getByRole("button", { name: "Delete" }).click();
    await expect.element(screen.getByText("Could not delete.")).toBeVisible();
    await expect.element(screen.getByRole("checkbox", { name: "Select Algebra" })).toBeChecked();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("phone", () => {
  beforeEach(async () => {
    await page.viewport(390, 844);
  });

  test("rows fold into title, meta and facts; the Sort button replaces the headers", async () => {
    const screen = await render(<Harness action={ok} />);
    await expect
      .element(screen.getByRole("columnheader", { name: /Note/ }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText("meta a1")).toBeVisible();
    await expect.element(screen.getByText("Ada · Code a1")).toBeVisible();
    await expect.element(screen.getByText("Note ↑")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Sort" })).toBeVisible();
    // The folded list keeps a visible select-all.
    await screen.getByRole("checkbox", { name: "Select all", exact: true }).click();
    await expect.element(screen.getByRole("checkbox", { name: "Select Geometry" })).toBeChecked();
  });

  test("the bulk bar floats at the bottom with its actions in a sheet", async () => {
    const action = vi.fn<BulkAction>(async () => ({ ok: true }));
    const screen = await render(<Harness action={action} />);
    await screen.getByRole("checkbox", { name: "Select Algebra" }).click();

    const bar = screen.getByRole("region", { name: "Bulk actions" });
    await expect.element(bar).toHaveTextContent("1 selected");
    const rect = bar.element().getBoundingClientRect();
    expect(getComputedStyle(bar.element()).position).toBe("fixed");
    expect(844 - rect.bottom).toBeLessThanOrEqual(16);
    // The toolbar stays: the bar does not take its place on a phone.
    await expect.element(screen.getByRole("textbox", { name: "Search codes" })).toBeVisible();

    await screen.getByRole("button", { name: "Actions", exact: true }).click();
    await screen.getByRole("menuitem", { name: "Delete" }).click();
    await expect.poll(() => action.mock.calls).toEqual([[["b2"]]]);
    await expect.element(bar).not.toBeInTheDocument();
  });

  test("the X clears the selection", async () => {
    const screen = await render(<Harness action={ok} />);
    await screen.getByRole("checkbox", { name: "Select Algebra" }).click();
    await screen.getByRole("button", { name: "Clear selection" }).click();
    await expect
      .element(screen.getByRole("region", { name: "Bulk actions" }))
      .not.toBeInTheDocument();
  });
});
