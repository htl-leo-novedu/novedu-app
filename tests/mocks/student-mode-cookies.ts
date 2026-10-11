import { STUDENT_MODE_COOKIE } from "@/lib/student-mode-constants";

// The ONE I/O seam of `lib/student-mode.ts` (next/headers' `cookies()`), stubbed
// for every suite that keeps the effective-teacher rule REAL: the rule's own
// tests and the chat runtime route's reasoning gate. Shared so both drive the
// rule through the same jar shape and the same cookie name.

/** The session id the stub cookie names; give a test session `session: { id }` with it. */
export const TEST_SESSION_ID = "test-session-1";

/** As much of a Next `cookies()` jar as `lib/student-mode.ts` ever touches. */
export interface StudentModeCookieJar {
  get: (name: string) => { value: string } | undefined;
}

/**
 * A jar carrying the student-mode cookie for `TEST_SESSION_ID` (the value the
 * mode writes is the session id), or no cookie at all. Pass `value` to drive
 * the "a cookie naming another session is not student mode" case.
 */
export function studentModeCookies(active: boolean, value = TEST_SESSION_ID): StudentModeCookieJar {
  return {
    get: (name: string) => (active && name === STUDENT_MODE_COOKIE ? { value } : undefined),
  };
}
