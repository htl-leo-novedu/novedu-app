import { cookies } from "next/headers";

// The Classic/New switch between the two list engines (see
// `docs/filtered-lists.md`, "The new list engine"). A per-device cookie the list
// page reads on the server, so it renders the chosen engine with no flash; the
// switch's server action (`lib/list-engine-actions.ts`) writes it. It exists only
// while both engines do — removing the classic engine removes this file.

export const LIST_ENGINE_COOKIE = "novedu-list-engine";

export const LIST_ENGINES = ["classic", "new"] as const;
export type ListEngine = (typeof LIST_ENGINES)[number];

/** What a device without the cookie gets. */
export const DEFAULT_LIST_ENGINE: ListEngine = "classic";

/** The list routes that have both engines — where the switch may land. */
export const LIST_ENGINE_ROUTES = ["/codes"] as const;

export function parseListEngine(value: unknown): ListEngine {
  return LIST_ENGINES.find((engine) => engine === value) ?? DEFAULT_LIST_ENGINE;
}

/** The engine this request's device chose. */
export async function getListEngine(): Promise<ListEngine> {
  return parseListEngine((await cookies()).get(LIST_ENGINE_COOKIE)?.value);
}
