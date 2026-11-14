"use client";

import { useSelectedLayoutSegment } from "next/navigation";
import type { ReactNode } from "react";

// Routes that render WITHOUT the app chrome (the status bar with its burger menu
// and user menu). Sign-in has no navigation to offer and no account to show, and
// /device is a single approval decision reached from a link the CLI prints —
// both name the app and the signed-in person in their own body text. The /lti
// pages (the Moodle arrival, the account-link confirmation and the code picker
// shown inside Moodle's dialog) are single-purpose stops on the way from Moodle
// (docs/moodle.md).
const BARE_ROUTES = new Set(["sign-in", "device", "lti"]);

// The root layout is a server component and cannot read the current path, so the
// decision is made here: `useSelectedLayoutSegment` returns the first path
// segment ("sign-in" for /sign-in, null for /). It resolves during SSR too, so
// the chrome never flashes before being hidden.
export function AppChrome({ children }: { children: ReactNode }) {
  const segment = useSelectedLayoutSegment();
  if (segment !== null && BARE_ROUTES.has(segment)) return null;
  return children;
}
