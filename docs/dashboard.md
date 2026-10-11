# Usage dashboard

The teacher-only read surface over the usage metering tables at `/usage`. It is the
first UI on top of `novedu_usage_by_code` (docs/usage-metering.md, which otherwise
has no read surface) and the seed of a subsystem that grows: the token-over-time bar
chart is built to be reused on future single-code stats pages.

Read before touching: `app/usage/**`, `lib/usage-stats-store.ts`, `lib/usage-range.ts`,
the shared chart building blocks in `components/charts/**` and
`components/dashboard-{ui,skeletons}.tsx` (also used by the LLM diagnostics page,
`docs/diagnostics.md`), the `--chart-*` tokens in `app/globals.css`, and the
`/usage` entry in `components/nav-menu.tsx`.

## What it shows

- A **stacked bar chart** of token usage over time — cached input, new input, output
  — with a **data table** of the same buckets beneath it.
- Four **donut pies**: total tokens per **module** (tutor/quiz/writing/coding/cloze), per
  **code** (top 9 + "Other"), per **model** (top 9 + "Other"; a NULL model —
  metered before models were recorded — shows as "(unknown)"), and per **LLM
  provider** (`docs/ai-models.md`; a NULL provider likewise "(unknown)"). The
  provider pie is the **cost split** — model ids are not provider-disjoint (the
  same id can be served by more than one provider), so the model pie cannot stand
  in for it. The two LLM pies sit side by side beneath the module/code pair.
- Three **KPIs**: **Chats** (distinct Mastra threads with a user message), **Quiz
  answers graded** (`SUM(quiz_answers)`) and **Cloze submissions graded**
  (`SUM(cloze_submissions)`).
- The quiz pre-check hint (`docs/codes.md`, "Immediate feedback") is **not** in any
  of these numbers — its classifier calls are deliberately unmetered
  (`docs/usage-metering.md`).

The code pie (and the module pie) may show a **`cli-eval` pseudo-code / `eval`
module** row: that is a teacher's `novedu-cli eval` run, metered under a sentinel
code rather than a real one (`docs/cli-eval.md`, `docs/usage-metering.md`). It has no
`novedu_codes` row, so the LEFT JOIN leaves its metadata NULL and it is labelled by
its raw code — and it can never collide with a minted 10-character code.

A single **time filter** — `Last 24 hours / 7 days / 30 days / 365 days` — governs
**every** panel, including the KPIs.

## Time model — UTC

Everything is **UTC**: the `hour` column of `novedu_usage_by_code` is a top-of-hour
UTC bucket, and the dashboard labels and bucket boundaries are UTC too (axes say so).
There is no per-viewer timezone conversion, so a bucket boundary and its label always
line up. `lib/usage-range.ts` is the pure, deterministic core (it takes `now` as an
argument — no `new Date()` inside — so it is trivially unit-testable):

| range | grain | buckets |
|---|---|---|
| 24h | hour | 24 |
| 7d | day | 7 |
| 30d | day | 30 |
| 365d | month | 12 |

`resolveRange(range, now)` returns the window `start`, the `grain`, and the full
ordered bucket list (each with a UTC label); `zeroFill` merges the aggregate rows
onto that list so an empty hour/day/month renders as an explicit zero, not a gap;
`foldTopN` keeps the top-N slices and sums the rest into "Other". It imports nothing
server-only, so the client may use it too.

## The read seam — `lib/usage-stats-store.ts`

Mirrors `lib/code-stats-store.ts`: raw by-value `sql` via `getDb().execute`
(the KPI query joins Mastra's `mastra.mastra_messages`, which Drizzle never
declares — its camelCase columns are double-quoted in the raw SQL, and
`db.execute()` returns `{ rows }`, so every read pulls its rows off that
property), and the **never-throws** contract — every function returns
`undefined` on a DB error and logs it, so a failed panel degrades to
"unavailable" instead of crashing the page.
**One query per chart/KPI**, each aggregating in SQL so only a small result set
crosses the wire, and **read once where the shape allows**:

- `getTokenTimeSeries({ range, now, code? })` — SUM per UTC bucket, `WHERE hour >=
  start [AND code = @code]`, zero-filled. Feeds the **bar chart AND the table**.
  `code?` is the **reuse seam** for single-code stats pages; omitted, it sums across
  all codes.
- `getUsageBreakdown({ range, now })` — one `(code, module)` scan feeds the module
  and code pies (summed by module, folded top-9-by-code + Other). Code slices are
  labelled with the teacher's own **note**, never a student.
- `getTokensByModel({ range, now })` — one `GROUP BY model` scan for the model pie
  (label = the raw model id, NULL → "(unknown)", folded top 9 + Other).
- `getTokensByProvider({ range, now })` — the sibling `GROUP BY provider` scan for
  the provider pie (label = the app-level provider name the recorder stamped,
  NULL → "(unknown)", folded top 9 + Other for consistency though the provider
  count is far below that). Its own read, not a fold of the model query, so a slow
  or failed one degrades only its own card; `ModelsSection` issues the two in
  parallel.
