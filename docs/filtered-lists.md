# Filtered lists

Teacher-facing list screens (YAML Files at `/files`, Shared Tutor Codes at
`/codes`, and any future list) share **one** concept so they look and behave
the same and only have to be improved once. Read this before adding a new list or
touching `components/data-list.tsx`, `components/list-filter-bar.tsx`, or a list
page's `searchParams` handling. Styling follows `docs/styling.md` — the list
chrome (container, toolbar, table) lives INSIDE `DataList`/`ListFilterBar` as
Tailwind utilities; pages never restate it.

## The one firm rule: filter in the database, never in memory

Filtering is a **SQL `WHERE`**, not a `Array.filter`/`useMemo`. The filter state
lives in the **URL search params**; the server page reads them and passes them to a
store function that builds a parameterized query. The list that renders is already
the filtered result. This keeps the page correct as data grows and makes pagination
a pure server concern later.

## The pieces

| Piece | Where | Role |
| --- | --- | --- |
| URL search params | `?q=…&mine=…&page=…` | the filter + page state, shareable + back-button friendly |
| Server page | `app/<list>/page.tsx` | `await searchParams`, parse, call the store, build rows + columns, render `DataList` |
| Store query | `lib/*-store.ts` | the actual SQL filter (see below) |
| `DataList<T>` | `components/data-list.tsx` (**server**) | the full list page body: `PageBody` shell + toolbar + empty/no-match + the pagination seam around a `ListTable` |
| `ListTable<T>` | `components/data-list.tsx` (**server**) | the bare column-driven table; owns ALL table chrome incl. the per-column `kind` recipes — embedded tables (the per-code `ConversationStats`) render through it directly |
| `studentColumn<T>()` | `components/student-column.tsx` (**server-safe**) | the shared **Student** cell recipe — display name with the user-id fallback + hover title, width-capped monospace — one entry in the `columns` of the per-code teacher lists (writing savers, coding issued keys), the same shape as `ownerColumn` |
| `ListFilterBar` | `components/list-filter-bar.tsx` (**client**) | the only interactive bit: controls + **Apply** → push a new query string; exports `OwnerFilter` (the owner dropdown) and `FilterCheckbox` (the `/reports` "Only my codes" toggle) |
| ui primitives | `components/ui/` (`Button`/`buttonVariants`, `Input`, `Badge`, `IconButton`) | the "New …" action, the search input, kind/status chips, row action buttons |

### Page width: the table decides, within a clamp

