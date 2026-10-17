import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalThreadPayload,
  getThreadTokenSecret,
  newThread,
  resetThreadTokenSecretForTests,
  signThreadToken,
  THREAD_ID_PATTERN,
  type ThreadTokenPayload,
  verifyThreadToken,
} from "@/lib/thread-token";

const SECRET = "test-secret";
const PAYLOAD: ThreadTokenPayload = {
  code: "a1b2c3d4e5",
  userId: "student-sub-1",
  threadId: "0f8fad5b-d9cb-469f-a165-70867728950e",
};

describe("signThreadToken / verifyThreadToken", () => {
  it("verifies its own signature", () => {
    const token = signThreadToken(PAYLOAD, SECRET);
    expect(verifyThreadToken(token, PAYLOAD, SECRET)).toBe(true);
  });

  it.each([
    ["code", { ...PAYLOAD, code: "zzzzzzzzzz" }],
    ["userId", { ...PAYLOAD, userId: "student-sub-2" }],
    ["threadId", { ...PAYLOAD, threadId: "11111111-d9cb-469f-a165-70867728950e" }],
  ])("rejects a token signed for a different %s", (_field, other) => {
    const token = signThreadToken(other as ThreadTokenPayload, SECRET);
    expect(verifyThreadToken(token, PAYLOAD, SECRET)).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signThreadToken(PAYLOAD, "other-secret");
    expect(verifyThreadToken(token, PAYLOAD, SECRET)).toBe(false);
  });

  it("rejects tampered, truncated and padded tokens", () => {
    const token = signThreadToken(PAYLOAD, SECRET);
    const flipped = (token[0] === "0" ? "1" : "0") + token.slice(1);
    expect(verifyThreadToken(flipped, PAYLOAD, SECRET)).toBe(false);
    expect(verifyThreadToken(token.slice(0, -2), PAYLOAD, SECRET)).toBe(false);
    expect(verifyThreadToken(`${token}00`, PAYLOAD, SECRET)).toBe(false);
    // Buffer.from(.., "hex") stops at the first invalid char — `<sig>zz` must
    // not slip through the length check.
    expect(verifyThreadToken(`${token}zz`, PAYLOAD, SECRET)).toBe(false);
  });

  it("rejects non-string and empty tokens", () => {
    expect(verifyThreadToken(undefined, PAYLOAD, SECRET)).toBe(false);
    expect(verifyThreadToken(null, PAYLOAD, SECRET)).toBe(false);
    expect(verifyThreadToken(42, PAYLOAD, SECRET)).toBe(false);
    expect(verifyThreadToken("", PAYLOAD, SECRET)).toBe(false);
    expect(verifyThreadToken("not-hex-at-all", PAYLOAD, SECRET)).toBe(false);
  });
});

describe("canonicalThreadPayload", () => {
  it("is injective — shifting characters between fields changes the canonical form", () => {
    const a = canonicalThreadPayload({ code: "ab", userId: "c", threadId: "t" });
    const b = canonicalThreadPayload({ code: "a", userId: "bc", threadId: "t" });
    expect(a).not.toBe(b);
  });

  it("survives quotes and separators inside field values", () => {
    const a = canonicalThreadPayload({ code: 'a","b', userId: "u", threadId: "t" });
    const b = canonicalThreadPayload({ code: "a", userId: 'b","u', threadId: "t" });
    expect(a).not.toBe(b);
  });
});

describe("getThreadTokenSecret", () => {
  afterEach(() => {
    resetThreadTokenSecretForTests();
  });

  it("throws when AUTH_SECRET is not set", () => {
    resetThreadTokenSecretForTests();
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => getThreadTokenSecret()).toThrow(/AUTH_SECRET/);
  });

  it("derives a stable, purpose-bound key (not AUTH_SECRET itself)", () => {
    resetThreadTokenSecretForTests();
    vi.stubEnv("AUTH_SECRET", "the-auth-secret");
    const first = getThreadTokenSecret();
    expect(first).not.toBe("the-auth-secret");
    expect(getThreadTokenSecret()).toBe(first);
  });
});

describe("newThread", () => {
  afterEach(() => {
    resetThreadTokenSecretForTests();
  });

  it("mints a fresh UUID thread id with a token the production secret verifies", () => {
    resetThreadTokenSecretForTests();
    vi.stubEnv("AUTH_SECRET", "the-auth-secret");
    const first = newThread("a1b2c3d4e5", "student-1");
    expect(first.threadId).toMatch(THREAD_ID_PATTERN);
    expect(first.threadId).not.toBe(newThread("a1b2c3d4e5", "student-1").threadId);
    expect(
      verifyThreadToken(
        first.threadToken,
        { code: "a1b2c3d4e5", userId: "student-1", threadId: first.threadId },
        getThreadTokenSecret(),
      ),
    ).toBe(true);
  });
});
