import type { VariantProps } from "class-variance-authority";
import Link from "next/link";
import { CopyIconButton } from "@/components/copy-icon-button";
import { DataList, type ListColumn } from "@/components/data-list";
import { EditIcon, LayoutIcon, ShareIcon } from "@/components/icons";
import { ListFilterBar, OwnerFilter } from "@/components/list-filter-bar";
import { DeleteSelectedButton, SelectionProvider } from "@/components/list-selection";
import { Notice } from "@/components/notice";
import { ownerColumn } from "@/components/owner-column";
import { Main } from "@/components/page-main";
import { requireTeacherPage } from "@/components/require-teacher-page";
import { selectionColumn } from "@/components/selection-column";
import { Badge, type badgeVariants } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { iconButtonVariants } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { resolveAppOriginOr } from "@/lib/app-origin";
import { codeModuleLabels, isCodeModule } from "@/lib/code-modules/types";
import { type OwnerParams, parseOwner } from "@/lib/db/owner-filter";
import { type PagingParams, parsePaging } from "@/lib/db/paging";
import { parseSort, type SortParams } from "@/lib/db/sorting";
import { FILE_SORT_COLUMNS, listFileOwners, listFiles } from "@/lib/file-store";
import { filePublicUrl } from "@/lib/file-url";
import { deleteSelectedFilesAction } from "@/lib/files-actions";
import { getSession } from "@/lib/session";
import { LocalTime } from "../local-time";

// One active file as shown in the list (no content). `updatedSeconds` is the
// active version's write time as unix seconds; `createdBy` is the OWNER's user id —
// here the last writer, since the table is append-only — which drives the owner
// filter, applied in the DB. `ownerName` is its `novedu_user` resolution, `null`
// for a teacher who has never signed in through the web app.
interface FileRow {
  id: string;
  name: string;
  kind: string;
  title: string | null;
  description: string | null;
  updatedSeconds: number;
  createdBy: string;
  ownerName: string | null;
}

// Kind → badge tone, shared visual language with the codes list: module kinds
// use the module's pill color (codeModuleLabels); `fragment` is the one kind
// without a module and gets its own hue.
const KIND_TONES: Record<string, VariantProps<typeof badgeVariants>["tone"]> = {
  tutor: codeModuleLabels.tutor.tone,
  quiz: codeModuleLabels.quiz.tone,
  writing: codeModuleLabels.writing.tone,
  coding: codeModuleLabels.coding.tone,
  fragment: "purple",
};

