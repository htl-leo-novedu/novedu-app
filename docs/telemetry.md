# Telemetry — OpenTelemetry with two backends (Azure Monitor / standard OTLP)

Deep reference for the app's optional observability. The always-on invariants are
summarized in `AGENTS.md`; this file has the full mechanics. Read it before
touching `instrumentation.ts`, `lib/telemetry*.ts`, the `@opentelemetry/*` /
`@azure/monitor-opentelemetry` dependencies, `compose.telemetry.yaml`, or any call
site that records an event or an error.

## Backends, and which one runs

Server-side traces, metrics, logs and exceptions are exported through OpenTelemetry
to **exactly one** of two backends per server process, chosen once at startup:

| Condition (checked in this order)                 | Result                                             |
| ------------------------------------------------- | -------------------------------------------------- |
| `OTEL_SDK_DISABLED=true`                          | Telemetry disabled, regardless of other settings.  |
| Non-empty `OTEL_EXPORTER_OTLP_ENDPOINT`           | **Standard OTLP** path (`@opentelemetry/sdk-node`); no Azure initialization. |
| Non-empty `APPLICATIONINSIGHTS_CONNECTION_STRING` | **Azure Monitor** path (`@azure/monitor-opentelemetry`). |
| Neither destination configured                    | Telemetry disabled; no SDK, no exporter, no network sink. |

Whitespace-only values count as absent; the disable flag is case-insensitive.
**OTLP wins when both destinations are present**, so a local `.env` can point at
Aspire without removing the Azure setting, and an Aspire AppHost (which injects
`OTEL_EXPORTER_OTLP_ENDPOINT` into the processes it launches) needs no
Novedu-specific configuration. The flip side: **setting
`OTEL_EXPORTER_OTLP_ENDPOINT` on the production Web App switches it off
App Insights.** `OTEL_EXPORTER_OTLP_ENDPOINT` is the sole opt-in for the
standard path; the per-signal variables (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
etc.) alone do not enable it.

The startup log names only the selected mode (`telemetry: mode=otlp`,
`telemetry: mode=azure`, `telemetry: disabled (…)`) — never an endpoint, a
connection string, or a credential. Environment changes take effect after a
restart. The App Insights connection string is a **secret**: it lives in the
local `.env` (gitignored) and as an app setting on the production web app —
**never in the repo or CI**, so the secret-free `qa.yml` invariant
(`docs/ci-security.md`) holds. CI runs with no destination set, i.e. telemetry
off. An OTLP endpoint is not a secret, but is never committed either.

## The seam: `lib/telemetry.ts`

All telemetry goes through one small facade, so the rest of the app never imports
an SDK and never selects a backend:

- **`initTelemetry()`** — one-time bring-up, returning the mode that runs
  (`"disabled" | "azure" | "otlp"`). A pure resolver (`lib/telemetry-mode.ts`,
  no imports) reads the table above; the chosen initializer is then
  **dynamically imported** — `lib/telemetry-azure.ts` calls `useAzureMonitor()`,
  `lib/telemetry-otlp.ts` constructs and starts a `NodeSDK`. Neither SDK enters
  edge/browser bundles and only the selected one is paid for. Bring-up is
  idempotent and cached, including its failure: an initializer that throws
  leaves telemetry off for the life of the process (with a diagnostic that
  redacts both destination values) and **never falls back** to the other backend.
- **`recordError(error, attrs?)`** — records a caught error as an exception span
  (App Insights `AppExceptions`; an `exception` span with an exception event on
  any other receiver). Safe when telemetry is off. What it withholds, and why:
  see the privacy bullet below.
- **`emitEvent(name, attrs?)`** — a **content-free** feature-usage event through
  the OpenTelemetry logs API. The name travels three ways at once: as the log
  body (so a plain receiver such as Aspire displays it), as the record's
  first-class `eventName` (JSON key `eventName` on the OTLP wire), and as the
  `microsoft.custom_event.name` attribute that lands it in the App Insights
  `customEvents` table (an ordinary receiver shows that as one more attribute).
  The logs API is a **no-op when no provider is registered**, so this module is
  safe to import from shared code; without `initTelemetry()` it does nothing and
  never touches the network.

