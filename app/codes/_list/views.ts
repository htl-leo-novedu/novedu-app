import type { Sort } from "@/lib/db/sorting";
import type { CodeColumnId } from "./columns";

// The `/codes` list's views (see `docs/filtered-lists.md`, "The new list
// engine"): named column sets for a use case, defined here in code. A view
// decides which columns show, so it also decides which sorts are allowed and
// which page columns get computed at all.

export interface CodeView {
  id: string;
  label: string;
  /** One line in the view picker saying what the view is for. */
  description: string;
  columns: CodeColumnId[];
  /** The order without a `?sort=`; `undefined` = the store's newest first. */
  defaultSort?: Sort;
  /** That default order in words, for the folded phone list's header. */
  defaultSortLabel: string;
}

export const CODE_VIEWS: CodeView[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Your codes with their availability window and how often they were used.",
    columns: ["kind", "note", "owner", "from", "until", "interactions"],
    defaultSortLabel: "Newest first",
  },
  {
    id: "models",
    label: "Models & usage",
    description:
      "Which model each code runs on and how many OpenRouter tokens it was billed for in the last 30 days.",
    columns: ["kind", "note", "model", "source", "interactions", "tokens"],
    defaultSort: { key: "tokens", dir: "desc" },
    defaultSortLabel: "Most billed tokens first",
  },
];

export const DEFAULT_CODE_VIEW = CODE_VIEWS[0] as CodeView;

/** The view `?view=` names; an absent or unknown id is the default view. */
export function pickCodeView(id: string): CodeView {
  return CODE_VIEWS.find((view) => view.id === id) ?? DEFAULT_CODE_VIEW;
}
