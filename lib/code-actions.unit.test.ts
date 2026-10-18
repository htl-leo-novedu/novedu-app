import { beforeEach, describe, expect, it, vi } from "vitest";

// The actions are thin auth + FormData shells around the shared pipeline in
// lib/code-service.ts (covered by code-service.unit.test.ts) — these tests pin
// the SHELL: the teacher gate, the FormData field mapping, the result → form
// state mapping, that create redirects to the new code's edit page, that edit
// saves only the window+note, and that delete is teacher-gated (but NOT
// owner-gated — any effective teacher may manage any code).

const mocks = vi.hoisted(() => ({
  requireTeacherUserId: vi.fn(),
  validateCodeFile: vi.fn(),
  createCode: vi.fn(),
  getCode: vi.fn(),
  updateCode: vi.fn(),
  deleteCodesAndData: vi.fn(),
  loadActivityLlm: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: "localhost:3000" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/student-mode", () => ({ requireTeacherUserId: mocks.requireTeacherUserId }));
vi.mock("@/lib/app-hosted-fetcher", () => ({ appHostedFetcher: () => vi.fn() }));
// Create-time validation is derived from the module's fileKind by the registry's
// `validateCodeFile`; mock it directly.
vi.mock("@/lib/code-modules/registry", () => ({
  validateCodeFile: mocks.validateCodeFile,
}));
vi.mock("@/lib/code-store", async (importOriginal) => {
  // Keep the REAL validateCodeRequest — the actions' validation behavior is part
  // of the contract under test; only the storage calls are mocked.
  const actual = await importOriginal<typeof import("@/lib/code-store")>();
  return {
    ...actual,
    createCode: mocks.createCode,
    getCode: mocks.getCode,
    updateCode: mocks.updateCode,
  };
});
// The destructive store is fully mocked — it pulls in @/app/mastra otherwise.
vi.mock("@/lib/code-stats-store", () => ({
  deleteCodesAndData: mocks.deleteCodesAndData,
}));
// The display-only YAML read (covered by activity-llm.unit.test.ts).
vi.mock("@/lib/activity-llm", () => ({ loadActivityLlm: mocks.loadActivityLlm }));
// validateCodeRequest (imported for real above) pulls in @/lib/db, which must not
// try to talk to a database in unit tests.
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

import {
  createCodeAction,
  deleteSelectedCodesAction,
  readActivityLlmAction,
  updateCodeAction,
} from "@/lib/code-actions";

const FILE = "https://example.com/tutor.yaml";
const START = 1_700_000_000;
const END = 1_700_003_600;

function formData(note = "My class", module = "tutor"): FormData {
  const data = new FormData();
  data.set("module", module);
  data.set("file", FILE);
  data.set("startTs", String(START));
  data.set("endTs", String(END));
  data.set("note", note);
  return data;
}

beforeEach(() => {
  vi.stubEnv("CODE_ORIGIN", "");
  vi.stubEnv("TUTOR_CODE_ORIGIN", "");
  // The shared gate yields the teacher's user id directly (no separate session
  // round trip); the action reuses it.
  mocks.requireTeacherUserId.mockResolvedValue({ ok: true, userId: "teacher-sub-1" });
  mocks.validateCodeFile.mockResolvedValue({
    ok: true,
    warnings: [],
    title: null,
    description: null,
    anonymous: true,
  });
  mocks.createCode.mockResolvedValue({ stored: true, code: "abc123def4" });
  // The service reads the stored row back after a create (the API returns it);
  // tests that exercise updateCodeAction override this per test.
  mocks.getCode.mockResolvedValue({
    code: "abc123def4",
    module: "tutor",
    createdBy: "teacher-sub-1",
    fileUrl: FILE,
    validFrom: new Date(START * 1000),
    validUntil: new Date(END * 1000),
    note: "My class",
    origin: "http://localhost:3000",
    anonymous: true,
    llm: null,
    createdAt: new Date(),
  });
});

describe("createCodeAction", () => {
  it("redirects to the new code's edit page on success", async () => {
    await createCodeAction({ status: "idle" }, formData());
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/codes");
    expect(mocks.redirect).toHaveBeenCalledWith("/codes/edit/abc123def4");
  });

  it("stores the validated payload (with module) under the creating teacher's user id", async () => {
    await createCodeAction({ status: "idle" }, formData("  trimmed note  "));
    expect(mocks.createCode).toHaveBeenCalledWith("teacher-sub-1", {
      module: "tutor",
      fileUrl: FILE,
      validFrom: new Date(START * 1000),
      validUntil: new Date(END * 1000),
      note: "trimmed note",
      origin: "http://localhost:3000",
      anonymous: true,
      llm: null,
    });
  });

  it("passes the LLM override FormData fields through to the pipeline", async () => {
    const data = formData();
    data.set("llmProvider", "SCCH");
    data.set("llmModel", "some-model");
    await createCodeAction({ status: "idle" }, data);
    expect(mocks.createCode).toHaveBeenCalledWith(
      "teacher-sub-1",
      expect.objectContaining({ llm: { provider: "SCCH", model: "some-model" } }),
    );
  });

  it("passes the override's reasoning level through to the pipeline", async () => {
    const data = formData();
    data.set("llmProvider", "SCCH");
    data.set("llmModel", "some-model");
    data.set("llmReasoning", "high");
    await createCodeAction({ status: "idle" }, data);
    expect(mocks.createCode).toHaveBeenCalledWith(
      "teacher-sub-1",
      expect.objectContaining({
        llm: { provider: "SCCH", model: "some-model", reasoning: "high" },
      }),
    );
  });

  it("rejects an unknown module without touching storage", async () => {
    const data = formData();
    data.set("module", "future-module"); // not a built module
    const state = await createCodeAction({ status: "idle" }, data);
    expect(state).toMatchObject({ status: "error", message: expect.stringMatching(/activity/i) });
    expect(mocks.createCode).not.toHaveBeenCalled();
  });

  it("rejects non-teachers", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    const state = await createCodeAction({ status: "idle" }, formData());
    expect(state).toMatchObject({ status: "error", message: expect.stringMatching(/teachers/i) });
    expect(mocks.createCode).not.toHaveBeenCalled();
  });

  it("rejects a file that fails validation, surfacing the full structured error list", async () => {
    mocks.validateCodeFile.mockResolvedValue({
      ok: false,
      errors: [
        {
          code: "TUTOR_SCHEMA_ERROR",
          message: "Document does not match the expected structure",
          zodIssues: { errors: ['Unrecognized key: "nae"'] },
        },
      ],
    });
    const state = await createCodeAction({ status: "idle" }, formData());
    expect(state).toMatchObject({
      status: "error",
      errors: [{ code: "TUTOR_SCHEMA_ERROR", zodIssues: { errors: ['Unrecognized key: "nae"'] } }],
    });
    expect(mocks.createCode).not.toHaveBeenCalled();
  });
});

describe("updateCodeAction", () => {
  const entry = {
    code: "a1b2c3d4e5",
    module: "tutor",
    createdBy: "someone-else",
    fileUrl: FILE,
    anonymous: true,
  };

  beforeEach(() => {
    mocks.getCode.mockResolvedValue(entry);
    mocks.updateCode.mockResolvedValue({ ok: true });
  });

  it("saves the window + note of any teacher's code (URL never submitted) and revalidates", async () => {
    const state = await updateCodeAction("a1b2c3d4e5", { status: "idle" }, formData("  new  "));
    expect(state).toEqual({ status: "saved" });
    expect(mocks.updateCode).toHaveBeenCalledWith("a1b2c3d4e5", {
      validFrom: new Date(START * 1000),
      validUntil: new Date(END * 1000),
      note: "new",
      llm: null,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/codes");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/codes/edit/a1b2c3d4e5");
  });

  it("saves an edited LLM override pair (editable, unlike the module/file URL)", async () => {
    const data = formData();
    data.set("llmProvider", "SCCH");
    data.set("llmModel", "another-model");
    const state = await updateCodeAction("a1b2c3d4e5", { status: "idle" }, data);
    expect(state).toEqual({ status: "saved" });
    expect(mocks.updateCode).toHaveBeenCalledWith(
      "a1b2c3d4e5",
      expect.objectContaining({ llm: { provider: "SCCH", model: "another-model" } }),
    );
  });

  it("rejects a reasoning level without the override pair, without writing", async () => {
    const data = formData();
    data.set("llmReasoning", "low");
    const state = await updateCodeAction("a1b2c3d4e5", { status: "idle" }, data);
    expect(state).toMatchObject({
      status: "error",
      message: expect.stringMatching(/reasoning level/i),
    });
    expect(mocks.updateCode).not.toHaveBeenCalled();
  });

  it("rejects an override provider this server has not configured, without writing", async () => {
    vi.stubEnv("AZURE_FOUNDRY_ENDPOINT", "");
    const data = formData();
    data.set("llmProvider", "Azure Foundry");
    data.set("llmModel", "gpt-5.4-mini");
    const state = await updateCodeAction("a1b2c3d4e5", { status: "idle" }, data);
    expect(state).toMatchObject({
      status: "error",
      message: expect.stringMatching(/Azure Foundry/),
    });
    expect(mocks.updateCode).not.toHaveBeenCalled();
  });

  it("rejects non-teachers and never writes", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    const state = await updateCodeAction("a1b2c3d4e5", { status: "idle" }, formData());
    expect(state).toMatchObject({ status: "error", message: expect.stringMatching(/teachers/i) });
    expect(mocks.updateCode).not.toHaveBeenCalled();
  });

  it("errors when the code no longer exists", async () => {
    mocks.getCode.mockResolvedValue(null);
    const state = await updateCodeAction("a1b2c3d4e5", { status: "idle" }, formData());
    expect(state).toMatchObject({ status: "error", message: expect.stringMatching(/no longer/i) });
    expect(mocks.updateCode).not.toHaveBeenCalled();
  });

  it("surfaces a retry hint when the lookup itself fails", async () => {
    mocks.getCode.mockResolvedValue(undefined);
    const state = await updateCodeAction("a1b2c3d4e5", { status: "idle" }, formData());
    expect(state).toMatchObject({ status: "error", message: expect.stringMatching(/try again/i) });
    expect(mocks.updateCode).not.toHaveBeenCalled();
  });

  it("surfaces validation errors (e.g. end before start) without writing", async () => {
    const data = formData();
    data.set("startTs", String(END));
    data.set("endTs", String(START));
    const state = await updateCodeAction("a1b2c3d4e5", { status: "idle" }, data);
    expect(state).toMatchObject({ status: "error" });
    expect(mocks.updateCode).not.toHaveBeenCalled();
  });
});

// The bulk delete behind the list's "Delete Selected" — the only way to delete a
// code: teacher-gated (NOT owner-gated) and runs `deleteCodesAndData`.
describe("deleteSelectedCodesAction", () => {
  it("deletes the selected codes and revalidates — no ownership check", async () => {
    mocks.deleteCodesAndData.mockResolvedValue({ ok: true, deleted: 2 });
    const result = await deleteSelectedCodesAction(["a1b2c3d4e5", "f6g7h8i9j0"]);
    expect(result).toEqual({ ok: true, deleted: 2 });
    expect(mocks.deleteCodesAndData).toHaveBeenCalledWith(["a1b2c3d4e5", "f6g7h8i9j0"]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/codes");
  });

  it("rejects non-teachers and never touches the data", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    const result = await deleteSelectedCodesAction(["a1b2c3d4e5"]);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/teachers/i) });
    expect(mocks.deleteCodesAndData).not.toHaveBeenCalled();
  });

  it("reports failure (no revalidate) when the bulk delete fails", async () => {
    mocks.deleteCodesAndData.mockResolvedValue({ ok: false, deleted: 0 });
    const result = await deleteSelectedCodesAction(["a1b2c3d4e5"]);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/repeat/i) });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

