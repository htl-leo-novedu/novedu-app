# LLM diagnostics

The teacher-only read surface over the app's own Application Insights telemetry at
`/diagnostics` (burger menu "Diagnostics", status-bar heading "LLM Diagnostics"). It
shows how the upstream LLM calls behaved in a time span and what students
experienced, and its **Copy report** button puts a plain-text summary on the
clipboard for a support case. It is read-only over telemetry the app already emits
(`docs/telemetry.md`): no telemetry change, no new setting, no API route.

Read before touching: `app/diagnostics/**`, `lib/diagnostics-*.ts`,
`buildMonitorCredential` in `lib/azure-credential.ts`, and the `/diagnostics` entry in
`components/nav-menu.tsx`.

## What it shows

- **Summary tiles** for the whole range, one row per provider with calls: LLM calls
  (est.), error rate (5xx + 429 + no response), and the wait for response headers
  p50 / p95 / max; one **student impact** row: failed chat turns, their share of all
  turns, and the chat-turn p95; plus the sampling note.
- **Upstream LLM calls** — calls per bin stacked by outcome (OK, other 4xx, 429,
  5xx, no response), one small chart per provider, SCCH first.
- **Wait for response headers** — p50 (solid) and p95 (dashed) per provider and bin.
- **Student impact** — failed chat turns per bin (bars, left axis) and the chat-turn
  p95 (line, right axis), plus the failures grouped by module and error code.
- **Errors by provider and status** — count, median wait, first and last seen; at
  most **20** rows, by count.
- **Failed calls (sample)** — the newest **50** retained rows, each with the number
  of calls it stands for.

Every count is an estimate from sampled telemetry, and telemetry arrives a few
minutes late — the page says both.

## Time model — local in the UI, UTC in the report

The UI thinks in the **viewer's** time zone; the server learns it from the URL.

- Presets: `?range=last1h|today|yesterday|last7d&tz=<IANA zone>`. **Last hour** is
  a rolling 60 min ending now whose start is floored to its 1 min bin, **Today** is
  local midnight → now, **Yesterday** the whole previous local day (23 h / 25 h on a
  DST day), **Last 7 days** a rolling 7 × 24 h ending now whose start is floored to
  its 1 h bin, counted from local midnight (so a half-hour zone gets bins on its
  local hours). The server resolves them with the pure
  `lib/diagnostics-range.ts` (`now` injected; Node ships full ICU), so reloading
  "Today" always shows fresh data.
- Custom: `?from=<ISO UTC>&to=<ISO UTC>`, converted in the browser from two
  `datetime-local` inputs (`lib/datetime-local.ts`). `from`/`to` win over `range`.
- No `tz` → the client `EnsureRange` adds the browser zone (and `range=today` when
  no range is set) with `router.replace`; nothing is queried before that. A
  present-but-unknown zone resolves in UTC, so this never loops.
- Validation: `from < to`, `to` clamped to now, span ≤ 31 days. An invalid custom
  range falls back to the last 24 hours, an unknown preset to Today — each with an
  inline notice.
- Bin size by span: ≤ 3 h → 1 min, ≤ 24 h → 5 min, ≤ 7 d → 1 h, else 6 h. A
  rolling window (Last hour, Last 7 days, the 24 h fallback) picks its bin from
  the nominal span, then floors its start down to that bin — the fallback in UTC —
  and keeps the bin, although the floored window is up to one bin longer; `to`
  stays now.
  Today and Yesterday start at local midnight; a custom range is used as given.
  Bins are aligned to the range start (`bin_at(timestamp, <bin>, datetime(<from>))`),
  and `binStarts` produces the same keys, so every chart is zero-filled key for key.

Chart axes and table times render in local time (`app/diagnostics/_charts/axes.ts`,
`LocalTime`). The report uses **ISO UTC** everywhere and names the local zone and
its offset once, on its Range line.

## The read seam — `lib/diagnostics-client.ts`

- The resource is addressed by the `ApplicationId` inside the existing
  `APPLICATIONINSIGHTS_CONNECTION_STRING` (`parseApplicationId`). No connection
  string, or none with an `ApplicationId` → the page shows a **Not configured**
  card and Azure is never called.
- `POST https://api.applicationinsights.io/v1/apps/<ApplicationId>/query` with
  `{ query, timespan }`, a 30 s `AbortSignal`, and an Entra bearer token for scope
  `https://api.applicationinsights.io/.default`.
