import { generateKeyPairSync, type KeyObject, randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, type JWK, type JWTPayload, SignJWT } from "jose";
import { LEARNER_ROLE, LTI, LTI_AGS, LTI_DL } from "@/lib/moodle-launch";

// A fake Moodle platform for tests (docs/testing.md, "Moodle"): its own key
// pair, signed `id_token`s with chosen claims, and its key set. The unit tests
// verify against `keySet()`; the @live-db round trip serves `jwks()` from a
// small HTTP server under the fake's issuer address.

export interface FakeMoodle {
  issuer: string;
  clientId: string;
  deploymentId: string;
  jwks(): Promise<{ keys: JWK[] }>;
  keySet(): Promise<ReturnType<typeof createLocalJWKSet>>;
  /** Signs `claims` as Moodle would (RS256, issuer, audience = client id, 5 minutes). */
  sign(claims: JWTPayload, options?: { expiresIn?: string }): Promise<string>;
  /** The claims of a learner's resource launch for `code`. */
  resourceClaims(input: {
    nonce: string;
    code?: string;
    sub?: string;
    name?: string | null;
    username?: string;
    roles?: string[];
    lineitem?: string | null;
    course?: string;
  }): JWTPayload;
  /** The claims of a teacher's deep-linking request. */
  deepLinkClaims(input: { nonce: string; returnUrl?: string; data?: string }): JWTPayload;
}

export function fakeMoodle(input: {
  issuer: string;
  clientId: string;
  deploymentId: string;
}): FakeMoodle {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomUUID();
  const publicJwk = async (): Promise<JWK> => ({
    ...(await exportJWK(publicKey as KeyObject)),
    kid,
    alg: "RS256",
    use: "sig",
  });
  const base = (nonce: string, type: string): JWTPayload => ({
    nonce,
    [`${LTI}deployment_id`]: input.deploymentId,
    [`${LTI}version`]: "1.3.0",
    [`${LTI}message_type`]: type,
  });

  return {
    ...input,
    jwks: async () => ({ keys: [await publicJwk()] }),
    keySet: async () => createLocalJWKSet({ keys: [await publicJwk()] }),
    sign: (claims, options) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(input.issuer)
        .setAudience(input.clientId)
        .setIssuedAt()
        .setExpirationTime(options?.expiresIn ?? "5m")
        .sign(privateKey),
    resourceClaims: (claims) => ({
      ...base(claims.nonce, "LtiResourceLinkRequest"),
      sub: claims.sub ?? "moodle-user-7",
      ...(claims.name === null ? {} : { name: claims.name ?? "Mia Muster" }),
      [`${LTI}roles`]: claims.roles ?? [LEARNER_ROLE],
      [`${LTI}custom`]: claims.code === undefined ? {} : { novedu_code: claims.code },
      [`${LTI}ext`]: { user_username: claims.username ?? "mmuster" },
      [`${LTI}context`]: { id: "2", title: claims.course ?? "Math 3A" },
      ...(claims.lineitem === null
        ? {}
        : {
            [`${LTI_AGS}endpoint`]: {
              scope: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
              lineitem:
                claims.lineitem ??
                `${input.issuer}/mod/lti/services.php/2/lineitems/5/lineitem?type_id=1`,
            },
          }),
    }),
    deepLinkClaims: (claims) => ({
      ...base(claims.nonce, "LtiDeepLinkingRequest"),
      sub: "moodle-teacher-1",
      [`${LTI_DL}deep_linking_settings`]: {
        deep_link_return_url:
          claims.returnUrl ?? `${input.issuer}/mod/lti/contentitem_return.php?course=2`,
        accept_types: ["ltiResourceLink"],
        ...(claims.data === undefined ? {} : { data: claims.data }),
      },
    }),
  };
}

let toolPem: string | undefined;

/**
 * Stubs the four Moodle variables (a throwaway tool key, generated once per
 * test file) and AUTH_SECRET for a unit test, so `moodleAvailable()` answers
 * the given connection. The caller resets `resetMoodleConfigForTests()`.
 */
export function stubMoodleEnv(
  stubEnv: (name: string, value: string) => unknown,
  connection: { issuer: string; clientId: string; deploymentId: string },
): void {
  toolPem ??= generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  stubEnv("MOODLE_LTI_PRIVATE_KEY", toolPem);
  stubEnv("MOODLE_LTI_ISSUER", connection.issuer);
  stubEnv("MOODLE_LTI_CLIENT_ID", connection.clientId);
  stubEnv("MOODLE_LTI_DEPLOYMENT_ID", connection.deploymentId);
  stubEnv("AUTH_SECRET", "test-auth-secret");
}
