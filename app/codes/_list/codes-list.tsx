import Link from "next/link";
import { ArrowUpDownIcon, TrashIcon } from "@/components/icons";
import { ActionMenu } from "@/components/list/action-menu";
import { EngineSwitch } from "@/components/list/engine-switch";
import { FilterChips } from "@/components/list/filters";
import { ListControls } from "@/components/list/list-controls";
import { ListGrid } from "@/components/list/list-grid";
import { ListPager } from "@/components/list/list-pager";
import { SearchBox } from "@/components/list/search-box";
import { ListSelection } from "@/components/list/selection";
import { describeSort, sortMenuItems } from "@/components/list/sorting";
import { listHref } from "@/components/list/url";
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
import {
  CODE_COLUMNS,
  CodeRowMenu,
  codeFolded,
  codeRowAccent,
  codeRowLabel,
  toCodeRow,
} from "./columns";
import {
  CODES_PATH,
  CodeFilterGroups,
  clearFiltersHref,
  codeFilterChips,
  parseCodeFilters,
} from "./filters";
import { DEFAULT_CODE_VIEW } from "./views";

// `/codes` on the new list engine (see `docs/filtered-lists.md`, "The new list
// engine"). The page (`app/codes/page.tsx`) has already gated the teacher and
// picked this engine. Everything the list shows is filtered, sorted and paged
// in the database from the URL; page columns are computed for the visible rows
// only, and only when the view shows them.
export async function CodesList({ sp }: { sp: ParamRecord }) {
  const session = await getSession();
  const currentUserId = session?.user?.id ?? "";

  const view = DEFAULT_CODE_VIEW;
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

  // A page column: one aggregate over this page's codes, and only when the view
  // shows it. `undefined` = the count failed, which shows "—", never a wrong zero.
  const counts = view.columns.includes("interactions")
    ? await getInteractionCounts(result.rows.map((entry) => entry.code))
    : undefined;
  const rows = result.rows.map((entry) =>
    toCodeRow(entry, windowStatus(entry, now), counts ? (counts.get(entry.code) ?? 0) : null),
  );

  const chips = codeFilterChips(sp, filters, owners, currentUserId);
  const isFiltered = filters.q !== "" || chips.length > 0;
  const sorting = { pathname: CODES_PATH, params: sp, sort };

  return (
    <Main>
      <ListSelection allIds={rows.map((row) => row.code)}>
        <PageBody wide>
          {/* Remembers the applied view for the burger and back links, never the page. */}
          <RememberListFilter pathname={CODES_PATH} search={carryParams(sp, ["page"]).toString()} />

          <div className="flex w-0 min-w-full flex-wrap items-center justify-between gap-3">
            <p className="text-foreground/70 text-sm">
              {result.total} {result.total === 1 ? "code" : "codes"}
            </p>
            <div className="flex items-center gap-2">
              <EngineSwitch list={CODES_PATH} current="new" />
              <Link href="/codes/new" className={buttonVariants()}>
                New code
              </Link>
            </div>
          </div>

          <ListControls
            search={
              <SearchBox
                pathname={CODES_PATH}
                params={sp}
                label="Search codes"
                placeholder="Search note or code"
              />
            }
            sortMenu={
              <ActionMenu
                label="Sort"
                items={sortMenuItems(columns, sorting, view.defaultSortLabel)}
                triggerClassName={buttonVariants({ variant: "outline" })}
              >
                <ArrowUpDownIcon />
                Sort
              </ActionMenu>
            }
            filterCount={chips.length}
            drawer={
              <CodeFilterGroups
                sp={sp}
                filters={filters}
                owners={owners}
                currentUserId={currentUserId}
              />
            }
            chips={<FilterChips chips={chips} clearHref={clearFiltersHref(sp)} />}
            clearHref={clearFiltersHref(sp)}
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

          <p className="w-0 min-w-full text-foreground/65 text-sm">{view.description}</p>

          {rows.length === 0 ? (
            <p className="w-0 min-w-full">
              {isFiltered ? (
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
