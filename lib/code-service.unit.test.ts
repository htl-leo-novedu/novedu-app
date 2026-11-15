import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared create-code pipeline behind BOTH the web form action and the
// bearer API route. These tests pin the policy: validate-before-store ordering,
// the save-time provider gate, the structured-error pass-through, the frozen
// anonymous flag, and the reason discriminants each transport maps from. The
// module validator and the store are mocked; validateCodeRequest stays real.

const mocks = vi.hoisted(() => ({
  validateCodeFile: vi.fn(),
  createCode: vi.fn(),
  getCode: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: "localhost:3000" })),
}));
vi.mock("@/lib/app-hosted-fetcher", () => ({ appHostedFetcher: () => vi.fn() }));
vi.mock("@/lib/code-modules/registry", () => ({ validateCodeFile: mocks.validateCodeFile }));
vi.mock("@/lib/code-store", async (importOriginal) => {
  // Keep the REAL validateCodeRequest — its checks are part of the pipeline
  // under test; only the storage calls are mocked.
  const actual = await importOriginal<typeof import("@/lib/code-store")>();
  return { ...actual, createCode: mocks.createCode, getCode: mocks.getCode };
});
// validateCodeRequest (imported for real above) pulls in @/lib/db, which must not
// try to talk to a database in unit tests.
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

import { createCodeForUser } from "@/lib/code-service";

const FILE = "https://example.com/tutor.yaml";
const START = 1_700_000_000;
const END = 1_700_003_600;

const ENTRY = {
  code: "abc123def4",
  module: "tutor",
  createdBy: "teacher-1",
  fileUrl: FILE,
  validFrom: new Date(START * 1000),
  validUntil: new Date(END * 1000),
  note: "My class",
  origin: "http://localhost:3000",
  anonymous: true,
  llm: null,
  createdAt: new Date("2026-07-07T08:00:00Z"),
};

function input(overrides: Partial<Parameters<typeof createCodeForUser>[1]> = {}) {
  return {
    module: "tutor",
    file: FILE,
    start: String(START),
    end: String(END),
    note: "My class",
    llmProvider: "",
    llmModel: "",
    llmReasoning: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("CODE_ORIGIN", "");
  vi.stubEnv("TUTOR_CODE_ORIGIN", "");
  mocks.validateCodeFile.mockResolvedValue({
    ok: true,
    warnings: [],
    title: null,
    description: null,
    anonymous: true,
  });
  mocks.createCode.mockResolvedValue({ stored: true, code: "abc123def4" });
  mocks.getCode.mockResolvedValue(ENTRY);
});

describe("createCodeForUser", () => {
  it("returns the stored entry and its share URL on success", async () => {
    const result = await createCodeForUser("teacher-1", input());
    expect(result).toEqual({
      ok: true,
      entry: ENTRY,
      shareUrl: "http://localhost:3000/abc123def4",
    });
  });

  it("stores the validated payload (with module) under the given user id", async () => {
    await createCodeForUser("teacher-1", input({ note: "  trimmed note  " }));
    expect(mocks.createCode).toHaveBeenCalledWith("teacher-1", {
      module: "tutor",
      fileUrl: FILE,
      validFrom: new Date(START * 1000),
      validUntil: new Date(END * 1000),
      note: "trimmed note",
      origin: "http://localhost:3000",
      anonymous: true,
      llm: null,
      moodle: false,
    });
  });

  it("refuses the Moodle switch on a non-quiz before validating the file", async () => {
    const result = await createCodeForUser("teacher-1", input({ moodle: true }));
    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      message: "Only quiz codes can hand in results to Moodle.",
    });
    expect(mocks.createCode).not.toHaveBeenCalled();
  });

  it("rejects an unknown module without validating or storing", async () => {
    const result = await createCodeForUser("teacher-1", input({ module: "future-module" }));
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      message: expect.stringMatching(/activity/i),
    });
    expect(mocks.validateCodeFile).not.toHaveBeenCalled();
    expect(mocks.createCode).not.toHaveBeenCalled();
  });

  it("rejects a bad request (half-filled override) without touching storage", async () => {
    const result = await createCodeForUser("teacher-1", input({ llmModel: "some-model" }));
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      message: expect.stringMatching(/both/i),
    });
    expect(mocks.createCode).not.toHaveBeenCalled();
  });

  it("stores the LLM override pair when both halves are supplied", async () => {
    await createCodeForUser("teacher-1", input({ llmProvider: "SCCH", llmModel: "some-model" }));
    expect(mocks.createCode).toHaveBeenCalledWith(
      "teacher-1",
      expect.objectContaining({ llm: { provider: "SCCH", model: "some-model" } }),
    );
  });

  it("rejects an override naming a provider this server has not configured", async () => {
    // Without AZURE_FOUNDRY_ENDPOINT Foundry is unavailable, so the save-time
    // gate must reject the override instead of storing it.
    vi.stubEnv("AZURE_FOUNDRY_ENDPOINT", "");
    const result = await createCodeForUser(
      "teacher-1",
      input({ llmProvider: "Azure Foundry", llmModel: "gpt-5.4-mini" }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      message: expect.stringMatching(/Azure Foundry/),
    });
    expect(mocks.createCode).not.toHaveBeenCalled();
  });

  it("passes the validator's structured errors through and does NOT store", async () => {
    mocks.validateCodeFile.mockResolvedValue({
      ok: false,
      errors: [{ code: "TUTOR_SCHEMA_ERROR", message: "bad" }],
    });
    const result = await createCodeForUser("teacher-1", input());
    expect(result).toMatchObject({
      ok: false,
      reason: "validation",
      errors: [{ code: "TUTOR_SCHEMA_ERROR" }],
    });
    expect(mocks.createCode).not.toHaveBeenCalled();
  });

  it("freezes the activity's anonymity flag from the validator result", async () => {
    mocks.validateCodeFile.mockResolvedValue({
      ok: true,
      warnings: [],
      title: null,
      description: null,
      anonymous: false,
    });
    await createCodeForUser("teacher-1", input());
    expect(mocks.createCode).toHaveBeenCalledWith(
      "teacher-1",
      expect.objectContaining({ anonymous: false }),
    );
  });

  it("stores null bounds for an open-ended code (blank start and end)", async () => {
    await createCodeForUser("teacher-1", input({ start: "", end: "" }));
    expect(mocks.createCode).toHaveBeenCalledWith(
      "teacher-1",
      expect.objectContaining({ validFrom: null, validUntil: null }),
    );
  });

  it("is unavailable (a HARD error) when the code cannot be stored", async () => {
    mocks.createCode.mockResolvedValue({ stored: false });
    const result = await createCodeForUser("teacher-1", input());
    expect(result).toMatchObject({
      ok: false,
      reason: "unavailable",
      message: expect.stringMatching(/could not be stored/i),
    });
  });

  it("is unavailable when the stored row cannot be read back", async () => {
    mocks.getCode.mockResolvedValue(undefined);
    const result = await createCodeForUser("teacher-1", input());
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
  });
});
