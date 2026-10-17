import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// The bordered-field recipe, shared by text-like <input> elements and <select>.
// Checkboxes/radios stay native (they follow the forced light color-scheme).
export const inputVariants = cva(
  "h-9 rounded-full border border-foreground/25 bg-background px-3 text-foreground text-sm placeholder:text-foreground/40 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
);

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(inputVariants(), className)} {...props} />;
}

// The native arrow sits flush against the rounded right edge (Chrome ignores
// padding for it), so a select draws its own chevron: two `currentColor`
// gradient triangles inside a wider right padding.
const SELECT_CHEVRON =
  "appearance-none pr-9 bg-no-repeat bg-[image:linear-gradient(45deg,transparent_50%,currentColor_50%),linear-gradient(135deg,currentColor_50%,transparent_50%)] bg-[position:calc(100%-1.1rem)_55%,calc(100%-0.8rem)_55%] bg-[size:0.3rem_0.3rem]";

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(inputVariants(), SELECT_CHEVRON, className)} {...props} />;
}
