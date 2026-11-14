import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { fakeMoodle } from "@/tests/fake-moodle";
import type { MoodleConnection } from "./moodle-config";
import {
  type ArrivalToken,
  checkLaunchClaims,
  decideArrival,
  deepLinkingResponseClaims,
  donePath,
  insideIssuer,
  LTI,
  LTI_DL,
  moodleTokenKey,
  readLaunch,
  signMoodleToken,
  verifyMoodleToken,
} from "./moodle-launch";

// The launch, as pure functions with real crypto (docs/testing.md: security
// modules stay real). A fake platform signs the id_tokens with its own key.

const CONNECTION: MoodleConnection = {
  issuer: "https://moodle.example.org",
  clientId: "client-1",
  deploymentId: "7",
  jwksUrl: "https://moodle.example.org/mod/lti/certs.php",
  tokenUrl: "https://moodle.example.org/mod/lti/token.php",
  authUrl: "https://moodle.example.org/mod/lti/auth.php",
};
const platform = fakeMoodle({ issuer: CONNECTION.issuer, clientId: "client-1", deploymentId: "7" });
const SECRET = "test-auth-secret";
const key = (purpose: "state" | "pick" | "arrival") => moodleTokenKey(purpose, SECRET);

const ARRIVAL: ArrivalToken = {
  sub: "42",
  name: "Mia Muster",
  username: "mmuster",
  code: "quiz-code1",
  course: "Math 3A",
  lineitem: "https://moodle.example.org/mod/lti/services.php/2/lineitems/5/lineitem",
};

describe("the signed tokens", () => {
  it("round-trip their payload", async () => {
    const token = await signMoodleToken("arrival", ARRIVAL, key("arrival"));
    await expect(verifyMoodleToken("arrival", token, key("arrival"))).resolves.toEqual(ARRIVAL);
    const state = await signMoodleToken("state", { nonce: "n1" }, key("state"));
    await expect(verifyMoodleToken("state", state, key("state"))).resolves.toEqual({ nonce: "n1" });
  });

  it("refuse a token of another purpose, even under the same key", async () => {
    const state = await signMoodleToken("state", { nonce: "n1" }, key("pick"));
    await expect(verifyMoodleToken("pick", state, key("pick"))).resolves.toBeUndefined();
  });

  it("refuse another label's key", async () => {
    const token = await signMoodleToken("arrival", ARRIVAL, key("state"));
    await expect(verifyMoodleToken("arrival", token, key("arrival"))).resolves.toBeUndefined();
    const other = moodleTokenKey("arrival", "another-secret");
    await expect(verifyMoodleToken("arrival", token, other)).resolves.toBeUndefined();
  });

  it("refuse a tampered token", async () => {
    const token = await signMoodleToken("arrival", ARRIVAL, key("arrival"));
    const [header, payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...ARRIVAL, sub: "1", typ: "arrival" })).toString(
      "base64url",
    );
    expect(payload).not.toBe(forged);
    await expect(
      verifyMoodleToken("arrival", `${header}.${forged}.${signature}`, key("arrival")),
    ).resolves.toBeUndefined();
  });

  it("refuse an expired token", async () => {
    const expired = await new SignJWT({ nonce: "n1", typ: "state" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key("state"));
    await expect(verifyMoodleToken("state", expired, key("state"))).resolves.toBeUndefined();
  });

  it("refuse garbage and an arrival with a malformed code", async () => {
    await expect(verifyMoodleToken("state", undefined, key("state"))).resolves.toBeUndefined();
    await expect(verifyMoodleToken("state", "a.b.c", key("state"))).resolves.toBeUndefined();
    const bad = await signMoodleToken(
      "arrival",
      { ...ARRIVAL, code: "NOT A CODE" },
      key("arrival"),
    );
    await expect(verifyMoodleToken("arrival", bad, key("arrival"))).resolves.toBeUndefined();
  });
});

