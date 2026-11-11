"use client";

import { useId, useState } from "react";
import { FieldError } from "@/components/ui/field";
import { SEGMENTED_NAV, segmentedItemVariants } from "@/components/ui/segmented-nav";
import { applyTheme, type Theme } from "@/lib/theme";
import { setThemeAction } from "@/lib/theme-actions";
import { cn } from "@/lib/utils";

// The Settings page's "Appearance" section (docs/home.md → Settings page): the
// colour theme of this device (lib/theme.ts). Native radios styled as a
// segmented row, so arrow keys and the radio-group semantics come for free. A
// pick applies at once and is then stored in the device's cookie; when storing
// fails the pick still holds until the page is reloaded, and the section says so.

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Same as device" },
];

const SAVE_FAILED =
  "Your choice could not be saved right now. It applies until you reload the page.";

export function ThemeSettings({ initialTheme }: { initialTheme: Theme }) {
  const [theme, setTheme] = useState(initialTheme);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  const hintId = useId();

  async function choose(next: Theme) {
    setTheme(next);
    setError(null);
    applyTheme(next);
    const saved = await setThemeAction(next).catch(() => null);
    if (!saved?.ok) setError(SAVE_FAILED);
  }

  return (
    <div className="flex flex-col gap-3">
      <fieldset aria-describedby={hintId} className="flex flex-col gap-2">
        <legend className="sr-only">Colour theme</legend>
        <div className={cn(SEGMENTED_NAV, "self-start")}>
          {OPTIONS.map((option) => (
            <label
              key={option.value}
              className={cn(
                segmentedItemVariants({ active: theme === option.value }),
                "cursor-pointer has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-2",
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={theme === option.value}
                onChange={() => choose(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      <p id={hintId} className="text-foreground/65 text-sm">
        Saved on this device. “Same as device” follows your system’s light or dark setting.
      </p>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}
