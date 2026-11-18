import { formatCount } from "@/components/charts/format";
import { DashboardCard, DataUnavailable } from "@/components/dashboard-ui";
import { type ListColumn, ListTable } from "@/components/data-list";
import {
  type Grain,
  grainOf,
  type TokenBucket,
  type TokenSums,
  type UsageRange,
} from "@/lib/usage-range";
import { getTokenTimeSeries } from "@/lib/usage-stats-store";
import { HourHeader, LocalHour } from "./local-hour";
import { TokenUsageBarChart } from "./token-usage-bar-chart";

// The token-usage-over-time section: ONE `getTokenTimeSeries` read feeds both the
// (client) stacked bar chart and the (server) data table below it — read once,
// shown twice. The table lists the newest bucket first (the chart keeps the usual
// oldest → newest time axis) and ends in a Total row summed from the same buckets;
// its header and Total row stay in place while the bucket rows scroll. Hourly
// buckets are labelled in the viewer's time zone by the browser (`local-hour.tsx`),
// day and month buckets in UTC. Async server component behind its own Suspense
// boundary.

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

/** The first column: the bucket, labelled for the range's grain. */
function timeColumn(grain: Grain): ListColumn<TokenBucket> {
  if (grain === "hour") {
    return {
      header: <HourHeader />,
      kind: "time",
      render: (b) => <LocalHour bucketKey={b.key} utcLabel={b.label} />,
      footer: "Total",
    };
  }
  return {
    header: grain === "day" ? "Date (UTC)" : "Month (UTC)",
    kind: "time",
    render: (b) => b.label,
    footer: "Total",
  };
}

const SUBTITLE: Record<Grain, string> = {
  hour: "Cached input, new input, and output tokens per hour (your local time).",
  day: "Cached input, new input, and output tokens per day (UTC).",
  month: "Cached input, new input, and output tokens per month (UTC).",
};

function columns(grain: Grain, sums: TokenSums): ListColumn<TokenBucket>[] {
  return [
    timeColumn(grain),
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
  const grain = grainOf(range);
  return (
    <DashboardCard title="Token usage over time" subtitle={SUBTITLE[grain]}>
      {data ? (
        <>
          <TokenUsageBarChart data={data} grain={grain} />
          <ListTable
            // Newest first, so the current bucket needs no scrolling.
            rows={[...data].reverse()}
            getRowKey={(b) => b.key}
            columns={columns(grain, sumBuckets(data))}
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
