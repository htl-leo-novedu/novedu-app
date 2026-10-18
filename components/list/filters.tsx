import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { META_LABEL } from "@/components/ui/meta-label";

// The new list engine's server-safe filter pieces (see `docs/filtered-lists.md`,
// "The new list engine"): a filter group of the panel, and the summary line
// under the toolbar that says which filters the list applies.
//
// A group knows nothing about where it sits: the panel (`FilterPanel`) is only
// a container, so moving the groups into a side panel later is a container swap.

export function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset's legend fights the flex layout
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-2">
      <p className={META_LABEL} aria-hidden="true">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export interface FilterSummaryPart {
  label: string;
  value: string;
}

const Dot = () => (
  <span aria-hidden="true" className="mx-2 text-foreground/40">
    ·
  </span>
);

/**
 * The row count and the filters the list applies, in the list's fixed order —
 * built from the same parsed URL the query uses, so the line can never disagree
 * with the rows. "Clear all" (only while something is filtered) is a link.
 */
export function FilterSummary({
  count,
  parts,
  clearHref,
}: {
  /** The row count in words, e.g. "12 codes". */
  count: string;
  parts: FilterSummaryPart[];
  clearHref?: string;
}) {
  return (
    <p className="w-0 min-w-full text-foreground/70 text-sm">
      <span className="font-semibold text-foreground">{count}</span>
      {parts.map((part) => (
        <Fragment key={part.label}>
          <Dot />
          <span className="text-foreground/55">{part.label}:</span> {part.value}
        </Fragment>
      ))}
      {clearHref ? (
        <>
          <Dot />
          <Link href={clearHref} className="text-foreground/70 underline hover:text-foreground">
            Clear all
          </Link>
        </>
      ) : null}
    </p>
  );
}
