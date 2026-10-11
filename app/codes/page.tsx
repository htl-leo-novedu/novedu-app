import Link from "next/link";
import { DataList, type ListColumn } from "@/components/data-list";
import { EditIcon, ExternalLinkIcon, StatsIcon } from "@/components/icons";
import { ListFilterBar, OwnerFilter } from "@/components/list-filter-bar";
import { DeleteSelectedButton, SelectionProvider } from "@/components/list-selection";
import { ModuleBadge } from "@/components/module-badge";
import { AccessDenied, Notice } from "@/components/notice";
import { ownerColumn } from "@/components/owner-column";
import { Main } from "@/components/page-main";
import { selectionColumn } from "@/components/selection-column";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { iconButtonVariants } from "@/components/ui/icon-button";
import { Input, Select } from "@/components/ui/input";
import { countClozeSubmissions } from "@/lib/cloze-counts-store";
import { deleteSelectedCodesAction } from "@/lib/code-actions";
import {
  CODE_MODULES,
  type CodeModule,
  codeModuleLabels,
  parseModuleParam,
} from "@/lib/code-modules/types";
import { getInteractionCounts } from "@/lib/code-stats-store";
import {
  CODE_SORT_COLUMNS,
  DISTANT_FUTURE,
  DISTANT_PAST,
  listCodeOwners,
  listCodes,
} from "@/lib/code-store";
import { type OwnerParams, parseOwner } from "@/lib/db/owner-filter";
import { type PagingParams, parsePaging } from "@/lib/db/paging";
import { parseSort, type SortParams } from "@/lib/db/sorting";
import { getSession } from "@/lib/session";
import { isEffectiveTeacher } from "@/lib/student-mode";
import { LocalTime } from "../local-time";
import { CopyCodeButton } from "./copy-code-button";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

type WindowStatus = "active" | "upcoming" | "expired";

// Where "now" falls relative to a code's window. Codes are never garbage-
// collected, so expired ones stay listed — their activity won't open, but their
// stats are still reachable and they can be deleted. A missing bound is coalesced
// to its sentinel, so an open-ended code is never "upcoming"/"expired" on that
// side.
function windowStatus(
  entry: { validFrom: Date | null; validUntil: Date | null },
  now: Date,
): WindowStatus {
  const from = entry.validFrom ?? DISTANT_PAST;
  const until = entry.validUntil ?? DISTANT_FUTURE;
  if (now < from) return "upcoming";
  if (now > until) return "expired";
  return "active";
}

interface CodeRow {
  code: string;
  module: CodeModule;
  note: string;
  fileUrl: string;
  /** The creating teacher's session user id — the OWNER, immutable for a code. */
  createdBy: string;
  /** Its `novedu_user` resolution; `null` for a teacher with no row yet. */
  ownerName: string | null;
  validFromSeconds: number | null;
  validUntilSeconds: number | null;
  status: WindowStatus;
  /**
   * Qualifying-interaction count (a cloze code's first submissions), or null when
   * the count query failed.
   */
  interactionCount: number | null;
}

/** A row's count from its query's map; null when that query failed. */
function countOf(counts: Map<string, number> | undefined, code: string): number | null {
  return counts === undefined ? null : (counts.get(code) ?? 0);
}

function statusBadge(status: WindowStatus) {
  if (status === "expired")
    return (
      <Badge tone="red" caps className="ml-2 align-middle">
        expired
      </Badge>
    );
  if (status === "upcoming")
    return (
      <Badge tone="blue" caps className="ml-2 align-middle">
        upcoming
      </Badge>
    );
  return (
    <Badge tone="green" caps className="ml-2 align-middle">
      <span className="size-1.5 rounded-full bg-current" />
      active
    </Badge>
  );
}

// Left row stripe in the module's color — same hues as the solid module pills
// (the Badge `solid` compound variants).
const MODULE_ROW_ACCENT: Record<CodeModule, string> = {
  tutor: "border-l-4 border-l-teal-700",
  quiz: "border-l-4 border-l-amber-700",
  writing: "border-l-4 border-l-green-700",
  coding: "border-l-4 border-l-blue-800",
  cloze: "border-l-4 border-l-rose-700",
};

