import { formatCount } from "@/components/charts/format";
import { DashboardCard, DataUnavailable } from "@/components/dashboard-ui";
import { type ListColumn, ListTable } from "@/components/data-list";
import type { TokenBucket, TokenSums, UsageRange } from "@/lib/usage-range";
import { getTokenTimeSeries } from "@/lib/usage-stats-store";
import { TokenUsageBarChart } from "./token-usage-bar-chart";

// The token-usage-over-time section: ONE `getTokenTimeSeries` read feeds both the
// (client) stacked bar chart and the (server) data table below it — read once,
// shown twice. The table ends in a Total row summed from the same buckets, and
// its header and Total row stay in place while the bucket rows scroll. Async
// server component behind its own Suspense boundary.

const total = (b: TokenSums) => b.inputNew + b.inputCached + b.output;

/** Column sums over the range's buckets (the table's Total row). */
export function sumBuckets(buckets: TokenBucket[]): TokenSums {
  return buckets.reduce(
    (sum, b) => ({
      inputNew: sum.inputNew + b.inputNew,
      inputCached: sum.inputCached + b.inputCached,
      output: sum.output + b.output,
    }),
    { inputNew: 0, inputCached: 0, output: 0 },
  );
}

function columns(sums: TokenSums): ListColumn<TokenBucket>[] {
  return [
    { header: "Time (UTC)", kind: "time", render: (b) => b.label, footer: "Total" },
    {
      header: "New input",
      kind: "numeric",
      render: (b) => formatCount(b.inputNew),
      footer: formatCount(sums.inputNew),
    },
    {
      header: "Cached input",
      kind: "numeric",
      render: (b) => formatCount(b.inputCached),
      footer: formatCount(sums.inputCached),
    },
    {
      header: "Output",
      kind: "numeric",
      render: (b) => formatCount(b.output),
      footer: formatCount(sums.output),
    },
    {
      header: "Total",
      kind: "numeric",
      render: (b) => formatCount(total(b)),
      footer: formatCount(total(sums)),
    },
  ];
}

export async function TokenSection({ range, now }: { range: UsageRange; now: Date }) {
  const data = await getTokenTimeSeries({ range, now });
  return (
    <DashboardCard
      title="Token usage over time"
      subtitle="Cached input, new input, and output tokens per bucket (UTC)."
    >
      {data ? (
        <>
          <TokenUsageBarChart data={data} />
          <ListTable
            rows={data}
            getRowKey={(b) => b.key}
            columns={columns(sumBuckets(data))}
            sticky
            className="mt-4 max-h-80"
          />
        </>
      ) : (
        <DataUnavailable />
      )}
    </DashboardCard>
  );
}
