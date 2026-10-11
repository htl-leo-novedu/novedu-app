import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

// The shared validate-then-store pipeline behind BOTH the web editor's actions
// and the bearer PUT /api/files/<name>. These tests pin the policy: the
// VALIDATE-BEFORE-STORE ordering (an invalid file is never persisted), the
// structured-error pass-through, the store-reason → discriminant mapping, and
// the upsert dispatch — create needs a kind, update validates against the
// STORED kind, and a mismatching supplied kind fails LOUDLY (never silently
// ignored). The store and validator loaders are mocked; the pure name/kind
// checks stay real.

const mocks = vi.hoisted(() => ({
  createFile: vi.fn(),
  updateFile: vi.fn(),
  getActiveFile: vi.fn(),
  defaultFetcher: vi.fn(),
  loadAndBuildTutorPrompt: vi.fn(),
  loadAndCheckFragmentFile: vi.fn(),
  loadAndCheckQuiz: vi.fn(),
  loadAndCheckWriting: vi.fn(),
  resolveAppOrigin: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/app-origin", () => ({ resolveAppOrigin: mocks.resolveAppOrigin }));
vi.mock("@/lib/tutors", () => ({
  loadAndBuildTutorPrompt: mocks.loadAndBuildTutorPrompt,
}));
vi.mock("@/lib/prompt-fragments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prompt-fragments")>()),
  defaultFetcher: mocks.defaultFetcher,
  loadAndCheckFragmentFile: mocks.loadAndCheckFragmentFile,
}));
// file-validators is real, but the quiz/writing loaders import the scheme-gated
// YAML core from `@/lib/tutors` (mocked above to a subset). They are mocked so
// the seam's MAPPING is what's under test here.
vi.mock("@/lib/quiz-validate", () => ({ loadAndCheckQuiz: mocks.loadAndCheckQuiz }));
vi.mock("@/lib/writing-validate", () => ({ loadAndCheckWriting: mocks.loadAndCheckWriting }));
// Keep the REAL validateFileName / isFileKind — they are part of the contract —
// and mock only the storage calls.
vi.mock("@/lib/file-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/file-store")>();
  return {
    ...actual,
    createFile: mocks.createFile,
    updateFile: mocks.updateFile,
    getActiveFile: mocks.getActiveFile,
  };
});

import { createFileForUser, updateFileForUser, upsertFileForUser } from "@/lib/file-service";
import type { Fetcher } from "@/lib/prompt-fragments";

