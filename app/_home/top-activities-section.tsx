import Link from "next/link";
import { formatCount } from "@/components/charts/format";
import { DataUnavailable } from "@/components/dashboard-ui";
import { HelpTip } from "@/components/help-tip";
import { ModuleBadge } from "@/components/module-badge";
import { buttonVariants } from "@/components/ui/button";
import { getTeacherHome } from "@/lib/home-data";
import { cn } from "@/lib/utils";
import {
  HOME_CAPTION,
  HOME_CARD,
  HOME_CARD_PAD,
  HOME_MUTED,
  HOME_SECTION_HEAD,
  HOME_SECTION_TITLE,
} from "./home-ui";
import { Meter } from "./meter";

// Top activities: the teacher's five codes with the most interactions in the
// last 30 days, with the share outside school hours. A table from `sm` up; on
// phones each row folds into a two-line entry (the head is kept for screen
// readers).

const TH =
  "whitespace-nowrap border-foreground/15 border-b px-3 pb-2 text-left font-semibold text-foreground/65 text-xs uppercase tracking-wide first:pl-0 last:pr-0";
const TD =
  "border-foreground/8 px-3 py-2.5 align-middle first:pl-0 last:pr-0 max-sm:border-0 max-sm:p-0 sm:border-b";

export async function TopActivitiesSection({ userId }: { userId: string }) {
  const { hasCodes, top } = await getTeacherHome(userId);
  if (hasCodes === false) return null;
  let body: React.ReactNode;
  if (!top) {
    body = <DataUnavailable />;
  } else if (top.length === 0) {
    body = <p className={HOME_MUTED}>No activity in the last 30 days.</p>;
  } else {
    body = (
      <table className="w-full border-collapse max-sm:block">
        <thead className="max-sm:sr-only">
          <tr>
            <th scope="col" className={cn(TH, "w-7")}>
              <span className="sr-only">Rank</span>
              <span aria-hidden="true">#</span>
            </th>
            <th scope="col" className={TH}>
              Activity
            </th>
            <th scope="col" className={TH}>
              Kind
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              Interactions
            </th>
            <th scope="col" className={cn(TH, "text-right")}>
              <span className="inline-flex items-center gap-1">
                Outside school hours
                <HelpTip label="What counts as outside school hours">
                  The share of this activity's interactions on weekends, or Monday to Friday before
                  8:00 or from 17:00 (Vienna time). Counted by whole hours; school holidays are not
                  taken into account.
                </HelpTip>
              </span>
            </th>
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {top.map((activity, i) => (
            <tr
              key={activity.code}
              className="max-sm:grid max-sm:grid-cols-[1.5rem_minmax(0,1fr)_auto] max-sm:gap-x-2.5 max-sm:gap-y-0.5 max-sm:border-foreground/8 max-sm:border-b max-sm:py-2.5 max-sm:last:border-b-0 sm:[&:last-child>td]:border-b-0"
            >
              <td className={cn(TD, "text-foreground/65 tabular-nums max-sm:row-span-3")}>
                {i + 1}
              </td>
              <td className={cn(TD, "min-w-0 max-sm:col-start-2 max-sm:row-start-1")}>
                <Link
                  href={`/codes/${encodeURIComponent(activity.code)}`}
                  className="block font-semibold text-sm no-underline hover:underline hover:underline-offset-3"
                >
                  {activity.label}
                </Link>
                <span className="block font-mono text-foreground/65 text-xs tracking-wide">
                  {activity.code}
                </span>
              </td>
              <td
                className={cn(TD, "max-sm:col-start-3 max-sm:row-start-1 max-sm:justify-self-end")}
              >
                <ModuleBadge module={activity.module} />
              </td>
              <td
                className={cn(
                  TD,
                  "font-bold tabular-nums max-sm:col-span-2 max-sm:col-start-2 max-sm:font-semibold max-sm:text-sm sm:text-right",
                )}
              >
                {formatCount(activity.interactions)}
                <span className="font-normal text-foreground/65 sm:sr-only"> interactions</span>
              </td>
              <td
                className={cn(
                  TD,
                  "tabular-nums max-sm:col-span-2 max-sm:col-start-2 max-sm:text-sm sm:text-right",
                )}
              >
                {/* Phones: one line of flowing text; the percent never splits. */}
                <span className="items-center gap-2.5 max-sm:inline sm:inline-flex">
                  <span className="whitespace-nowrap">{activity.outsidePercent} %</span>
                  <span className="text-foreground/65 sm:sr-only"> outside school hours</span>
                  <Meter
                    aria-hidden="true"
                    value={activity.outsidePercent / 100}
                    fillClassName="bg-chart-1"
                    className="h-1.5 w-18 max-sm:hidden"
                  />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <section aria-labelledby="home-top" className={cn(HOME_CARD, HOME_CARD_PAD)}>
      <div className={HOME_SECTION_HEAD}>
        <h2 id="home-top" className={HOME_SECTION_TITLE}>
          Top activities
        </h2>
        <span className={HOME_CAPTION}>Most interactions in the last 30 days</span>
      </div>
      {body}
      <div className="mt-3.5 flex flex-wrap justify-between gap-x-4 gap-y-1.5 border-foreground/15 border-t pt-3">
        <span className={HOME_CAPTION}>
          Interactions = chat messages, quiz answers, writing saves and coding requests. Your own
          test runs count too.
          <span className="sm:hidden">
            {" "}
            Outside school hours: weekends, or Monday to Friday before 8:00 or from 17:00.
          </span>
        </span>
        <Link href="/usage" className={cn(buttonVariants({ variant: "link" }), "text-sm")}>
          Usage dashboard
        </Link>
      </div>
    </section>
  );
}

export function TopActivitiesSkeleton() {
  return <div className={cn(HOME_CARD, "h-80")} aria-hidden="true" />;
}