// Teacher-only: lists ALL codes across modules (any effective teacher may
// see/manage every code — finer-grained RBAC is planned), with a contains-filter
// over note/code, an owner dropdown (defaulting to the signed-in teacher), and a
// module filter — all applied IN THE DATABASE via URL search params (see
// `docs/filtered-lists.md`), never in memory. Each row shows its module, its
// owner, how many interactions the code has seen (one
// aggregate query for the whole filtered set), a link to detailed stats, an edit
// link, and an irreversible delete. "Effective" teacher: a teacher in student
// mode is denied like a student.
export default async function CodesPage({
  searchParams,
}: {
  searchParams: Promise<
    { q?: string | string[]; module?: string | string[] } & OwnerParams & PagingParams & SortParams
  >;
}) {
  if (!(await isEffectiveTeacher())) {
    return (
      <Main>
        <AccessDenied />
      </Main>
    );
  }

  const session = await getSession();
  const currentUserId = session?.user?.id ?? "";

  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim();
  // Absent `?owner=` means the signed-in teacher, so the default view — and
  // "Clear" — need no param at all (docs/filtered-lists.md).
  const owner = parseOwner(sp, currentUserId);
  const moduleFilter = parseModuleParam(sp.module);
  const paging = parsePaging(sp);
  const sort = parseSort(sp, CODE_SORT_COLUMNS);

  // The dropdown's options come from the whole (unfiltered) code set, so the owner
  // a teacher just picked can never disappear from the control that picked them.
  const [result, owners] = await Promise.all([
    listCodes({
      search: q || undefined,
      createdBy: owner.createdBy,
      module: moduleFilter,
      paging,
      sort,
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

  // One round trip for all interaction counts (no per-row query), and only for
  // the codes on THIS page. `undefined` = the count query failed; the column then
  // shows "—" rather than a wrong zero.
  // Cloze codes have no conversations: their count is "first submissions" from the
  // per-gap counts store (docs/cloze.md), likewise one round trip.
  const [counts, clozeCounts] = await Promise.all([
    getInteractionCounts(result.rows.map((entry) => entry.code)),
    countClozeSubmissions(
      result.rows.filter((entry) => entry.module === "cloze").map((entry) => entry.code),
    ),
  ]);
  const now = new Date();

  const rows: CodeRow[] = result.rows.map((entry) => ({
    code: entry.code,
    module: entry.module,
    note: entry.note,
    fileUrl: entry.fileUrl,
    createdBy: entry.createdBy,
    ownerName: entry.ownerName,
    validFromSeconds: entry.validFrom ? seconds(entry.validFrom) : null,
    validUntilSeconds: entry.validUntil ? seconds(entry.validUntil) : null,
    status: windowStatus(entry, now),
    interactionCount: countOf(entry.module === "cloze" ? clozeCounts : counts, entry.code),
  }));

  const columns: ListColumn<CodeRow, keyof typeof CODE_SORT_COLUMNS>[] = [
    // Leading multi-select column; the selection key is the CODE, which is what
    // `deleteSelectedCodesAction` deletes by.
    selectionColumn<CodeRow>(
      (row) => row.code,
      (row) => row.note || row.code,
    ),
    {
      header: "Module",
      sortKey: "module",
      render: (row) => <ModuleBadge module={row.module} />,
    },
    {
      header: "Note",
      sortKey: "note",
      className: "max-w-96 overflow-hidden text-ellipsis whitespace-nowrap",
      // The tooltip carries the activity YAML URL — the one piece of context that
      // does not fit a column.
      render: (row) => (
        <span title={row.fileUrl}>
          {row.note || row.code}
          {statusBadge(row.status)}
        </span>
      ),
    },
    ownerColumn<CodeRow>(),
    {
      header: "Valid from",
      sortKey: "from",
      kind: "time",
      render: (row) => <LocalTime seconds={row.validFromSeconds} fallback="No start" />,
    },
    {
      header: "Valid until",
      sortKey: "until",
      kind: "time",
      render: (row) => <LocalTime seconds={row.validUntilSeconds} fallback="No end" />,
    },
    {
      // Filtered to cloze, the column is the module's own count ("Submissions").
      header: moduleFilter === "cloze" ? codeModuleLabels.cloze.countColumn : "Interactions",
      kind: "numeric",
      render: (row) => (
        <span title={row.module === "cloze" ? "First submissions" : undefined}>
          {row.interactionCount === null ? "—" : row.interactionCount}
        </span>
      ),
    },
    {
      header: "Actions",
      srOnlyHeader: true,
      kind: "actions",
      render: (row) => (
        <>
          <Link
            href={`/codes/${row.code}`}
            className={iconButtonVariants()}
            aria-label="View stats"
            title="View stats"
          >
            <StatsIcon />
          </Link>
          {row.status === "active" ? (
            // A plain <a>, not <Link>: opening in a new tab is always a full
            // document load (next/link bails out of client navigation for any
            // target other than _self), so <Link> would only add a prefetch
            // whose payload can never be used. Same as /files' "Open raw YAML".
            <a
              href={`/${row.code}`}
              className={iconButtonVariants()}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in new tab"
              title="Open in new tab"
            >
              <ExternalLinkIcon />
            </a>
          ) : null}
          <CopyCodeButton code={row.code} />
          <Link
            href={`/codes/edit/${row.code}`}
            className={iconButtonVariants()}
            aria-label={`Edit ${row.note || row.code}`}
            title="Edit"
          >
            <EditIcon />
          </Link>
        </>
      ),
    },
  ];

  return (
    <Main>
      <SelectionProvider allIds={rows.map((row) => row.code)}>
        <DataList
          wide
          rows={rows}
          getRowKey={(row) => row.code}
          columns={columns}
          rowClassName={(row) => MODULE_ROW_ACCENT[row.module]}
          hint={
            <>
              All codes. Filter by note/code, activity, or owner. Expired ones stay here so you can
              review their stats; delete a code to remove it and all of its conversation data.
            </>
          }
          actions={
            <>
              <Link href="/codes/new" className={buttonVariants()}>
                New code
              </Link>
              <DeleteSelectedButton action={deleteSelectedCodesAction} itemNoun="code" />
            </>
          }
          filterBar={
            <ListFilterBar
              hasActiveFilter={q !== "" || owner.value !== "" || moduleFilter !== undefined}
              resetKey={`${q}|${owner.value}|${moduleFilter ?? ""}`}
              pageSize={result.pageSize}
              sort={sort}
            >
              <Input
                type="search"
                name="q"
                className="w-56"
                placeholder="Filter by note or code…"
                defaultValue={q}
                aria-label="Filter codes"
              />
              <Select
                name="module"
                className="w-56"
                defaultValue={moduleFilter ?? ""}
                aria-label="Filter by activity"
              >
                <option value="">All activities</option>
                {CODE_MODULES.map((m) => (
                  <option key={m} value={m}>
                    {codeModuleLabels[m].badge}
                  </option>
                ))}
              </Select>
              <OwnerFilter
                className="w-56"
                noun="codes"
                options={owners}
                value={owner.value}
                currentUserId={currentUserId}
                currentUserName={session?.user?.name}
              />
            </ListFilterBar>
          }
          isFiltered={q !== "" || owner.value !== "" || moduleFilter !== undefined}
          emptyState={
            <>
              No codes yet. <Link href="/codes/new">Create one</Link> to share an activity with
              students — or pick “All owners” to see codes from other teachers.
            </>
          }
          noMatchState="No codes match your filter."
          pathname="/codes"
          params={sp}
          pagination={result}
          sorting={sort}
        />
      </SelectionProvider>
    </Main>
  );
}
