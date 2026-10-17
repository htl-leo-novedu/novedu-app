import { beforeEach, describe, expect, it, vi } from "vitest";

// The tutor thread actions ("start over", "resume"). The two I/O seams — the session and the code
// gate — are mocked, but `lib/thread-token` stays REAL (docs/testing.md:
// security-critical pure modules are exercised for real), so the minted token is
// a genuine HMAC and the assertions below prove the actual binding: the token
// works for (code, session user, new thread) and for nothing else.

const getSession = vi.hoisted(() => vi.fn());
const checkCode = vi.hoisted(() => vi.fn());
const threadLastMessageAt = vi.hoisted(() => vi.fn());
const listOwnTutorThreads = vi.hoisted(() => vi.fn());
const ownsTutorThread = vi.hoisted(() => vi.fn());
const readAnonymousFlag = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session", () => ({ getSession }));
vi.mock("@/lib/tutor-history-store", () => ({
  threadLastMessageAt,
  listOwnTutorThreads,
  ownsTutorThread,
}));
vi.mock("@/lib/file-validators", () => ({ readAnonymousFlag }));
vi.mock("@/lib/code-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-store")>()),
  checkCode,
}));

import {
  getThreadTokenSecret,
  resetThreadTokenSecretForTests,
  signThreadToken,
  verifyThreadToken,
} from "@/lib/thread-token";
import {
  listTutorThreads,
  openTutorThread,
  resumeTutorThread,
  startNewTutorThread,
} from "@/lib/tutor-actions";

const CODE = "a1b2c3d4e5";
const USER = "student-1";
const MINUTE = 60 * 1000;

beforeEach(() => {
  resetThreadTokenSecretForTests();
  getSession.mockResolvedValue({ user: { id: USER } });
  checkCode.mockResolvedValue({
    ok: true,
    entry: { code: CODE, module: "tutor", anonymous: true, fileUrl: "https://e/t.yaml" },
  });
  threadLastMessageAt.mockResolvedValue(new Date(Date.now() - 5 * MINUTE));
});

it("mints a thread whose token verifies for (code, session user, thread)", async () => {
  const result = await startNewTutorThread({ code: CODE });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    verifyThreadToken(
      result.threadToken,
      { code: CODE, userId: USER, threadId: result.threadId },
      getThreadTokenSecret(),
    ),
  ).toBe(true);
});

it("mints a DIFFERENT thread each time — a restart never reuses the old one", async () => {
  const first = await startNewTutorThread({ code: CODE });
  const second = await startNewTutorThread({ code: CODE });

  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(second.threadId).not.toBe(first.threadId);
  expect(second.threadToken).not.toBe(first.threadToken);
});

it("binds the token to the SESSION user, not the caller", async () => {
  const result = await startNewTutorThread({ code: CODE });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // The same thread id claimed by anyone else is rejected — that binding is the
  // only thing isolating students' chats (docs/codes.md).
  expect(
    verifyThreadToken(
      result.threadToken,
      { code: CODE, userId: "someone-else", threadId: result.threadId },
      getThreadTokenSecret(),
    ),
  ).toBe(false);
  // …and so is the same token replayed against another code.
  expect(
    verifyThreadToken(
      result.threadToken,
      { code: "f5e4d3c2b1", userId: USER, threadId: result.threadId },
      getThreadTokenSecret(),
    ),
  ).toBe(false);
});

// The session / code / module refusals and their texts are the shared student gate's
// (lib/activity-gate.unit.test.ts); this proves the tutor wiring.
it("refuses through the shared student gate, for tutor codes only", async () => {
  checkCode.mockResolvedValue({ ok: true, entry: { code: CODE, module: "quiz" } });

  expect(await startNewTutorThread({ code: CODE })).toEqual({
    ok: false,
    message: "This code is not for this activity.",
  });
});

it("re-checks the code on every call — a window that closed mid-session stops minting", async () => {
  expect((await startNewTutorThread({ code: CODE })).ok).toBe(true);

  checkCode.mockResolvedValue({ ok: false, reason: "expired" });

  expect((await startNewTutorThread({ code: CODE })).ok).toBe(false);
  expect(checkCode).toHaveBeenCalledTimes(2);
});

