# Filtered lists

Teacher-facing list screens (YAML Files at `/files`, Shared Tutor Codes at
`/codes`, and any future list) share **one** concept so they look and behave
the same and only have to be improved once. Read this before adding a new list or
touching `components/data-list.tsx`, `components/list-filter-bar.tsx`, or a list
page's `searchParams` handling. Styling follows `docs/styling.md` — the list
chrome (container, toolbar, table) lives INSIDE `DataList`/`ListFilterBar` as
Tailwind utilities; pages never restate it.

Two list engines render these screens. The **classic engine** (`DataList` +
`ListFilterBar`, most of this doc) renders every list. `/codes` also has the
**new engine** (`components/list/`, see "The new list engine" at the end), and a
per-device Classic/New switch on the page picks one — classic by default. The firm
rule, paging, sorting and the filter memory below hold for both.

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
| `lib/db/sort-order.ts` | shared, server-only | `SortColumns`, `sortOrder(sort, columns, fallback, tiebreaker)` — the one ORDER BY builder |
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
| `DataList` | `components/data-list.tsx` (**server**) | mounts it on the classic lists; the new `/codes` list body mounts it itself |
| `NavMenu` | `components/nav-menu.tsx` (**client**) | the burger's list items, resolved when the menu opens |
| `BackLink` | `components/back-link.tsx` (**client**) | the "← Back to …" links, resolved in an effect after mount |

One entry per list route (`novedu:list-filter:/codes`), holding the applied query
string. Five things are load-bearing:

- **`DataList` writes, guarded by its `url`.** So the classic write sites are exactly
  the four routes that pass `pathname` + `params` (`/codes`, `/files`, `/images`, `/reports`);
  an embedded list — the writing module's savers list, the per-code conversation
  stats — has no route of its own and never writes. Nothing to wire per page. On
  the new engine the list body mounts `RememberListFilter` itself
  (`app/codes/_list/codes-list.tsx`), under the same `/codes` key, so both engines
  share one remembered filter. The new engine's URL grammar extends the classic one;
  what the classic list does not understand (a comma list, `status`) reads as no
  filter there.
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

## The new list engine

`/codes` has a second engine next to the classic one. It keeps every rule above —
filter, sort and page in SQL, state in the URL, select-all page-scoped, delete
bulk-only — and changes the screen: one toolbar row with a view picker, one "…"
menu per row instead of a row of buttons, a filter panel whose changes load only
on Apply, a summary line naming the applied filters, a bulk bar that appears
while rows are ticked, and rows that fold into three lines on a phone. It is deliberately
Novedu-sized: a small core plus per-list files, no generic grid framework.