- The token comes from `buildMonitorCredential()` — the explicit
  `ChainedTokenCredential(AzureCliCredential, ManagedIdentityCredential)`, ambient
  tenant, never `DefaultAzureCredential`, never an API key — cached per process by
  `getBearerTokenProvider` and bounded to 15 s.
- **Never throws**: each call resolves to the first result table or a typed failure —
  `not-configured`, `credential` (the Entra token could not be obtained: timeout, no
  `az login`, IMDS unreachable), `forbidden` (401, 403), `timeout`, `error` (any
  other HTTP error, network failure, or malformed body). Every failure but
  `not-configured` is logged and passed to `recordError` with
  `novedu.area=diagnostics`; the log never holds the connection string, the request
  URL (it carries the app id), a header, or the token.

`lib/diagnostics-hosts.ts` maps the host of each LLM call to a provider name. The
hosts come from `resolveChatEndpoint` (`lib/llm/endpoint.ts`) for every
`LLM_PROVIDERS` entry — no provider branch, no host literal. A provider not
configured on this server (its URL getter throws) is absent from the map, and its
historical calls show as **other**. The map never leaves the server.

## Loading model

`app/diagnostics/load.ts` starts the five queries **once** per render and hands the
page four promises (`llm`, `errors`, `failedCalls`, `impact`), each already shaped by
the pure `lib/diagnostics-shape.ts`. Every section is an async server component
behind its own `<Suspense>` (keyed by the range), awaiting the promise(s) it needs —
the KPIs await `llm` + `impact`, the failed-call table `failedCalls` + `llm` — so no
query runs twice and a slow or failing query degrades only its own sections.

The **Copy report** control is its own Suspense boundary awaiting all four promises:
it becomes usable once the page settled, and `lib/diagnostics-report.ts` formats the
very DTO the page rendered, in the browser, with no second query. Where the
clipboard is refused, the text appears in a read-only field.

The charts, cards and skeletons are built from the same shared pieces as the usage
dashboard (`components/charts/**`, `components/dashboard-{ui,skeletons}.tsx`,
`docs/dashboard.md` "Charts & palette"); only the axis formatters are the page's own.

Every data card carries `data-testid="diagnostics-<section>"`, `data-state`
(`ok` | `empty` | `unavailable`) and, when unavailable, `data-failure`. The card
copy per failure: `credential` → "the server could not obtain an Entra token to read
Application Insights", `forbidden` → "the server's identity cannot read Application
Insights (missing Reader role?)", `timeout` → "try a shorter range", `error` →
"could not be loaded right now". When `resolveTelemetryMode()` is not `azure` (e.g.
OTLP wins locally), a banner warns that this process's own recent data may be
missing.

## The KQL — `lib/diagnostics-kql.ts`

Pure builders. The only values that reach a query are two validated `Date`s (as
ISO literals) and the `BinSize` enum through a fixed lookup — nothing the user
types, and no host literal. Queries use the table names of the App Insights
**resource** endpoint (`dependencies`, `requests`, `timestamp`, `itemCount`,
`customDimensions`), not the workspace `App*` names.

| Query | Source | Notes |
|---|---|---|
| `llmCalls` | `dependencies`, `type == "HTTP" and name endswith "/chat/completions"` | Per bin and host, plus whole-range totals as rows with `t == null` (a `union`). Outcome by `toint(resultCode)`: empty/0 no response, 429, ≥ 500, ≥ 400, else OK. |
| `llmErrorBreakdown` | same prelude, non-OK | By host × `resultCode`, `top 20 by errors`. |
| `llmFailedSample` | same prelude, non-OK | `top 50 by timestamp desc`. |
| `chatFailures` | `dependencies`, `target == "exception"`, `customDimensions["novedu.area"] == "chat-run"` | By bin, `novedu.module`, `novedu.chat.failure`, `novedu.chat.run_error_code`. |
| `chatTurns` | top-level `requests` named `POST /api/copilotkit/agent/<id>/run` | Turns and p95 per bin, plus the whole-range total. |

Facts about the data the queries rely on (verified against live data):

- An LLM call's `target` is the **full URL**; the host is
  `parse_url(target).Host`, falling back to the raw `target` when that is a bare
  host. An `InProc` row of the coding route also contains `chat/completions`, hence
  the case-insensitive `type =~ "HTTP"` filter.
- The fetch span ends when the **response headers** arrive, so `duration` is the wait
  before streaming starts, not the full stream.
- **A 503 carries `success == true`** — Next's fetch span does not flag HTTP errors.
  Outcomes come from `resultCode` only; no query reads `success`.
