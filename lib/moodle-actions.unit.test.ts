import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMoodleConfigForTests } from "@/lib/moodle-config";
import { ARRIVAL_COOKIE, type ArrivalToken, signMoodleToken } from "@/lib/moodle-launch";
import { stubMoodleEnv } from "@/tests/fake-moodle";

// The Moodle server actions: the confirmation page's two buttons re-read the
// arrival cookie (never a form field), act on the session user only, clear the
// cookie and redirect; unlink acts on the session user's own rows. Real tokens;
// the session, cookies, redirect and the store are stand-ins.

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  cookie: undefined as string | undefined,
  deleted: [] as unknown[],
  findLinkState: vi.fn(),
  linkAndStoreTarget: vi.fn(),
  storeTarget: vi.fn(),
  unlinkOwn: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "novedu-lti-arrival" && mocks.cookie ? { value: mocks.cookie } : undefined,
    delete: (options: unknown) => mocks.deleted.push(options),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { path });
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/moodle-store", () => ({
  findLinkState: mocks.findLinkState,
  linkAndStoreTarget: mocks.linkAndStoreTarget,
  storeTarget: mocks.storeTarget,
  unlinkOwn: mocks.unlinkOwn,
}));
vi.mock("@/lib/telemetry", () => ({ emitEvent: vi.fn(), recordError: vi.fn() }));

import { confirmMoodleLink, declineMoodleLink, unlinkMoodleAccount } from "./moodle-actions";

const ISSUER = "https://moodle.example.org";
const ARRIVAL: ArrivalToken = {
  sub: "42",
  name: "Mia Muster",
  username: "mmuster",
  code: "quiz-code1",
  course: null,
  lineitem: `${ISSUER}/mod/lti/services.php/2/lineitems/5/lineitem`,
};
const TARGET = { code: "quiz-code1", lineitemUrl: ARRIVAL.lineitem };

async function redirectOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return (error as { path?: string }).path;
  }
}

beforeEach(async () => {
  resetMoodleConfigForTests();
  stubMoodleEnv(vi.stubEnv, { issuer: ISSUER, clientId: "c", deploymentId: "1" });
  mocks.getSession.mockResolvedValue({ user: { id: "u1" } });
  mocks.cookie = await signMoodleToken("arrival", ARRIVAL);
  mocks.deleted = [];
  mocks.findLinkState.mockResolvedValue({ ownMoodleUserId: null, moodleUserOwner: null });
  mocks.linkAndStoreTarget.mockResolvedValue("linked");
  mocks.storeTarget.mockResolvedValue(true);
  mocks.unlinkOwn.mockResolvedValue(true);
});

describe("confirmMoodleLink", () => {
  it("links the session user to the cookie's Moodle account and opens the quiz", async () => {
    expect(await redirectOf(confirmMoodleLink)).toBe("/quiz-code1");
    expect(mocks.linkAndStoreTarget).toHaveBeenCalledWith(ISSUER, "u1", "42", TARGET);
    expect(mocks.deleted).toEqual([{ name: ARRIVAL_COOKIE, path: "/lti" }]);
  });

  it("stores nothing without a valid cookie", async () => {
    mocks.cookie = "forged";
    expect(await redirectOf(confirmMoodleLink)).toBe("/lti/done?state=expired");
    expect(mocks.linkAndStoreTarget).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveLength(1);
  });

  it("re-runs the decision: a mismatch since the page opened stores nothing", async () => {
    mocks.findLinkState.mockResolvedValue({ ownMoodleUserId: null, moodleUserOwner: "u2" });
    expect(await redirectOf(confirmMoodleLink)).toBe(
      "/lti/done?state=mismatch-moodle&code=quiz-code1",
    );
    expect(mocks.linkAndStoreTarget).not.toHaveBeenCalled();
  });

  it("answers a unique violation as the refusal and a failure as unavailable", async () => {
    mocks.linkAndStoreTarget.mockResolvedValue("mismatch");
    expect(await redirectOf(confirmMoodleLink)).toBe(
      "/lti/done?state=mismatch-moodle&code=quiz-code1",
    );
    mocks.linkAndStoreTarget.mockResolvedValue("error");
    expect(await redirectOf(confirmMoodleLink)).toBe("/lti/done?state=unavailable&code=quiz-code1");
  });

  it("only stores the target when the accounts got linked meanwhile", async () => {
    mocks.findLinkState.mockResolvedValue({ ownMoodleUserId: "42", moodleUserOwner: "u1" });
    expect(await redirectOf(confirmMoodleLink)).toBe("/quiz-code1");
    expect(mocks.storeTarget).toHaveBeenCalledWith(ISSUER, "u1", TARGET);
    expect(mocks.linkAndStoreTarget).not.toHaveBeenCalled();
  });

  it("sends a signed-out caller to sign-in without touching anything", async () => {
    mocks.getSession.mockResolvedValue(null);
    expect(await redirectOf(confirmMoodleLink)).toBe("/sign-in?callbackURL=%2Flti%2Farrive");
    expect(mocks.findLinkState).not.toHaveBeenCalled();
  });
});

describe("declineMoodleLink", () => {
  it("stores nothing, clears the cookie and says so", async () => {
    expect(await redirectOf(declineMoodleLink)).toBe("/lti/done?state=declined&code=quiz-code1");
    expect(mocks.linkAndStoreTarget).not.toHaveBeenCalled();
    expect(mocks.storeTarget).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveLength(1);
  });
});

describe("unlinkMoodleAccount", () => {
  it("unlinks the session user on the configured Moodle", async () => {
    await expect(unlinkMoodleAccount()).resolves.toEqual({ ok: true });
    expect(mocks.unlinkOwn).toHaveBeenCalledWith(ISSUER, "u1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("refuses without a session, without Moodle, and on a failure", async () => {
    mocks.unlinkOwn.mockResolvedValue(false);
    await expect(unlinkMoodleAccount()).resolves.toMatchObject({ ok: false });
    mocks.getSession.mockResolvedValue(null);
    await expect(unlinkMoodleAccount()).resolves.toEqual({
      ok: false,
      message: "Please sign in to continue.",
    });
    mocks.getSession.mockResolvedValue({ user: { id: "u1" } });
    vi.stubEnv("MOODLE_LTI_PRIVATE_KEY", "");
    resetMoodleConfigForTests();
    await expect(unlinkMoodleAccount()).resolves.toMatchObject({ ok: false });
  });
});
