import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMoodleConfigForTests } from "@/lib/moodle-config";
import { GET } from "./route";

vi.mock("@/lib/telemetry", () => ({ recordError: vi.fn(), emitEvent: vi.fn() }));

beforeEach(() => resetMoodleConfigForTests());

describe("GET /api/lti/jwks", () => {
  it("answers 404 without a key", async () => {
    vi.stubEnv("MOODLE_LTI_PRIVATE_KEY", "");
    expect((await GET()).status).toBe(404);
  });

  it("answers the public key set with the key alone (no connection needed)", async () => {
    vi.stubEnv(
      "MOODLE_LTI_PRIVATE_KEY",
      generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    );
    vi.stubEnv("MOODLE_LTI_ISSUER", "");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).not.toHaveProperty("d");
  });
});
