import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { lastPage, type PagedResult, type ParamRecord, pageHref } from "@/lib/db/paging";
import { cn } from "@/lib/utils";

// The new list engine's pager: "Showing 21–40 of 137" plus previous/next links
// (plain links, so paging works without JS). Hrefs derive from the EFFECTIVE,
// clamped page in `result`, never from the URL. Same behaviour as the classic
// pager in `components/data-list.tsx`; the copy ends with the classic engine.

const STEP = buttonVariants({ variant: "outline", size: "sm" });

function Step({ href, label }: { href: string | undefined; label: string }) {
  // The unavailable end stays in place as a dimmed span, so the row never shifts.
  return href ? (
    <Link href={href} className={STEP}>
      {label}
    </Link>
  ) : (
    <span aria-disabled="true" className={cn(STEP, "pointer-events-none opacity-50")}>
      {label}
    </span>
  );
}

export function ListPager({
  pathname,
  params,
  result,
  rowCount,
}: {
  pathname: string;
  params: ParamRecord;
  result: Pick<PagedResult<unknown>, "page" | "pageSize" | "total">;
  rowCount: number;
}) {
  const { page, pageSize, total } = result;
  // COUNT and rows are separate queries, so a concurrent delete can leave a
  // total with no rows: no pager then, rather than "Showing 21–20 of 137".
  if (total === 0 || rowCount === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(from + rowCount - 1, total);
  return (
    <nav
      aria-label="Pagination"
      className="flex w-0 min-w-full flex-wrap items-center justify-between gap-3 text-sm max-md:pb-16"
    >
      <p className="text-foreground/70">
        Showing {from}–{to} of {total}
      </p>
      {total > pageSize ? (
        <div className="flex items-center gap-2">
          <Step
            href={page > 1 ? pageHref(pathname, params, page - 1, pageSize) : undefined}
            label="‹ Previous"
          />
          <Step
            href={
              page < lastPage(total, pageSize)
                ? pageHref(pathname, params, page + 1, pageSize)
                : undefined
            }
            label="Next ›"
          />
        </div>
      ) : null}
    </nav>
  );
}