describe("insideIssuer", () => {
  it.each([
    ["https://moodle.example.org/mod/lti/x", true],
    ["https://moodle.example.org", true],
    ["https://moodle.example.org.evil.test/mod/lti/x", false],
    ["https://evil.test/https://moodle.example.org/", false],
    ["http://moodle.example.org/mod/lti/x", false],
    [42, false],
  ])("%s → %s", (url, inside) => {
    expect(insideIssuer(url, "https://moodle.example.org")).toBe(inside);
  });

  it("respects a path in the Plattform-ID", () => {
    expect(insideIssuer("https://h.test/moodle/mod/x", "https://h.test/moodle")).toBe(true);
    expect(insideIssuer("https://h.test/moodle2/mod/x", "https://h.test/moodle")).toBe(false);
  });
});

describe("readLaunch", () => {
  const launch = async (claims: Record<string, unknown>, nonce = "n1") =>
    readLaunch(await platform.sign(claims), CONNECTION, nonce, await platform.keySet());

  it("reads a learner's resource launch into an arrival", async () => {
    const message = await launch(platform.resourceClaims({ nonce: "n1", code: "quiz-code1" }));
    expect(message).toEqual({
      kind: "resource",
      code: "quiz-code1",
      learner: true,
      arrival: {
        sub: "moodle-user-7",
        name: "Mia Muster",
        username: "mmuster",
        course: "Math 3A",
        lineitem: `${CONNECTION.issuer}/mod/lti/services.php/2/lineitems/5/lineitem?type_id=1`,
      },
    });
  });

  it("refuses a token of another platform key, issuer, audience or an expired one", async () => {
    const other = fakeMoodle({
      issuer: CONNECTION.issuer,
      clientId: "client-1",
      deploymentId: "7",
    });
    const claims = platform.resourceClaims({ nonce: "n1", code: "quiz-code1" });
    const keys = await platform.keySet();
    for (const token of [
      await other.sign(claims),
      await fakeMoodle({
        issuer: "https://other.test",
        clientId: "client-1",
        deploymentId: "7",
      }).sign(claims),
      await fakeMoodle({ issuer: CONNECTION.issuer, clientId: "client-2", deploymentId: "7" }).sign(
        claims,
      ),
      await platform.sign(claims, { expiresIn: "-1m" }),
      "garbage",
    ]) {
      await expect(readLaunch(token, CONNECTION, "n1", keys)).resolves.toEqual({
        kind: "refused",
        reason: "token",
      });
    }
  });

  it("refuses a wrong nonce, deployment, version or message type", async () => {
    const claims = platform.resourceClaims({ nonce: "n1", code: "quiz-code1" });
    await expect(launch(claims, "n2")).resolves.toMatchObject({ reason: "nonce" });
    await expect(launch({ ...claims, [`${LTI}deployment_id`]: "8" })).resolves.toMatchObject({
      reason: "deployment",
    });
    await expect(launch({ ...claims, [`${LTI}version`]: "1.1" })).resolves.toMatchObject({
      reason: "version",
    });
    await expect(launch({ ...claims, [`${LTI}message_type`]: "Other" })).resolves.toMatchObject({
      reason: "message-type",
    });
  });

  it("refuses a grade column outside the Plattform-ID", async () => {
    await expect(
      launch(
        platform.resourceClaims({
          nonce: "n1",
          code: "quiz-code1",
          lineitem: "https://evil.test/x",
        }),
      ),
    ).resolves.toEqual({ kind: "refused", reason: "lineitem" });
  });

  it("reads a non-learner, a missing grade column, no name and a bad code", async () => {
    const teacher = await launch(
      platform.resourceClaims({
        nonce: "n1",
        code: "quiz-code1",
        roles: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"],
      }),
    );
    expect(teacher).toMatchObject({ kind: "resource", learner: false });
    const noLineitem = await launch(
      platform.resourceClaims({ nonce: "n1", code: "quiz-code1", lineitem: null }),
    );
    expect(noLineitem).toMatchObject({ kind: "resource", learner: true, arrival: null });
    const noName = await launch(
      platform.resourceClaims({ nonce: "n1", code: "quiz-code1", name: null }),
    );
    expect(noName).toMatchObject({ arrival: { name: null } });
    const badCode = await launch(platform.resourceClaims({ nonce: "n1", code: "../admin" }));
    expect(badCode).toMatchObject({ kind: "resource", code: null });
    const noCode = await launch(platform.resourceClaims({ nonce: "n1" }));
    expect(noCode).toMatchObject({ kind: "resource", code: null });
  });

  it("reads a deep-linking request and checks its return URL", async () => {
    await expect(launch(platform.deepLinkClaims({ nonce: "n1", data: "opaque" }))).resolves.toEqual(
      {
        kind: "deep-link",
        pick: {
          returnUrl: `${CONNECTION.issuer}/mod/lti/contentitem_return.php?course=2`,
          data: "opaque",
        },
      },
    );
    await expect(
      launch(platform.deepLinkClaims({ nonce: "n1", returnUrl: "https://evil.test/return" })),
    ).resolves.toEqual({ kind: "refused", reason: "return-url" });
  });

  it("falls back to given and family name", () => {
    const message = checkLaunchClaims(
      {
        ...platform.resourceClaims({ nonce: "n1", code: "quiz-code1", name: null }),
        given_name: "Mia",
        family_name: "Muster",
      },
      CONNECTION,
      "n1",
    );
    expect(message).toMatchObject({ arrival: { name: "Mia Muster" } });
  });
});

