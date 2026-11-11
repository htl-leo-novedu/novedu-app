"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { MENU_ITEM, MENU_PANEL } from "@/components/ui/menu";
import { signOutAction } from "@/lib/auth-actions";
import { enterStudentModeAction, exitStudentModeAction } from "@/lib/student-mode-actions";
import { clearAllTutorThreads } from "@/lib/tutor-thread-storage";
import { cn } from "@/lib/utils";
import { usePopover } from "./use-popover";

// The shared menu row as a full-width, left-aligned form button.
const MENU_ACTION = cn(MENU_ITEM, "w-full text-left");

type StatusBarUser = {
  name?: string | null;
  isTeacher?: boolean;
};

// Up to two initials from the user's name for the avatar placeholder.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

export function UserMenu({
  user,
  studentMode = false,
}: {
  // `user.isTeacher` is the EFFECTIVE status (false while simulating a
  // student), so it gates both the badge and the "View as student" item.
  user: StatusBarUser | null;
  // True while a (real) teacher is simulating a student. Shows the always-
  // visible pill with the exit control — the one teacher capability that
  // student mode keeps.
  studentMode?: boolean;
}) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>();
  // Signed out where the proxy let the request through: it only checks that a
  // session cookie is PRESENT, so a garbage cookie — or a genuine one whose
  // session row is gone — reaches the page and resolves no session. Without this
  // the bar would be empty and the only way back would be typing /sign-in. No
  // callbackURL — the visitor is already where they wanted to be, and the
  // sign-in page defaults to "/".
  if (!user)
    return (
      <Link href="/sign-in" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
        Sign in
      </Link>
    );
  const name = user.name?.trim() || "Signed in";

  return (
    <div className="relative flex items-center" ref={ref}>
      {studentMode && (
        <form
          action={exitStudentModeAction}
          className="mr-2.5 inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 py-0.5 pr-1 pl-3"
        >
          <span className="whitespace-nowrap font-semibold text-amber-800 text-xs">
            Student mode
          </span>
          <button
            type="submit"
            className="cursor-pointer rounded-full border border-amber-200 bg-white px-2.5 py-0.5 font-semibold text-amber-800 text-xs hover:bg-amber-100"
          >
            Exit
          </button>
        </form>
      )}
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-foreground/15 bg-background py-1 pr-1.5 pl-2.5 text-foreground hover:bg-accent"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {user.isTeacher && (
          <span
            className="inline-flex cursor-help items-center text-foreground/70 [&_svg]:pointer-events-none"
            role="img"
            title="Teacher — may perform teacher-only operations"
            aria-label="Teacher"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M12 3 1 9l11 6 9-4.91V17h2V9L12 3zM5 13.18v3.82c0 .73 3.13 3 7 3s7-2.27 7-3v-3.82l-7 3.82-7-3.82z" />
            </svg>
          </span>
        )}
        <span className="max-w-56 overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-sm">
          {name}
        </span>
        <span
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/65 font-semibold text-background text-xs"
          aria-hidden="true"
        >
          {initials(name)}
        </span>
      </button>
      {open && (
        <div className={cn(MENU_PANEL, "right-0 min-w-40")} role="menu">
          {user.isTeacher && (
            // NOTE: no onClick-close here — unmounting the form before React
            // processes the submission would cancel the action. The route
            // refresh after the action re-renders the bar without this item.
            <form action={enterStudentModeAction}>
              <button type="submit" role="menuitem" className={MENU_ACTION}>
                View as student
              </button>
            </form>
          )}
          {/* Every signed-in user, either role: the per-user preferences (docs/home.md). */}
          <Link
            href="/settings"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => setOpen(false)}
          >
            Settings
          </Link>
          {/* The tab's remembered tutor threads go first: the next person signing
              in on this tab must not inherit them (lib/tutor-thread-storage.ts).
              onSubmit runs before React hands the form to the action. */}
          <form action={signOutAction} onSubmit={() => clearAllTutorThreads()}>
            <button type="submit" role="menuitem" className={MENU_ACTION}>
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
