import {
  type FilterDraft,
  FilterSearch,
  FilterSelect,
  FilterToggle,
} from "@/components/list/filter-panel";
import { FilterGroup, type FilterSummaryPart } from "@/components/list/filters";
import { listHref, paramValue, parseMultiParam } from "@/components/list/url";
import { CODE_MODULES, type CodeModule, codeModuleLabels } from "@/lib/code-modules/types";
import { WINDOW_STATUSES, type WindowStatus } from "@/lib/code-window";
import { ALL_OWNERS, type OwnerOption, parseOwner } from "@/lib/db/owner-filter";
import type { ParamRecord } from "@/lib/db/paging";

// The `/codes` list's filters on the new list engine (see `docs/filtered-lists.md`,
// "The new list engine"). Each is a URL param the store turns into SQL:
//
//   q       contains-search over note/code (the panel's search field)
//   owner   absent = me, `all`, or a user id — as on the classic list
//   module  activities, comma-separated (`?module=tutor,quiz`)
//   status  window states at the request's "now", comma-separated

export const CODES_PATH = "/codes";

export interface CodeFilters {
  q: string;
  owner: { value: string; createdBy: string | undefined };
  modules: CodeModule[];
  statuses: WindowStatus[];
}

export function parseCodeFilters(sp: ParamRecord, currentUserId: string): CodeFilters {
  return {
    q: paramValue(sp, "q"),
    owner: parseOwner(sp, currentUserId),
    modules: parseMultiParam(sp, "module", CODE_MODULES),
    statuses: parseMultiParam(sp, "status", WINDOW_STATUSES),
  };
}

const STATUS_LABELS: Record<WindowStatus, string> = {
  active: "Active",
  upcoming: "Upcoming",
  expired: "Expired",
};

interface OwnerChoice {
  /** The owner param's value; `""` = me. */
  value: string;
  label: string;
}

/**
 * The owner choices besides "Mine" and "All owners": every other owner, plus a
 * URL-named owner outside that list (a stale bookmark), so the control never
 * disagrees with the filter the query applies. My own id in the URL is "Mine".
 */
function otherOwners(options: OwnerOption[], value: string, currentUserId: string): OwnerChoice[] {
  const others = options
    .filter((option) => option.userId !== currentUserId)
    .map((option) => ({ value: option.userId, label: option.label }));
  if (
    value !== "" &&
    value !== ALL_OWNERS &&
    value !== currentUserId &&
    !others.some((o) => o.value === value)
  ) {
    others.push({ value, label: value });
  }
  return others;
}

/** The owner param as the controls see it: my own id reads as the default. */
const ownerValue = (filters: CodeFilters, currentUserId: string) =>
  filters.owner.value === currentUserId ? "" : filters.owner.value;

/** The filters the URL applies, as the panel's draft starts out. */
export function appliedCodeFilters(filters: CodeFilters, currentUserId: string): FilterDraft {
  const owner = ownerValue(filters, currentUserId);
  return {
    q: filters.q ? [filters.q] : [],
    owner: owner ? [owner] : [],
    module: filters.modules,
    status: filters.statuses,
  };
}

/** How many filter values the list applies (the default owner is none). */
export const codeFilterCount = (filters: CodeFilters, currentUserId: string) =>
  Object.values(appliedCodeFilters(filters, currentUserId)).flat().length;

/** The panel's search field. */
export function CodeSearch() {
  return (
    <FilterGroup label="Search">
      <FilterSearch param="q" label="Search codes" placeholder="Search note or code" />
    </FilterGroup>
  );
}

/** The panel's filter groups. */
export function CodeFilterGroups({
  filters,
  owners,
  currentUserId,
}: {
  filters: CodeFilters;
  owners: OwnerOption[];
  currentUserId: string;
}) {
  const others = otherOwners(owners, ownerValue(filters, currentUserId), currentUserId);
  return (
    <>
      <FilterGroup label="Owner">
        <FilterToggle param="owner" value="">
          Mine
        </FilterToggle>
        <FilterToggle param="owner" value={ALL_OWNERS}>
          All owners
        </FilterToggle>
        {others.length > 0 ? (
          <FilterSelect
            param="owner"
            label="Other owner"
            placeholder="Other owner…"
            options={others}
          />
        ) : null}
      </FilterGroup>
      <FilterGroup label="Activity">
        {CODE_MODULES.map((module) => (
          <FilterToggle key={module} param="module" value={module} multi>
            {codeModuleLabels[module].badge}
          </FilterToggle>
        ))}
      </FilterGroup>
      <FilterGroup label="Status">
        {WINDOW_STATUSES.map((status) => (
          <FilterToggle key={status} param="status" value={status} multi>
            {STATUS_LABELS[status]}
          </FilterToggle>
        ))}
      </FilterGroup>
    </>
  );
}

/**
 * The summary line's filters, in a fixed order: the owner always (my own codes
 * are a filter too), then activity, status and search only when set.
 */
export function codeFilterSummary(
  filters: CodeFilters,
  owners: OwnerOption[],
  currentUserId: string,
): FilterSummaryPart[] {
  const owner = ownerValue(filters, currentUserId);
  const ownerLabel =
    owner === ""
      ? "mine"
      : owner === ALL_OWNERS
        ? "all owners"
        : (otherOwners(owners, owner, currentUserId).find((o) => o.value === owner)?.label ??
          owner);
  const parts: FilterSummaryPart[] = [{ label: "Owner", value: ownerLabel }];
  if (filters.modules.length > 0) {
    parts.push({
      label: "Activity",
      value: filters.modules.map((module) => codeModuleLabels[module].badge).join(", "),
    });
  }
  if (filters.statuses.length > 0) {
    parts.push({
      label: "Status",
      value: filters.statuses.map((status) => STATUS_LABELS[status]).join(", "),
    });
  }
  if (filters.q) parts.push({ label: "Search", value: `“${filters.q}”` });
  return parts;
}

/** The list URL with every filter cleared; the sort and page size stay. */
export const clearFiltersHref = (sp: ParamRecord) =>
  listHref(CODES_PATH, sp, {
    q: undefined,
    owner: undefined,
    module: undefined,
    status: undefined,
  });
