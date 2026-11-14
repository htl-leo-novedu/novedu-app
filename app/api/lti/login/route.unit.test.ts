import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMoodleConfigForTests } from "@/lib/moodle-config";
import { verifyMoodleToken } from "@/lib/moodle-launch";
import { stubMoodleEnv } from "@/tests/fake-moodle";

vi.mock("@/lib/app-origin", () => ({ resolveAppOrigin: async () => "https://novedu.example" }));
vi.mock("@/lib/telemetry", () => ({ emitEvent: vi.fn(), recordError: vi.fn() }));

import { GET, POST } from "./route";

// The start of the launch: Moodle's login request becomes a redirect to its
// authorization endpoint, carrying a signed state whose nonce is the request's.

const CONNECTION = {
  issuer: "https://moodle.example.org",
  clientId: "client-1",
  deploymentId: "7",
};
const PARAMS = {
  iss: "https://moodle.example.org",
  client_id: "client-1",
  login_hint: "2",
  lti_message_hint: '{"cmid":5}',
  target_link_uri: "https://novedu.example/api/lti/launch",
};

beforeEach(() => {
  resetMoodleConfigForTests();
  stubMoodleEnv(vi.stubEnv, CONNECTION);
});

const get = (params: Record<string, string>) =>
  GET(new Request(`https://novedu.example/api/lti/login?${new URLSearchParams(params)}`));

describe("/api/lti/login", () => {
  it("redirects to Moodle's authorization endpoint with a signed state", async () => {
    const response = await get(PARAMS);
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "");
    expect(`${target.origin}${target.pathname}`).toBe(
      "https://moodle.example.org/mod/lti/auth.php",
    );
    const query = Object.fromEntries(target.searchParams);
    expect(query).toMatchObject({
      scope: "openid",
      response_type: "id_token",
      response_mode: "form_post",
      prompt: "none",
      client_id: "client-1",
      redirect_uri: "https://novedu.example/api/lti/launch",
      login_hint: "2",
      lti_message_hint: '{"cmid":5}',
    });
    const state = await verifyMoodleToken("state", query.state);
    expect(state?.nonce).toBe(query.nonce);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("accepts the same request as a form POST", async () => {
    const response = await POST(
      new Request("https://novedu.example/api/lti/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(PARAMS),
      }),
    );
    expect(response.status).toBe(302);
  });

  it("refuses another platform or client id with 400", async () => {
    expect((await get({ ...PARAMS, iss: "https://other.test" })).status).toBe(400);
    expect((await get({ ...PARAMS, client_id: "client-2" })).status).toBe(400);
    const { login_hint: _drop, ...noHint } = PARAMS;
    expect((await get(noHint)).status).toBe(400);
  });

  it("answers 404 while Moodle is not available", async () => {
    vi.stubEnv("MOODLE_LTI_PRIVATE_KEY", "");
    expect((await get(PARAMS)).status).toBe(404);
  });
});
