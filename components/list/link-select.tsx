"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// A filter value picked from a long list (a school's teachers as owners), where
// pills would not fit: a select whose options carry the URL each choice leads to,
// navigating on change — the dropdown twin of `FilterPill`.
export function LinkSelect({
  label,
  placeholder,
  options,
  value,
  className,
}: {
  label: string;
  /** The empty first option, shown while none of `options` is the active value. */
  placeholder: string;
  options: { value: string; label: string; href: string }[];
  value: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const active = options.some((option) => option.value === value);
  return (
    <Select
      aria-label={label}
      className={cn("h-8", active && "border-foreground", className)}
      value={active ? value : ""}
      disabled={pending}
      onChange={(event) => {
        const option = options.find((o) => o.value === event.target.value);
        if (option) startTransition(() => router.push(option.href));
      }}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}