describe("resumeTutorThread", () => {
  const THREAD = "0b6f0c1e-1111-4222-8333-444455556666";

  function ownToken(over: { code?: string; userId?: string; threadId?: string } = {}) {
    return signThreadToken(
      { code: over.code ?? CODE, userId: over.userId ?? USER, threadId: over.threadId ?? THREAD },
      getThreadTokenSecret(),
    );
  }

  function resume(threadToken = ownToken(), threadId = THREAD) {
    return resumeTutorThread({ code: CODE, threadId, threadToken });
  }

  it("accepts the owner's token on a thread last written 59 minutes ago", async () => {
    threadLastMessageAt.mockResolvedValue(new Date(Date.now() - 59 * MINUTE));
    expect(await resume()).toEqual({ ok: true });
    expect(threadLastMessageAt).toHaveBeenCalledWith(CODE, THREAD);
  });

  it("rejects a malformed thread id before any lookup", async () => {
    expect(await resume(ownToken({ threadId: "x".repeat(65) }), "x".repeat(65))).toEqual({
      ok: false,
    });
    expect(await resume(ownToken({ threadId: "a b" }), "a b")).toEqual({ ok: false });
    expect(checkCode).not.toHaveBeenCalled();
    expect(threadLastMessageAt).not.toHaveBeenCalled();
  });

  it.each([
    ["another user's token", () => ownToken({ userId: "someone-else" })],
    ["a token for another code", () => ownToken({ code: "f5e4d3c2b1" })],
    ["a token for another thread", () => ownToken({ threadId: "another-thread" })],
    ["an empty token", () => ""],
  ])("rejects %s", async (_label, token) => {
    expect(await resume(token())).toEqual({ ok: false });
    expect(threadLastMessageAt).not.toHaveBeenCalled();
  });

  it.each([
    ["no messages", null],
    ["exactly 60 minutes idle", new Date(Date.now() - 60 * MINUTE)],
    ["61 minutes idle", new Date(Date.now() - 61 * MINUTE)],
    ["a store failure", undefined],
  ])("rejects a thread with %s", async (_label, lastAt) => {
    threadLastMessageAt.mockResolvedValue(lastAt);
    expect(await resume()).toEqual({ ok: false });
  });

  it("rejects a non-tutor code", async () => {
    checkCode.mockResolvedValue({ ok: true, entry: { code: CODE, module: "writing" } });
    expect(await resume()).toEqual({ ok: false });
  });

  it.each(["unknown-code", "not-started", "expired", "lookup-failed"] as const)(
    "rejects a %s code",
    async (reason) => {
      checkCode.mockResolvedValue({ ok: false, reason });
      expect(await resume()).toEqual({ ok: false });
    },
  );

  it("rejects without a session", async () => {
    getSession.mockResolvedValue(null);
    expect(await resume()).toEqual({ ok: false });
  });

  it("past the limit, accepts the owner's thread on a per-user tutor (a reopened conversation)", async () => {
    threadLastMessageAt.mockResolvedValue(new Date(Date.now() - 3 * 24 * 60 * MINUTE));
    checkCode.mockResolvedValue({
      ok: true,
      entry: { code: CODE, module: "tutor", anonymous: false, fileUrl: "https://e/t.yaml" },
    });
    readAnonymousFlag.mockResolvedValue({ anonymous: false, definitive: true });
    ownsTutorThread.mockResolvedValue(true);
    expect(await resume()).toEqual({ ok: true });
    expect(ownsTutorThread).toHaveBeenCalledWith(USER, CODE, THREAD);

    ownsTutorThread.mockResolvedValue(false);
    expect(await resume()).toEqual({ ok: false });
  });

  it("past the limit, refuses on an anonymous tutor without looking for ownership", async () => {
    threadLastMessageAt.mockResolvedValue(new Date(Date.now() - 61 * MINUTE));
    checkCode.mockResolvedValue({
      ok: true,
      entry: { code: CODE, module: "tutor", anonymous: true, fileUrl: "https://e/t.yaml" },
    });
    expect(await resume()).toEqual({ ok: false });
    expect(ownsTutorThread).not.toHaveBeenCalled();
  });

  it("binds to the SESSION user: the owner's token fails for anyone else signed in", async () => {
    const token = ownToken();
    getSession.mockResolvedValue({ user: { id: "someone-else" } });
    expect(await resume(token)).toEqual({ ok: false });
  });
});

