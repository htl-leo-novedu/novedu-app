import Link from "next/link";
import { ArrowUpDownIcon, TrashIcon } from "@/components/icons";
import { ActionMenu } from "@/components/list/action-menu";
import { EngineSwitch } from "@/components/list/engine-switch";
import { FilterSummary } from "@/components/list/filters";
import { ListControls } from "@/components/list/list-controls";
import { ListGrid } from "@/components/list/list-grid";
import { ListPager } from "@/components/list/list-pager";
import { ListSelection } from "@/components/list/selection";
import { describeSort, sortMenuItems } from "@/components/list/sorting";
import { listHref, paramValue } from "@/components/list/url";
import { ViewPicker } from "@/components/list/view-picker";
import { Notice } from "@/components/notice";
import { Main, PageBody } from "@/components/page-main";
import { RememberListFilter } from "@/components/remember-list-filter";
import { buttonVariants } from "@/components/ui/button";
import { deleteSelectedCodesAction } from "@/lib/code-actions";
import { getInteractionCounts } from "@/lib/code-stats-store";
import { listCodeOwners, listCodes } from "@/lib/code-store";
import { windowStatus } from "@/lib/code-window";
import { carryParams, type ParamRecord, parsePaging } from "@/lib/db/paging";
import { parseSort } from "@/lib/db/sorting";
import { getSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import {
  CODE_COLUMNS,
  CodeRowMenu,
  codeFolded,
  codeRowAccent,
  codeRowLabel,
  toCodeRow,
} from "./columns";
import {
  appliedCodeFilters,
  CODES_PATH,
  CodeFilterGroups,
  CodeSearch,
  clearFiltersHref,
  codeFilterCount,
  codeFilterSummary,
  parseCodeFilters,
} from "./filters";
import { effectiveModels } from "./models";
import { CODE_VIEWS, DEFAULT_CODE_VIEW, pickCodeView } from "./views";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// `/codes` on the new list engine (see `docs/filtered-lists.md`, "The new list
// engine"). The page (`app/codes/page.tsx`) has already gated the teacher and
// picked this engine. Everything the list shows is filtered, sorted and paged
// in the database from the URL; page columns are computed for the visible rows
// only, and only when the view shows them.
export async function CodesList({ sp }: { sp: ParamRecord }) {
  const session = await getSession();
  const currentUserId = session?.user?.id ?? "";

  const view = pickCodeView(paramValue(sp, "view"));
  const shows = (id: (typeof view.columns)[number]) => view.columns.includes(id);
  const columns = view.columns.map((id) => CODE_COLUMNS[id]);
  // The sort allow-list is the view's sortable columns.
  const sortable = Object.fromEntries(
    columns.flatMap((column) => (column.sortKey ? [[column.sortKey, true]] : [])),
  );
  const filters = parseCodeFilters(sp, currentUserId);
  const sort = parseSort(sp, sortable);
  // One "now" per request: the status filter and the status badges agree.
  const now = new Date();

  const [result, owners] = await Promise.all([
    listCodes({
      search: filters.q || undefined,
      createdBy: filters.owner.createdBy,
      modules: filters.modules,
      statuses: filters.statuses,
      now,
      paging: parsePaging(sp),
      sort: sort ?? view.defaultSort,
      // A query column with a subquery: only when the view shows it.
      billedTokensSince: shows("tokens") ? new Date(now.getTime() - THIRTY_DAYS_MS) : undefined,
    }),
    listCodeOwners(),
  ]);

  if (result === undefined) {
    return (
      <Main>
        <Notice heading="Codes temporarily unavailable">
          <p>Codes could not be loaded right now. Try again in a moment.</p>
        </Notice>
      </Main>
    );
  }

  // Page columns: computed over this page's codes, and only when the view shows
  // them. A failed count is `undefined` and a model that can't be read `null` —
  // both show "—", never a wrong value.
  const [counts, models] = await Promise.all([
    shows("interactions")
      ? getInteractionCounts(result.rows.map((entry) => entry.code))
      : undefined,
    shows("model") ? effectiveModels(result.rows) : undefined,
  ]);
  const rows = result.rows.map((entry) =>
    toCodeRow(entry, windowStatus(entry, now), {
      interactionCount: counts ? (counts.get(entry.code) ?? 0) : null,
      model: models?.get(entry.code) ?? null,
    }),
  );

  const filterCount = codeFilterCount(filters, currentUserId);
  const sorting = { pathname: CODES_PATH, params: sp, sort };

  return (
    <Main>
      <ListSelection allIds={rows.map((row) => row.code)}>
        <PageBody wide>
          {/* Remembers the applied view for the burger and back links, never the page. */}
          <RememberListFilter pathname={CODES_PATH} search={carryParams(sp, ["page"]).toString()} />

          <ListControls
            viewPicker={
              <ViewPicker
                views={CODE_VIEWS.map((v) => ({
                  label: v.label,
                  description: v.description,
                  // Another view has other sortable columns: the sort goes, the filters stay.
                  href: listHref(CODES_PATH, sp, {
                    view: v.id === DEFAULT_CODE_VIEW.id ? undefined : v.id,
                    sort: undefined,
                  }),
                  current: v.id === view.id,
                }))}
              />
            }
            sortMenu={
              <ActionMenu
                label="Sort"
                items={sortMenuItems(columns, sorting, view.defaultSortLabel)}
                triggerClassName={cn(buttonVariants({ variant: "outline" }), "w-9 px-0")}
              >
                <ArrowUpDownIcon />
                <span className="sr-only">Sort</span>
              </ActionMenu>
            }
            actions={
              <>
                <EngineSwitch list={CODES_PATH} current="new" />
                <Link href="/codes/new" className={buttonVariants()}>
                  New code
                </Link>
              </>
            }
            filterCount={filterCount}
            filters={{
              pathname: CODES_PATH,
              params: sp,
              applied: appliedCodeFilters(filters, currentUserId),
            }}
            search={<CodeSearch />}
            groups={
              <CodeFilterGroups filters={filters} owners={owners} currentUserId={currentUserId} />
            }
            summary={
              <FilterSummary
                count={`${result.total} ${result.total === 1 ? "code" : "codes"}`}
                parts={codeFilterSummary(filters, owners, currentUserId)}
                clearHref={filterCount > 0 ? clearFiltersHref(sp) : undefined}
              />
            }
            itemNoun="code"
            bulkActions={[
              {
                label: "Delete",
                pendingLabel: "Deleting",
                action: deleteSelectedCodesAction,
                icon: <TrashIcon />,
                destructive: true,
                confirm: "delete",
              },
            ]}
          />

          {rows.length === 0 ? (
            <p className="w-0 min-w-full">
              {filterCount > 0 ? (
                "No codes match your filter."
              ) : (
                <>
                  No codes yet. <Link href="/codes/new">Create one</Link> to share an activity with
                  students — or{" "}
                  <Link href={listHref(CODES_PATH, sp, { owner: "all" })}>show all owners</Link> to
                  see codes from other teachers.
                </>
              )}
            </p>
          ) : (
            <ListGrid
              rows={rows}
              columns={columns}
              rowKey={(row) => row.code}
              rowLabel={codeRowLabel}
              rowClassName={codeRowAccent}
              rowMenu={(row) => <CodeRowMenu row={row} />}
              folded={codeFolded}
              sorting={sorting}
              sortLabel={describeSort(columns, sort, view.defaultSortLabel)}
            />
          )}

          <ListPager pathname={CODES_PATH} params={sp} result={result} rowCount={rows.length} />
        </PageBody>
      </ListSelection>
    </Main>
  );
}
