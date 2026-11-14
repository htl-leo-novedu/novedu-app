import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubMoodleEnv } from "@/tests/fake-moodle";
import { postScore, resetAgsForTests, withPath } from "./moodle-ags";
import { type MoodleConnection, resetMoodleConfigForTests } from "./moodle-config";

// The grade-service client with `fetch` stubbed: the token request, the token
// cache and its drop on a 401, the score body, the result mapping, and that
// nothing but a status is ever logged.

vi.mock("@/lib/telemetry", () => ({ recordError: vi.fn(), emitEvent: vi.fn() }));

const CONNECTION: MoodleConnection = {
  issuer: "https://moodle.example.org",
  clientId: "client-1",
  deploymentId: "7",
  jwksUrl: "https://moodle.example.org/mod/lti/certs.php",
  tokenUrl: "https://moodle.example.org/mod/lti/token.php",
  authUrl: "https://moodle.example.org/mod/lti/auth.php",
};
const LINEITEM = "https://moodle.example.org/mod/lti/services.php/2/lineitems/5/lineitem?type_id=1";
const SCORE = { userId: "42", scoreGiven: 7, scoreMaximum: 10, comment: "Novedu quiz: …" };
const NOW = new Date("2026-11-14T10:00:00Z");

const fetchMock = vi.fn();
const tokenOk = () => Response.json({ access_token: "tok-1", expires_in: 3600 });

beforeEach(() => {
  resetMoodleConfigForTests();
  resetAgsForTests();
  stubMoodleEnv(vi.stubEnv, CONNECTION);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("withPath", () => {
  it("appends to the path before the query string", () => {
    expect(withPath(LINEITEM, "/scores")).toBe(
      "https://moodle.example.org/mod/lti/services.php/2/lineitems/5/lineitem/scores?type_id=1",
    );
  });
});

describe("postScore", () => {
  it("requests a score-scoped token, then posts the score", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(postScore(CONNECTION, LINEITEM, SCORE, NOW)).resolves.toBe("ok");

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] ?? [];
    expect(tokenUrl).toBe(CONNECTION.tokenUrl);
    const form = new URLSearchParams(String(tokenInit.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://purl.imsglobal.org/spec/lti-ags/scope/score");
    expect(form.get("client_assertion")?.split(".")).toHaveLength(3);

    const [scoreUrl, scoreInit] = fetchMock.mock.calls[1] ?? [];
    expect(scoreUrl).toBe(withPath(LINEITEM, "/scores"));
    expect(scoreInit.headers).toMatchObject({
      authorization: "Bearer tok-1",
      "content-type": "application/vnd.ims.lis.v1.score+json",
    });
    expect(JSON.parse(scoreInit.body)).toEqual({
      ...SCORE,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded",
      timestamp: NOW.toISOString(),
    });
  });

  it("reuses the token, and drops it on a 401 for one retry", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await postScore(CONNECTION, LINEITEM, SCORE, NOW);
    await postScore(CONNECTION, LINEITEM, SCORE, NOW);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(postScore(CONNECTION, LINEITEM, SCORE, NOW)).resolves.toBe("ok");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(CONNECTION.tokenUrl);
  });

  it("maps 404 to not-found and everything else to failed, logging only a status", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(postScore(CONNECTION, LINEITEM, SCORE, NOW)).resolves.toBe("not-found");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(postScore(CONNECTION, LINEITEM, SCORE, NOW)).resolves.toBe("failed");
    fetchMock.mockRejectedValueOnce(new Error(`network ${LINEITEM}`));
    await expect(postScore(CONNECTION, LINEITEM, SCORE, NOW)).resolves.toBe("failed");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("lineitem");
  });

  it("fails without throwing when the token request fails", async () => {
    resetAgsForTests();
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 400 }));
    await expect(postScore(CONNECTION, LINEITEM, SCORE, NOW)).resolves.toBe("failed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