The four full list pages (`/codes`, `/files`, `/images`, `/reports`) pass `wide` to
`DataList`, which forwards it to `PageBody`. The wide column is `fit-content`
**clamped to 1280–1760px and additionally capped by the viewport**
(`w-fit min-w-[min(100%,80rem)] max-w-[min(100%,110rem)]`): the 1280px floor is
identical to the default `max-w-7xl`, so a small table and its toolbar look
exactly as before; between the bounds the column fits the table with no stretched
columns and no dead space; the 1760px cap keeps ultrawide monitors scannable
(uncapped, rows degrade into sparse ribbons with the actions a screen away from
the row's identifying text). The column width therefore follows the content — a
long note, a page change or a filter can shift the centered layout horizontally;
the floor absorbs most of it, and per-column caps like `/codes`' `max-w-96` note
are what keep one row from driving the whole page to the cap.

**Only the table may size that column.** Every other child `DataList` renders
(the hint, the toolbar row, the empty/no-match paragraph, the pager) carries
`w-0 min-w-full` — zero intrinsic width contribution, then the column's resolved
width to wrap in. A new child added there without those classes silently inflates
the page width of every list.

**Any table's card scrolls horizontally on overflow** (`overflow-x-auto` on the
`ListTable` card). That is the universal fallback and applies to every render,
embedded tables included: below ~1300px — down to phone widths, where the column
equals the viewport — the table scrolls inside its card instead of being clipped,
so every action button stays reachable. Embedded and bounded lists (the writing
module's savers list, the per-code conversation stats, the usage dashboard) do
**not** get `wide`; they keep the default `max-w-7xl` column and rely on the card
scroll alone. `tests/component/list-overflow.browser.test.tsx` is the guard for
both the scroll fallback and the three clamp regimes.

**Footer row and sticky mode.** A column may set `footer` (e.g. a column total);
`ListTable` then renders a footer row in the header's weight and tint, an empty
cell for every column without one. `sticky` pins the header and that footer row
while the body scrolls inside the card, whose height the caller caps through
`className` (the usage dashboard's token table: `max-h-80`). In sticky mode the
table uses the separate border model and the pinned cells get an opaque
background, so their rules travel with them and the scrolling rows never show
through (`tests/component/list-table-sticky.browser.test.tsx`).

### Store: dynamic query, the Drizzle way

Build an `SQL[]` of optional conditions and apply them with `.where(and(...conditions))`
— `and()` over an empty array is a no-op, and `undefined` conditions are dropped.
Do not chain multiple `.where()` (each replaces the previous). Text search uses the
shared `containsAny(term, [cols])` from `lib/db/text-filter.ts` (a parameterized,
wildcard-escaped `ILIKE` — Postgres's plain `LIKE` is case-sensitive, so a
case-insensitive "contains" match needs `ILIKE` instead; no `LOWER()` needed).
Example (`listFiles`):

```ts
const conditions: SQL[] = [isNull(files.validUntil)];
const term = opts?.search?.trim();
if (term) { const m = containsAny(term, [files.name, files.title, files.description]); if (m) conditions.push(m); }
if (opts?.createdBy) conditions.push(eq(files.createdBy, opts.createdBy));
// .select({…}).from(files).where(and(...conditions)).orderBy(desc(files.validFrom))
```

**Aggregated stats are a separate, single query — never per row.** When a list shows
a count joined from other tables (e.g. the codes list's "Interactions" column comes
from the Mastra-owned `mastra_threads`/`mastra_messages`, joined by value and read
with raw `sql`), run the filtered list first, then **one** aggregate over the whole
result set (e.g. `getInteractionCounts(codes)` takes an `IN (…) … GROUP BY`). No
N+1.

### Server page wiring

`searchParams` is a `Promise` in Next 16 — `await` it. Reading it forces dynamic
rendering (these pages are already dynamic via `auth()`). Parse, query, map to plain
row objects (convert `Date`s to unix seconds for `LocalTime`), and render:

```tsx
const sp = await searchParams; // Promise<{ q?: string|string[] } & OwnerParams & …>
const q = typeof sp.q === "string" ? sp.q : "";
const owner = parseOwner(sp, userId);       // absent ?owner= = the signed-in teacher
const [rows, owners] = await Promise.all([
  listFiles({ search: q || undefined, createdBy: owner.createdBy }),
  listFileOwners(),
]);
return (
  <DataList
    rows={rows} getRowKey={(r) => r.id} columns={columns}
    actions={<Link href="/files/new" className={buttonVariants()}>New file</Link>}
    filterBar={
      <ListFilterBar hasActiveFilter={q !== "" || owner.value !== ""}>
        <Input type="search" name="q" defaultValue={q} aria-label="Filter files" placeholder="Filter…" className="w-56" />
        <OwnerFilter className="w-56" noun="files" options={owners} value={owner.value}
          currentUserId={userId} currentUserName={session?.user?.name} />
      </ListFilterBar>
    }
    isFiltered={q.trim() !== "" || owner.value !== ""}
    emptyState={<>No files yet. <Link href="/files/new">Create one</Link>.</>}
    noMatchState="No files match your filter."
  />
);
```

`columns` are `{ header, render(row), kind?, className?, headerClassName?, srOnlyHeader? }`.
**`kind` is the column's cell recipe** — `"numeric"` (right-aligned, snug),
`"time"` (no wrap), `"actions"` (right-aligned icon-button row) — so pages never
repeat alignment classes; `className`/`headerClassName` are cn-merged deltas for
genuinely page-specific cells. Because `DataList` is a **server** component, the
`render` functions live in the page and may return client leaf components
(`LocalTime`, `CopyIconButton`, the row checkbox) — no Server→Client function-prop
boundary is crossed (that only applies to `"use client"` components).

### `ListFilterBar` serialization

On **Apply** it walks the form controls and builds a `URLSearchParams`: text/select
contribute their value when non-empty; **checkboxes always contribute `"1"`/`"0"`**
(so a server reads a default-on toggle as `mine !== "0"`); `page` is dropped (reset
to the first page). It uses `useRouter`/`usePathname` only — current values are
server-rendered into `defaultValue`/`defaultChecked`, so no `useSearchParams`
(avoids its Suspense caveat). Any control with a `name` participates, so a future
filter (a `<select>`, a date range) drops in without touching the bar.

## The owner filter

`/codes`, `/files` and `/images` all answer "whose is this?" the same way: a sortable
**Owner** column and an **owner dropdown** that defaults to the signed-in teacher.
It is one more instance of the one discipline — the person filter is a SQL `WHERE`,
and the option list is its own small query.

**"Owner" is the user-facing word on all three lists**, and it is deliberately
looser than "creator": `novedu_codes.created_by` never changes, but `novedu_files`
and `novedu_images` are append-only, so the active row's `created_by` is whoever
saved the item LAST. The teacher guide says exactly that; the docs of those two
subsystems repeat it.

| Piece | Where | Role |
| --- | --- | --- |
| `lib/db/owner-filter.ts` | shared, **no DB or drizzle import** | `ALL_OWNERS`, `OwnerOption`, `OwnerParams`, `parseOwner` |
| `lib/db/owners.ts` | shared, server-only | `listOwners(table, createdByColumn, conditions)` — the one DISTINCT query — plus the `ownerJoin` / `ownerLabel` SQL fragments every store reuses |
| store | `lib/{code,file,image}-store.ts` | `list*Owners()` + the `ownerName` LEFT JOIN + the `owner` sort key |
| `OwnerFilter` | `components/list-filter-bar.tsx` (**client**) | the `<select>`: me, all owners, then an `<optgroup>` of the rest |
| `ownerColumn<T>()` | `components/owner-column.tsx` (**server-safe**) | the Owner cell recipe, one entry in a page's `columns` — the same shape as `selectionColumn`; width-capped and ellipsised, because the raw-id fallback can be a 36-character Entra GUID (for an id that predates `novedu_user`) that would otherwise widen every table |

### The URL grammar makes "Clear" free

`?owner=` absent (or empty) = **the signed-in teacher**, `all` = every owner, anything
else = that user id verbatim. Two existing `ListFilterBar` behaviors then do the work:
the serializer drops empty `<select>` values, so the default view has NO query string,
and "Clear" is a bare `router.push(pathname)` — which therefore lands back on the
teacher's own items with no code of its own. (The bearer API routes have their own
`mine` param — `docs/api.md`.)

A user id outside the option list — a stale bookmark, or an owner whose last item was
deleted — is **kept**, not silently swapped for the default: it filters (and finds
nothing) and `OwnerFilter` appends it as its own option, so the control can never
claim a filter the query is not applying. That is the opposite of `parseSort`, whose
allow-list makes an unknown key degrade to the default order; here degrading would
hide that the URL asked for something.

### The two queries

The row query LEFT-JOINs `novedu_user` **by value** for `ownerName` (`null` → the
page shows the raw user id), exactly like `lib/report-store.ts` does for a reporter. The
join is on that table's primary key, and **no list condition reaches into `novedu_user`** —
the search term deliberately does not match owner names — so `countRows` stays
join-free and the COUNT can never drift from the rows.

`listOwners` is a `SELECT DISTINCT created_by, COALESCE(name, created_by)`.
Two things are load-bearing:

- It gets the list's **base conditions only** (`isNull(validUntil)`, the known-module
  guard), never the active search/module filter — otherwise the owner a teacher just
  picked could vanish from the control that picked them.
