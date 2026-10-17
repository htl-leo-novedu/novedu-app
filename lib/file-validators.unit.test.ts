import { describe, expect, it, vi } from "vitest";

// Layer-2 validator seam + the runtime-light readAnonymousFlag, both keyed by
// FileKind. The underlying loaders (lib/tutors, lib/quiz-validate, lib/quiz-fetch,
// lib/writing-validate, lib/writing-fetch) are mocked so this is hermetic — it
// asserts the MAPPING each kind performs (which loader, which options, how the
// result is shaped), not the validation itself.

const mocks = vi.hoisted(() => ({
  loadAndBuildTutorPrompt: vi.fn(),
  loadAndCheckFragmentFile: vi.fn(),
  loadQuiz: vi.fn(),
  loadAndCheckQuiz: vi.fn(),
  loadWriting: vi.fn(),
  loadAndCheckWriting: vi.fn(),
  loadAndCheckCoding: vi.fn(),
  // The server's YAML fetcher as a sentinel (resolution: app-hosted-fetcher's test).
  serverFetcher: vi.fn(),
}));

vi.mock("@/lib/tutors", () => ({
  loadAndBuildTutorPrompt: mocks.loadAndBuildTutorPrompt,
}));
vi.mock("@/lib/prompt-fragments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prompt-fragments")>()),
  loadAndCheckFragmentFile: mocks.loadAndCheckFragmentFile,
}));
vi.mock("@/lib/app-hosted-fetcher", () => ({
  serverYamlFetcher: async () => mocks.serverFetcher,
}));
vi.mock("@/lib/quiz-fetch", () => ({ loadQuiz: mocks.loadQuiz }));
vi.mock("@/lib/quiz-validate", () => ({ loadAndCheckQuiz: mocks.loadAndCheckQuiz }));
vi.mock("@/lib/writing-fetch", () => ({ loadWriting: mocks.loadWriting }));
vi.mock("@/lib/writing-validate", () => ({ loadAndCheckWriting: mocks.loadAndCheckWriting }));
vi.mock("@/lib/coding-validate", () => ({ loadAndCheckCoding: mocks.loadAndCheckCoding }));

import { fileValidators, readAnonymousFlag } from "@/lib/file-validators";

const URL_ = "https://example.com/file.yaml";
const fetcher = vi.fn();

// The four activity kinds share one validator (`activityValidator`): the kind's strict
// check, the provider gate, then title/description/anonymous with null/null/true
// fallbacks (coding carries no `anonymous` field — it is always anonymous).
const activityChecks = {
  tutor: {
    check: mocks.loadAndBuildTutorPrompt,
    // The THOROUGH library check, as at share/create time.
    args: [URL_, fetcher, { validateLibraries: true }],
  },
  quiz: { check: mocks.loadAndCheckQuiz, args: [URL_, fetcher] },
  writing: { check: mocks.loadAndCheckWriting, args: [URL_, fetcher] },
  coding: { check: mocks.loadAndCheckCoding, args: [URL_, fetcher] },
};
const activityKinds = ["tutor", "quiz", "writing", "coding"] as const;

describe("fileValidators.coding", () => {
  it("FREEZES anonymous: true, whatever the check returns (coding is always anonymous)", async () => {
    mocks.loadAndCheckCoding.mockResolvedValue({
      ok: true,
      warnings: [],
      title: "C",
      anonymous: false,
      provider: "SCCH",
    });
    expect(await fileValidators.coding.validate(URL_, fetcher)).toMatchObject({
      ok: true,
      anonymous: true,
    });
  });
});

describe.each(activityKinds)("fileValidators.%s", (kind) => {
  const { check, args } = activityChecks[kind];

  it("runs the kind's check and maps title/description/anonymous + warnings", async () => {
    // (Coding's anonymous: true is frozen — its own test above.)
    const anonymous = kind === "coding";
    check.mockResolvedValue({
      ok: true,
      warnings: ["w"],
      title: "T",
      description: "D",
      anonymous,
      provider: "SCCH",
    });
    const result = await fileValidators[kind].validate(URL_, fetcher);
    expect(check).toHaveBeenCalledWith(...args);
    expect(result).toEqual({
      ok: true,
      warnings: ["w"],
      title: "T",
      description: "D",
      anonymous,
    });
  });

  it("falls back to null title/description and the privacy-safe anonymous: true", async () => {
    check.mockResolvedValue({ ok: true, warnings: [], provider: "SCCH" });
    expect(await fileValidators[kind].validate(URL_, fetcher)).toEqual({
      ok: true,
      warnings: [],
      title: null,
      description: null,
      anonymous: true,
    });
  });

  it("surfaces the structured errors on a failed check (BLOCKS the save)", async () => {
    check.mockResolvedValue({ ok: false, errors: [{ code: "X", message: "m" }], warnings: [] });
    expect(await fileValidators[kind].validate(URL_, fetcher)).toEqual({
      ok: false,
      errors: [{ code: "X", message: "m" }],
    });
  });
});

describe("fileValidators.fragment", () => {
  it("validates with NO title/description and the privacy-safe anonymous default", async () => {
    mocks.loadAndCheckFragmentFile.mockResolvedValue({ ok: true, warnings: [] });
    expect(await fileValidators.fragment.validate(URL_, fetcher)).toEqual({
      ok: true,
      warnings: [],
      title: null,
      description: null,
      anonymous: true,
    });
  });

  it("propagates fragment errors", async () => {
    mocks.loadAndCheckFragmentFile.mockResolvedValue({
      ok: false,
      errors: [{ code: "F", message: "m" }],
    });
    expect(await fileValidators.fragment.validate(URL_, fetcher)).toEqual({
      ok: false,
      errors: [{ code: "F", message: "m" }],
    });
  });
});