// The code form's read-only "Activity's LLM" line: teacher-gated, http(s) only, and
// whatever goes wrong is `null` (one generic warning in the form).
describe("readActivityLlmAction", () => {
  const LLM = { provider: "OpenRouter", model: "google/gemma-4", reasoning: "high" };

  beforeEach(() => {
    mocks.loadActivityLlm.mockReset().mockResolvedValue(LLM);
  });

  it("reads the YAML's llm block at the trimmed, normalized URL", async () => {
    await expect(readActivityLlmAction(`  ${FILE}  `)).resolves.toEqual(LLM);
    expect(mocks.loadActivityLlm).toHaveBeenCalledWith(FILE);
  });

  it("is null when the file can't be read", async () => {
    mocks.loadActivityLlm.mockResolvedValue(null);
    await expect(readActivityLlmAction(FILE)).resolves.toBeNull();
  });

  it("rejects non-teachers without reading anything", async () => {
    mocks.requireTeacherUserId.mockResolvedValue({ ok: false });
    await expect(readActivityLlmAction(FILE)).resolves.toBeNull();
    expect(mocks.loadActivityLlm).not.toHaveBeenCalled();
  });

  it("reads nothing for a blank, malformed or non-http(s) URL", async () => {
    for (const url of ["", "not a url", "file:///etc/passwd", "ftp://example.com/a.yaml"]) {
      await expect(readActivityLlmAction(url)).resolves.toBeNull();
    }
    await expect(readActivityLlmAction(42 as unknown as string)).resolves.toBeNull();
    expect(mocks.loadActivityLlm).not.toHaveBeenCalled();
  });
});
