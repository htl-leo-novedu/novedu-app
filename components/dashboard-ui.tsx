import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared chrome for the sections of the chart pages (the usage dashboard, the LLM
// diagnostics page). Pure presentation (server-safe), styled with the app's
// hairline-card recipe + foreground ramp (docs/styling.md); folds into shadcn's
// Card when that lands.

export const DASHBOARD_CARD = "rounded-lg border border-foreground/15 bg-card p-4";

export function DashboardCard({
  title,
  subtitle,
  action,
  className,
  children,
  ...props
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Top-right corner of the header, e.g. a `HelpTip`. */
  action?: ReactNode;
} & ComponentProps<"section">) {
  return (
    <section className={cn(DASHBOARD_CARD, className)} {...props}>
      <header className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold text-sm">{title}</h2>
          {subtitle ? <p className="text-foreground/60 text-xs">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** The centered, muted placeholder both the error and empty states render. */
function DashboardNotice({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-foreground/60 text-sm">{children}</p>;
}

/** Shown in place of a chart/table when its query failed (the store never throws). */
export function DataUnavailable() {
  return (
    <DashboardNotice>
      This data could not be loaded right now. Try again in a moment.
    </DashboardNotice>
  );
}

/** Shown when a query succeeded but there is nothing in the window. */
export function EmptyRange({ children }: { children: ReactNode }) {
  return <DashboardNotice>{children}</DashboardNotice>;
}
