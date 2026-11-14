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
  getOwnLink: vi.fn(),
  getOwnTarget: vi.fn(),
  markHandedIn: vi.fn(),
  verifyAndLoadQuiz: vi.fn(),
  getCode: vi.fn(),
  postScore: vi.fn(),
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
  getOwnLink: mocks.getOwnLink,
  getOwnTarget: mocks.getOwnTarget,
  markHandedIn: mocks.markHandedIn,
}));
vi.mock("@/lib/quiz-verify", () => ({
  verifyAndLoadQuiz: mocks.verifyAndLoadQuiz,
  attemptLength: (quiz: { questionCount?: number; questions: unknown[] }) =>
    quiz.questionCount ?? quiz.questions.length,
}));
vi.mock("@/lib/activity-gate", () => ({
  CODE_REJECTION_MESSAGES: {
    expired: "This activity's availability window has ended.",
    "lookup-failed": "Codes cannot be checked right now — try again in a moment.",
  },
}));
vi.mock("@/lib/moodle-ags", () => ({ postScore: mocks.postScore }));
vi.mock("@/lib/code-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-store")>()),
  getCode: mocks.getCode,
}));
vi.mock("@/lib/telemetry", () => ({ emitEvent: vi.fn(), recordError: vi.fn() }));

import {
  confirmMoodleLink,
  declineMoodleLink,
  handInToMoodle,
  unlinkMoodleAccount,
} from "./moodle-actions";
import { arrivalFingerprint } from "./moodle-arrival";
import { getReceiptSecret, signReceipt } from "./moodle-receipt";

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
  mocks.getCode.mockResolvedValue({ code: "quiz-code1", module: "quiz", moodle: true });
});

/** The confirmation form as the page rendered it for the current cookie. */
function shownForm(cookie = mocks.cookie): FormData {
  const form = new FormData();
  form.set("arrival", arrivalFingerprint(cookie));
  return form;
}
const confirm = () => confirmMoodleLink(shownForm());