The **CLI never initializes telemetry** and must not create an exporter even with
`OTEL_*` or Azure variables in its environment: `cli/src/**` imports neither the
facade nor any `@opentelemetry/sdk-*` / instrumentation / exporter package nor
the Azure distro — walked transitively and grep-guarded by
`lib/telemetry-isolation.unit.test.ts`. The facade sits outside the CLI's
bundled closure, so changing it implies no CLI release.

## The standard OTLP path

`lib/telemetry-otlp.ts` builds `new NodeSDK({ instrumentations, resourceDetectors[, serviceName] })`
and calls `start()`. Nothing else is passed: supplying explicit `spanProcessors` /
`traceExporter`, `metricReaders`, or `logRecordProcessors` would bypass the SDK's
environment-based setup for that signal, so every exporter, processor, reader and
sampler is left to the SDK. That setup is **not re-implemented, re-validated, or
re-documented here** — see the
[OTLP exporter configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/)
and [general SDK configuration](https://opentelemetry.io/docs/languages/sdk-configuration/general/)
references and the [`@opentelemetry/sdk-node` README](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/opentelemetry-sdk-node).
In short: protocol `OTEL_EXPORTER_OTLP_PROTOCOL` (default `http/protobuf`; gRPC and
HTTP/JSON are available), headers, per-signal endpoint/exporter overrides
(`OTEL_{TRACES,METRICS,LOGS}_EXPORTER`, `otlp` by default for all three signals,
`none` to switch one off), timeouts, sampler (`OTEL_TRACES_SAMPLER`, default
parent-based always-on), and the periodic metric reader
(`OTEL_METRIC_EXPORT_INTERVAL` / `_TIMEOUT`, 60 s / 30 s by default).

Novedu sets exactly two things the SDK would get wrong on its own:

- **Service name** defaults to `novedu-chat` when `OTEL_SERVICE_NAME` is blank
  (passed as `serviceName` only in that case, since the option would override the
  variable). On the Azure path the same variable sets `cloud_RoleName`.
- **Resource detectors** are the fixed set `env, host, os, serviceinstance`.
  NodeSDK's default set (and `OTEL_NODE_RESOURCE_DETECTORS=all`) includes the
  `process` detector, which exports `process.command_args` (the full argv) and
  `process.owner` (the OS username) — never enable it. The explicit list also
  means the `OTEL_NODE_RESOURCE_DETECTORS` variable is ignored. Standard-mode
  startup probes no Azure metadata service.

Novedu installs **no diagnostic logger of its own**. `OTEL_LOG_LEVEL` turns on the
SDK's console diagnostics (exporter failures, configuration warnings); those can
echo the configured endpoint, so leave it unset in production. A malformed
`OTEL_EXPORTER_OTLP_ENDPOINT` does not make `start()` throw: the SDK warns (only
visible with `OTEL_LOG_LEVEL`) and exports fail asynchronously.

Dependencies: `@opentelemetry/sdk-node`, `@opentelemetry/instrumentation-http`,
`@opentelemetry/instrumentation-pg`, `@opentelemetry/instrumentation-runtime-node`
are direct dependencies at the ranges the installed Azure distribution resolves
to, and `@opentelemetry/api` / `@opentelemetry/api-logs` are exact pins of the
versions the distro itself pulls. The point is that the API packages hand out the
global tracer and logger: our direct imports and the distro's must end up on the
**same installed copy**, which is what the matching versions buy — `npm ls
@opentelemetry/api-logs` shows one hoisted entry with every other consumer
`deduped` onto it (the lone exception is the older `api-logs` nested under
`@azure/opentelemetry-instrumentation-azure-sdk`, transitive inside the distro
and not ours to align). Pinning `api-logs` to a version the distro does not use
installs a second copy instead. `sdk-node`, `api-logs`, every instrumentation and
every exporter are lockstep 0.x releases — **bump them together with the distro**
and re-pin `api-logs` to the version the new distro resolves to, or the copies
drift apart. `sdk-node` and the three instrumentations patch modules at `require`
time, so they are listed in `serverExternalPackages` (`next.config.ts`) beside the
distro and `pg`, and traced into the standalone Docker output.

## The Azure Monitor path

`lib/telemetry-azure.ts` calls `useAzureMonitor({ azureMonitorExporterOptions: { connectionString } })`
and nothing else. The distribution builds the same `NodeSDK` internally but adds
Azure-specific pieces a plain SDK would have to reconstruct: standard and live
metrics (Live Metrics is on by default and stays on), Azure resource detection,
the Application Insights sampler, custom-event mapping. It registers the HTTP and
`pg` instrumentations with the same bare defaults as the standard path, and
installs its own console diagnostic logger (warnings and above;
`APPLICATIONINSIGHTS_INSTRUMENTATION_LOGGING_LEVEL` / `OTEL_LOG_LEVEL` adjust it).
The two paths are mutually exclusive by construction: the distribution replaces
any global provider it finds, which is why the resolver picks one and only one.

## Startup ordering (`instrumentation.ts`)

`register()` runs once per server instance (Node runtime only) and does, in order:

1. **`initTelemetry()` FIRST** — before anything opens a connection — so the
   selected backend's auto-instrumentation can patch the HTTP and `pg` modules.
   Then `emitEvent("app_started", …)` (a no-op when disabled). Startup never
   waits for a receiver.
2. Check the image storage root (`docs/images.md`).
3. Apply Drizzle migrations and create Mastra's tables (`docs/database.md`).

Telemetry is **independent of the database**: it is gated on its own destination
settings, not `DATABASE_URL`, so the no-DB boot path (e.g. plain `next build`,
tutor validation) still initializes telemetry if a destination is set. The
edge/browser branches of the file do not initialize telemetry.

## Capturing uncaught errors: `onRequestError`

`instrumentation.ts` also exports **`onRequestError`** (Next's hook, fired for
every uncaught error in route handlers, server actions, and RSC renders) → it
calls `recordError(err, { path, routeType })` — only the path and route type,
never headers. This is the capture path for errors auto-instrumentation misses,
**notably async DB-driver rejections**.

Two non-obvious, load-bearing details (both baked into `lib/telemetry.ts`):

- Once `onRequestError` is defined, **Next stops auto-recording exceptions on the
  request span** (it delegates to the hook) — so the hook must do the recording.
- `recordError()` records on a span created with **`{ root: true }`**. A child of
  the active request span would inherit that span's sampling decision, and an
  errored route's request span is *dropped*, so the exception would silently
  vanish. The root span gets its **own, independent root sampling decision**
  instead. Delivery is still subject to the sampler, the bounded batch queues and
  receiver availability — a recorded error is very likely, not guaranteed, to
  export.

Errors that are caught and swallowed (e.g. a `console.error` in a `lib/*-store.ts`
that does not rethrow) never reach `onRequestError` — call `recordError()`
explicitly at those sites if you want them exported.

## What the signals look like

Both backends run the HTTP and `pg` instrumentations; the standard OTLP path adds
`instrumentation-runtime-node`. A receiver gets:

- **Request spans.** Next emits its own spans whenever a global tracer provider is
  registered: `BaseServer.handleRequest` (kind SERVER) plus a route-resolved
  span carrying `next.route`. `instrumentation-http`'s server span **wraps** them
  rather than duplicating them: a page request is three nested SERVER spans
  (`instrumentation-http` → Next's generic `BaseServer.handleRequest` → the
  route-resolved one), an API route two. Azure maps every SERVER span to its own
  `AppRequests` row, so **counting rows overcounts requests**; on Aspire it is one
  trace with nested spans. Incoming instrumentation stays on because it provides
  the unsampled request-duration metric.
- **Outgoing calls.** `instrumentation-http` covers the `http`/`https` clients.
  Node's global `fetch` is undici, which it does not cover; LLM and other
  `fetch` calls are covered by Next's own `fetch <METHOD> <url>` span (kind
  CLIENT), emitted for every `globalThis.fetch` from server code
  (`NEXT_OTEL_FETCH_DISABLED=1` would hide it). `instrumentation-undici` is not
  installed; add it only if a real LLM call is shown to produce no span.