// Teacher-only: every app-hosted YAML file (active versions only), with a
// contains-filter over name/title/description and an owner dropdown (defaulting
// to the signed-in teacher) — both applied IN THE DATABASE via URL search params
// (see `docs/filtered-lists.md`), never in memory. No row-level security: every
// teacher sees and maintains every file. "Effective" teacher: a teacher in
// student mode is denied like a student.
export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] } & OwnerParams & PagingParams & SortParams>;
}) {
  const denied = await requireTeacherPage();
  if (denied) return denied;

  const session = await getSession();
  const currentUserId = session?.user?.id ?? "";

  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim();
  // Absent `?owner=` means the signed-in teacher, so the default view — and
  // "Clear" — need no param at all (docs/filtered-lists.md).
  const owner = parseOwner(sp, currentUserId);
  const paging = parsePaging(sp);
  const sort = parseSort(sp, FILE_SORT_COLUMNS);

  // The dropdown's options come from the whole (unfiltered) file set, so the owner
  // a teacher just picked can never disappear from the control that picked them.
  const [result, owners] = await Promise.all([
    listFiles({ search: q || undefined, createdBy: owner.createdBy, paging, sort }),
    listFileOwners(),
  ]);

  if (result === undefined) {
    return (
      <Main>
        <Notice heading="Files temporarily unavailable">
          <p>Your files could not be loaded right now. Try again in a moment.</p>
        </Notice>
      </Main>
    );
  }

  // The public URL origin is resolved once on the server and threaded down, so
  // every Copy URL / open / share link is built identically (no client origin).
  const origin = await resolveAppOriginOr("");
  const fileUrl = (name: string) => filePublicUrl(origin, name);

  const rows: FileRow[] = result.rows.map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    title: entry.title,
    description: entry.description,
    updatedSeconds: Math.floor(entry.validFrom.getTime() / 1000),
    createdBy: entry.createdBy,
    ownerName: entry.ownerName,
  }));

  const columns: ListColumn<FileRow, keyof typeof FILE_SORT_COLUMNS>[] = [
    // Leading multi-select column; the selection key is the file NAME, which is
    // what `deleteSelectedFilesAction` deletes by (and is unique among active files).
    selectionColumn<FileRow>(
      (row) => row.name,
      (row) => row.name,
    ),
    {
      header: "Name",
      sortKey: "name",
      className: "whitespace-nowrap font-mono",
      render: (row) => row.name,
    },
    {
      header: "Kind",
      sortKey: "kind",
      render: (row) => (
        <Badge caps solid tone={KIND_TONES[row.kind] ?? "green"}>
          {row.kind}
        </Badge>
      ),
    },
    {
      header: "Title",
      sortKey: "title",
      className: "max-w-104 overflow-hidden text-ellipsis whitespace-nowrap",
      render: (row) => <span title={row.description ?? undefined}>{row.title ?? "—"}</span>,
    },
    ownerColumn<FileRow>(),
    {
      header: "Last updated",
      sortKey: "updated",
      kind: "time",
      render: (row) => <LocalTime seconds={row.updatedSeconds} />,
    },
    {
      header: "Actions",
      srOnlyHeader: true,
      kind: "actions",
      render: (row) => {
        const url = fileUrl(row.name);
        return (
          <>
            <CopyIconButton text={url} label="Copy URL" promptLabel="Copy the file URL:" />
            {isCodeModule(row.kind) ? (
              <Link
                href={`/codes/new?module=${row.kind}&file=${encodeURIComponent(url)}`}
                className={iconButtonVariants()}
                aria-label="Create code"
                title="Create code"
              >
                <ShareIcon />
              </Link>
            ) : null}
            <Link
              href={`/files/edit/${row.name}`}
              className={iconButtonVariants()}
              aria-label={`Edit ${row.name}`}
              title="Edit"
            >
              <EditIcon />
            </Link>
            <Link
              href={`/files/gui/edit/${row.name}`}
              className={iconButtonVariants()}
              aria-label={`Open ${row.name} in GUI editor`}
              title="Edit in GUI (experimental)"
            >
              <LayoutIcon />
            </Link>
          </>
        );
      },
    },
  ];

  return (
    <Main>
      <SelectionProvider allIds={rows.map((row) => row.name)}>
        <DataList
          wide
          rows={rows}
          getRowKey={(row) => row.id}
          columns={columns}
          hint={
            <>
              App-hosted YAML files (students cannot read them). Copy a file's URL and paste it into
              a code (tutor, quiz, writing and coding files offer a one-click shortcut). Every save
              is validated; an invalid file is rejected.
            </>
          }
          actions={
            <>
              <Link href="/files/new" className={buttonVariants()}>
                New file
              </Link>
              <Link href="/images" className={buttonVariants()}>
                Manage images
              </Link>
              <DeleteSelectedButton action={deleteSelectedFilesAction} itemNoun="file" />
            </>
          }
          filterBar={
            <ListFilterBar
              hasActiveFilter={q !== "" || owner.value !== ""}
              resetKey={`${q}|${owner.value}`}
              pageSize={result.pageSize}
              sort={sort}
            >
              <Input
                type="search"
                name="q"
                className="w-72"
                placeholder="Filter by name, title, description…"
                defaultValue={q}
                aria-label="Filter files"
              />
              <OwnerFilter
                className="w-56"
                noun="files"
                options={owners}
                value={owner.value}
                currentUserId={currentUserId}
                currentUserName={session?.user?.name}
              />
            </ListFilterBar>
          }
          isFiltered={q !== "" || owner.value !== ""}
          emptyState={
            <>
              No files yet. <Link href="/files/new">Create one</Link> to host a tutor, fragment or
              quiz YAML.
            </>
          }
          noMatchState="No files match your filter."
          pathname="/files"
          params={sp}
          pagination={result}
          sorting={sort}
        />
      </SelectionProvider>
    </Main>
  );
}