describe("confirmMoodleLink", () => {
  it("links the session user to the cookie's Moodle account and opens the quiz", async () => {
    expect(await redirectOf(confirm)).toBe("/quiz-code1");
    expect(mocks.linkAndStoreTarget).toHaveBeenCalledWith(ISSUER, "u1", "42", TARGET);
    expect(mocks.deleted).toEqual([{ name: ARRIVAL_COOKIE, path: "/lti" }]);
  });

  it("stores nothing without a valid cookie", async () => {
    mocks.cookie = "forged";
    expect(await redirectOf(confirm)).toBe("/lti/done?state=expired");
    expect(mocks.linkAndStoreTarget).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveLength(1);
  });

  it("re-runs the decision: a mismatch since the page opened stores nothing", async () => {
    mocks.findLinkState.mockResolvedValue({ ownMoodleUserId: null, moodleUserOwner: "u2" });
    expect(await redirectOf(confirm)).toBe("/lti/done?state=mismatch-moodle&code=quiz-code1");
    expect(mocks.linkAndStoreTarget).not.toHaveBeenCalled();
  });

  it("answers a clash with the refusal that fits what is stored, a failure as unavailable", async () => {
    mocks.linkAndStoreTarget.mockResolvedValue("mismatch");
    mocks.findLinkState
      .mockResolvedValueOnce({ ownMoodleUserId: null, moodleUserOwner: null })
      .mockResolvedValueOnce({ ownMoodleUserId: null, moodleUserOwner: "u2" });
    expect(await redirectOf(confirm)).toBe("/lti/done?state=mismatch-moodle&code=quiz-code1");
    mocks.findLinkState
      .mockResolvedValueOnce({ ownMoodleUserId: null, moodleUserOwner: null })
      .mockResolvedValueOnce({ ownMoodleUserId: "43", moodleUserOwner: null });
    expect(await redirectOf(confirm)).toBe("/lti/done?state=mismatch-novedu&code=quiz-code1");
    mocks.linkAndStoreTarget.mockResolvedValue("error");
    expect(await redirectOf(confirm)).toBe("/lti/done?state=unavailable&code=quiz-code1");
  });

  it("only stores the target when the accounts got linked meanwhile", async () => {
    mocks.findLinkState.mockResolvedValue({ ownMoodleUserId: "42", moodleUserOwner: "u1" });
    expect(await redirectOf(confirm)).toBe("/quiz-code1");
    expect(mocks.storeTarget).toHaveBeenCalledWith(ISSUER, "u1", TARGET);
    expect(mocks.linkAndStoreTarget).not.toHaveBeenCalled();
  });

  it("shows the confirmation again when another launch replaced the cookie", async () => {
    const shown = shownForm();
    mocks.cookie = await signMoodleToken("arrival", { ...ARRIVAL, sub: "99" });
    expect(await redirectOf(() => confirmMoodleLink(shown))).toBe("/lti/arrive");
    expect(mocks.linkAndStoreTarget).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveLength(0);
  });

  it("decides again after a key clash: a double submit lands on the quiz", async () => {
    mocks.linkAndStoreTarget.mockResolvedValue("mismatch");
    mocks.findLinkState
      .mockResolvedValueOnce({ ownMoodleUserId: null, moodleUserOwner: null })
      .mockResolvedValueOnce({ ownMoodleUserId: "42", moodleUserOwner: "u1" });
    expect(await redirectOf(confirm)).toBe("/quiz-code1");
  });

  it("stores nothing when the code was switched off or deleted since the launch", async () => {
    mocks.getCode.mockResolvedValue({ code: "quiz-code1", module: "quiz", moodle: false });
    expect(await redirectOf(confirm)).toBe("/quiz-code1");
    mocks.getCode.mockResolvedValue(null);
    expect(await redirectOf(confirm)).toBe("/quiz-code1");
    expect(mocks.linkAndStoreTarget).not.toHaveBeenCalled();
  });

  it("sends a signed-out caller to sign-in without touching anything", async () => {
    mocks.getSession.mockResolvedValue(null);
    expect(await redirectOf(confirm)).toBe("/sign-in?callbackURL=%2Flti%2Farrive");
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

describe("handInToMoodle", () => {
  const ATTEMPT = "6f1c2d3e-0000-4000-8000-000000000001";
  const QUIZ = { questions: [{ id: "q1" }, { id: "q2" }, { id: "q3" }, { id: "q4" }] };
  const receipt = (
    slot: number,
    questionId: string,
    verdict: "correct" | "partial" | "incorrect",
  ) =>
    signReceipt(
      { code: "quiz-code1", userId: "u1", attemptId: ATTEMPT },
      { slot, questionId, verdict },
      getReceiptSecret(),
    );
  const handIn = async (receipts: unknown) =>
    handInToMoodle({ code: "quiz-code1", attemptId: ATTEMPT, receipts });

  beforeEach(() => {
    mocks.verifyAndLoadQuiz.mockResolvedValue({
      ok: true,
      userId: "u1",
      code: "quiz-code1",
      quiz: QUIZ,
      moodle: true,
    });
    mocks.getOwnLink.mockResolvedValue({ moodleUserId: "42", linkedAt: new Date() });
    mocks.getOwnTarget.mockResolvedValue({ lineitemUrl: ARRIVAL.lineitem, handedInAt: null });
    mocks.postScore.mockResolvedValue("ok");
    mocks.markHandedIn.mockResolvedValue(true);
  });

  it("counts the receipts on the server and posts score and comment to the target", async () => {
    const result = await handIn([
      receipt(0, "q1", "correct"),
      receipt(1, "q2", "partial"),
      receipt(2, "q3", "incorrect"),
    ]);
    expect(result).toMatchObject({ ok: true, percent: 38 });
    expect(mocks.postScore).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: ISSUER }),
      ARRIVAL.lineitem,
      {
        userId: "42",
        scoreGiven: 1.5,
        scoreMaximum: 4,
        comment: "Novedu quiz: 4 questions — 1 correct, 1 partly correct, 1 wrong, 1 not answered.",
      },
      expect.any(Date),
    );
    expect(mocks.markHandedIn).toHaveBeenCalledWith(ISSUER, "u1", TARGET, expect.any(Date));
  });

  it("refuses a receipt for a question no longer in the quiz", async () => {
    const result = await handIn([receipt(0, "removed-question", "correct")]);
    expect(result).toMatchObject({ ok: false, retry: false });
    expect(mocks.postScore).not.toHaveBeenCalled();
  });

  it("refuses a forged receipt as a whole and posts nothing", async () => {
    const result = await handIn([{ ...receipt(0, "q1", "incorrect"), verdict: "correct" }]);
    expect(result).toEqual({ ok: false, message: "This result can't be handed in.", retry: false });
    expect(mocks.postScore).not.toHaveBeenCalled();
  });

  it("refuses without receipts or with a malformed attempt id", async () => {
    await expect(handIn([])).resolves.toMatchObject({ ok: false, retry: false });
    await expect(
      handInToMoodle({ code: "quiz-code1", attemptId: "nope", receipts: [] }),
    ).resolves.toMatchObject({ ok: false, retry: false });
    expect(mocks.postScore).not.toHaveBeenCalled();
  });

  it("refuses an ended quiz without a retry", async () => {
    mocks.verifyAndLoadQuiz.mockResolvedValue({
      ok: false,
      message: "This activity's availability window has ended.",
    });
    await expect(handIn([receipt(0, "q1", "correct")])).resolves.toEqual({
      ok: false,
      message: "This quiz has ended, so the result can't be handed in.",
      retry: false,
    });
  });

  it("refuses a code switched off, and a student without a link or target", async () => {
    mocks.verifyAndLoadQuiz.mockResolvedValue({
      ok: true,
      userId: "u1",
      code: "quiz-code1",
      quiz: QUIZ,
      moodle: false,
    });
    await expect(handIn([receipt(0, "q1", "correct")])).resolves.toEqual({
      ok: false,
      message: "Hand-in to Moodle is switched off for this quiz.",
      retry: false,
    });
    mocks.verifyAndLoadQuiz.mockResolvedValue({
      ok: true,
      userId: "u1",
      code: "quiz-code1",
      quiz: QUIZ,
      moodle: true,
    });
    mocks.getOwnTarget.mockResolvedValue(null);
    await expect(handIn([receipt(0, "q1", "correct")])).resolves.toMatchObject({
      ok: false,
      retry: false,
    });
    expect(mocks.postScore).not.toHaveBeenCalled();
  });

  it("maps Moodle's answers to messages with a retry, storing nothing on failure", async () => {
    mocks.postScore.mockResolvedValue("not-found");
    await expect(handIn([receipt(0, "q1", "correct")])).resolves.toEqual({
      ok: false,
      message: "This activity no longer exists in Moodle. Ask your teacher.",
      retry: true,
    });
    mocks.postScore.mockResolvedValue("failed");
    await expect(handIn([receipt(0, "q1", "correct")])).resolves.toEqual({
      ok: false,
      message: "Moodle could not be reached right now. Please try again.",
      retry: true,
    });
    expect(mocks.markHandedIn).not.toHaveBeenCalled();
  });
});
