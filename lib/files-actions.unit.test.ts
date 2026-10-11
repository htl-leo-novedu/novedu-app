import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The save actions are thin auth shells around the shared pipeline in
// lib/file-service.ts (covered by file-service.unit.test.ts). These tests pin
// the SHELL for create/update — the teacher gate, the result → form-state
// mapping, the revalidate/redirect wiring — plus the FULL behavior of what
// still lives here: the validate-only actions and the student-GUI loaders.
// The store and validator are mocked; the pure name/kind checks stay real.

const mocks = vi.hoisted(() => ({
  requireTeacherUserId: vi.fn(),
  createFile: vi.fn(),
  updateFile: vi.fn(),
  softDeleteFiles: vi.fn(),
  getActiveFile: vi.fn(),
  loadAndBuildTutorPrompt: vi.fn(),
  loadAndCheckFragmentFile: vi.fn(),
  loadAndCheckQuiz: vi.fn(),
  loadAndCheckWriting: vi.fn(),
  defaultFetcher: vi.fn(),
  resolveAppOrigin: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/student-mode", () => ({ requireTeacherUserId: mocks.requireTeacherUserId }));
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
    softDeleteFiles: mocks.softDeleteFiles,
    getActiveFile: mocks.getActiveFile,
  };
});
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import * as actions from "@/lib/files-actions";
import {
  createFileAction,
  deleteSelectedFilesAction,
  loadFileFromDbAction,
  loadYamlFromUrlAction,
  updateFileAction,
  validateExistingFileAction,
  validateNewFileAction,
} from "@/lib/files-actions";

beforeEach(() => {
  mocks.requireTeacherUserId.mockResolvedValue({ ok: true, userId: "teacher-1" });
  mocks.resolveAppOrigin.mockResolvedValue("http://localhost:3000");
  mocks.loadAndCheckFragmentFile.mockResolvedValue({ ok: true });
  mocks.loadAndCheckQuiz.mockResolvedValue({
    ok: true,
    warnings: [],
    anonymous: true,
    title: null,
  });
  mocks.loadAndCheckWriting.mockResolvedValue({
    ok: true,
    warnings: [],
    anonymous: false,
    title: null,
  });
  mocks.loadAndBuildTutorPrompt.mockResolvedValue({
    ok: true,
    title: "Title",
    description: "Desc",
  });
  mocks.createFile.mockResolvedValue({ ok: true, name: "my-file" });
  mocks.updateFile.mockResolvedValue({ ok: true });
  mocks.softDeleteFiles.mockResolvedValue({ ok: true, deleted: 2 });
  mocks.getActiveFile.mockResolvedValue({ name: "my-file", kind: "fragment", content: "old" });
  mocks.defaultFetcher.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "external-yaml",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const FRAGMENT = { name: "my-file", kind: "fragment", content: "id: f\n" };

describe("createFileAction", () => {
  it("rejects a non-teacher before any work", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    const result = await createFileAction(FRAGMENT);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/teachers/i) });
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("maps a service message failure to the form's message shape", async () => {
    mocks.createFile.mockResolvedValue({ ok: false, reason: "name-taken" });
    const result = await createFileAction(FRAGMENT);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/already exists/i) });
  });

  it("maps the validator's structured errors to the form's errors shape", async () => {
    mocks.loadAndCheckFragmentFile.mockResolvedValue({
      ok: false,
      errors: [
        { code: "FRAGMENT_FILE_SCHEMA_ERROR", message: "bad", zodIssues: { errors: ["x"] } },
      ],
    });
    const result = await createFileAction(FRAGMENT);
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: "FRAGMENT_FILE_SCHEMA_ERROR" }],
    });
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("revalidates and redirects to the edit page on success", async () => {
    await expect(createFileAction(FRAGMENT)).rejects.toThrow("REDIRECT:/files/edit/my-file");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/files");
  });
});

