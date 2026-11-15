import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMoodleConfigForTests } from "@/lib/moodle-config";
import {
  ARRIVAL_COOKIE,
  LEARNER_ROLE,
  signMoodleToken,
  verifyMoodleToken,
} from "@/lib/moodle-launch";
import { fakeMoodle, stubMoodleEnv } from "@/tests/fake-moodle";

// The public launch handler: state, Moodle's signed message, then a 303 to the
// picker, to /lti/arrive with the arrival cookie, or to the quiz. Real crypto
// throughout; only Moodle's remote key set, the code row and the origin are
// stand-ins.

const platform = fakeMoodle({
  issuer: "https://moodle.example.org",
  clientId: "client-1",
  deploymentId: "7",
});
const mocks = vi.hoisted(() => ({
  getCode: vi.fn(),
  keySet: undefined as unknown,
  emitEvent: vi.fn(),
}));
vi.mock("@/lib/code-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-store")>()),
  getCode: mocks.getCode,
}));
vi.mock("@/lib/app-origin", () => ({ resolveAppOrigin: async () => "https://novedu.example" }));
vi.mock("@/lib/telemetry", () => ({ emitEvent: mocks.emitEvent, recordError: vi.fn() }));
vi.mock("@/lib/moodle-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moodle-http")>()),
  moodleKeySet: () => mocks.keySet,
}));

import { POST } from "./route";

const QUIZ = { code: "quiz-code1", module: "quiz", moodle: true };

async function launch(claims: Record<string, unknown>, nonce = "n1"): Promise<Response> {
  const body = new URLSearchParams({
    state: await signMoodleToken("state", { nonce }),
    id_token: await platform.sign(claims),
  });
  return POST(
    new Request("https://novedu.example/api/lti/launch", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
}

beforeEach(async () => {
  resetMoodleConfigForTests();
  stubMoodleEnv(vi.stubEnv, platform);
  mocks.keySet = await platform.keySet();
  mocks.getCode.mockResolvedValue(QUIZ);
});

describe("POST /api/lti/launch", () => {
  it("answers 404 while Moodle is not available", async () => {
    vi.stubEnv("MOODLE_LTI_ISSUER", "");
    vi.stubEnv("MOODLE_LTI_CLIENT_ID", "");
    vi.stubEnv("MOODLE_LTI_DEPLOYMENT_ID", "");
    expect(
      (await launch(platform.resourceClaims({ nonce: "n1", code: "quiz-code1" }))).status,
    ).toBe(404);
  });

  it("sets the signed arrival cookie for a learner and goes to /lti/arrive", async () => {
    const response = await launch(platform.resourceClaims({ nonce: "n1", code: "quiz-code1" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://novedu.example/lti/arrive");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${ARRIVAL_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\/lti(;|$)/);
    expect(cookie).toMatch(/Max-Age=900/);
    expect(cookie).toMatch(/Secure/);
    const token = /=([^;]+)/.exec(cookie)?.[1];
    await expect(verifyMoodleToken("arrival", token)).resolves.toMatchObject({
      sub: "moodle-user-7",
      name: "Mia Muster",
      code: "quiz-code1",
    });
    // Nothing personal travels in the address.
    expect(response.headers.get("location")).not.toContain("moodle-user-7");
  });

  it("refuses a missing or expired state with 401", async () => {
    const response = await POST(
      new Request("https://novedu.example/api/lti/launch", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ state: "nope", id_token: "x" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a token signed by someone else with 401 and a plain message", async () => {
    mocks.keySet = await fakeMoodle(platform).keySet();
    const response = await launch(platform.resourceClaims({ nonce: "n1", code: "quiz-code1" }));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Novedu could not accept this launch from Moodle.");
  });

  it("refuses a grade column outside the Plattform-ID with 400", async () => {
    const response = await launch(
      platform.resourceClaims({
        nonce: "n1",
        code: "quiz-code1",
        lineitem: "https://evil.test/li",
      }),
    );
    expect(response.status).toBe(400);
  });

  it.each([
    ["an unknown code", null],
    ["a code without the switch", { ...QUIZ, moodle: false }],
  ])("just opens the quiz for %s", async (_label, entry) => {
    mocks.getCode.mockResolvedValue(entry);
    const response = await launch(platform.resourceClaims({ nonce: "n1", code: "quiz-code1" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://novedu.example/quiz-code1");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("just opens the quiz for a non-learner or a launch without a grade column", async () => {
    for (const claims of [
      platform.resourceClaims({
        nonce: "n1",
        code: "quiz-code1",
        roles: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"],
      }),
      platform.resourceClaims({
        nonce: "n1",
        code: "quiz-code1",
        lineitem: null,
        roles: [LEARNER_ROLE],
      }),
    ]) {
      const response = await launch(claims);
      expect(response.headers.get("location")).toBe("https://novedu.example/quiz-code1");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("sends a launch without a usable code to the start page", async () => {
    const response = await launch(platform.resourceClaims({ nonce: "n1" }));
    expect(response.headers.get("location")).toBe("https://novedu.example/");
    expect(mocks.getCode).not.toHaveBeenCalled();
  });

  it("sends a deep-linking request to the picker with a signed pick token", async () => {
    const response = await launch(platform.deepLinkClaims({ nonce: "n1", data: "d" }));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/lti/pick");
    await expect(verifyMoodleToken("pick", location.searchParams.get("t"))).resolves.toEqual({
      returnUrl: "https://moodle.example.org/mod/lti/contentitem_return.php?course=2",
      data: "d",
    });
  });

  it("reports outcomes as content-free events", async () => {
    await launch(platform.resourceClaims({ nonce: "n1", code: "quiz-code1" }));
    expect(mocks.emitEvent).toHaveBeenCalledWith("moodle.launch", {
      "novedu.moodle.outcome": "arrival",
    });
  });
});