- `getDashboardKpis({ range, now })` — one round trip, three windowed subselects, feeds
  **all three KPI tiles**.

## Loading model — server components + Suspense streaming

The dashboard is **server-first**, matching the repo's stats convention
(`conversation-stats.tsx` → `getCodeStats`): each section is an async **server**
component that reads the store directly and passes data as **props** to thin client
chart children — there is deliberately **no client `fetch('/api/*')`** and so **no
`/api/usage/*` route to gate** (the page's `isEffectiveTeacher()` is the whole gate).

"Load immediately with loading indicators" is React `<Suspense>` streaming: the page
shell + range tabs flush instantly and each section streams in independently behind
its own skeleton (`components/dashboard-skeletons.tsx`). The time filter is the `?range=`
search param — `range-tabs.tsx` is a small client `<Link>` group styled with the
shared `SEGMENTED_NAV` / `segmentedItemVariants` recipe (`components/ui/segmented-nav.ts`); the Suspense
boundaries are **keyed by range**, so switching shows the skeletons again while the
new window streams. `page.tsx` snaps one `now` and passes it to every section, so the
KPI, chart, and pies all describe the same window.

## Charts & palette

Recharts (`recharts`, a client-only lib — every chart is a `"use client"` child fed
by props). It renders via inline SVG styles and ships **no global stylesheet to
import**, so it adds no unlayered CSS and does not touch the `@layer` order
(docs/styling.md). Research current Recharts docs via context7 (`/recharts/recharts`)
before charting work.

Colors follow docs/styling.md — the dataviz-validated hues live **only** as
`--chart-*` tokens in `app/globals.css` (shadcn's `--chart-1..N` convention, so
shadcn's chart components drop in later); components carry **no bare hex**. Because an
SVG `fill` attribute does not resolve a CSS custom property,
`components/charts/chart-colors.ts` reads the tokens with `getComputedStyle` and hands
Recharts concrete strings; chart **chrome** (grid/axis/legend/tooltip) uses
`currentColor` + opacity or token-based HTML styles off the `foreground` ramp.

The building blocks every chart in the app shares (this dashboard and the LLM
diagnostics page) live in `components/charts/`: `chart-colors.ts` (the token
resolver), `chart-chrome.tsx` (props objects for grid, axes and tooltip cursor, the
tooltip/legend styles, `legendText`), `chart-frame.tsx` (`ChartFrame` — the sized
`text-foreground` box around `ResponsiveContainer`, `h-72` unless a `h-*` delta is
passed) and `format.ts` (fixed en-US `formatCount` / `formatCompact`). The section
cards and their notices are `components/dashboard-ui.tsx`. Each chart stays a plain
Recharts component composed from these — there is no generic chart abstraction. The bar chart's companion table and the pies'
legends are the dataviz **"relief"** that keeps the two sub-3:1 hues legible. The app
is **light-only**. The code pie is top-9 + "Other"; only the first 8 hues are
CVD-validated and a 10-slice pie is at the readability limit, so `N` is a single
constant (`foldTopN`) if a ranked bar or top-8 is later preferred. The model and
provider pies both use the pie's rank-colored `variant="model"`: neither models
nor providers have a fixed identity order to color by (unlike the modules), so
the rank palette + the "Other" gray is exactly the assignment they need.

## Anonymity

Unchanged from docs/usage-metering.md: `novedu_usage_by_code` carries **no user id**,
so nothing the dashboard reads can link a student to an activity. The per-code pie
labels slices with the teacher's note; the "Chats" KPI counts threads, never
students. No message/prompt content or PII is read.

## Testing

- **Unit** — `lib/usage-range.unit.test.ts` (pure windowing/labels/zero-fill/foldTopN
  with an injected `now`); `lib/usage-stats-store.unit.test.ts` (the
  `code-stats-store.unit.test.ts` template — mock `getDb().execute` with a canned
  `{ rows }` result, assert the shaping + never-throws); `app/usage/page.unit.test.tsx` (the
  teacher gate) and the section server components via `renderToStaticMarkup`.
- **Component** — the bar + pie charts render props-driven in the `vitest-browser`
  project (real Chromium), through the shared `renderChart` harness
  (`tests/render-chart.tsx`: stylesheet, fixed-width frame, pointer parked off the
  chart so no tooltip duplicates a legend label).
- **E2E** — `e2e/usage-dashboard.live.spec.ts` (`@live-db`, seeds
  `novedu_usage_by_code` via the plain `pg` driver through `e2e/db.ts`, runs in
  CI) and a hermetic access-denied spec (default student session). See
  docs/testing.md.

## Extending it

- **A new chart/KPI**: add a store function (one query), a client chart child fed by
  props, and a section behind its own `<Suspense>`.
- **Single-code stats page**: call `getTokenTimeSeries({ code })` from a server
  component and render `<TokenUsageBarChart>` with the result — the seam already
  exists.
- **Exact-local windows** (if the user base ever leaves CET): the only change is
  anchoring the window/labels to a viewer timezone; the store filter stays `hour >=
  start`.
