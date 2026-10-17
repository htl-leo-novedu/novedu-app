import { beforeEach, describe, expect, it, vi } from "vitest";

// The saveWriting server action. The whole app is behind the Entra gate; the
// writing CODE authorizes the activity (re-verified on every save), the session
// `oid` is the row owner (a student writes ONLY their own row), and — the writing
// divergence — the action re-reads the `anonymous` flag LIVE from the YAML and
// REJECTS the save for an anonymous activity (defense in depth). The I/O seams
// (the session, the code check, the YAML load, the store) are mocked; the test asserts
// the GATING, not the persistence.

const getSession = vi.hoisted(() => vi.fn());
const checkCode = vi.hoisted(() => vi.fn());
const loadWriting = vi.hoisted(() => vi.fn());
const saveSubmission = vi.hoisted(() => vi.fn());
const recordWritingSave = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session", () => ({ getSession }));
vi.mock("@/lib/code-store", () => ({ checkCode }));
vi.mock("@/lib/writing-fetch", () => ({ loadWriting }));
vi.mock("@/lib/writing-store", () => ({ saveSubmission }));
// after() runs the metering write off the response path; run it inline so the test
// can assert the counter fired.
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/lib/usage-store", () => ({ recordWritingSave }));

import { saveWriting } from "@/lib/writing-actions";

const CODE = "a1b2c3d4e5";
const USER_ID = "oid-student-1";

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    entry: {
      code: CODE,
      module: "writing",
      fileUrl: "https://example.com/api/files/w",
      ...overrides,
    },
  };
}

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: USER_ID } });
  checkCode.mockResolvedValue(validEntry());
  loadWriting.mockResolvedValue({ ok: true, writing: { anonymous: false } });
  saveSubmission.mockResolvedValue(undefined);
});

describe("saveWriting — the anonymous rejection (defense in depth)", () => {
  it("REJECTS the save when the activity is anonymous, without touching the store", async () => {
    loadWriting.mockResolvedValue({ ok: true, writing: { anonymous: true } });
    const res = await saveWriting({ code: CODE, text: "my draft" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/does not save/i);
    expect(saveSubmission).not.toHaveBeenCalled();
    expect(recordWritingSave).not.toHaveBeenCalled();
  });

  it("saves for an attributed (anonymous:false) activity, keyed by the session oid + trimmed text", async () => {
    const res = await saveWriting({ code: CODE, text: "  my draft  " });
    expect(res).toEqual({ ok: true });
    expect(saveSubmission).toHaveBeenCalledWith({
      code: CODE,
      userId: USER_ID,
      text: "my draft",
    });
    // The save is metered off the response path.
    expect(recordWritingSave).toHaveBeenCalledWith({ code: CODE, userId: USER_ID });
  });
});

// The session / code / module refusals and their texts are the shared student gate's
// (lib/activity-gate.unit.test.ts); this proves the writing wiring.
describe("saveWriting — the gates", () => {
  it("refuses through the shared student gate, for writing codes only, saving nothing", async () => {
    checkCode.mockResolvedValue(validEntry({ module: "tutor" }));
    const res = await saveWriting({ code: CODE, text: "x" });
    expect(res).toEqual({ ok: false, message: "This code is not for this activity." });
    expect(saveSubmission).not.toHaveBeenCalled();
  });

  it("surfaces the load failure message and does not save", async () => {
    loadWriting.mockResolvedValue({ ok: false, message: "writing unavailable" });
    const res = await saveWriting({ code: CODE, text: "x" });
    expect(res).toEqual({ ok: false, message: "writing unavailable" });
    expect(saveSubmission).not.toHaveBeenCalled();
  });
});
