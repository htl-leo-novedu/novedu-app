import type { CodeColumnId } from "./columns";

// The `/codes` list's views (see `docs/filtered-lists.md`, "The new list
// engine"): named column sets for a use case, defined here in code. A view
// decides which columns show, so it also decides which sorts are allowed and
// which page columns get computed at all. Unsorted, every view lists the newest
// codes first (the store's default order).

export interface CodeView {
  id: string;
  label: string;
  /** One line in the view picker saying what the view is for. */
  description: string;
  columns: CodeColumnId[];
}

export const CODE_VIEWS: CodeView[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Your codes with their availability window and how often they were used.",
    columns: ["kind", "note", "owner", "from", "until", "interactions"],
  },
  {
    id: "models",
    label: "Models",
    description:
      "Which model each code runs on: its activity YAML's, and the code's override that replaces it.",
    columns: ["kind", "note", "yamlModel", "override"],
  },
];

export const DEFAULT_CODE_VIEW = CODE_VIEWS[0] as CodeView;

/** The view `?view=` names; an absent or unknown id is the default view. */
export function pickCodeView(id: string): CodeView {
  return CODE_VIEWS.find((view) => view.id === id) ?? DEFAULT_CODE_VIEW;
}
