import { decodeJwt, decodeProtectedHeader } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicJwks, resetMoodleConfigForTests } from "@/lib/moodle-config";
import { LTI, LTI_DL, signMoodleToken } from "@/lib/moodle-launch";
import { stubMoodleEnv } from "@/tests/fake-moodle";

// The picker's answer: a signed deep-linking response posted back to the
// return URL from the signed pick token — or a redirect back to the picker with
// a fixed error key. Real tokens and the real tool key; the code row is a stand-in.

const mocks = vi.hoisted(() => ({ getCode: vi.fn() }));
vi.mock("@/lib/code-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-store")>()),
  getCode: mocks.getCode,
}));
vi.mock("@/lib/app-origin", () => ({ resolveAppOrigin: async () => "https://novedu.example" }));
vi.mock("@/lib/telemetry", () => ({ emitEvent: vi.fn(), recordError: vi.fn() }));

import { POST } from "./route";

const ISSUER = "https://moodle.example.org";
const RETURN_URL = `${ISSUER}/mod/lti/contentitem_return.php?course=2&id=5`;
const QUIZ = { code: "quiz-code1", module: "quiz", moodle: true, note: "Fractions" };

async function pick(code: string, token?: string): Promise<Response> {
  const t = token ?? (await signMoodleToken("pick", { returnUrl: RETURN_URL, data: "d1" }));
  return POST(
    new Request("https://novedu.example/api/lti/pick", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t, code }),
    }),
  );
}

beforeEach(() => {
  resetMoodleConfigForTests();
  stubMoodleEnv(vi.stubEnv, { issuer: ISSUER, clientId: "client-1", deploymentId: "7" });
  mocks.getCode.mockResolvedValue(QUIZ);
});

describe("POST /api/lti/pick", () => {
  it("answers an auto-submitting form with the signed deep-linking response", async () => {
    const response = await pick("https://novedu.example/QUIZ-CODE1");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`action="${RETURN_URL.replace("&", "&amp;")}"`);
    const jwt = /name="JWT" value="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(decodeProtectedHeader(jwt)).toMatchObject({
      alg: "RS256",
      kid: (await publicJwks())?.keys[0]?.kid,
    });
    const claims = decodeJwt(jwt);
    expect(claims).toMatchObject({
      iss: "client-1",
      aud: ISSUER,
      [`${LTI}message_type`]: "LtiDeepLinkingResponse",
      [`${LTI}deployment_id`]: "7",
      [`${LTI_DL}data`]: "d1",
    });
    expect(claims[`${LTI_DL}content_items`]).toEqual([
      expect.objectContaining({
        title: "Novedu: Fractions",
        url: "https://novedu.example/api/lti/launch",
        custom: { novedu_code: "quiz-code1" },
      }),
    ]);
    expect(mocks.getCode).toHaveBeenCalledWith("quiz-code1");
  });

  it.each([
    ["an unknown code", null, "unknown"],
    ["another module", { ...QUIZ, module: "tutor" }, "not-quiz"],
    ["a quiz without the switch", { ...QUIZ, moodle: false }, "not-enabled"],
    ["a failed lookup", undefined, "unavailable"],
  ])("sends %s back to the picker with its error key", async (_label, entry, error) => {
    mocks.getCode.mockResolvedValue(entry);
    const response = await pick("quiz-code1");
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/lti/pick");
    expect(location.searchParams.get("error")).toBe(error);
    expect(location.searchParams.get("t")).toBeTruthy();
  });

  it("treats input that cannot be a code as unknown without a lookup", async () => {
    const response = await pick("not a code!");
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "unknown",
    );
    expect(mocks.getCode).not.toHaveBeenCalled();
  });

  it("sends an invalid token to the expired picker", async () => {
    const response = await pick("quiz-code1", "forged");
    expect(response.headers.get("location")).toBe("https://novedu.example/lti/pick");
    expect(mocks.getCode).not.toHaveBeenCalled();
  });

  it("answers 404 while Moodle is not available", async () => {
    vi.stubEnv("MOODLE_LTI_PRIVATE_KEY", "");
    expect((await pick("quiz-code1")).status).toBe(404);
  });
});
