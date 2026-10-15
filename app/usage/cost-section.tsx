import type { ReactNode } from "react";
import { formatCompact } from "@/components/charts/format";
import { DashboardCard, DataUnavailable, EmptyRange } from "@/components/dashboard-ui";
import { HelpTip } from "@/components/help-tip";
import { estimateCost, UNKNOWN_MODEL, type UnmatchedModel } from "@/lib/usage-cost";
import { fetchOpenRouterModels, priceModels } from "@/lib/usage-cost-lookup";
import { USAGE_RANGE_LABELS, type UsageRange } from "@/lib/usage-range";
import { getScchTokensByModel } from "@/lib/usage-stats-store";
import { CostDonutChart } from "./cost-donut-chart";

// The cost card (docs/dashboard.md, "Cost estimate"): what the SCCH tokens of the
// window would cost at OpenRouter's list prices for the same models. SCCH gives
// them to us for free, so this is a market value, never a bill. The store read
// and OpenRouter's model list run in parallel, then one Hugging Face lookup per
// model; all outside responses are cached for a day. The card has its own
// Suspense boundary, so these lookups never hold up the rest of the page.
// Models that cannot be matched with confidence are left out and named in a
// warning, never priced by a guess. Async server component.

const fetchDate = (d: Date) =>
  d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

function UnmatchedWarning({ models }: { models: UnmatchedModel[] }) {
  return (
    <div className="mt-3 text-warning text-xs" data-testid="usage-cost-unmatched">
      <p className="font-semibold">Not priced, no matching OpenRouter model found:</p>
      <ul className="mt-1 space-y-0.5">
        {models.map((m) => (
          <li key={m.model}>
            {m.model === UNKNOWN_MODEL ? m.model : <code className="font-mono">{m.model}</code>} (
            {formatCompact(m.tokens)} tokens)
          </li>
        ))}
      </ul>
    </div>
  );
}

async function CostBody({ range, now }: { range: UsageRange; now: Date }): Promise<ReactNode> {
  const [rows, openRouter] = await Promise.all([
    getScchTokensByModel({ range, now }),
    fetchOpenRouterModels(),
  ]);
  if (!rows) return <DataUnavailable />;
  if (rows.length === 0) return <EmptyRange>No SCCH usage in this range.</EmptyRange>;
  if (!openRouter) return <DataUnavailable />;

  const prices = await priceModels(
    rows.flatMap((r) => (r.model === null ? [] : [r.model])),
    openRouter,
  );
  const estimate = estimateCost(rows, (model) => prices.get(model));
  const caption = openRouter.fetchedAt
    ? `A rough estimate. Prices from OpenRouter, fetched ${fetchDate(openRouter.fetchedAt)}.`
    : "A rough estimate. Prices from OpenRouter.";

  return (
    <>
      {estimate.pricedTokens > 0 ? (
        <CostDonutChart cost={estimate} rangeLabel={USAGE_RANGE_LABELS[range]} />
      ) : null}
      {estimate.unmatched.length > 0 ? <UnmatchedWarning models={estimate.unmatched} /> : null}
      <p className="mt-3 border-foreground/15 border-t pt-2 text-foreground/60 text-xs">
        {caption}
      </p>
    </>
  );
}

export async function CostSection({ range, now }: { range: UsageRange; now: Date }) {
  return (
    // Sized like one pie card; the other half of the row stays empty.
    <div className="grid gap-4 md:grid-cols-2">
      <DashboardCard
        title="Estimated cost at OpenRouter prices"
        subtitle="SCCH tokens in this range, priced at OpenRouter's list prices for the same models. SCCH provides them for free."
        action={
          <HelpTip label="About this estimate" icon="help">
            These are not real costs: Novedu pays nothing for SCCH tokens. The figure only indicates
            what the same tokens would cost on the open market, at OpenRouter's prices.
          </HelpTip>
        }
        data-testid="usage-cost"
      >
        {await CostBody({ range, now })}
      </DashboardCard>
    </div>
  );
}
