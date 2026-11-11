"use server";

import { cookies } from "next/headers";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

// The Settings page's Appearance choice (lib/theme.ts). Ungated on purpose: it
// only stores a display preference for this device — no user id, no database.
// An unknown value is stored as the default. No type re-exports here: a
// `"use server"` module may export async functions only.

export async function setThemeAction(theme: unknown): Promise<{ ok: true }> {
  (await cookies()).set(THEME_COOKIE, parseTheme(theme), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return { ok: true };
}
