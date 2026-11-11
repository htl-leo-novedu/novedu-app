import type { ReactNode } from "react";
import { DashboardCard, EmptyRange } from "@/components/dashboard-ui";
import type { DiagnosticsFailure, SectionState } from "@/lib/diagnostics-shape";
import type { TelemetryMode } from "@/lib/telemetry-mode";
import { cn } from "@/lib/utils";

// Shared chrome of the diagnostics page (docs/diagnostics.md). Pure presentation,
// server-safe; the card recipe is the usage dashboard's. Every data card carries
// `data-testid` + `data-state` (+ `data-failure`), which the e2e specs wait on.

export type CardState = "ok" | "empty" | "unavailable";

export function SectionCard({
  testId,
  title,
  subtitle,
  state,
  failure,
  children,
}: {
  testId: string;
  title: string;
  subtitle?: ReactNode;
  state: CardState;
  failure?: DiagnosticsFailure;
  children: ReactNode;
}) {
  return (
    <DashboardCard
      title={title}
      subtitle={subtitle}
      data-testid={testId}
      data-state={state}
      data-failure={failure}
    >
      {children}
    </DashboardCard>
  );
}

const UNAVAILABLE_COPY: Record<DiagnosticsFailure, string> = {
  credential:
    "Unavailable — the server could not obtain an Entra token to read Application Insights.",
  forbidden:
    "Unavailable — the server's identity cannot read Application Insights (missing Reader role?)",
  timeout: "Unavailable — the query timed out; try a shorter range.",
  error: "Unavailable — this data could not be loaded right now.",
  "not-configured": "Unavailable — Application Insights is not configured on this server.",
};

export function Unavailable({ failure }: { failure: DiagnosticsFailure }) {
  return (
    <p className="py-8 text-center text-foreground/60 text-sm" role="status">
      {UNAVAILABLE_COPY[failure]}
    </p>
  );
}

/**
 * Renders a section's body for its state: the data view, the empty copy, or the
 * unavailable copy — inside a card that exposes the state to the e2e specs.
 */
export function StateCard<T>({
  testId,
  title,
  subtitle,
  section,
  empty,
  children,
}: {
  testId: string;
  title: string;
  subtitle?: ReactNode;
  section: SectionState<T>;
  empty: ReactNode;
  children: (data: T) => ReactNode;
}) {
  return (
    <SectionCard
      testId={testId}
      title={title}
      subtitle={subtitle}
      state={section.state}
      failure={section.state === "unavailable" ? section.failure : undefined}
    >
      {section.state === "ok" ? children(section.data) : null}
      {section.state === "empty" ? <EmptyRange>{empty}</EmptyRange> : null}
      {section.state === "unavailable" ? <Unavailable failure={section.failure} /> : null}
    </SectionCard>
  );
}

const BANNER = "rounded-lg border px-4 py-3 text-sm";

export function NotConfiguredCard() {
  return (
    <SectionCard testId="diagnostics-not-configured" title="Not configured" state="unavailable">
      <p className="text-foreground/70 text-sm">
        This server has no Application Insights resource to read from: its{" "}
        <code>APPLICATIONINSIGHTS_CONNECTION_STRING</code> is not set or carries no{" "}
        <code>ApplicationId</code>.
      </p>
    </SectionCard>
  );
}

export function TelemetryModeBanner({ mode }: { mode: TelemetryMode }) {
  return (
    <p
      className={cn(
        BANNER,
        "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
      )}
      data-testid="diagnostics-telemetry-banner"
    >
      This server does not send its telemetry to Application Insights right now (mode:{" "}
      <strong>{mode}</strong>), so its own recent data may be missing from these charts.
    </p>
  );
}

export function RangeNotice({ children }: { children: ReactNode }) {
  return (
    <p className={cn(BANNER, "border-foreground/15 bg-card")} role="status">
      {children}
    </p>
  );
}

export function DelayHint() {
  return (
    <p className="text-foreground/60 text-xs">
      Telemetry arrives with a delay of a few minutes; the last bin is partial. Counts are estimates
      from sampled telemetry. Times are shown in your local time zone.
    </p>
  );
}
