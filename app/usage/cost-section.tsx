import type { ReactNode } from "react";
import { formatCompact } from "@/components/charts/format";
import { DashboardCard, DataUnavailable, EmptyRange } from "@/components/dashboard-ui";
import { HelpTip } from "@/components/help-tip";
import {
  estimateCost,
  type ModelPrice,
  type ModelTokens,
  openRouterSpendPriceOf,
  UNKNOWN_MODEL,
  type UnmatchedModel,
} from "@/lib/usage-cost";
import { fetchOpenRouterModels, type OpenRouterModels, priceModels } from "@/lib/usage-cost-lookup";
import { USAGE_RANGE_LABELS, type UsageRange } from "@/lib/usage-range";
import { getModelTokensForProvider } from "@/lib/usage-stats-store";
import { CostDonutChart } from "./cost-donut-chart";

// The two cost cards (docs/dashboard.md, "Cost estimate"), both at OpenRouter's
// list prices and both ballparks:
// - `CostSection`: what the SCCH tokens of the window would cost for the same
//   models. SCCH gives them to us for free, so this is a market value, never a
//   bill. One Hugging Face lookup per model maps an SCCH id to its original.
// - `SpendSection`: what the OpenRouter tokens of the window cost — billed for
//   real. The recorded id is OpenRouter's own, so no Hugging Face step.
// The store read and OpenRouter's model list run in parallel; all outside
// responses are cached for a day. Each card has its own Suspense boundary, so the
// lookups never hold up the rest of the page. Models that cannot be matched with
// confidence are left out and named in a warning, never priced by a guess. Async
// server components.

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

/** The card body shared by both cards, once the rows and the price list are in. */
function CostBody({
  rows,
  openRouter,
  priceOf,
  range,
}: {
  rows: ModelTokens[];
  openRouter: OpenRouterModels;
  priceOf: (model: string) => ModelPrice | undefined;
  range: UsageRange;
}) {
  const estimate = estimateCost(rows, priceOf);
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

async function ScchCostBody({ range, now }: { range: UsageRange; now: Date }): Promise<ReactNode> {
  const [rows, openRouter] = await Promise.all([
    getModelTokensForProvider({ range, now, provider: "SCCH" }),
    fetchOpenRouterModels(),
  ]);
  if (!rows) return <DataUnavailable />;
  if (rows.length === 0) return <EmptyRange>No SCCH usage in this range.</EmptyRange>;
  if (!openRouter) return <DataUnavailable />;

  const prices = await priceModels(
    rows.flatMap((r) => (r.model === null ? [] : [r.model])),
    openRouter,
  );
  return (
    <CostBody
      rows={rows}
      openRouter={openRouter}
      priceOf={(model) => prices.get(model)}
      range={range}
    />
  );
}

async function SpendBody({ range, now }: { range: UsageRange; now: Date }): Promise<ReactNode> {
  const [rows, openRouter] = await Promise.all([
    getModelTokensForProvider({ range, now, provider: "OpenRouter" }),
    fetchOpenRouterModels(),
  ]);
  if (!rows) return <DataUnavailable />;
  if (rows.length === 0) return <EmptyRange>No OpenRouter usage in this range.</EmptyRange>;
  if (!openRouter) return <DataUnavailable />;

  return (
    <CostBody
      rows={rows}
      openRouter={openRouter}
      priceOf={(model) => openRouterSpendPriceOf(openRouter.json, model)}
      range={range}
    />
  );
}

export const COST_TITLE = "Estimated cost at OpenRouter prices";
export const SPEND_TITLE = "OpenRouter spend (estimate)";

export async function CostSection({ range, now }: { range: UsageRange; now: Date }) {
  return (
    <DashboardCard
      title={COST_TITLE}
      subtitle="SCCH tokens in this range, priced at OpenRouter's list prices for the same models. SCCH provides them for free."
      action={
        <HelpTip label="About this estimate" icon="help">
          These are not real costs: Novedu pays nothing for SCCH tokens. The figure only indicates
          what the same tokens would cost on the open market, at OpenRouter's prices.
        </HelpTip>
      }
      data-testid="usage-cost"
    >
      {await ScchCostBody({ range, now })}
    </DashboardCard>
  );
}

export async function SpendSection({ range, now }: { range: UsageRange; now: Date }) {
  return (
    <DashboardCard
      title={SPEND_TITLE}
      subtitle="OpenRouter tokens in this range, priced at OpenRouter's list prices. These tokens are billed."
      action={
        <HelpTip label="About the spend estimate" icon="help">
          Novedu's own token counts times OpenRouter's list prices, so a ballpark rather than the
          bill. New input is priced at the model's cache-write rate where it lists one, because
          almost all new input to these models is written to the provider's cache. The bill can
          differ, for example by OpenRouter's fee or the provider's own prices.
        </HelpTip>
      }
      data-testid="usage-spend"
    >
      {await SpendBody({ range, now })}
    </DashboardCard>
  );
}
