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
];

export const DEFAULT_CODE_VIEW = CODE_VIEWS[0] as CodeView;

/** Views still to be built: the picker lists them greyed out as "Coming soon". */
export const PLANNED_CODE_VIEWS = [
  { label: "Compact", description: "Just the note, the code and the status." },
  { label: "Models & cost", description: "Which model each code runs on and what it costs." },
];
