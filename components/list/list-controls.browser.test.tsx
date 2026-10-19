import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));
vi.mock("next/link", () => import("@/tests/mocks/next-link"));

// The new list engine's controls and table together, in a real browser with
// the real stylesheet: the one-row toolbar (view picker, Filters, the page's
// actions), the filter panel's draft that only Apply (or Enter) turns into one
// URL, Cancel and Clear all, the tri-state select-all, the bulk bar taking the
// toolbar's place without moving the table, a bulk delete, and the phone layout
// — the actions on top, folded rows, the Sort button, and the bulk bar floating
// at the bottom with its actions behind a sheet. The real server action and DB
// delete are the e2e spec's (`e2e/codes-list-engine.spec.ts`).
import "@/app/globals.css";
import { ActionMenu } from "./action-menu";
import { type FilterDraft, FilterSearch, FilterSelect, FilterToggle } from "./filter-panel";
import { FilterGroup, FilterSummary } from "./filters";
import { ListControls } from "./list-controls";
import { type GridColumn, ListGrid } from "./list-grid";
import { type BulkAction, ListSelection } from "./selection";
import { ViewPicker } from "./view-picker";

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
const ACTIVE: FilterDraft = { q: [], owner: [], status: ["active"] };

function Harness({ action, applied = ACTIVE }: { action: BulkAction; applied?: FilterDraft }) {
  return (
    <ListSelection allIds={ROWS.map((row) => row.id)}>
      <ListControls
        viewPicker={
          <ViewPicker
            views={[
              { label: "Overview", description: "Everything.", href: "/codes", current: true },
              {
                label: "Models",
                description: "The models.",
                href: "/codes?view=models",
                current: false,
              },
            ]}
          />
        }
        sortMenu={
          <ActionMenu
            label="Sort"
            items={[{ kind: "link", label: "Note", href: "/codes?sort=note" }]}
          >
            Sort
          </ActionMenu>
        }
        actions={<a href="/codes/new">New code</a>}
        filterCount={Object.values(applied).flat().length}
        filters={{ pathname: "/codes", params: { sort: "note", page: "3" }, applied }}
        search={<FilterSearch param="q" label="Search codes" placeholder="Search" />}
        groups={
          <>
            <FilterGroup label="Owner">
              <FilterToggle param="owner" value="">
                Mine
              </FilterToggle>
              <FilterToggle param="owner" value="all">
                All owners
              </FilterToggle>
              <FilterSelect
                param="owner"
                label="Other owner"
                placeholder="Other owner…"
                options={[{ value: "u-ada", label: "Ada" }]}
              />
            </FilterGroup>
            <FilterGroup label="Status">
              <FilterToggle param="status" value="active" multi>
                Active
              </FilterToggle>
              <FilterToggle param="status" value="expired" multi>
                Expired
              </FilterToggle>
            </FilterGroup>
          </>
        }
        summary={
          <FilterSummary
            count="3 codes"
            parts={[
              { label: "Owner", value: "mine" },
              { label: "Status", value: "Active" },
            ]}
            clearHref="/codes?sort=note"
          />
        }
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
        rowActions={(row) => (
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
  push.mockClear();
  confirmSpy.mockReset().mockReturnValue(true);
});

afterEach(async () => {
  await page.viewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

const ok: BulkAction = async () => ({ ok: true });
const box = (element: Element) => element.getBoundingClientRect();

describe("desktop", () => {
  test("one toolbar row: view picker and Filters, the page's actions on the right; the summary under it", async () => {
    const screen = await render(<Harness action={ok} />);
    const view = box(screen.getByRole("button", { name: /^View/ }).element());
    const filters = box(screen.getByRole("button", { name: /Filters/ }).element());
    const action = box(screen.getByRole("link", { name: "New code" }).element());
    expect(Math.abs(view.top + view.height / 2 - (action.top + action.height / 2))).toBeLessThan(4);
    expect(filters.left).toBeGreaterThan(view.right);
    expect(action.left).toBeGreaterThan(filters.right + 300);
    // The search field lives in the panel, not the toolbar.
    await expect
      .element(screen.getByRole("searchbox", { name: "Search codes" }))
      .not.toBeInTheDocument();

    const summary = screen.getByText("3 codes").element().parentElement as HTMLElement;
    expect(summary.textContent).toBe("3 codes·Owner: mine·Status: Active·Clear all");
    expect(box(summary).top).toBeGreaterThan(view.bottom);
    await expect
      .element(screen.getByRole("link", { name: "Clear all" }))
      .toHaveAttribute("href", "/codes?sort=note");
  });

  test("the view picker names the current view and lists every view, the current one ticked", async () => {
    const screen = await render(<Harness action={ok} />);
    const trigger = screen.getByRole("button", { name: /^View/ });
    await expect.element(trigger).toHaveTextContent("Overview");
    await trigger.click();
    await expect
      .element(screen.getByRole("menuitem", { name: /Overview/ }))
      .toHaveAttribute("aria-current", "true");
    await expect.element(screen.getByText("Everything.")).toBeVisible();
    const models = screen.getByRole("menuitem", { name: /Models/ });
    await expect.element(models).toHaveAttribute("href", "/codes?view=models");
    await expect.element(models).not.toHaveAttribute("aria-current");
    await expect.element(screen.getByText("The models.")).toBeVisible();
  });

  test("the panel edits a draft; only Apply loads, as one URL without the page", async () => {
    const screen = await render(<Harness action={ok} />);
    const filters = screen.getByRole("button", { name: /Filters/ });
    await expect.element(filters).toHaveTextContent("1");
    await filters.click();
    await expect.element(filters).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("form", { name: "Filters" });
    await expect
      .element(panel.getByRole("button", { name: "Active" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(panel.getByText("Not applied yet")).not.toBeInTheDocument();

    await panel.getByRole("searchbox", { name: "Search codes" }).fill("frac");
    await panel.getByRole("button", { name: "Expired" }).click();
    await expect
      .element(panel.getByRole("button", { name: "Expired" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(panel.getByText("Not applied yet")).toBeVisible();
    expect(push).not.toHaveBeenCalled();

    await panel.getByRole("button", { name: "Apply" }).click();
    expect(push).toHaveBeenCalledWith("/codes?sort=note&q=frac&status=active,expired");
    await expect.element(panel).not.toBeInTheDocument();
  });

  test("Enter in the search field applies the whole draft", async () => {
    const screen = await render(<Harness action={ok} />);
    await screen.getByRole("button", { name: /Filters/ }).click();
    await screen.getByRole("button", { name: "Active" }).click();
    await screen.getByRole("searchbox", { name: "Search codes" }).fill("alg");
    await userEvent.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/codes?sort=note&q=alg");
  });

  test("Cancel throws the draft away; Apply without a change only closes", async () => {
    const screen = await render(<Harness action={ok} />);
    const filters = screen.getByRole("button", { name: /Filters/ });
    await filters.click();
    await screen.getByRole("button", { name: "Expired" }).click();
    await screen.getByRole("button", { name: "Cancel" }).click();
    await expect.element(screen.getByRole("form", { name: "Filters" })).not.toBeInTheDocument();

    await filters.click();
    await expect
      .element(screen.getByRole("button", { name: "Expired" }))
      .toHaveAttribute("aria-pressed", "false");
    await screen.getByRole("button", { name: "Apply" }).click();
    await expect.element(screen.getByRole("form", { name: "Filters" })).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  test("Clear all empties the draft, back to the defaults", async () => {
    const screen = await render(
      <Harness action={ok} applied={{ q: ["x"], owner: ["all"], status: ["active"] }} />,
    );
    await screen.getByRole("button", { name: /Filters/ }).click();
    await screen.getByRole("button", { name: "Clear all" }).click();
    await expect.element(screen.getByRole("searchbox", { name: "Search codes" })).toHaveValue("");
    await expect
      .element(screen.getByRole("button", { name: "Mine" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByRole("button", { name: "Active" }))
      .toHaveAttribute("aria-pressed", "false");
    await expect.element(screen.getByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(push).toHaveBeenCalledWith("/codes?sort=note");
  });

  test("an owner is one choice: pills and the select take turns", async () => {
    const screen = await render(<Harness action={ok} />);
    await screen.getByRole("button", { name: /Filters/ }).click();
    const select = screen.getByRole("combobox", { name: "Other owner" });
    await select.selectOptions("u-ada");
    await expect
      .element(screen.getByRole("button", { name: "Mine" }))
      .toHaveAttribute("aria-pressed", "false");
    await screen.getByRole("button", { name: "All owners" }).click();
    await expect.element(select).toHaveValue("");
    await screen.getByRole("button", { name: "Apply" }).click();
    expect(push).toHaveBeenCalledWith("/codes?sort=note&owner=all&status=active");
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

  test("the bulk bar takes the whole toolbar row's place without moving the table", async () => {
    const screen = await render(<Harness action={ok} />);
    const table = screen.getByRole("table").element();
    const before = table.getBoundingClientRect().top;
    await expect
      .element(screen.getByRole("button", { name: "Sort", includeHidden: true }))
      .not.toBeVisible();

    await screen.getByRole("checkbox", { name: "Select Fractions" }).click();
    const bar = screen.getByRole("region", { name: "Bulk actions" });
    await expect.element(bar).toHaveTextContent("1 selected");
    for (const name of [/^View/, /Filters/]) {
      await expect
        .element(screen.getByRole("button", { name, includeHidden: true }))
        .not.toBeVisible();
    }
    await expect
      .element(screen.getByRole("link", { name: "New code", includeHidden: true }))
      .not.toBeVisible();
    expect(table.getBoundingClientRect().top).toBe(before);

    await screen.getByRole("button", { name: "Clear selection" }).click();
    await expect.element(bar).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: /Filters/ })).toBeVisible();
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

  test("the page's actions get the top row, above the view picker, Sort and Filters", async () => {
    const screen = await render(<Harness action={ok} />);
    const action = box(screen.getByRole("link", { name: "New code" }).element());
    const view = box(screen.getByRole("button", { name: /Overview/ }).element());
    const sort = box(screen.getByRole("button", { name: "Sort" }).element());
    const filters = box(screen.getByRole("button", { name: /Filters/ }).element());
    expect(action.bottom).toBeLessThanOrEqual(view.top);
    expect(Math.abs(view.top - sort.top)).toBeLessThan(4);
    expect(Math.abs(view.top - filters.top)).toBeLessThan(4);
    // The view picker takes the room left on its row.
    expect(view.width).toBeGreaterThan(150);
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
    await expect.element(screen.getByRole("button", { name: /Filters/ })).toBeVisible();

    await screen.getByRole("button", { name: "Actions", exact: true }).click();
    await screen.getByRole("menuitem", { name: "Delete" }).click();
    await expect.poll(() => action.mock.calls).toEqual([[["b2"]]]);
    await expect.element(bar).not.toBeInTheDocument();
  });

  test("a long unbroken word wraps instead of widening the folded list", async () => {
    const long = { id: "d4", note: "Aufgabensammlung".repeat(4), owner: "Ada" };
    const screen = await render(
      <ListSelection allIds={[long.id]}>
        <ListGrid
          rows={[long]}
          columns={COLUMNS}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.note}
          rowActions={() => null}
          folded={{ title: (row) => row.note, meta: () => null }}
          sorting={{ pathname: "/codes", params: {}, sort: undefined }}
          sortLabel="Newest first"
        />
      </ListSelection>,
    );
    expect(box(screen.getByRole("table").element()).width).toBeLessThanOrEqual(390);
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
