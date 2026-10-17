import { beforeEach, describe, expect, it, vi } from "vitest";

// The student gate every activity's server actions open with. Session and code row
// are mocked; the rejection texts are the contract a student reads.

const getSession = vi.hoisted(() => vi.fn());
const checkCode = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session", () => ({ getSession }));
vi.mock("@/lib/code-store", () => ({ checkCode }));

import { verifyStudentActivity } from "@/lib/activity-gate";

const CODE = "a1b2c3d4e5";
const entry = { code: CODE, module: "quiz" };

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: "student-1" } });
  checkCode.mockResolvedValue({ ok: true, entry });
});

describe("verifyStudentActivity — session and code", () => {
  it("returns the session user and the code row", async () => {
    expect(await verifyStudentActivity(CODE, "quiz")).toEqual({
      ok: true,
      userId: "student-1",
      entry,
    });
    expect(checkCode).toHaveBeenCalledWith(CODE);
  });

  it("asks to sign in before any code lookup", async () => {
    getSession.mockResolvedValue(null);
    expect(await verifyStudentActivity(CODE, "quiz")).toEqual({
      ok: false,
      message: "Please sign in to continue.",
    });
    expect(checkCode).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown-code", "This code is not valid."],
    ["not-started", "This activity's availability window has not started yet."],
    ["expired", "This activity's availability window has ended."],
    ["lookup-failed", "Codes cannot be checked right now — try again in a moment."],
  ] as const)("refuses a %s code with its message", async (reason, message) => {
    checkCode.mockResolvedValue({ ok: false, reason });
    expect(await verifyStudentActivity(CODE, "quiz")).toEqual({ ok: false, message });
  });
});

describe("verifyStudentActivity — module", () => {
  it("passes a code of the asked module", async () => {
    expect(await verifyStudentActivity(CODE, "quiz")).toMatchObject({ ok: true, entry });
  });

  it("refuses a code of another module", async () => {
    expect(await verifyStudentActivity(CODE, "writing")).toEqual({
      ok: false,
      message: "This code is not for this activity.",
    });
  });
});