describe("updateFileAction", () => {
  it("rejects a non-teacher before any work", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    const result = await updateFileAction("my-file", "id: f\n");
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/teachers/i) });
    expect(mocks.updateFile).not.toHaveBeenCalled();
  });

  it("maps a service message failure to the form's message shape", async () => {
    mocks.getActiveFile.mockResolvedValue(null);
    const result = await updateFileAction("my-file", "id: f\n");
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/no longer exists/i),
    });
    expect(mocks.updateFile).not.toHaveBeenCalled();
  });

  it("maps validator errors to the form's errors shape", async () => {
    mocks.loadAndCheckFragmentFile.mockResolvedValue({
      ok: false,
      errors: [{ code: "FRAGMENT_FILE_SCHEMA_ERROR", message: "bad" }],
    });
    const result = await updateFileAction("my-file", "id: f\n");
    expect(result).toMatchObject({ ok: false, errors: [{ code: "FRAGMENT_FILE_SCHEMA_ERROR" }] });
    expect(mocks.updateFile).not.toHaveBeenCalled();
  });

  it("revalidates on success", async () => {
    const result = await updateFileAction("my-file", "id: f\n");
    expect(result).toEqual({ ok: true, summary: null });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/files");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/files/edit/my-file");
  });
});

// The validate-only actions back the standalone "Validate" button: they run the
// SAME preamble + validator as create/update but must NEVER touch the store, and a
// pass carries the non-blocking warnings through to the form.
describe("validateNewFileAction", () => {
  it("returns the validator's warnings on a valid buffer and never stores", async () => {
    mocks.loadAndCheckFragmentFile.mockResolvedValue({
      ok: true,
      warnings: [{ code: "UNDECLARED_VARIABLE", message: "heads up" }],
    });
    const result = await validateNewFileAction(FRAGMENT);
    expect(result).toEqual({
      ok: true,
      warnings: [{ code: "UNDECLARED_VARIABLE", message: "heads up" }],
      summary: null,
    });
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("passes the validator's structured errors through and never stores", async () => {
    mocks.loadAndCheckFragmentFile.mockResolvedValue({
      ok: false,
      errors: [{ code: "FRAGMENT_FILE_SCHEMA_ERROR", message: "bad" }],
    });
    const result = await validateNewFileAction(FRAGMENT);
    expect(result).toMatchObject({ ok: false, errors: [{ code: "FRAGMENT_FILE_SCHEMA_ERROR" }] });
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("rejects a non-teacher before validating", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    const result = await validateNewFileAction(FRAGMENT);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/teachers/i) });
    expect(mocks.loadAndCheckFragmentFile).not.toHaveBeenCalled();
  });

  it("validates a cloze buffer with the REAL cloze validator and returns its gap inventory", async () => {
    const result = await validateNewFileAction({
      name: "my-cloze",
      kind: "cloze",
      content:
        "id: c\nllm: { model: m }\nevaluation: e\ntext: She [[is going to]] start at [[nine|time]].\n",
    });
    expect(result).toEqual({
      ok: true,
      warnings: [],
      summary: '2 gaps · 1 "is going to" · 2 "nine" (time)',
    });
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("validates a quiz via loadAndCheckQuiz and never stores", async () => {
    mocks.loadAndCheckQuiz.mockResolvedValue({
      ok: true,
      warnings: [],
      anonymous: true,
      title: null,
    });
    const result = await validateNewFileAction({
      name: "my-quiz",
      kind: "quiz",
      content: "id: q\n",
    });
    expect(result).toEqual({ ok: true, warnings: [], summary: null });
    expect(mocks.loadAndCheckQuiz).toHaveBeenCalled();
    expect(mocks.loadAndBuildTutorPrompt).not.toHaveBeenCalled();
    expect(mocks.loadAndCheckFragmentFile).not.toHaveBeenCalled();
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("blocks an invalid quiz with structured errors and never stores", async () => {
    mocks.loadAndCheckQuiz.mockResolvedValue({
      ok: false,
      errors: [{ code: "QUIZ_SCHEMA_ERROR", message: "no questions" }],
      warnings: [],
    });
    const result = await validateNewFileAction({
      name: "my-quiz",
      kind: "quiz",
      content: "id: q\n",
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "QUIZ_SCHEMA_ERROR" }] });
    expect(mocks.createFile).not.toHaveBeenCalled();
  });

  it("rejects a malformed name without validating", async () => {
    const result = await validateNewFileAction({ ...FRAGMENT, name: "bad name!" });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/letters/i) });
    expect(mocks.loadAndCheckFragmentFile).not.toHaveBeenCalled();
  });

  it("rejects empty content", async () => {
    const result = await validateNewFileAction({ ...FRAGMENT, content: "   " });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/empty/i) });
    expect(mocks.loadAndCheckFragmentFile).not.toHaveBeenCalled();
  });
});

