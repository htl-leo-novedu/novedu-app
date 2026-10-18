import Link from "next/link";
import { CopyIcon, EditIcon, ExternalLinkIcon, StatsIcon } from "@/components/icons";
import { ActionMenu, type ActionMenuItem } from "@/components/list/action-menu";
import type { GridColumn } from "@/components/list/list-grid";
import { ModuleBadge } from "@/components/module-badge";
import { Badge } from "@/components/ui/badge";
import type { CodeModule } from "@/lib/code-modules/types";
import type { CODE_SORT_COLUMNS, CodeListRow } from "@/lib/code-store";
import type { WindowStatus } from "@/lib/code-window";
import { LocalTime } from "../../local-time";

// The `/codes` list's column catalogue for the new list engine (see
// `docs/filtered-lists.md`, "The new list engine"): every column a view may
// show, keyed by id. A column with a `sortKey` is a QUERY column — it orders by
// the store's `CODE_SORT_COLUMNS` entry of that key; one without is display-only
// (Interactions is a PAGE column, counted after the page is read).

/** One `/codes` row as the new list renders it — plain values, dates as unix seconds. */
export interface CodeRow {
  code: string;
  module: CodeModule;
  note: string;
  fileUrl: string;
  createdBy: string;
  ownerName: string | null;
  validFromSeconds: number | null;
  validUntilSeconds: number | null;
  status: WindowStatus;
  /** Qualifying-interaction count; `null` when the count failed or the view doesn't show it. */
  interactionCount: number | null;
}

const seconds = (date: Date | null) => (date ? Math.floor(date.getTime() / 1000) : null);

export function toCodeRow(
  entry: CodeListRow,
  status: WindowStatus,
  interactionCount: number | null,
): CodeRow {
  return {
    code: entry.code,
    module: entry.module,
    note: entry.note,
    fileUrl: entry.fileUrl,
    createdBy: entry.createdBy,
    ownerName: entry.ownerName,
    validFromSeconds: seconds(entry.validFrom),
    validUntilSeconds: seconds(entry.validUntil),
    status,
    interactionCount,
  };
}

/** The row's name wherever one is needed (checkbox, menu): the note, else the code. */
export const codeRowLabel = (row: CodeRow) => row.note || row.code;

export function StatusBadge({ status }: { status: WindowStatus }) {
  if (status === "expired")
    return (
      <Badge tone="red" caps>
        expired
      </Badge>
    );
  if (status === "upcoming")
    return (
      <Badge tone="blue" caps>
        upcoming
      </Badge>
    );
  return (
    <Badge tone="green" caps>
      <span className="size-1.5 rounded-full bg-current" />
      active
    </Badge>
  );
}

// Left row stripe in the module's colour — the hues of the solid module pills.
const MODULE_ROW_ACCENT: Record<CodeModule, string> = {
  tutor: "border-l-4 border-l-teal-700",
  quiz: "border-l-4 border-l-amber-700",
  writing: "border-l-4 border-l-green-700",
  coding: "border-l-4 border-l-blue-800",
};

export const codeRowAccent = (row: CodeRow) => MODULE_ROW_ACCENT[row.module];

/** The note links to the code's stats; the tooltip carries the activity's YAML URL. */
function NoteLink({ row }: { row: CodeRow }) {
  return (
    <Link href={`/codes/${row.code}`} title={row.fileUrl} className="no-underline hover:underline">
      {codeRowLabel(row)}
    </Link>
  );
}

type CodeSortKey = keyof typeof CODE_SORT_COLUMNS;
export type CodeColumnId = "kind" | "note" | "owner" | "from" | "until" | "interactions";

export const CODE_COLUMNS: Record<CodeColumnId, GridColumn<CodeRow> & { sortKey?: CodeSortKey }> = {
  kind: {
    id: "kind",
    header: "Activity",
    sortKey: "module",
    render: (row) => <ModuleBadge module={row.module} />,
  },
  note: {
    id: "note",
    header: "Note",
    sortKey: "note",
    className: "max-w-96 overflow-hidden text-ellipsis whitespace-nowrap",
    render: (row) => (
      <>
        <NoteLink row={row} /> <StatusBadge status={row.status} />
      </>
    ),
  },
  owner: {
    id: "owner",
    header: "Owner",
    sortKey: "owner",
    // Width-capped: the user-id fallback can be a 36-character GUID.
    className: "max-w-48 overflow-hidden text-ellipsis whitespace-nowrap",
    render: (row) => <span title={row.createdBy}>{row.ownerName ?? row.createdBy}</span>,
    fact: (row) => row.ownerName ?? row.createdBy,
  },
  from: {
    id: "from",
    header: "Valid from",
    sortKey: "from",
    kind: "time",
    render: (row) => <LocalTime seconds={row.validFromSeconds} fallback="No start" />,
    fact: (row) =>
      row.validFromSeconds === null ? null : (
        <>
          From <LocalTime seconds={row.validFromSeconds} dateOnly />
        </>
      ),
  },
  until: {
    id: "until",
    header: "Valid until",
    sortKey: "until",
    kind: "time",
    render: (row) => <LocalTime seconds={row.validUntilSeconds} fallback="No end" />,
    fact: (row) =>
      row.validUntilSeconds === null ? null : (
        <>
          Until <LocalTime seconds={row.validUntilSeconds} dateOnly />
        </>
      ),
  },
  interactions: {
    id: "interactions",
    header: "Interactions",
    kind: "numeric",
    render: (row) => (row.interactionCount === null ? "—" : row.interactionCount),
    fact: (row) =>
      row.interactionCount === null
        ? null
        : `${row.interactionCount} interaction${row.interactionCount === 1 ? "" : "s"}`,
  },
};

/** Lines 1 and 2 of a folded phone row: the note, then kind, code and status. */
export const codeFolded = {
  title: (row: CodeRow) => <NoteLink row={row} />,
  meta: (row: CodeRow) => (
    <>
      <ModuleBadge module={row.module} />
      <span className="font-mono text-foreground/65 text-xs">{row.code}</span>
      <StatusBadge status={row.status} />
    </>
  ),
};

/** A row's "…" menu. No delete here: deleting is bulk-only. */
export function CodeRowMenu({ row }: { row: CodeRow }) {
  const items: ActionMenuItem[] = [
    { kind: "link", label: "View stats", href: `/codes/${row.code}`, icon: <StatsIcon /> },
    row.status === "active"
      ? {
          kind: "link",
          label: "Open activity",
          href: `/${row.code}`,
          newTab: true,
          icon: <ExternalLinkIcon />,
        }
      : {
          kind: "disabled",
          label: "Open activity",
          reason: "only while active",
          icon: <ExternalLinkIcon />,
        },
    { kind: "copy-link", label: "Copy link", path: `/${row.code}`, icon: <CopyIcon /> },
    { kind: "link", label: "Edit code", href: `/codes/edit/${row.code}`, icon: <EditIcon /> },
  ];
  return <ActionMenu label={`Actions for ${codeRowLabel(row)}`} items={items} />;
}