- The ORDER BY repeats the **selected** COALESCE expression: Postgres requires every
  `ORDER BY` term of a `SELECT DISTINCT` to appear in the select list. Ordering by
  the coalesced label (not by `name`) is also what keeps an owner without a
  `novedu_user` row inside the alphabet instead of leading it as a NULL.

The same COALESCE is the `owner` entry of each store's `*_SORT_COLUMNS`, so the
column sorts by what it displays — which is why it is the shared `ownerLabel()`
rather than an expression each store spells out. (`/reports` sorts its `student`
column by the bare joined name — a missing name sorts last ascending — because that
list has no raw-id fallback in its ORDER BY.)

A page therefore adds the whole feature with three lines: `parseOwner(sp, userId)`,
`ownerColumn<Row>()` in its `columns`, and `<OwnerFilter>` in its filter bar. A
selected user id equal to the signed-in teacher's is treated as the empty default, so
`?owner=<my user id>` and no param at all render the same control.

## Multi-delete (row selection + "Delete Selected")

Every list gets the same bulk-delete affordance from one shared layer, so it looks
and behaves identically and improves once. The pieces:

| Piece | Where | Role |
| --- | --- | --- |
| `SelectionProvider` | `components/list-selection.tsx` (**client**) | owns the selected-key `Set` + the in-flight `pending` flag; clears + `router.refresh()`es on a successful delete |
| `selectionColumn(getRowKey, rowLabel?)` | `components/selection-column.tsx` (**server-safe**) | the leading checkbox column: `SelectAllControls` header (select-all / unselect-all icons) + a per-row `RowSelectCheckbox` |
| `DeleteSelectedButton` | `components/list-selection.tsx` (**client**) | the `destructiveOutline` `Button`; disabled until ≥1 row; confirms with the count, runs the action, shows the shared `Spinner` while pending |
| per-list bulk action | `lib/*-actions.ts` (`"use server"`) | teacher-gated; calls the store's bulk function; passed to `DeleteSelectedButton` as a prop |