- **Postgres.** `instrumentation-pg` spans for every round trip (Drizzle queries
  and Mastra's storage calls alike, since both share the one pool from
  `lib/db/pool.ts`): `pg.query:<VERB> <db>`, `pg.connect`, plus the
  `db.client.operation.duration`, `db.client.connection.count` and
  `db.client.connection.pending_requests` metrics (the pool metrics come from
  `pg-pool` events). On Azure these are `AppDependencies` rows of type
  `postgresql`; a failed statement is the same row with `success == false` plus
  an `AppExceptions` row whose message names the SQLSTATE
  (`PostgreSQL error … (code: 42501)`) — the first place to look when a boot
  logs a privilege problem (`docs/database.md`, ownership hazard).
- **Runtime metrics** (OTLP path only). `instrumentation-runtime-node`: `nodejs.eventloop.*`
  (utilization, time, delay percentiles) and `v8js.*` (heap sizes, GC duration).
  The metrics reader alone emits nothing; these instruments are what appears.
- **HTTP metrics.** Under the default semantic-convention mode the names are
  `http.server.duration` and `http.client.duration` (milliseconds);
  `OTEL_SEMCONV_STABILITY_OPT_IN=http` switches to the stable
  `http.server.request.duration` / `http.client.request.duration` (seconds).