describe("provider availability gate (app-only, on top of the CLI-shared core)", () => {
  // The loaders are mocked, but providerUnavailableReason stays REAL — the gate's
  // env sensitivity is exactly what these tests pin down.
  const okFoundry = (kind: (typeof activityKinds)[number]) =>
    activityChecks[kind].check.mockResolvedValue({
      ok: true,
      warnings: [],
      provider: "Azure Foundry",
    });

  for (const kind of activityKinds) {
    it(`${kind}: BLOCKS a valid Foundry file when the server has no AZURE_FOUNDRY_ENDPOINT`, async () => {
      vi.stubEnv("AZURE_FOUNDRY_ENDPOINT", "");
      okFoundry(kind);
      const result = await fileValidators[kind].validate(URL_, fetcher);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          { code: "PROVIDER_UNAVAILABLE", message: expect.stringContaining("Azure Foundry") },
        ]);
      }
    });
  }

  it("passes a Foundry file when the server is configured for it", async () => {
    vi.stubEnv("AZURE_FOUNDRY_ENDPOINT", "https://res.openai.azure.com");
    okFoundry("quiz");
    expect(await fileValidators.quiz.validate(URL_, fetcher)).toMatchObject({ ok: true });
  });

  it("passes an SCCH file regardless of the Foundry env", async () => {
    vi.stubEnv("AZURE_FOUNDRY_ENDPOINT", "");
    mocks.loadAndCheckQuiz.mockResolvedValue({
      ok: true,
      warnings: [],
      anonymous: true,
      title: "Q",
      provider: "SCCH",
    });
    expect(await fileValidators.quiz.validate(URL_, fetcher)).toMatchObject({ ok: true });
  });
});

describe("readAnonymousFlag (runtime-light, by FileKind)", () => {
  it("quiz → reads the live flag via loadQuiz (definitive)", async () => {
    mocks.loadQuiz.mockResolvedValue({ ok: true, quiz: { anonymous: false } });
    expect(await readAnonymousFlag("quiz", URL_)).toEqual({ anonymous: false, definitive: true });
    expect(mocks.loadQuiz).toHaveBeenCalledWith(URL_);
  });

  it("tutor → reads the built flag WITHOUT the heavy library check", async () => {
    mocks.loadAndBuildTutorPrompt.mockResolvedValue({ ok: true, anonymous: false });
    expect(await readAnonymousFlag("tutor", URL_)).toEqual({ anonymous: false, definitive: true });
    // Called with the server fetcher (app-hosted files from the DB, never a
    // loopback) and NO { validateLibraries: true } option.
    expect(mocks.loadAndBuildTutorPrompt).toHaveBeenCalledWith(URL_, mocks.serverFetcher);
  });

  it("writing → reads the live flag via loadWriting, DEFAULTING to false (definitive)", async () => {
    // parseWriting already defaults `anonymous` to false; readAnonymousFlag just
    // forwards the loaded flag definitively when the YAML reads.
    mocks.loadWriting.mockResolvedValue({ ok: true, writing: { anonymous: false } });
    expect(await readAnonymousFlag("writing", URL_)).toEqual({
      anonymous: false,
      definitive: true,
    });
    expect(mocks.loadWriting).toHaveBeenCalledWith(URL_);
  });

  it("writing → an explicit anonymous:true is carried through definitively", async () => {
    mocks.loadWriting.mockResolvedValue({ ok: true, writing: { anonymous: true } });
    expect(await readAnonymousFlag("writing", URL_)).toEqual({ anonymous: true, definitive: true });
  });

  it("writing → falls back to the privacy-safe default when the YAML cannot be read", async () => {
    mocks.loadWriting.mockResolvedValue({ ok: false, message: "gone" });
    expect(await readAnonymousFlag("writing", URL_)).toEqual({
      anonymous: true,
      definitive: false,
    });
  });

  it("falls back to anonymous:true NON-definitively when the YAML cannot be read", async () => {
    mocks.loadQuiz.mockResolvedValue({ ok: false, message: "gone" });
    expect(await readAnonymousFlag("quiz", URL_)).toEqual({ anonymous: true, definitive: false });
  });

  it("coding → always anonymous:true definitively, WITHOUT reading the YAML", async () => {
    expect(await readAnonymousFlag("coding", URL_)).toEqual({ anonymous: true, definitive: true });
    // Coding is anonymous by construction — no loader is consulted.
    expect(mocks.loadQuiz).not.toHaveBeenCalled();
    expect(mocks.loadWriting).not.toHaveBeenCalled();
  });

  it("returns the non-definitive default for a kind with no anonymity flag (fragment)", async () => {
    expect(await readAnonymousFlag("fragment", URL_)).toEqual({
      anonymous: true,
      definitive: false,
    });
    expect(mocks.loadQuiz).not.toHaveBeenCalled();
    expect(mocks.loadAndBuildTutorPrompt).not.toHaveBeenCalled();
  });

  it("never throws — a throwing loader yields the non-definitive default", async () => {
    mocks.loadAndBuildTutorPrompt.mockRejectedValue(new Error("ECONNRESET"));
    expect(await readAnonymousFlag("tutor", URL_)).toEqual({ anonymous: true, definitive: false });
  });
});
