import { generateKeyPairSync } from "node:crypto";
import { compactVerify, importJWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  moodleAvailable,
  moodleConnection,
  moodleKeyConfigured,
  publicJwks,
  publicKeyPem,
  resetMoodleConfigForTests,
  signWithToolKey,
} from "./moodle-config";

vi.mock("@/lib/telemetry", () => ({ recordError: vi.fn(), emitEvent: vi.fn() }));

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function setConnection(issuer = "https://moodle.example.org/") {
  vi.stubEnv("MOODLE_LTI_ISSUER", issuer);
  vi.stubEnv("MOODLE_LTI_CLIENT_ID", "client-1");
  vi.stubEnv("MOODLE_LTI_DEPLOYMENT_ID", "7");
}

beforeEach(() => {
  resetMoodleConfigForTests();
  vi.stubEnv("MOODLE_LTI_PRIVATE_KEY", "");
  vi.stubEnv("MOODLE_LTI_ISSUER", "");
  vi.stubEnv("MOODLE_LTI_CLIENT_ID", "");
  vi.stubEnv("MOODLE_LTI_DEPLOYMENT_ID", "");
});

afterEach(() => vi.restoreAllMocks());

describe("moodleConnection", () => {
  it("is undefined when nothing is set, without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(moodleConnection()).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("derives Moodle's three endpoints from the Plattform-ID", () => {
    setConnection();
    expect(moodleConnection()).toEqual({
      issuer: "https://moodle.example.org",
      clientId: "client-1",
      deploymentId: "7",
      jwksUrl: "https://moodle.example.org/mod/lti/certs.php",
      tokenUrl: "https://moodle.example.org/mod/lti/token.php",
      authUrl: "https://moodle.example.org/mod/lti/auth.php",
    });
  });

  it("keeps a path in the Plattform-ID", () => {
    setConnection("http://127.0.0.1:8091/moodle");
    expect(moodleConnection()?.tokenUrl).toBe("http://127.0.0.1:8091/moodle/mod/lti/token.php");
  });

  it("treats a partial connection as missing and warns once by name only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("MOODLE_LTI_ISSUER", "https://moodle.example.org");
    vi.stubEnv("MOODLE_LTI_CLIENT_ID", "secret-looking-client");
    expect(moodleConnection()).toBeUndefined();
    expect(moodleConnection()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("MOODLE_LTI_DEPLOYMENT_ID");
    expect(String(warn.mock.calls[0])).not.toContain("secret-looking-client");
    expect(String(warn.mock.calls[0])).not.toContain("moodle.example.org");
  });

  it("refuses an issuer that is not an http(s) address", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setConnection("javascript:alert(1)");
    expect(moodleConnection()).toBeUndefined();
  });
});

describe("the tool key", () => {
  it("is not configured without the variable", async () => {
    expect(moodleKeyConfigured()).toBe(false);
    expect(await publicJwks()).toBeUndefined();
    expect(await publicKeyPem()).toBeUndefined();
  });

  it("publishes the public key with its RFC 7638 thumbprint as kid", async () => {
    vi.stubEnv("MOODLE_LTI_PRIVATE_KEY", PEM);
    const jwks = await publicJwks();
    expect(jwks?.keys).toHaveLength(1);
    const [key] = jwks?.keys ?? [];
    expect(key).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(key?.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).not.toHaveProperty("d");
    expect(await publicKeyPem()).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  });

  it("accepts a PEM written on one line with \\n escapes", async () => {
    vi.stubEnv("MOODLE_LTI_PRIVATE_KEY", PEM.replace(/\n/g, "\\n"));
    expect(await publicJwks()).toBeDefined();
  });

  it("signs with the published key", async () => {
    vi.stubEnv("MOODLE_LTI_PRIVATE_KEY", PEM);
    const jwt = await signWithToolKey({ iss: "client-1" }, "https://moodle.example.org");
    const [jwk] = (await publicJwks())?.keys ?? [];
    const { protectedHeader } = await compactVerify(jwt, await importJWK(jwk ?? {}, "RS256"));
    expect(protectedHeader).toMatchObject({ alg: "RS256", kid: jwk?.kid, typ: "JWT" });
  });

  it("counts a bad key as unusable and never logs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv(
      "MOODLE_LTI_PRIVATE_KEY",
      "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----",
    );
    setConnection();
    expect(moodleKeyConfigured()).toBe(true);
    expect(await publicJwks()).toBeUndefined();
    expect(await moodleAvailable()).toBeUndefined();
    expect(String(error.mock.calls)).not.toContain("not-a-key");
  });
});

describe("moodleAvailable", () => {
  it("needs the key and the complete connection", async () => {
    setConnection();
    expect(await moodleAvailable()).toBeUndefined();
    vi.stubEnv("MOODLE_LTI_PRIVATE_KEY", PEM);
    expect((await moodleAvailable())?.issuer).toBe("https://moodle.example.org");
  });

  it("is off with a key but no connection", async () => {
    vi.stubEnv("MOODLE_LTI_PRIVATE_KEY", PEM);
    expect(await moodleAvailable()).toBeUndefined();
  });
});
