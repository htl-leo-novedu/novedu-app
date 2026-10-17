import { Suspense } from "react";
import {
  BreakdownSkeleton,
  ChartSkeleton,
  KpiSkeleton,
  ModelsSkeleton,
} from "@/components/dashboard-skeletons";
import { Main, PageBody } from "@/components/page-main";
import { requireTeacherPage } from "@/components/require-teacher-page";
import { parseRange } from "@/lib/usage-range";
import { BreakdownSection } from "./breakdown-section";
import { COST_TITLE, CostSection, SPEND_TITLE, SpendSection } from "./cost-section";
import { KpiSection } from "./kpi-section";
import { ModelsSection } from "./models-section";
import { RangeTabs } from "./range-tabs";
import { TokenSection } from "./token-section";

// Teacher-only usage dashboard (docs/dashboard.md). The shell + range tabs render
// immediately; each data section is its own async server component behind a
// Suspense boundary, so they stream in independently (a slow query never blocks the
// others). The Suspense boundaries are keyed by range so switching the filter shows
// the skeletons again while the new window streams. "Effective" teacher: a teacher
// in student mode is denied like a student. All windows/labels are UTC.
export const dynamic = "force-dynamic";

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const denied = await requireTeacherPage();
  if (denied) return denied;

  const range = parseRange((await searchParams).range);
  // One snapshot shared by every section, so the KPI, chart, and pies all describe
  // the same window.
  const now = new Date();

  return (
    <Main>
      <PageBody className="gap-6">
        <RangeTabs />
        <Suspense key={`kpi-${range}`} fallback={<KpiSkeleton />}>
          <KpiSection range={range} now={now} />
        </Suspense>
        <Suspense
          key={`tokens-${range}`}
          fallback={<ChartSkeleton title="Token usage over time" />}
        >
          <TokenSection range={range} now={now} />
        </Suspense>
        <Suspense key={`breakdown-${range}`} fallback={<BreakdownSkeleton />}>
          <BreakdownSection range={range} now={now} />
        </Suspense>
        <Suspense key={`models-${range}`} fallback={<ModelsSkeleton />}>
          <ModelsSection range={range} now={now} />
        </Suspense>
        {/* The two cost cards share a row, each sized like one pie card: the real
            OpenRouter spend first, the SCCH market value beside it. */}
        <div className="grid gap-4 md:grid-cols-2">
          <Suspense key={`spend-${range}`} fallback={<ChartSkeleton title={SPEND_TITLE} />}>
            <SpendSection range={range} now={now} />
          </Suspense>
          <Suspense key={`cost-${range}`} fallback={<ChartSkeleton title={COST_TITLE} />}>
            <CostSection range={range} now={now} />
          </Suspense>
        </div>
      </PageBody>
    </Main>
  );
}