// "Previous conversations" — only on a code whose FROZEN and LIVE `anonymous`
// flags are both false, and only ever the session user's own threads.
describe("listTutorThreads / openTutorThread", () => {
  const THREAD = "7a1c2b3d-1111-4222-8333-444455556666";
  const SUMMARY = {
    threadId: THREAD,
    lastActivityAt: new Date("2026-10-08T10:00:00Z"),
    userMessageCount: 3,
    preview: { kind: "text" as const, text: "Hi" },
  };
  const REFUSED = { ok: false, message: "This conversation can't be opened." };

  function perUserCode(frozen = false) {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { code: CODE, module: "tutor", anonymous: frozen, fileUrl: "https://e/t.yaml" },
    });
  }

  beforeEach(() => {
    perUserCode();
    readAnonymousFlag.mockResolvedValue({ anonymous: false, definitive: true });
    listOwnTutorThreads.mockResolvedValue({ threads: [SUMMARY], more: false });
    ownsTutorThread.mockResolvedValue(true);
    threadLastMessageAt.mockResolvedValue(new Date("2026-01-01T00:00:00Z"));
  });

  it("lists the SESSION user's threads for this code", async () => {
    expect(await listTutorThreads({ code: CODE })).toEqual({
      ok: true,
      threads: [SUMMARY],
      more: false,
    });
    expect(listOwnTutorThreads).toHaveBeenCalledExactlyOnceWith(USER, CODE);
    expect(readAnonymousFlag).toHaveBeenCalledWith("tutor", "https://e/t.yaml");
  });

  it.each([
    ["frozen anonymous, live per-user", true, false, true],
    ["frozen per-user, live anonymous", false, true, true],
    ["both anonymous", true, true, true],
    ["an unreadable YAML (counts as anonymous)", false, true, false],
  ])("is refused with %s", async (_label, frozen, live, definitive) => {
    perUserCode(frozen);
    readAnonymousFlag.mockResolvedValue({ anonymous: live, definitive });
    expect(await listTutorThreads({ code: CODE })).toEqual({ ok: false });
    expect(await openTutorThread({ code: CODE, threadId: THREAD })).toEqual(REFUSED);
    expect(listOwnTutorThreads).not.toHaveBeenCalled();
    expect(ownsTutorThread).not.toHaveBeenCalled();
  });

  it.each([
    ["no session", () => getSession.mockResolvedValue(null)],
    ["a bad code", () => checkCode.mockResolvedValue({ ok: false, reason: "expired" })],
    [
      "a non-tutor code",
      () =>
        checkCode.mockResolvedValue({
          ok: true,
          entry: { code: CODE, module: "writing", anonymous: false, fileUrl: "x" },
        }),
    ],
    ["a list failure", () => listOwnTutorThreads.mockResolvedValue(undefined)],
  ])("list is refused with %s", async (_label, arrange) => {
    arrange();
    expect(await listTutorThreads({ code: CODE })).toEqual({ ok: false });
  });

  it("opens an owned thread with a token that verifies for exactly (code, session user, thread)", async () => {
    const result = await openTutorThread({ code: CODE, threadId: THREAD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ownsTutorThread).toHaveBeenCalledWith(USER, CODE, THREAD);
    const secret = getThreadTokenSecret();
    expect(
      verifyThreadToken(result.threadToken, { code: CODE, userId: USER, threadId: THREAD }, secret),
    ).toBe(true);
    for (const other of [
      { code: CODE, userId: "someone-else", threadId: THREAD },
      { code: "f5e4d3c2b1", userId: USER, threadId: THREAD },
      { code: CODE, userId: USER, threadId: "another-thread" },
    ]) {
      expect(verifyThreadToken(result.threadToken, other, secret)).toBe(false);
    }
  });

  it.each([
    [
      "no ownership row (another user's or another code's thread)",
      () => ownsTutorThread.mockResolvedValue(false),
    ],
    ["an ownership lookup failure", () => ownsTutorThread.mockResolvedValue(undefined)],
    ["an empty thread", () => threadLastMessageAt.mockResolvedValue(null)],
    ["a message lookup failure", () => threadLastMessageAt.mockResolvedValue(undefined)],
    ["no session", () => getSession.mockResolvedValue(null)],
  ])("open is refused with %s, always the same message", async (_label, arrange) => {
    arrange();
    expect(await openTutorThread({ code: CODE, threadId: THREAD })).toEqual(REFUSED);
  });

  it("open refuses a malformed thread id before any lookup", async () => {
    expect(await openTutorThread({ code: CODE, threadId: "a b" })).toEqual(REFUSED);
    expect(checkCode).not.toHaveBeenCalled();
  });
});
