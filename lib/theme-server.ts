import { cookies } from "next/headers";
import { parseTheme, THEME_COOKIE, type Theme } from "@/lib/theme";

// The server side of the colour theme (lib/theme.ts): which theme this
// request's device chose. The root layout renders it as `<html data-theme>`;
// the Settings page preselects it.

export async function getTheme(): Promise<Theme> {
  return parseTheme((await cookies()).get(THEME_COOKIE)?.value);
}
