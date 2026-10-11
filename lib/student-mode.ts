import { cookies } from "next/headers";
import { getSession, requireTeacher, type Session } from "@/lib/session";
import { STUDENT_MODE_COOKIE } from "@/lib/student-mode-constants";

// "Student mode": a teacher temporarily views the app as a student would see
// it. While active, every teacher check treats the user as a non-teacher — the
// ONLY teacher capability that remains is exiting the mode again.
//
// State lives in an httpOnly SESSION cookie (no max-age, gone when the browser
// closes — the mode is meant to be temporary) whose value is the id of the
// Novedu session that entered the mode. It applies only while that session is
// the current one: a new sign-in, an expired session or a reset database never
// inherits a cookie left behind (browsers restore session cookies, and a
// `localhost` cookie spans every port). The cookie grants nothing, it only
// RESTRICTS: a student setting it by hand merely opts into what they already
// are, so it needs no signing. Only entering the mode is gated (see
// lib/student-mode-actions.ts).
//
// Kept OUT of auth.ts on purpose: auth.ts is the auth INSTANCE (provider, tables,
// hooks). The student-mode rule is app policy layered on top of a session, and
// every consumer of it already goes through lib/session.ts.

// Re-exported so the rule and the cookie name stay one import for server callers.
export { STUDENT_MODE_COOKIE };

/** The raw cookie read: does the cookie name THIS session? */
export async function isStudentMode(session: Session | null): Promise<boolean> {
  const sessionId = session?.session?.id;
  if (!sessionId) return false;
  return (await cookies()).get(STUDENT_MODE_COOKIE)?.value === sessionId;
}

export interface TeacherView {
  /** The session's actual role (the server-owned `is_teacher` column). */
  realTeacher: boolean;
  /** True while a real teacher is simulating a student. */
  studentMode: boolean;
  /** The status the app must ACT on: real teacher AND not simulating. */
  effectiveTeacher: boolean;
}

/**
 * THE rule — "real teacher AND not simulating a student" — computed for a
 * session the caller ALREADY has. Every other export in this file derives from
 * it, so the rule has exactly one definition, and this is the only function that
 * reads the raw `session.user.isTeacher` flag on the student-mode-aware path.
 * (`lib/session.ts`'s `requireTeacher()` reads it too, for the channels that have
 * no student mode at all — the CLI/API bearer routes; see `docs/api.md`.)
 *
 * Prefer this overload on a hot path that already called `getSession()` (the chat
 * runtime route, which gates reasoning display on it — `docs/chat.md`) so the
 * session is looked up once per request instead of twice. Everywhere else,
 * prefer `getTeacherView()` / `isEffectiveTeacher()`.
 */
export async function teacherViewForSession(session: Session | null): Promise<TeacherView> {
  const realTeacher = session?.user?.isTeacher ?? false;
  const studentMode = realTeacher && (await isStudentMode(session));
  return { realTeacher, studentMode, effectiveTeacher: realTeacher && !studentMode };
}

/** The rule's boolean half, for a session the caller already has. */
export async function effectiveTeacherForSession(session: Session | null): Promise<boolean> {
  return (await teacherViewForSession(session)).effectiveTeacher;
}

/**
 * THE single source of truth for "how teacher-ish is this user right now".
 * Everything that gates or displays teacher capabilities must derive from this
 * (or the isEffectiveTeacher/requireEffectiveTeacher shorthands below) — never
 * from `session.user.isTeacher` directly, which ignores student mode.
 */
export async function getTeacherView(): Promise<TeacherView> {
  return teacherViewForSession(await getSession());
}

/** Shorthand for gating teacher features. */
export async function isEffectiveTeacher(): Promise<boolean> {
  return (await getTeacherView()).effectiveTeacher;
}

/**
 * Like `requireTeacher()`, but also refuses while student mode is active, so
 * teacher-only server work is genuinely unavailable during the simulation.
 */
export async function requireEffectiveTeacher() {
  const session = await requireTeacher();
  if ((await teacherViewForSession(session)).studentMode) {
    throw new Error("Forbidden: student mode is active.");
  }
  return session;
}

export type TeacherGate = { ok: true; userId: string } | { ok: false };

/**
 * The standard server-action teacher gate: requires an EFFECTIVE teacher and
 * hands back the session user id. Returns a result rather than throwing so each
 * action words its OWN refusal in its OWN result shape — the security check
 * lives in one place (a missed copy of the gate is a real authz hole) while the
 * wording stays per-action. Callers must `return` on `ok: false` before any
 * privileged work.
 */
export async function requireTeacherUserId(): Promise<TeacherGate> {
  try {
    const session = await requireEffectiveTeacher();
    return { ok: true, userId: session.user.id };
  } catch {
    return { ok: false };
  }
}
