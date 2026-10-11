import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Small status/kind pill used in list cells (code module, file kind, window
// status, health probes). Tones are a fixed palette; callers map their domain
// (file kind, window status, …) onto a tone. `solid` renders the saturated
// filled pill (module/kind identity); the default soft tint is for statuses.
// `caps` renders the label as small uppercase. An icon child sits before the
// label via the flex gap.
export const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-px font-semibold text-xs",
  {
    variants: {
      tone: {
        neutral: "bg-foreground/10 text-foreground/80",
        red: "bg-red-600/15 text-red-800",
        blue: "bg-blue-600/15 text-blue-800",
        green: "bg-emerald-600/15 text-emerald-800",
        orange: "bg-orange-500/20 text-orange-800",
        purple: "bg-purple-500/20 text-purple-800",
        teal: "bg-teal-600/15 text-teal-800",
        rose: "bg-rose-600/15 text-rose-800",
      },
      solid: {
        true: "text-white",
        false: "",
      },
      caps: {
        true: "uppercase tracking-wide",
        false: "",
      },
    },
    // With `solid`, the tone's tinted background/text are overridden by the
    // filled recipe (cn() below resolves the conflict in favor of these).
    compoundVariants: [
      { solid: true, tone: "neutral", class: "bg-foreground/75 text-background" },
      { solid: true, tone: "red", class: "bg-red-700" },
      { solid: true, tone: "blue", class: "bg-blue-800" },
      { solid: true, tone: "green", class: "bg-green-700" },
      { solid: true, tone: "orange", class: "bg-amber-700" },
      { solid: true, tone: "purple", class: "bg-purple-700" },
      { solid: true, tone: "teal", class: "bg-teal-700" },
      { solid: true, tone: "rose", class: "bg-rose-700" },
    ],
    defaultVariants: { tone: "neutral", caps: false, solid: false },
  },
);

export function Badge({
  className,
  tone,
  caps,
  solid,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone, caps, solid }), className)} {...props} />;
}