- `recordError()` records on a root span, so a failed chat turn is a `dependencies`
  row with `target == "exception"` whose attributes sit in `customDimensions`
  (`exceptions` holds no custom attributes). Its `operation_Id` is its own, so it is
  correlated with the LLM calls by time only. `INCOMPLETE_STREAM` is CopilotKit's
  code; a `stream-error` failure carries none and is grouped by its failure kind.
- Requests are nested 2–3 server spans deep; only the top-level row
  (`operation_ParentId == operation_Id`) carries the concrete agent route.
- Telemetry is **sampled**: every count is `sum(itemCount)`, every percentile is
  weighted (`percentilesw` / `percentilew`), and the sampling note is retained rows ÷
  `sum(itemCount)` over the LLM calls.
- LLM call rows carry no model, module or code — only the host identifies the
  provider.

## The clipboard report

Plain text that also reads as Markdown: a header (Range in UTC with the local span,
zone and offset — `UTC+2→+1` across a DST switch; the app's own public host;
generation time; the sampling note), one block per provider (headline, errors by
status, a timeline of the bins with errors or a p95 ≥ 3× the range's p50 — at most
48, the worst kept and re-sorted by time — and the failed-call sample), and a
student-impact line. An unavailable section is one line with its failure. The
2026-09-25 SCCH incident (`lib/diagnostics-report.fixture.ts`) pins the format
verbatim.

## Security & privacy

- Teacher-only via `requireTeacherPage()` (a teacher in student mode is denied); the
  page gate is the whole gate — there is no route, no `proxy.ts` change, no new
  public surface.
- The connection string stays server-only; only the `ApplicationId` is extracted.
- Provider **names only** reach the browser and the report — hosts are mapped away
  on the server, so no endpoint URL leaves it (the LLM-connectivity invariant,
  `docs/ai-models.md`). "Server" in the report is the app's own public host
  (`AUTH_URL`, else the request host).
- The queries read only content-free telemetry (`docs/telemetry.md`) and show no
  user ids, codes or content.
- Each stage's `ApplicationId` addresses that stage's own App Insights resource,
  never another stage's or the shared workspace.

## Operations

The app's identity needs **Reader on its own App Insights resource**: each
stage's `ca-novedu-<stage>` on its `appi-novedu-<stage>` (`docs/azure-runtime-env.md`). A
fresh assignment answers 403 for a few minutes. The environment's
`APPLICATIONINSIGHTS_CONNECTION_STRING` must contain `ApplicationId=`, or the page
shows "Not configured".

Locally the `az login` identity reads the resource named by `.env`. For a resource in
the Novedu tenant, sign in under `AZURE_CONFIG_DIR=~/.htl-azure-novedu`
(`docs/azure-runtime-env.md`, "Access") and start the app with the same variable.

Verification after an assignment: open `/diagnostics` once on that environment — the
live e2e runs with the developer's identity and cannot prove it.

## Testing

- Unit (hermetic): `lib/diagnostics-{range,kql,hosts,shape,client,report}.unit.test.ts`
  (zones and DST, query facts, host mapping, canned result tables, mocked
  fetch/credential, the golden report), `lib/azure-credential.unit.test.ts`, and
  `app/diagnostics/{page,sections,range-controls}.unit.test.tsx`.
- Component: `app/diagnostics/_charts/charts.browser.test.tsx` (through the shared
  `tests/render-chart.tsx` harness) and `copy-report-button.browser.test.tsx`.
- E2E hermetic: `e2e/diagnostics.spec.ts` — student denied, the zone redirect, the
  invalid-range notice, and the not-configured card (CI) or settled sections (a local
  `.env` with a connection string).
- E2E live: `e2e/diagnostics.live.spec.ts`, `@live @live-telemetry`
  (`npm run test:e2e:telemetry`; needs `.env` + `az login`, skips without the
  connection string). It proves the real endpoint accepts all five queries and the
  report reaches the clipboard. Excluded from CI (`docs/testing.md`).

## Extending

- A new signal = a builder in `lib/diagnostics-kql.ts` (typed values only), a shaper
  in `lib/diagnostics-shape.ts` (read columns by name, return a `SectionState`), a
  promise in `load.ts`, a section behind its own Suspense boundary, and — if it
  belongs in a support case — a block in `lib/diagnostics-report.ts` plus the golden
  test.
- A new provider needs nothing here: its host comes from `resolveChatEndpoint`.