**Delete is bulk-only — one path, no second copy.** "Delete Selected" is the ONLY
way to delete a code / file / image: there is no per-row trash button and no
edit-page single delete. The store keeps the per-item work in a helper that takes a
**`DbExecutor`** (the shared `Db | Transaction` type from `lib/db`):
`closeActiveFile` (files), `closeActiveImage` (images), `deleteCodeRows` (codes).
The bulk action loops that helper inside **one `getDb().transaction(...)`**, so every
selected item is removed with identical per-item logic. Codes also have
`deleteCodeConversations`, which takes only the code and runs on Mastra storage
outside that transaction (below).

**Two-pool transaction caveat.** Drizzle (`novedu_*`) and Mastra (`mastra_*`) are
separate pools that can't share a transaction. So files (pure Drizzle soft-delete)
are fully one transaction; codes run the `novedu_*` row deletes for all
selected codes in one transaction but the **Mastra** thread/message deletes run per
code *outside* it.

**Selection key ≠ React key.** The selection id is whatever the bulk action deletes
by — a file **name**, a tutor **code** — which may differ from the DataList
`getRowKey` (files key rows by the version `id`). `SelectionProvider`'s `allIds` and
`selectionColumn`'s `getRowKey` must use that SAME selection key.

```tsx
// In the page (server): selection key = file NAME (what the action deletes by).
const columns = [selectionColumn<FileRow>((r) => r.name, (r) => r.name), ...rest];
return (
  <SelectionProvider allIds={rows.map((r) => r.name)}>
    <DataList rows={rows} getRowKey={(r) => r.id} columns={columns}
      actions={<>
        <Link href="/files/new" className={buttonVariants()}>New file</Link>
        <DeleteSelectedButton action={deleteSelectedFilesAction} itemNoun="file" />
      </>}
      /* …filterBar / states… */ />
  </SelectionProvider>
);
```

