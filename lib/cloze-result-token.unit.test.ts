import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ClozeResultPayload,
  getClozeResultSecret,
  resetClozeResultSecretForTests,
  signClozeResultToken,
  verifyClozeResultToken,
} from "./cloze-result-token";
import { getThreadTokenSecret, resetThreadTokenSecretForTests } from "./thread-token";

// The cloze result token with the REAL HMAC (security-critical, never mocked).

const SECRET = "test-secret";
const payload: ClozeResultPayload = {
  code: "a1b2c3d4e5",
  userId: "u1",
  attemptId: "11111111-1111-4111-8111-111111111111",
  answers: ["will", "", "starts"],
  verdicts: ["incorrect", "incorrect", "correct"],
};

beforeEach(() => {
  resetClozeResultSecretForTests();
  resetThreadTokenSecretForTests();
});

describe("cloze result token", () => {
  it("verifies its own signature", () => {
    const token = signClozeResultToken(payload, SECRET);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyClozeResultToken(token, payload, SECRET)).toBe(true);
  });

  it.each([
    ["code", { code: "other" }],
    ["user", { userId: "u2" }],
    ["attempt", { attemptId: "22222222-2222-4222-8222-222222222222" }],
    ["answers", { answers: ["will", "", "start"] }],
    ["verdicts", { verdicts: ["correct", "incorrect", "correct"] }],
  ] as const)("rejects a token for another %s", (_, change) => {
    const token = signClozeResultToken(payload, SECRET);
    expect(verifyClozeResultToken(token, { ...payload, ...change }, SECRET)).toBe(false);
  });

  it("rejects a token signed with another secret, a non-hex suffix, and non-strings", () => {
    const token = signClozeResultToken(payload, SECRET);
    expect(verifyClozeResultToken(signClozeResultToken(payload, "x"), payload, SECRET)).toBe(false);
    expect(verifyClozeResultToken(`${token}zz`, payload, SECRET)).toBe(false);
    expect(verifyClozeResultToken(undefined, payload, SECRET)).toBe(false);
    expect(verifyClozeResultToken("", payload, SECRET)).toBe(false);
  });

  it("does not let answers shift between fields (array encoding is injective)", () => {
    const a = signClozeResultToken({ ...payload, answers: ["a,b"], verdicts: ["correct"] }, SECRET);
    const b = signClozeResultToken(
      { ...payload, answers: ["a", "b"], verdicts: ["correct"] },
      SECRET,
    );
    expect(a).not.toBe(b);
  });

  it("derives its own key domain from AUTH_SECRET, distinct from the thread token's", () => {
    vi.stubEnv("AUTH_SECRET", "auth-secret");
    expect(getClozeResultSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(getClozeResultSecret()).not.toBe(getThreadTokenSecret());
  });

  it("refuses to sign without AUTH_SECRET", () => {
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => getClozeResultSecret()).toThrow(/AUTH_SECRET/);
  });
});