// Every export of the "use server" module is a web-reachable endpoint, so a new
// export without the teacher gate must fail here. Each gate runs before its
// arguments are read, so the actions are called without any.
describe("teacher gate on every exported action", () => {
  it("refuses a non-teacher and touches no store, validator, fetcher or navigation", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    const exported = Object.values(actions);
    expect(exported.length).toBeGreaterThan(0);
    for (const action of exported) {
      expect(await (action as () => Promise<unknown>)()).toMatchObject({ ok: false });
    }
    expect(mocks.requireTeacherUserId).toHaveBeenCalledTimes(exported.length);
    for (const untouched of [
      mocks.createFile,
      mocks.updateFile,
      mocks.softDeleteFiles,
      mocks.getActiveFile,
      mocks.loadAndBuildTutorPrompt,
      mocks.loadAndCheckFragmentFile,
      mocks.loadAndCheckQuiz,
      mocks.loadAndCheckWriting,
      mocks.defaultFetcher,
      mocks.revalidatePath,
      mocks.redirect,
    ]) {
      expect(untouched).not.toHaveBeenCalled();
    }
  });
});

describe("validateExistingFileAction", () => {
  it("returns warnings on a valid buffer (kind from the active row) and never stores", async () => {
    mocks.loadAndCheckFragmentFile.mockResolvedValue({ ok: true, warnings: [] });
    const result = await validateExistingFileAction("my-file", "id: f\n");
    expect(result).toEqual({ ok: true, warnings: [], summary: null });
    expect(mocks.loadAndCheckFragmentFile).toHaveBeenCalled();
    expect(mocks.updateFile).not.toHaveBeenCalled();
  });

  it("passes validator errors through and never stores", async () => {
    mocks.loadAndCheckFragmentFile.mockResolvedValue({
      ok: false,
      errors: [{ code: "FRAGMENT_FILE_SCHEMA_ERROR", message: "bad" }],
    });
    const result = await validateExistingFileAction("my-file", "id: f\n");
    expect(result).toMatchObject({ ok: false, errors: [{ code: "FRAGMENT_FILE_SCHEMA_ERROR" }] });
    expect(mocks.updateFile).not.toHaveBeenCalled();
  });

  it("rejects a non-teacher before any work", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    const result = await validateExistingFileAction("my-file", "id: f\n");
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/teachers/i) });
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });

  it("rejects empty content", async () => {
    const result = await validateExistingFileAction("my-file", "  ");
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/empty/i) });
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });

  it("reports a vanished file", async () => {
    mocks.getActiveFile.mockResolvedValue(null);
    const result = await validateExistingFileAction("my-file", "id: f\n");
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/no longer exists/i),
    });
    expect(mocks.loadAndCheckFragmentFile).not.toHaveBeenCalled();
  });

  it("reports a transient lookup failure (DB down)", async () => {
    mocks.getActiveFile.mockResolvedValue(undefined);
    const result = await validateExistingFileAction("my-file", "id: f\n");
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/try again/i) });
    expect(mocks.loadAndCheckFragmentFile).not.toHaveBeenCalled();
  });
});