**Non-delete bulk actions — `BulkActionButton`.** The same selection layer drives
bulk actions that aren't deletes. `BulkActionButton({ action, label, pendingLabel,
icon?, variant?, confirmMessage? })` (`components/list-selection.tsx`) reuses the
provider's existing `runDelete` machinery (the same disabled-until-selection /
pending-`Spinner` / `FieldError`-on-failure behavior, and the same clear-selection +
`router.refresh()` on success as `DeleteSelectedButton`), but for any action taking
the selected ids and returning a `BulkDeleteResult`. `confirmMessage` is optional:
given, it returns the `window.confirm` text for the current count (a destructive
action passes one); omitted, the action runs immediately with no confirm. It is
**additive** — `DeleteSelectedButton` is untouched. The **`/reports`** inbox
(`docs/reports.md`) is the first user: its toolbar pairs two confirm-less
`BulkActionButton`s ("Mark resolved" / "Reopen") alongside the standard
`DeleteSelectedButton`, all over the same selected report ids.

Fast tests cover the pure interaction (`tests/component/list-selection.browser.test.tsx`);
the wired DB delete is the `@live-db` case in `e2e/file-and-tutor-code-crud.spec.ts`.

## Adding a new list

1. Add (or extend) a store function that takes `{ search?, createdBy?, … }` and
   filters in SQL with the `and(...conditions)` pattern.
2. Make the page `async`, `await searchParams`, query, map to plain rows.
3. Render `DataList` with your `columns`, an `actions` button, and a `ListFilterBar`
   holding your controls.
4. Add a sibling `loading.tsx` to the route segment that renders
   `<PageLoading label="Loading …" />` (`app/page-loading.tsx`). The page is an
   async server component, so without it the route shows a frozen page during the
   server query instead of a spinner.
5. Give each column the right `kind`; page-specific cells (a truncating note, a
   kind badge) use inline utilities or `<Badge>`/`<IconButton>` in the `render`
   function — per `docs/styling.md`, a recipe used by ≥2 pages moves into
   `components/ui/`.
6. Export a `SORT_COLUMNS` map from the store, hand it to `parseSort` in the page,
   give every column backed by that query a `sortKey`, and pass `sorting` to
   `DataList` + `sort` to `ListFilterBar` (see "Sorting" below).
7. If the rows have an owner, add the `ownerName` join + a `list*Owners()` export to
   the store and render `OwnerFilter` (see "The owner filter").
8. (Optional) Opt into multi-delete: add a bulk store function + a teacher-gated
   server action that reuses the per-item delete helper, wrap the `DataList` in
   `SelectionProvider`, prepend `selectionColumn`, and add `DeleteSelectedButton` to
   `actions` (see "Multi-delete" above).

## Pagination

Same discipline as filtering: the **skip and the limit are SQL** (`LIMIT/OFFSET`),
never an in-memory `slice()`. The page lives in the URL like every other filter
param. Page size is **20** (`DEFAULT_PAGE_SIZE`), with a hidden `?size=` override
clamped to `1…100` — `size=1` is legal on purpose, it is how the e2e suite forces a
two-page list out of two rows.

| Piece | Where | Role |
| --- | --- | --- |
| `lib/db/paging.ts` | shared, **no DB import** | `DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE`, `Paging`, `PagedResult<T>`, `ParamRecord`, `PagingParams`, `parsePaging`, `carryParams`, `pageHref`, `lastPage`, `paginate`, `unpagedResult` |
| `lib/db/count.ts` | shared, server-only | `countRows(table, conditions, joins?)` — the one `COUNT(*)` every list runs |
| store | `lib/*-store.ts` | a private `listConditions()` feeding that COUNT **and** a windowed row query |
| `Pager` | inside `components/data-list.tsx` (**server**) | "Showing 21–40 of 137" + prev/next `<Link>`s; renders at the reserved seam below the table |
| `ListFilterBar` | `components/list-filter-bar.tsx` | drops `page` on Apply (back to page 1), keeps a non-default `size` via a hidden input |

`components/data-list.tsx` imports `pageHref` from `lib/db/paging.ts`, so that module
must stay free of any `lib/db/index.ts` import — no driver code in the component graph.

### Store: COUNT + a windowed row query over ONE conditions array

```ts
export async function listFiles(opts?: { search?; createdBy?; paging?: Paging }):
  Promise<PagedResult<FileListEntry> | undefined> {
  const conditions = listConditions(opts);          // built once — count and rows must never drift
  try {
    return await paginate({
      paging: opts?.paging,
      count: () => countRows(files, conditions),     // the shared COUNT(*) — lib/db/count.ts
      rows: (window) => {                            // a FRESH builder per call — drizzle builders are stateful
        const query = getDb().select({…}).from(files).where(and(...conditions))
          .orderBy(desc(files.validFrom), asc(files.id));
        return window ? query.limit(window.limit).offset(window.offset) : query;
      },
    });
  } catch (error) { console.error(…); return undefined; }   // unchanged never-throw contract
}
```

Four things are load-bearing:

- **`.limit().offset()`, applied together.** No `$dynamic()` needed: the windowed and
  unwindowed chains are two expressions inside the one `rows` closure.
- **The ORDER BY must be unique.** `LIMIT/OFFSET` over a non-unique sort can repeat or
  skip rows between pages, so every list appends a primary-key tiebreaker
  (`files.id`, `images.id`, `codes.code`, `reports.id`).
- **The count repeats the joins.** `listReports` filters on `users`/`codes` columns, so
  it passes both LEFT JOINs to `countRows` (join on primary keys only — a join that
  could multiply rows would inflate the count).
- **No filter may drop rows after the query.** A post-query filter
  would make a page short and disagree with its total, so `listCodes` restricts
  `module` with an `inArray(codes.module, CODE_MODULES)` condition (its post-filter
  of unknown modules stays as unreachable belt-and-braces).

`paginate` runs the COUNT and the row query **in parallel** (one round-trip of
latency) and re-issues the row query **once** if the requested page over-shot the
data, returning the clamped page — so a stale `?page=` (a bookmark, or the last page
emptied by a bulk delete + `router.refresh()`) self-corrects. The two queries aren't
in one transaction, so `total` can drift by a row; that is why `DataList` keys its
empty state on `rows.length`, not on `total`. Omitting `paging` skips the COUNT
entirely and returns every match with `total: rows.length` — that is what the bearer
API routes do (`docs/api.md`), and it keeps one code path per store.

### Page wiring and the pager

```tsx
const paging = parsePaging(sp);
const result = await listFiles({ search: q || undefined, createdBy: …, paging });
// …
<ListFilterBar … pageSize={result.pageSize}>…</ListFilterBar>
<DataList … pathname="/files" params={sp} pagination={result} />
```

`pathname` + `params` are top-level `DataList` props, not part of the `pagination`
value: the pager AND the sortable headers build their links from the same list URL,
so it is passed once. Both are needed for either to render — they are optional only
because the writing module's embedded savers list has no route of its own to name.

`result.page` is the **effective** (clamped) page from the store, and every pager
href derives from it — never from the URL's `?page=`, which would otherwise offer a
"Next" that doesn't exist. A clamped page therefore leaves the stale number in the
address bar until the next click; the content is correct throughout.

Aggregates over the list shrink to the page for free: `/codes` runs
`getInteractionCounts()` over the 20 visible codes, `/images` builds 20 content-route
URLs.

**Select-all stays page-scoped.** `SelectionProvider` gets the rendered rows' ids and
narrows the selection to them *at render* (not only in the prune effect), so the count
and the delete payload can never carry a row from another page.

**Known scaling limit.** The tiebreakers make the sort unindexed, and `OFFSET n` is
O(n) — fine at teaching volumes. Keyset pagination is the upgrade path, and
`PagedResult` doesn't preclude it.

## Sorting

The third instance of the one discipline: the **`ORDER BY` is SQL**. Because the list
is paged, a sort has to span the whole filtered set — sorting the twenty rendered
rows would reorder a page instead of the list. The sort lives in the URL like every
other list param.

The grammar is one param: **`?sort=name`** ascending, **`?sort=-name`** descending,
absent = the list's default order. Clicking a header cycles **asc → desc → no sort**.
One sort column, never nested. A key outside the list's allow-list — a typo, a
hand-edited URL, a bookmark from before a column was dropped — reads as absent, so a
bad URL degrades to the default order instead of failing.

| Piece | Where | Role |
| --- | --- | --- |
| `lib/db/sorting.ts` | shared, **no DB or drizzle import** | `Sort`, `SortDirection`, `SortParams`, `parseSort`, `nextSort`, `formatSort`, `sortHref` |
| `lib/db/sort-order.ts` | shared, server-only | `SortColumns`, `sortOrder(sort, columns, fallback)` — the one ORDER BY builder |
| store | `lib/*-store.ts` | exports its `*_SORT_COLUMNS` map and takes an optional `sort` |
| `ListColumn.sortKey` | `components/data-list.tsx` | opts one column into click-to-sort |
| `DataList` | `components/data-list.tsx` (**server**) | `pathname`/`params` (shared with the pager) + `sorting={sort}`, the active sort |
| `ListFilterBar` | `components/list-filter-bar.tsx` | keeps the active `sort` across Apply via a hidden input |

`lib/db/sorting.ts` is imported by `components/data-list.tsx` **and** by the client
`ListFilterBar`, so — like `lib/db/paging.ts` — it must stay free of drizzle and of
`lib/db/index.ts`. That is the whole reason the ORDER BY builder is a second module.

### The store owns the allow-list

The sort-key → column map is declared **once**, in the store, and does double duty: it
builds the `ORDER BY` and it *is* the allow-list the page hands `parseSort`.

```ts
export const FILE_SORT_COLUMNS = {
  name: files.name, kind: files.kind, title: files.title, updated: files.validFrom,
} satisfies SortColumns;
// …
  .orderBy(...sortOrder(opts?.sort, FILE_SORT_COLUMNS, [desc(files.validFrom)], asc(files.id)));
```

Two rules hold in every store:

- **An explicit sort REPLACES the default order** (the `fallback` argument), it does
  not layer on top of it. On `/reports` that is visible: the urgent-first
  `holysh` `CASE` leads only while no column is sorted, and comes back when the sort
  is cycled off.
- **The primary-key tiebreaker always trails** (`files.id`, `images.id`, `codes.code`,
  `reports.id`) — the same `LIMIT/OFFSET` stability requirement paging already has.
  It is the helper's last argument rather than something each store remembers to
  append, so a new list cannot forget it.

`sort` is optional, so the four bearer API routes (`docs/api.md`) stay unsorted and
their JSON is unchanged.

### Which columns are sortable

Every column backed by a real column **of the list's own query** gets a `sortKey` —
text, dates and numbers alike, it is the same code. Not sortable: the selection and
Actions columns, and `/codes`' **Interactions**, which is a page-scoped aggregate over
the Mastra-owned tables computed after the page is read (so it cannot be an `ORDER BY`
term).

`/reports` orders `Code` and `Student` by the JOINed `codes.note` / `users.displayName`
— the values those cells lead with. Codes with an empty note therefore group together.

**NULL ordering** follows Postgres's default: NULLs sort **LAST ascending, FIRST
descending** (`asc()`/`desc()` are used plain — no `NULLS LAST` needed). It
applies wherever a nullable column is sortable, and a few of those are worth
knowing about:

- `/codes`' `Valid from`/`Valid until` — a windowless code (no bound set) is the
  common case, so ascending trails with all of them.
- `/reports`' `Status` deliberately does NOT sort by the nullable `resolved_at`
  (ascending would read resolved-first, the inverse of the column name). Its
  key is `CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END` — the state the badge
  shows — so ascending is open-first and `?sort=-status` resolved-first, the
  same "sort by what you display" rule as the owner label.
- `/reports`' `Code`/`Student`, when the joined code row or the reporter's
  display name is missing: the missing value sorts **LAST** ascending.

### URL plumbing

A sort link drops `?page=` (page 7 of a re-sorted list is a different set) and keeps
everything else, `?size=` included. The other direction is free: `pageHref` already
carries every param it does not own, so prev/next keep the sort. Both build on the
shared `carryParams` in `lib/db/paging.ts`, so a pager link and a sort link can never
disagree about the filter. (They can differ on `?size=`: `pageHref` re-emits it only
when non-default, `sortHref` carries whatever the URL had. `parsePaging` clamps either
way.) `ListFilterBar` keeps the sort across Apply the same
way it keeps a non-default `size` — a hidden input; "Clear" drops both.

## Remembering the last filter

A teacher who filters `/codes`, opens a code and comes back should land on the list
they left — so the browser remembers each list's last applied filter and the links
BACK to a list start from it. This does **not** bend the one firm rule: the URL is
still the only filter state the app reads, and the database still does the filtering.
`localStorage` only ever supplies the **starting href of a link**.

| Piece | Where | Role |
| --- | --- | --- |
| `components/list-filter-memory.ts` | shared, **no `"use client"`** (like `use-popover.ts`) | `listFilterKey`, `rememberListFilter`, `rememberedListHref` |
| `RememberListFilter` | `components/remember-list-filter.tsx` (**client**) | the write: an effect, renders `null` |
| `DataList` | `components/data-list.tsx` (**server**) | mounts it — the ONE write site |
| `NavMenu` | `components/nav-menu.tsx` (**client**) | the burger's list items, resolved when the menu opens |
| `BackLink` | `components/back-link.tsx` (**client**) | the "← Back to …" links, resolved in an effect after mount |

One entry per list route (`novedu:list-filter:/codes`), holding the applied query
string. Five things are load-bearing:

- **`DataList` writes, guarded by its `url`.** So the write sites are exactly the four
  routes that pass `pathname` + `params` (`/codes`, `/files`, `/images`, `/reports`);
  an embedded list — the writing module's savers list, the per-code conversation
  stats — has no route of its own and never writes. Nothing to wire per page.
- **`page` is dropped** (`carryParams(params, ["page"])`), so a remembered list reopens
  on page one. Everything else rides along, `sort` and a non-default `size` included.
- **An empty query REMOVES the entry**, so "Clear" — a bare `router.push(pathname)` —
  genuinely forgets rather than storing a blank.
- **Only links are seeded, never a page.** A list page never reads the memory: a typed
  or bookmarked `/codes` shows the plain list, and a shared URL means what it says.
- **Every storage access degrades to "nothing remembered"** — it can throw on access
  alone in some privacy modes, and navigation must never break over a filter.

`rememberedListHref` is safe to call for any href: one that already carries a `?` or a
`#` is returned untouched, and a path no list ever wrote simply misses. That is why
`BackLink` applies it unconditionally even though `/codes/<code>` is among its hrefs.

The two consumers resolve at different moments, for the same reason — the
server-rendered markup must not depend on `localStorage`. The burger's panel does not
exist until it opens, so `NavMenu` maps the hrefs in the click handler (always fresh,
no hydration to manage); `BackLink` is rendered with the page, so it starts from the
plain href and upgrades in an effect — which keeps the href real, so middle-click and
"open in new tab" carry the filter too. Either way a click landing in the very first
frame gets the plain list: a miss, never a wrong filter.

`tests/component/list-filter-memory.browser.test.tsx` is the guard for both halves.