beforeEach(() => {
  mocks.resolveAppOrigin.mockResolvedValue("http://localhost:3000");
  mocks.loadAndCheckFragmentFile.mockResolvedValue({ ok: true });
  mocks.loadAndCheckQuiz.mockResolvedValue({
    ok: true,
    warnings: [],
    anonymous: true,
    title: null,
  });
  mocks.loadAndBuildTutorPrompt.mockResolvedValue({
    ok: true,
    title: "Title",
    description: "Desc",
  });
  mocks.createFile.mockResolvedValue({ ok: true, name: "my-file" });
  mocks.updateFile.mockResolvedValue({ ok: true });
  mocks.getActiveFile.mockResolvedValue({ name: "my-file", kind: "fragment", content: "old" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const FRAGMENT = { name: "my-file", kind: "fragment", content: "id: f\n" };

describe("validation fetcher", () => {
  // The fragment validator is mocked to hand its fetcher a URL; the fetcher is the
  // seam under test (self buffer, hosted sibling from the store, external).
  async function fetchVia(url: string) {
    let fetched: Awaited<ReturnType<Fetcher>> | undefined;
    mocks.loadAndCheckFragmentFile.mockImplementationOnce(
      async (_url: string, fetcher: Fetcher) => {
        fetched = await fetcher(url);
        return { ok: true, warnings: [] };
      },
    );
    await createFileForUser("teacher-1", FRAGMENT);
    assert(fetched);
    return fetched;
  }

  it("resolves the file being saved to its unsaved buffer", async () => {
    const res = await fetchVia("http://localhost:3000/api/files/my-file");
    expect(await res.text()).toBe("id: f\n");
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
    expect(mocks.defaultFetcher).not.toHaveBeenCalled();
  });

  it("resolves a sibling hosted file from the store", async () => {
    mocks.getActiveFile.mockResolvedValue({ name: "other", kind: "fragment", content: "stored" });
    const res = await fetchVia("http://localhost:3000/api/files/other");
    expect(await res.text()).toBe("stored");
    expect(mocks.getActiveFile).toHaveBeenCalledWith("other");
    expect(mocks.defaultFetcher).not.toHaveBeenCalled();
  });

  it("sends an external URL to the default fetcher", async () => {
    const external = { ok: true, status: 200, text: async () => "remote" };
    mocks.defaultFetcher.mockResolvedValue(external);
    const res = await fetchVia("https://raw.githubusercontent.com/x/y/main/f.yaml");
    expect(res).toBe(external);
    expect(mocks.defaultFetcher).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/x/y/main/f.yaml",
    );
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });
});

describe("createFileForUser", () => {
  it("rejects a malformed name without validating or storing", async () => {
    const result = await createFileForUser("teacher-1", { ...FRAGMENT, name: "bad name!" });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(mocks.loadAndCheckFragmentFile).not.toHaveBeenCalled();
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("rejects an unknown kind", async () => {
    const result = await createFileForUser("teacher-1", { ...FRAGMENT, kind: "nonsense" });
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      message: expect.stringMatching(/tutor, fragment, quiz, writing, coding or cloze/i),
    });
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("rejects empty content", async () => {
    const result = await createFileForUser("teacher-1", { ...FRAGMENT, content: "   " });
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      message: expect.stringMatching(/empty/i),
    });
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("passes the validator's structured errors through and does NOT store", async () => {
    mocks.loadAndCheckFragmentFile.mockResolvedValue({
      ok: false,
      errors: [{ code: "FRAGMENT_FILE_SCHEMA_ERROR", message: "bad" }],
    });
    const result = await createFileForUser("teacher-1", FRAGMENT);
    expect(result).toMatchObject({
      ok: false,
      reason: "validation",
      errors: [{ code: "FRAGMENT_FILE_SCHEMA_ERROR" }],
    });
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("stores a tutor's denormalized title/description under the given user id", async () => {
    const result = await createFileForUser("teacher-1", {
      name: "my-tutor",
      kind: "tutor",
      content: "id: t",
    });
    expect(result).toEqual({ ok: true, summary: null });
    expect(mocks.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "my-tutor",
        kind: "tutor",
        title: "Title",
        description: "Desc",
      }),
      "teacher-1",
    );
  });

  it("validates a quiz via loadAndCheckQuiz, then stores it with a null description", async () => {
    mocks.loadAndCheckQuiz.mockResolvedValue({
      ok: true,
      warnings: [],
      anonymous: true,
      title: "Quiz Title",
    });
    const result = await createFileForUser("teacher-1", {
      name: "my-quiz",
      kind: "quiz",
      content: "id: q\n",
    });
    expect(result).toEqual({ ok: true, summary: null });
    // The quiz path runs the quiz validator, NOT the tutor/fragment loaders …
    expect(mocks.loadAndCheckQuiz).toHaveBeenCalled();
    expect(mocks.loadAndBuildTutorPrompt).not.toHaveBeenCalled();
    expect(mocks.loadAndCheckFragmentFile).not.toHaveBeenCalled();
    // … and stores the validator's title with a NULL description (quizzes carry none).
    expect(mocks.createFile).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "quiz", title: "Quiz Title", description: null }),
      "teacher-1",
    );
  });

  it("blocks an invalid quiz with structured errors and does NOT store", async () => {
    mocks.loadAndCheckQuiz.mockResolvedValue({
      ok: false,
      errors: [{ code: "QUIZ_SCHEMA_ERROR", message: "no questions" }],
      warnings: [],
    });
    const result = await createFileForUser("teacher-1", {
      name: "my-quiz",
      kind: "quiz",
      content: "id: q\n",
    });
    expect(result).toMatchObject({ ok: false, reason: "validation" });
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("maps a name-taken store result to a conflict", async () => {
    mocks.createFile.mockResolvedValue({ ok: false, reason: "name-taken" });
    const result = await createFileForUser("teacher-1", FRAGMENT);
    expect(result).toMatchObject({
      ok: false,
      reason: "conflict",
      message: expect.stringMatching(/already exists/i),
    });
  });

  it("maps a store error to unavailable", async () => {
    mocks.createFile.mockResolvedValue({ ok: false, reason: "error" });
    const result = await createFileForUser("teacher-1", FRAGMENT);
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("updateFileForUser", () => {
  it("rejects empty content before any lookup", async () => {
    const result = await updateFileForUser("teacher-1", "my-file", "  ");
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });

  it("is unavailable on a transient lookup failure (DB down)", async () => {
    mocks.getActiveFile.mockResolvedValue(undefined);
    const result = await updateFileForUser("teacher-1", "my-file", "id: f\n");
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(mocks.updateFile).not.toHaveBeenCalled();
  });

  it("reports a vanished file", async () => {
    mocks.getActiveFile.mockResolvedValue(null);
    const result = await updateFileForUser("teacher-1", "my-file", "id: f\n");
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      message: expect.stringMatching(/no longer exists/i),
    });
    expect(mocks.updateFile).not.toHaveBeenCalled();
  });

  it("validates against the STORED kind and passes errors through without storing", async () => {
    mocks.loadAndCheckFragmentFile.mockResolvedValue({
      ok: false,
      errors: [{ code: "FRAGMENT_FILE_SCHEMA_ERROR", message: "bad" }],
    });
    const result = await updateFileForUser("teacher-1", "my-file", "id: f\n");
    expect(result).toMatchObject({ ok: false, reason: "validation" });
    // The stored kind is fragment, so the fragment loader (not the tutor one) ran.
    expect(mocks.loadAndCheckFragmentFile).toHaveBeenCalled();
    expect(mocks.loadAndBuildTutorPrompt).not.toHaveBeenCalled();
    expect(mocks.updateFile).not.toHaveBeenCalled();
  });

  it('maps a not-found store result to an invalid "changed or was removed" message', async () => {
    mocks.updateFile.mockResolvedValue({ ok: false, reason: "not-found" });
    const result = await updateFileForUser("teacher-1", "my-file", "id: f\n");
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      message: expect.stringMatching(/changed or was removed/i),
    });
  });

  it("stores a new version under the given user id on success", async () => {
    const result = await updateFileForUser("teacher-1", "my-file", "id: f\n");
    expect(result).toEqual({ ok: true, summary: null });
    expect(mocks.updateFile).toHaveBeenCalledWith(
      "my-file",
      expect.objectContaining({ content: "id: f\n" }),
      "teacher-1",
    );
  });
});

describe("upsertFileForUser", () => {
  it("creates when the name is free and a kind is supplied", async () => {
    mocks.getActiveFile.mockResolvedValue(null);
    const result = await upsertFileForUser("teacher-1", {
      name: "new-file",
      kind: "fragment",
      content: "id: f\n",
    });
    expect(result).toEqual({ ok: true, action: "created", name: "new-file", kind: "fragment" });
    expect(mocks.createFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "new-file", kind: "fragment", content: "id: f\n" }),
      "teacher-1",
    );
    expect(mocks.updateFile).not.toHaveBeenCalled();
  });

  it("requires a kind when creating, naming the six kinds", async () => {
    mocks.getActiveFile.mockResolvedValue(null);
    const result = await upsertFileForUser("teacher-1", { name: "new-file", content: "id: f\n" });
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      message: expect.stringMatching(/tutor, fragment, quiz, writing, coding or cloze/i),
    });
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("updates when the file exists and no kind is supplied", async () => {
    const result = await upsertFileForUser("teacher-1", { name: "my-file", content: "id: f\n" });
    expect(result).toEqual({ ok: true, action: "updated", name: "my-file", kind: "fragment" });
    expect(mocks.updateFile).toHaveBeenCalledWith(
      "my-file",
      expect.objectContaining({ content: "id: f\n" }),
      "teacher-1",
    );
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("updates when the supplied kind MATCHES the stored one", async () => {
    const result = await upsertFileForUser("teacher-1", {
      name: "my-file",
      kind: "fragment",
      content: "id: f\n",
    });
    expect(result).toEqual({ ok: true, action: "updated", name: "my-file", kind: "fragment" });
  });

  it("fails LOUDLY on a kind mismatch, naming both kinds, without validating or storing", async () => {
    const result = await upsertFileForUser("teacher-1", {
      name: "my-file",
      kind: "quiz",
      content: "id: q\n",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "kind-mismatch",
      message: expect.stringMatching(/fragment/),
    });
    expect((result as { message: string }).message).toMatch(/quiz/);
    expect(mocks.loadAndCheckQuiz).not.toHaveBeenCalled();
    expect(mocks.loadAndCheckFragmentFile).not.toHaveBeenCalled();
    expect(mocks.updateFile).not.toHaveBeenCalled();
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("is unavailable when the existence check fails (DB down)", async () => {
    mocks.getActiveFile.mockResolvedValue(undefined);
    const result = await upsertFileForUser("teacher-1", {
      name: "my-file",
      kind: "fragment",
      content: "id: f\n",
    });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(mocks.createFile).not.toHaveBeenCalled();
    expect(mocks.updateFile).not.toHaveBeenCalled();
  });

  it("maps a create race (name-taken after the existence check) to a conflict", async () => {
    mocks.getActiveFile.mockResolvedValue(null);
    mocks.createFile.mockResolvedValue({ ok: false, reason: "name-taken" });
    const result = await upsertFileForUser("teacher-1", {
      name: "new-file",
      kind: "fragment",
      content: "id: f\n",
    });
    expect(result).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("rejects a malformed name without any lookup", async () => {
    const result = await upsertFileForUser("teacher-1", { name: "bad name!", content: "id: f\n" });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });
});
