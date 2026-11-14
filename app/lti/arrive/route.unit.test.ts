import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMoodleConfigForTests } from "@/lib/moodle-config";
import { ARRIVAL_COOKIE, type ArrivalToken, signMoodleToken } from "@/lib/moodle-launch";
import { stubMoodleEnv } from "@/tests/fake-moodle";

// `/lti/arrive`: the gated handler that turns a verified arrival cookie into a
// redirect — the quiz (storing the target) for a linked student, the
// confirmation page for an unlinked one, `/lti/done` otherwise — and clears
// the cookie on every outcome but the confirmation. Real tokens; the session
// and the store are stand-ins.

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  findLinkState: vi.fn(),
  storeTarget: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/moodle-store", () => ({
  findLinkState: mocks.findLinkState,
  storeTarget: mocks.storeTarget,
}));
vi.mock("@/lib/app-origin", () => ({ resolveAppOriginOr: async () => "https://novedu.example" }));
vi.mock("@/lib/telemetry", () => ({ emitEvent: vi.fn(), recordError: vi.fn() }));

import { GET } from "./route";

const ISSUER = "https://moodle.example.org";
const ARRIVAL: ArrivalToken = {
  sub: "42",
  name: "Mia Muster",
  username: "mmuster",
  code: "quiz-code1",
  course: "Math 3A",
  lineitem: `${ISSUER}/mod/lti/services.php/2/lineitems/5/lineitem`,
};

async function arrive(arrival: ArrivalToken | null = ARRIVAL): Promise<Response> {
  const request = new NextRequest("https://novedu.example/lti/arrive");
  if (arrival) request.cookies.set(ARRIVAL_COOKIE, await signMoodleToken("arrival", arrival));
  return GET(request);
}

const location = (response: Response) => response.headers.get("location");
const cleared = (response: Response) =>
  /novedu-lti-arrival=;.*Path=\/lti/.test(response.headers.get("set-cookie") ?? "");

beforeEach(() => {
  resetMoodleConfigForTests();
  stubMoodleEnv(vi.stubEnv, { issuer: ISSUER, clientId: "c", deploymentId: "1" });
  mocks.getSession.mockResolvedValue({ user: { id: "u1" } });
  mocks.findLinkState.mockResolvedValue({ ownMoodleUserId: null, moodleUserOwner: null });
  mocks.storeTarget.mockResolvedValue(true);
});

describe("GET /lti/arrive", () => {
  it("sends a signed-out student to sign-in and back here", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await arrive();
    expect(location(response)).toBe("https://novedu.example/sign-in?callbackURL=%2Flti%2Farrive");
    expect(cleared(response)).toBe(false);
  });

  it("sends an unlinked student to the confirmation page and keeps the cookie", async () => {
    const response = await arrive();
    expect(location(response)).toBe("https://novedu.example/lti/link");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.findLinkState).toHaveBeenCalledWith(ISSUER, "u1", "42");
  });

  it("stores the target of a linked student, clears the cookie and opens the quiz", async () => {
    mocks.findLinkState.mockResolvedValue({ ownMoodleUserId: "42", moodleUserOwner: "u1" });
    const response = await arrive();
    expect(location(response)).toBe("https://novedu.example/quiz-code1");
    expect(mocks.storeTarget).toHaveBeenCalledWith(ISSUER, "u1", {
      code: "quiz-code1",
      lineitemUrl: ARRIVAL.lineitem,
    });
    expect(cleared(response)).toBe(true);
  });

  it.each([
    ["no cookie", null, undefined, "/lti/done?state=expired"],
    [
      "a Moodle account linked to someone else",
      ARRIVAL,
      { ownMoodleUserId: null, moodleUserOwner: "u2" },
      "/lti/done?state=mismatch-moodle&code=quiz-code1",
    ],
    [
      "a Novedu account linked to another Moodle account",
      ARRIVAL,
      { ownMoodleUserId: "43", moodleUserOwner: null },
      "/lti/done?state=mismatch-novedu&code=quiz-code1",
    ],
    [
      "no name",
      { ...ARRIVAL, name: null },
      { ownMoodleUserId: null, moodleUserOwner: null },
      "/lti/done?state=no-name&code=quiz-code1",
    ],
    ["an unreadable link state", ARRIVAL, undefined, "/lti/done?state=unavailable&code=quiz-code1"],
  ] as const)(
    "clears the cookie and shows the message for %s",
    async (_label, arrival, links, path) => {
      mocks.findLinkState.mockResolvedValue(links);
      const response = await arrive(arrival);
      expect(location(response)).toBe(`https://novedu.example${path}`);
      expect(cleared(response)).toBe(true);
      expect(mocks.storeTarget).not.toHaveBeenCalled();
    },
  );

  it("treats an arrival as expired while Moodle is not available", async () => {
    vi.stubEnv("MOODLE_LTI_ISSUER", "");
    const response = await arrive();
    expect(location(response)).toBe(
      "https://novedu.example/lti/done?state=expired&code=quiz-code1",
    );
  });
});
