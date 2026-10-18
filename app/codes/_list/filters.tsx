import { type FilterChip, FilterGroup, FilterPill } from "@/components/list/filters";
import { LinkSelect } from "@/components/list/link-select";
import { listHref, paramValue, parseMultiParam, toggleMultiValue } from "@/components/list/url";
import { CODE_MODULES, type CodeModule, codeModuleLabels } from "@/lib/code-modules/types";
import { WINDOW_STATUSES, type WindowStatus } from "@/lib/code-window";
import { ALL_OWNERS, type OwnerOption, parseOwner } from "@/lib/db/owner-filter";
import type { ParamRecord } from "@/lib/db/paging";

// The `/codes` list's filters on the new list engine (see `docs/filtered-lists.md`,
// "The new list engine"). Each is a URL param the store turns into SQL:
//
//   q       contains-search over note/code (the toolbar's search box)
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

/** The drawer's filter groups. */
export function CodeFilterGroups({
  sp,
  filters,
  owners,
  currentUserId,
}: {
  sp: ParamRecord;
  filters: CodeFilters;
  owners: OwnerOption[];
  currentUserId: string;
}) {
  const owner = ownerValue(filters, currentUserId);
  const others = otherOwners(owners, owner, currentUserId);
  return (
    <>
      <FilterGroup label="Owner">
        <FilterPill href={listHref(CODES_PATH, sp, { owner: undefined })} active={owner === ""}>
          Mine
        </FilterPill>
        <FilterPill
          href={listHref(CODES_PATH, sp, { owner: ALL_OWNERS })}
          active={owner === ALL_OWNERS}
        >
          All owners
        </FilterPill>
        {others.length > 0 ? (
          <LinkSelect
            label="Other owner"
            placeholder="Other owner…"
            value={owner}
            options={others.map((o) => ({
              ...o,
              href: listHref(CODES_PATH, sp, { owner: o.value }),
            }))}
          />
        ) : null}
      </FilterGroup>
      <FilterGroup label="Activity">
        {CODE_MODULES.map((module) => (
          <FilterPill
            key={module}
            href={listHref(CODES_PATH, sp, {
              module: toggleMultiValue(filters.modules, module, CODE_MODULES),
            })}
            active={filters.modules.includes(module)}
          >
            {codeModuleLabels[module].badge}
          </FilterPill>
        ))}
      </FilterGroup>
      <FilterGroup label="Status">
        {WINDOW_STATUSES.map((status) => (
          <FilterPill
            key={status}
            href={listHref(CODES_PATH, sp, {
              status: toggleMultiValue(filters.statuses, status, WINDOW_STATUSES),
            })}
            active={filters.statuses.includes(status)}
          >
            {STATUS_LABELS[status]}
          </FilterPill>
        ))}
      </FilterGroup>
    </>
  );
}

/**
 * One chip per active filter value (the search term lives in its own box). The
 * default owner — me — is no filter, so it has no chip.
 */
export function codeFilterChips(
  sp: ParamRecord,
  filters: CodeFilters,
  owners: OwnerOption[],
  currentUserId: string,
): FilterChip[] {
  const chips: FilterChip[] = [];
  const owner = ownerValue(filters, currentUserId);
  if (owner !== "") {
    const label =
      owner === ALL_OWNERS
        ? "All owners"
        : `Owner: ${otherOwners(owners, owner, currentUserId).find((o) => o.value === owner)?.label ?? owner}`;
    chips.push({ label, removeHref: listHref(CODES_PATH, sp, { owner: undefined }) });
  }
  for (const module of filters.modules) {
    chips.push({
      label: codeModuleLabels[module].badge,
      removeHref: listHref(CODES_PATH, sp, {
        module: toggleMultiValue(filters.modules, module, CODE_MODULES),
      }),
    });
  }
  for (const status of filters.statuses) {
    chips.push({
      label: STATUS_LABELS[status],
      removeHref: listHref(CODES_PATH, sp, {
        status: toggleMultiValue(filters.statuses, status, WINDOW_STATUSES),
      }),
    });
  }
  return chips;
}

/** The list URL with every filter cleared; the sort and page size stay. */
export const clearFiltersHref = (sp: ParamRecord) =>
  listHref(CODES_PATH, sp, {
    q: undefined,
    owner: undefined,
    module: undefined,
    status: undefined,
  });
