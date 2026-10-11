import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session";

// `lib/student-mode.ts` holds THE teacher rule — "real teacher AND not
// simulating a student" — that every teacher gate in the app derives from
// (AGENTS.md). It has exactly two I/O seams: the session (`@/lib/session`) and the
// student-mode cookie (`next/headers`); both are stubbed here so the rule itself
// runs for real.

const getSession = vi.hoisted(() => vi.fn());
const requireTeacher = vi.hoisted(() => vi.fn());
const cookies = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session", () => ({ getSession, requireTeacher }));
vi.mock("next/headers", () => ({ cookies }));

import { studentModeCookies, TEST_SESSION_ID } from "@/tests/mocks/student-mode-cookies";
import {
  effectiveTeacherForSession,
  getTeacherView,
  isEffectiveTeacher,
  isStudentMode,
  requireEffectiveTeacher,
  requireTeacherUserId,
  teacherViewForSession,
} from "./student-mode";

const TEACHER = {
  session: { id: TEST_SESSION_ID },
  user: { id: "u1", isTeacher: true },
} as unknown as Session;
const STUDENT = {
  session: { id: TEST_SESSION_ID },
  user: { id: "u2", isTeacher: false },
} as unknown as Session;
/** The same teacher after a new sign-in: a different session id. */
const TEACHER_NEW_SESSION = {
  session: { id: "test-session-2" },
  user: { id: "u1", isTeacher: true },
} as unknown as Session;

function setStudentMode(active: boolean) {
  cookies.mockResolvedValue(studentModeCookies(active));
}

beforeEach(() => {
  setStudentMode(false);
});

describe("isStudentMode", () => {
  it("is true only when the cookie names the current session", async () => {
    setStudentMode(true);
    await expect(isStudentMode(TEACHER)).resolves.toBe(true);
    cookies.mockResolvedValue(studentModeCookies(true, "1"));
    await expect(isStudentMode(TEACHER)).resolves.toBe(false);
  });

  it("ignores a cookie left behind by an earlier session", async () => {
    setStudentMode(true);
    await expect(isStudentMode(TEACHER_NEW_SESSION)).resolves.toBe(false);
  });

  it("is false without a session", async () => {
    setStudentMode(true);
    await expect(isStudentMode(null)).resolves.toBe(false);
  });
});

describe("teacherViewForSession (the one definition of the rule)", () => {
  it("reports the triple for a real teacher who is NOT simulating", async () => {
    await expect(teacherViewForSession(TEACHER)).resolves.toEqual({
      realTeacher: true,
      studentMode: false,
      effectiveTeacher: true,
    });
  });

  it("reports real-but-not-effective while student mode is active", async () => {
    setStudentMode(true);
    await expect(teacherViewForSession(TEACHER)).resolves.toEqual({
      realTeacher: true,
      studentMode: true,
      effectiveTeacher: false,
    });
  });

  it("starts a new session of the same teacher as a teacher, despite a stale cookie", async () => {
    setStudentMode(true);
    await expect(teacherViewForSession(TEACHER_NEW_SESSION)).resolves.toEqual({
      realTeacher: true,
      studentMode: false,
      effectiveTeacher: true,
    });
  });

  it("never reports studentMode for a non-teacher who set the cookie", async () => {
    setStudentMode(true);
    await expect(teacherViewForSession(STUDENT)).resolves.toEqual({
      realTeacher: false,
      studentMode: false,
      effectiveTeacher: false,
    });
  });
});

describe("effectiveTeacherForSession (the rule's boolean half)", () => {
  it("is true for a real teacher who is NOT simulating a student", async () => {
    await expect(effectiveTeacherForSession(TEACHER)).resolves.toBe(true);
  });

  it("is false for a real teacher WHILE student mode is active", async () => {
    setStudentMode(true);
    await expect(effectiveTeacherForSession(TEACHER)).resolves.toBe(false);
  });

  it("is false for a non-teacher, cookie or not (the cookie only restricts)", async () => {
    await expect(effectiveTeacherForSession(STUDENT)).resolves.toBe(false);
    setStudentMode(true);
    await expect(effectiveTeacherForSession(STUDENT)).resolves.toBe(false);
  });

  it("is false for no session at all", async () => {
    await expect(effectiveTeacherForSession(null)).resolves.toBe(false);
  });

  it("does NOT call getSession() — it uses the session the caller already has", async () => {
    await effectiveTeacherForSession(TEACHER);
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("getTeacherView (the same rule, over the session it fetches itself)", () => {
  it("reports a plain teacher as effective", async () => {
    getSession.mockResolvedValue(TEACHER);
    await expect(getTeacherView()).resolves.toEqual({
      realTeacher: true,
      studentMode: false,
      effectiveTeacher: true,
    });
  });

  it("reports a simulating teacher as real-but-not-effective", async () => {
    getSession.mockResolvedValue(TEACHER);
    setStudentMode(true);
    await expect(getTeacherView()).resolves.toEqual({
      realTeacher: true,
      studentMode: true,
      effectiveTeacher: false,
    });
  });

  it("starts a new session of the same teacher as a teacher, despite a stale cookie", async () => {
    setStudentMode(true);
    await expect(teacherViewForSession(TEACHER_NEW_SESSION)).resolves.toEqual({
      realTeacher: true,
      studentMode: false,
      effectiveTeacher: true,
    });
  });

  it("never reports studentMode for a non-teacher who set the cookie", async () => {
    getSession.mockResolvedValue(STUDENT);
    setStudentMode(true);
    await expect(getTeacherView()).resolves.toEqual({
      realTeacher: false,
      studentMode: false,
      effectiveTeacher: false,
    });
  });

  it("treats a missing session as a non-teacher", async () => {
    getSession.mockResolvedValue(null);
    await expect(getTeacherView()).resolves.toMatchObject({ effectiveTeacher: false });
  });
});

describe("the shorthands gate on the effective status", () => {
  it("isEffectiveTeacher follows getTeacherView", async () => {
    getSession.mockResolvedValue(TEACHER);
    await expect(isEffectiveTeacher()).resolves.toBe(true);
    setStudentMode(true);
    await expect(isEffectiveTeacher()).resolves.toBe(false);
  });

  it("requireEffectiveTeacher refuses while student mode is active", async () => {
    requireTeacher.mockResolvedValue(TEACHER);
    await expect(requireEffectiveTeacher()).resolves.toBe(TEACHER);
    setStudentMode(true);
    await expect(requireEffectiveTeacher()).rejects.toThrow(/student mode/i);
  });

  it("requireTeacherUserId returns the user id, or a typed refusal", async () => {
    requireTeacher.mockResolvedValue(TEACHER);
    await expect(requireTeacherUserId()).resolves.toEqual({ ok: true, userId: "u1" });

    setStudentMode(true);
    await expect(requireTeacherUserId()).resolves.toEqual({ ok: false });
  });
});