// The bulk delete behind the list's "Delete Selected" — the only delete path: the
// teacher gate, the `softDeleteFiles` store primitive, and the list revalidation.
describe("deleteSelectedFilesAction", () => {
  it("rejects a non-teacher and never touches the store", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    const result = await deleteSelectedFilesAction(["a", "b"]);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/teachers/i) });
    expect(mocks.softDeleteFiles).not.toHaveBeenCalled();
  });

  it("deletes the selection with the session user id and revalidates", async () => {
    mocks.softDeleteFiles.mockResolvedValue({ ok: true, deleted: 2 });
    const result = await deleteSelectedFilesAction(["a", "b"]);
    expect(result).toEqual({ ok: true, deleted: 2 });
    expect(mocks.softDeleteFiles).toHaveBeenCalledWith(["a", "b"], "teacher-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/files");
  });

  it("maps a store failure to a retry message", async () => {
    mocks.softDeleteFiles.mockResolvedValue({ ok: false, deleted: 0 });
    const result = await deleteSelectedFilesAction(["a", "b"]);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/could not be deleted/i),
    });
  });
});

// The student GUI's loaders. `loadYamlFromUrlAction` must resolve all three URL
// shapes a tutor's fragment_files can take; `loadFileFromDbAction` is the by-name
// read for the edit flow. Both are teacher-gated.
describe("loadYamlFromUrlAction", () => {
  it("rejects a non-teacher before fetching", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    const result = await loadYamlFromUrlAction({ url: "https://example.com/f.yaml" });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/teachers/i) });
    expect(mocks.defaultFetcher).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) scheme without fetching", async () => {
    const result = await loadYamlFromUrlAction({ url: "ftp://example.com/f.yaml" });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/http/i) });
    expect(mocks.defaultFetcher).not.toHaveBeenCalled();
  });

  it("fetches an absolute external URL via the default fetcher", async () => {
    const result = await loadYamlFromUrlAction({ url: "https://example.com/frag.yaml" });
    expect(result).toEqual({
      ok: true,
      content: "external-yaml",
      resolvedUrl: "https://example.com/frag.yaml",
    });
    expect(mocks.defaultFetcher).toHaveBeenCalledWith("https://example.com/frag.yaml");
  });

  it("resolves a relative URL against baseUrl", async () => {
    const result = await loadYamlFromUrlAction({
      url: "frag.yaml",
      baseUrl: "https://example.com/dir/tutor.yaml",
    });
    expect(result).toMatchObject({ ok: true, resolvedUrl: "https://example.com/dir/frag.yaml" });
    expect(mocks.defaultFetcher).toHaveBeenCalledWith("https://example.com/dir/frag.yaml");
  });

  it("serves an app-hosted URL from the DB instead of a loopback fetch", async () => {
    mocks.getActiveFile.mockResolvedValue({
      name: "sibling",
      kind: "fragment",
      content: "db-yaml",
    });
    const result = await loadYamlFromUrlAction({
      url: "http://localhost:3000/api/files/sibling",
    });
    expect(result).toMatchObject({ ok: true, content: "db-yaml" });
    expect(mocks.getActiveFile).toHaveBeenCalledWith("sibling");
    expect(mocks.defaultFetcher).not.toHaveBeenCalled();
  });

  it("reports a non-OK fetch with its status", async () => {
    mocks.defaultFetcher.mockResolvedValue({ ok: false, status: 404, text: async () => "" });
    const result = await loadYamlFromUrlAction({ url: "https://example.com/missing.yaml" });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/404/) });
  });
});

describe("loadFileFromDbAction", () => {
  it("returns name, kind and content for an active file", async () => {
    mocks.getActiveFile.mockResolvedValue({ name: "my-file", kind: "tutor", content: "yaml" });
    const result = await loadFileFromDbAction("my-file");
    expect(result).toEqual({ ok: true, name: "my-file", kind: "tutor", content: "yaml" });
  });

  it("reports not-found for a vanished file", async () => {
    mocks.getActiveFile.mockResolvedValue(null);
    expect(await loadFileFromDbAction("ghost")).toEqual({ ok: false, reason: "not-found" });
  });

  it("reports error on a transient DB failure", async () => {
    mocks.getActiveFile.mockResolvedValue(undefined);
    expect(await loadFileFromDbAction("my-file")).toEqual({ ok: false, reason: "error" });
  });

  it("rejects a non-teacher", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    expect(await loadFileFromDbAction("my-file")).toEqual({ ok: false, reason: "error" });
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });
});
