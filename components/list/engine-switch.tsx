import { SEGMENTED_NAV, segmentedItemVariants } from "@/components/ui/segmented-nav";
import type { ListEngine } from "@/lib/list-engine";
import { switchListEngineAction } from "@/lib/list-engine-actions";
import { cn } from "@/lib/utils";

// The Classic/New switch both list engines show (lib/list-engine.ts). A plain
// form posting to a server action, so it works before hydration; the current
// engine's button submits nothing.
export function EngineSwitch({ list, current }: { list: string; current: ListEngine }) {
  return (
    <form
      action={switchListEngineAction}
      aria-label="List version"
      title="Switch between the classic and the new list"
      className={cn(SEGMENTED_NAV, "flex-nowrap p-0.5")}
    >
      <input type="hidden" name="list" value={list} />
      {(["classic", "new"] as const).map((engine) => (
        <button
          key={engine}
          type={engine === current ? "button" : "submit"}
          name="engine"
          value={engine}
          aria-pressed={engine === current}
          className={cn(segmentedItemVariants({ active: engine === current }), "py-1")}
        >
          {engine === "classic" ? "Classic" : "New"}
        </button>
      ))}
    </form>
  );
}