| Piece | Where | Role |
| --- | --- | --- |
| `ListGrid<T>` | `components/list/list-grid.tsx` (**server**) | the table: checkbox column, sortable header links, row "…" menu; plus each row's folded phone cell (below) |
| `GridColumn<T>` | same file | `{ id, header, render, sortKey?, kind?, className?, fact? }` — `fact` is the column's short text on a folded row |
| `ListControls` | `components/list/list-controls.tsx` (**client**) | the toolbar row (view picker, phone Sort, Filters button with a count badge, the page's actions), the filter panel, the summary line; swaps in the bulk bar while rows are ticked |
| `FilterPanel` / `FilterToggle` / `FilterSelect` / `FilterSearch` | `components/list/filter-panel.tsx` (**client**) | the panel holding the draft and its Apply / Cancel / Clear all, and the controls that edit the draft: toggle pills, a select for long lists (the "Other owner…" picker), the search field |
| `FilterGroup` / `FilterSummary` | `components/list/filters.tsx` (**server-safe**) | a labelled group of the panel; the summary line under the toolbar |
| `ViewPicker` | `components/list/view-picker.tsx` (**server-safe**) | the toolbar button naming the view; its menu lists every view with its description |
| `ActionMenu` | `components/list/action-menu.tsx` (**client**) | the one menu: the view picker, row "…" menus, the phone Sort menu, the phone bulk "Actions" |
| `ListSelection` / `RowCheckbox` / `SelectAllCheckbox` | `components/list/selection.tsx` (**client**) | the page-scoped selection and the one way a bulk action runs |
| `BulkBar` | `components/list/bulk-bar.tsx` (**client**) | "N selected" + one button per bulk action; floats at the bottom on a phone |
| `ListPager` | `components/list/list-pager.tsx` (**server**) | "Showing 21–40 of 137" + previous/next |
| `listHref` / `parseMultiParam` / `paramValue` | `components/list/url.ts` (**no DB import**) | the URL grammar: every link the server builds, and the panel's Apply |
| `describeSort` / `sortMenuItems` | `components/list/sorting.ts` (**no DB import**) | the folded list's Sort menu and its "Note ↑" line |
| `EngineSwitch` | `components/list/engine-switch.tsx` (**server**) | the Classic/New switch both engines render |
| per-list files | `app/codes/_list/` | `columns.tsx` (the column catalogue + row menu), `views.ts`, `filters.tsx` (parse, the panel's search and groups, its starting draft, the summary parts, the clear href), `models.ts` (the YAML model page column), `codes-list.tsx` (the list body) |

The engine does not import the classic pieces (`components/data-list.tsx`,
`components/list-filter-bar.tsx`, `components/list-selection.tsx`,
`components/selection-column.tsx`, `components/owner-column.tsx`); the small
duplication with `components/list-selection.tsx` is deliberate, so either engine
can be changed without touching the other.

### The filter panel: a draft, applied on Apply

The toolbar's Filters button opens the panel under it: the search field across the
top, then the filter groups. Nothing in the panel loads the list on its own — a
pill click, a pick from "Other owner…" or typing only edits the panel's **draft**
(client state in `FilterPanel`, started from the filters the URL applies), and a
"Not applied yet" hint shows while the draft differs. **Apply** — or Enter in the
search field — builds the next URL with `listHref` and navigates, so the server
re-queries; the panel stays open with "Applying…" until the filtered page arrives,
then closes. **Cancel** (or the Filters button) closes the panel and throws the
draft away; "Clear all" in the panel only empties the draft. `listHref` drops
`page` (a changed filter is a different set) and carries everything else, `sort`
and `size` included; an empty value removes its param.

The controls (`FilterToggle`, `FilterSelect`, `FilterSearch`) edit the draft
through context, each naming its URL param, so a filter group renders them
anywhere inside the panel and knows nothing about the panel itself — the groups
can move into another container without change. A param is either multi-value
(toggle pills, `multi`) or one choice (pills and a select taking turns; the value
`""` stands for the param's default).

Under the toolbar, the **summary line** says what the list shows: the row count,
then the applied filters in the list's fixed order, then "Clear all" while
anything is filtered. It is built on the server from the same parsed URL the query
uses, so it can never disagree with the rows; its "Clear all" is a link and
applies at once.

A **multi-value filter is ONE comma-separated param** — `?module=tutor,quiz`,
never `?module=tutor&module=quiz` — because `carryParams` keeps only a repeated
key's first value and the pager, sort links and filter memory all build on it.
`parseMultiParam` drops unknown values (a stale bookmark degrades to "no filter")
and returns them in the allowed order; `listHref` leaves the commas unescaped.

`/codes` reads `q` (note or code contains), `owner` (absent = me, `all`, or a user
id — "The owner filter" above), `module` and `status` (both comma lists), plus
`view`, `sort`, `page` and `size`. `status` is the code's window at the request's "now" —
`active`, `upcoming`, `expired` — a SQL condition over `valid_from`/`valid_until`
(`windowStatusCondition` in `lib/code-store.ts`); the page passes the store the
same `now` it uses for the status badges, so filter and badge always agree. The
summary line always names the owner — "mine" is a filter too — and adds activity,
status and the search term only when set; the Filters button's badge counts the
applied values, the search term included and the default owner not.

### Views, query columns and page columns

A **view** is a use-case column set, defined in code
(`app/codes/_list/views.ts`) and picked by `?view=` (absent or unknown = the
list's first view); unsorted, every view lists the newest codes first. The view's columns pick from the list's column catalogue
(`CODE_COLUMNS` in `app/codes/_list/columns.tsx`). The toolbar's view picker lists
every view with its one-line description, the current one ticked; its links keep
the filters and drop `sort` and `page`, since another view has other sortable
columns. Everything else carries `view` along like any param, so the filter
memory reopens the last view on this device.

`/codes` has two views:

- **Overview** (default): activity, note, owner, the window, interactions.
- **Models** (`view=models`): activity, note, the activity YAML's model and the
  code's override model. The override replaces the YAML's model
  wholesale (`effectiveLlm`), so an overridden code's YAML model is struck
  through, and a code without an override leaves that cell empty.

Every column is one of two kinds:

- A **query column** is read by the list's own SQL query; it gets a `sortKey` from
  the store's `*_SORT_COLUMNS`, and the view's sortable columns are the allow-list
  the page hands `parseSort`. "Override model" sorts by `LLM_OVERRIDE_MODEL` in
  `lib/code-store.ts`: the model of a usable override (the SQL twin of the
  store's override check), else NULL, so ascending lists the overridden codes
  first, A–Z.
- A **page column** is computed after the page is read, for the visible rows only.
  It is computed only when the active view shows it, is never sortable, and shows
  "—" when its computation fails, never a wrong value. `/codes` has two:
  - Interactions: one aggregate over the page's codes.
  - YAML model: `yamlModels` in `app/codes/_list/models.ts`, for every row on
    the page, overridden ones included. Each distinct activity file is loaded
    once, in parallel, through the same server fetcher the activities use, and
    its `llm:` block is read. Each load is capped at 10 seconds, so a slow
    outside host holds this view for at most that long and no other view at all.

### The row menu and the bulk bar

`ActionMenu` is a button plus a native `popover` panel. The popover lives in the
top layer, so it escapes the table card's `overflow-x-auto` clipping, and the
platform supplies light dismiss and Escape. From `md` up it drops from its
trigger, right-aligned (left-aligned with `align="start"`, as the view picker; the position is computed on open and handed to static
`md:` utilities through CSS variables, the `docs/styling.md` pattern); below `md`
it is a bottom sheet with 48px rows. Arrow keys, Home and End move between the
items; a scroll or resize closes it. Items are plain data — `link` (optionally
with a description line and a tick), `copy-link`, `disabled` (with its reason),
`button` — so a server page builds a row's menu.
The row menu never holds Delete: delete stays bulk-only.

The bulk bar replaces the whole toolbar row while rows are ticked (same height, so
the table does not move) and lists one button per bulk action; `confirm: "delete"` asks with
the count first. On a phone the toolbar stays and the bar floats at the bottom of
the screen, its actions behind an "Actions" sheet. Success clears the selection
and refreshes the page; a failure keeps the selection and shows the message.

### Phones: folded rows

Below `md` there is no sideways-scrolling table. Each row also renders a second,
folded cell — line 1 the row's title, line 2 its meta badges, line 3 every column's
`fact` joined by " · " — and CSS shows either the desktop cells or that cell. One
server render, no client-side shaping. The folded list has its own header row with
a visible "Select all" and the current order in words; the toolbar's Sort button
takes the place of the column headers. The toolbar wraps: the page's actions (the
Classic/New switch, "New code") take the top row, the view picker, Sort and
Filters the row under it.

### The Classic/New switch

The cookie `novedu-list-engine` (`classic` | `new`, `lib/list-engine.ts`) picks the
engine per device; `app/codes/page.tsx` gates the teacher first, then renders
the chosen engine. The switch posts to `switchListEngineAction`
(`lib/list-engine-actions.ts`), which sets the cookie (httpOnly, one year) and
redirects to the bare list route from `LIST_ENGINE_ROUTES` — never to a URL from
the form, and without the old filter, since neither engine has to understand the
other's params. The action is deliberately ungated: it only stores a display
preference, and the page it leads to gates itself. Absent the cookie, a device
gets `DEFAULT_LIST_ENGINE`.

### Adding a list to the new engine

1. In the store, take the list's filters as SQL conditions inside `listConditions`
   (multi-value filters as `inArray`), as in "Store: dynamic query" above.
2. Under `app/<list>/_list/`, write the column catalogue (`GridColumn`s with
   `sortKey`s from the store's sort map, `fact`s for the folded rows), the views,
   the filter file (parse, the panel's search and groups, its starting draft, the
   summary parts, the clear href), the row menu and the
   list body; render it from the page behind the engine cookie and add the route
   to `LIST_ENGINE_ROUTES`.
3. Compute page columns only when the view shows them.

The fast tests are `components/list/*.browser.test.tsx` (the menu, the toolbar, the
filter panel's draft and Apply, the bulk bar and the phone layout, against the
real stylesheet) and the
unit tests next to `components/list/url.ts`, `components/list/sorting.ts` and the
`app/codes/_list/` files; `e2e/codes-list-engine.spec.ts` opens both engines,
round-trips the switch and — `@live-db` — drives the filter panel, sort, pager,
the bulk delete and the Models view against the database.