describe("deepLinkingResponseClaims", () => {
  it("answers one resource link with the code and a grade column of 100", () => {
    const claims = deepLinkingResponseClaims({
      connection: CONNECTION,
      origin: "https://novedu.example",
      code: "quiz-code1",
      note: "Fractions",
      data: "opaque",
      nonce: "n9",
    });
    expect(claims).toEqual({
      iss: "client-1",
      nonce: "n9",
      [`${LTI}message_type`]: "LtiDeepLinkingResponse",
      [`${LTI}version`]: "1.3.0",
      [`${LTI}deployment_id`]: "7",
      [`${LTI_DL}data`]: "opaque",
      [`${LTI_DL}content_items`]: [
        {
          type: "ltiResourceLink",
          title: "Novedu: Fractions",
          url: "https://novedu.example/api/lti/launch",
          custom: { novedu_code: "quiz-code1" },
          lineItem: { scoreMaximum: 100, label: "Novedu: Fractions" },
        },
      ],
    });
  });

  it("titles a code without a note by the code and leaves out absent data", () => {
    const claims = deepLinkingResponseClaims({
      connection: CONNECTION,
      origin: "https://novedu.example",
      code: "quiz-code1",
      note: "",
      data: null,
      nonce: "n9",
    });
    expect(claims).not.toHaveProperty(`${LTI_DL}data`);
    expect(JSON.stringify(claims)).toContain('"title":"Novedu: quiz-code1"');
  });
});

describe("decideArrival", () => {
  const none = { ownMoodleUserId: null, moodleUserOwner: null };

  it.each([
    ["no arrival", undefined, none, "expired"],
    ["both unlinked", ARRIVAL, none, "confirm"],
    ["linked to each other", ARRIVAL, { ownMoodleUserId: "42", moodleUserOwner: "u1" }, "linked"],
    [
      "Moodle account linked to someone else",
      ARRIVAL,
      { ownMoodleUserId: null, moodleUserOwner: "u2" },
      "mismatch-moodle",
    ],
    [
      "Novedu account linked to another Moodle account",
      ARRIVAL,
      { ownMoodleUserId: "43", moodleUserOwner: null },
      "mismatch-novedu",
    ],
    ["no name", { ...ARRIVAL, name: null }, none, "no-name"],
    [
      "no name but already linked",
      { ...ARRIVAL, name: null },
      { ownMoodleUserId: "42", moodleUserOwner: "u1" },
      "linked",
    ],
  ] as const)("%s → %s", (_label, arrival, links, decision) => {
    expect(decideArrival("u1", arrival, links)).toBe(decision);
  });
});

describe("donePath", () => {
  it("carries the state and a pattern-checked code only", () => {
    expect(donePath("expired", "quiz-code1")).toBe("/lti/done?state=expired&code=quiz-code1");
    expect(donePath("no-name", "Bad Code")).toBe("/lti/done?state=no-name");
    expect(donePath("declined", null)).toBe("/lti/done?state=declined");
  });
});