- **Exceptions** recorded by `recordError()` (including Next request errors) and
  **application events** emitted through the logs API. Both stay content-free by
  the invariant below: an event carries ids, counts and durations only — e.g.
  `quiz.precheck` (`{ verdict, latencyMs, code }`, the quiz pre-check hint,
  `docs/codes.md`), whose classifier failures are reported under the
  `"novedu.area": "quiz-precheck"` attribute and never carry the student's answer.

The baseline is useful signal coverage, not identical Azure and Aspire metric
names, tables, or dashboards. Full prompt/agent tracing and capture of console
output are out of scope.

## PRIVACY INVARIANT — no message/prompt/PII content

**Telemetry must never carry conversation, prompt, or PII content**, on either
backend. What holds this:

- HTTP instrumentation captures **no bodies and no headers** by default (bodies
  have no capture option at all); never opt into `headersToSpanAttributes`.
- `instrumentation-pg`'s `enhancedDatabaseReporting` stays `false`, so **bound
  parameter values are never captured**. Under its default (old semantic
  conventions) mode it does export `db.user`, a password-masked
  `db.connection_string`, and the SQL text as `db.statement`
  (`OTEL_SEMCONV_STABILITY_OPT_IN=database` switches to the stable set with
  `db.query.text` and no user attribute). This is accepted as-is: `db.user` is
  the managed identity's name in production and a developer's own identity
  locally, and every database client in the app (Drizzle, Mastra's Postgres
  store, better-auth's adapter) sends parameterized SQL, so the statement text
  carries `$1`-style placeholders, not data. `lib/telemetry-pg-canary.unit.test.ts`
  asserts that a query with a bound string exports no literal.
- The resource never carries `process.command_args` / `process.owner` (fixed
  detector set above).
- The **one seam where content could leak is `emitEvent()` / `recordError()`** —
  so pass them only metadata: identifiers, names, counts, booleans. Never a
  message, a prompt, or user-entered text. `recordError()` keeps the message of
  a PLAIN `Error` only (prototype exactly `Error.prototype`, an identity check
  that holds in a minified build) — ours or a dependency's, so keep the
  messages you throw static or identifier-only. It withholds the message of
  every subclass (a Drizzle/`pg` query error, an ai-sdk or provider error, a
  `TypeError`) and of any non-Error throw, whose text can embed SQL
  parameters, model output, or response bodies: those export only their type
  (`code ?? name`, or the `typeof` of a non-Error) and their stack frames with
  the `Name: message` header stripped, and the message and span status message
  are the fixed text `[message withheld]`. `onRequestError` passes only `path`
  and `routeType`.
- SDK diagnostics: Novedu installs no diag logger; the SDKs' own console
  diagnostics (opt-in via `OTEL_LOG_LEVEL`) print status and configuration
  messages, not exported payloads.

> Note: a tutor code can appear in the request URL attribute (`AppRequests.Url`
> on Azure, `http.url` / `url.full` elsewhere) — it is an access credential in
> the path. Redaction of that is an open follow-up; no change may broaden the
> captured content.

## Failure and lifecycle behavior

Telemetry is **best effort**. An unavailable receiver, export timeout, queue
overflow, or SDK start failure never prevents startup, database migrations, or
request handling. Export relies on the SDK's bounded batching, queues, timeouts,
and retries; a receiver that comes back later is picked up by later export
attempts with no app action. A start failure leaves telemetry off until restart.

There is **no shutdown or flush handling** on either path. Next's standalone
server owns signal handling (its `SIGINT`/`SIGTERM` listener awaits only Next's
own close and then exits; a competing listener would race it with no ordering
guarantee), and the batch processors export on a five-second schedule anyway.
**The final batch may therefore be lost on exit.** Do not use
`NEXT_MANUAL_SIG_HANDLE`, private Next lifecycle APIs, or a custom server for
telemetry.

## Aspire local setup

The standalone [Aspire dashboard](https://aspire.dev/dashboard/standalone/) is
the reference OTLP receiver for local development and diagnostic sessions outside
Azure. It runs in one container from `compose.telemetry.yaml` (pinned
`mcr.microsoft.com/dotnet/aspire-dashboard` tag, never `latest`) — no Collector,
no AppHost, no .NET SDK. Any OTLP receiver replaces it through configuration
alone, and hosting elsewhere with Prometheus, Grafana, or a vendor backend means
pointing the same variables at an OpenTelemetry Collector that fans out to those
systems.

Defaults are kept: browser-token authentication for the UI (the login URL with
its token is in the container log) and an unsecured OTLP receiver for trusted
local senders. **Never set `ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS`** (it
disables all dashboard authentication). Dashboard settings use the
`ASPIRE_DASHBOARD_*` environment prefix. Both published ports are loopback only.

| Consumer                                  | Destination              |
| ----------------------------------------- | ------------------------ |
| Browser on the host                       | `http://localhost:18888` |
| App running on the host                   | `http://localhost:4318`  |

Host port `4318` maps to the dashboard's OTLP/HTTP port `18890`. The dashboard
accepts OTLP/gRPC, OTLP/HTTP protobuf and OTLP/HTTP JSON; `http/protobuf` is the
SDK default and the documented local transport, so no gRPC port is published.

```bash
# Dashboard only (the app runs on the host with `npm run dev` / `npm run start`)
docker compose -f compose.telemetry.yaml up -d
docker compose -f compose.telemetry.yaml logs aspire | grep "login?t="  # open this URL in the browser
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev
docker compose -f compose.telemetry.yaml down
```

App startup never depends on dashboard readiness. The dashboard keeps telemetry
in memory (default caps of 10,000 logs and traces) and discards it on restart;
this setup is for development and short-term diagnostics — durable storage and
production hosting of a non-Azure backend are out of scope.

## Operating the Azure path

- **Querying:** each stage has its own **workspace-based** App Insights component
  (`appi-novedu-dev` / `appi-novedu-prod`, backed by the shared `log-novedu` Log
  Analytics workspace; `docs/azure-runtime-env.md`), reached with the Novedu
  `az` profile (`docs/azure-runtime-env.md`, "Access"). Query it with the **`App*`
  table names** (`AppRequests`, `AppDependencies`, `AppExceptions`, `AppEvents`, …);
  in the shared workspace, filter by the stage's `_ResourceId`. The classic
  component query API (`az monitor app-insights query -g rg-novedu-<stage> --app
  appi-novedu-<stage>`, lowercase `requests`/`dependencies`/`exceptions`/
  `customEvents`) reads the same data, scoped to one stage.
- **Sampling:** `AppRequests` is sampled and holds one row per SERVER span (see
  above); the `http.server.duration` metric in `AppMetrics` is the unsampled
  request count.
- **The read side in the app:** the teacher-only `/diagnostics` page
  (`docs/diagnostics.md`) queries the LLM calls, failed chat turns and chat-turn
  durations of this resource through the App Insights query API, addressed by the
  `ApplicationId` in the connection string. The app's identity needs **Reader** on
  the resource — `ca-novedu-<stage>` on its own `appi-novedu-<stage>`.

## Tests

`docs/testing.md` lists the telemetry tests: secret-free unit tests over the
resolver, the facade and both initializers with in-memory exporters; three
real-`NodeSDK` tests against an in-process OTLP/HTTP receiver (delivery of all
three signals, a refusing receiver, the pg bound-value canary); the CLI
isolation grep-guard; and the manual acceptance check against Aspire, which is
never part of any suite.
