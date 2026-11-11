import { getSession } from "@/lib/session";
import { getTeacherView } from "@/lib/student-mode";
import { NavMenu } from "./nav-menu";
import { UserMenu } from "./user-menu";

// Persistent top chrome. Server component so it can read the session directly and
// pass the user down to the (client) user menu. The avatar is always the name's
// initials — `user.image` is never populated (docs/auth.md).
//
// The whole bar acts on the EFFECTIVE teacher status: a real teacher in student
// mode sees student navigation and no teacher badge — only the "Student mode"
// pill (with its exit control) gives the simulation away.
export async function StatusBar() {
  const session = await getSession();
  const { studentMode, effectiveTeacher } = await getTeacherView();

  return (
    <header className="flex shrink-0 items-center justify-between gap-4 bg-slate-900 px-5 py-2 text-white dark:border-white/10 dark:border-b">
      <NavMenu isTeacher={effectiveTeacher} />
      <UserMenu
        user={session?.user ? { ...session.user, isTeacher: effectiveTeacher } : null}
        studentMode={studentMode}
      />
    </header>
  );
}
