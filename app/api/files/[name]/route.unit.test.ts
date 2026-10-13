import { beforeEach, describe, expect, it, vi } from "vitest";

// GET and PUT on one URL, both teacher-bearer only (real auth gate over a stubbed
// `getSession`). The GET tests pin the gate running FIRST (no store lookup for an
// unauthenticated or student caller — no existence oracle) and its status mapping:
// malformed name → 404 (no DB hit), DB error → 503 (transient, not "missing"), no
// active version → 404, active version → 200 raw YAML with no-store. The PUT tests
// pin the 401/403 matrix, the body checks, and the upsert-reason → status mapping.
// The pure validateFileName stays real; getActiveFile and the file service are
// mocked.

const mocks = vi.hoisted(() => ({
  getActiveFile: vi.fn(),
  upsertFileForUser: vi.fn(),
  resolveAppOriginOr: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/file-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/file-store")>();
  return { ...actual, getActiveFile: mocks.getActiveFile };
});
vi.mock("@/lib/file-service", () => ({ upsertFileForUser: mocks.upsertFileForUser }));
vi.mock("@/lib/app-origin", () => ({ resolveAppOriginOr: mocks.resolveAppOriginOr }));

vi.mock("@/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));

import { auth } from "@/auth";
import { bearerSession } from "@/tests/mock-auth-session";
import { GET, PUT } from "./route";

const getSession = vi.mocked(auth.api.getSession);

const req = (token?: string) =>
  new Request("http://localhost/api/files/whatever", {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
const call = async (name: string) => GET(req(await mint()), { params: Promise.resolve({ name }) });

async function mint(teacher = true): Promise<string> {
  getSession.mockResolvedValue(
    bearerSession({ id: "teacher-oid-1", name: "Test Teacher", isTeacher: teacher }),
  );
  return "session-token";
}

async function putRequest(name: string, body: unknown, token?: string): Promise<Response> {
  return PUT(
    new Request(`http://localhost/api/files/${name}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ name }) },
  );
}

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue(null);
  mocks.upsertFileForUser.mockResolvedValue({
    ok: true,
    action: "created",
    name: "linked-lists",
    kind: "tutor",
  });
  mocks.resolveAppOriginOr.mockResolvedValue("https://app.example");
});

describe("GET /api/files/[name] auth", () => {
  it("401s without a token, with WWW-Authenticate, before any lookup", async () => {
    const res = await GET(req(), { params: Promise.resolve({ name: "exam-quiz" }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toEqual({ message: "Unauthorized" });
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });

  it("answers a malformed name the same 401 — no oracle before the gate", async () => {
    const res = await GET(req(), { params: Promise.resolve({ name: "bad name!" }) });
    expect(res.status).toBe(401);
  });

  it("403s a student token without reading the file", async () => {
    const res = await GET(req(await mint(false)), { params: Promise.resolve({ name: "exam" }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "Forbidden" });
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });
});

describe("GET /api/files/[name]", () => {
  it("404s a malformed name without hitting the database", async () => {
    const res = await call("bad name!");
    expect(res.status).toBe(404);
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });

  it("503s when the database is unreachable (transient, not missing)", async () => {
    mocks.getActiveFile.mockResolvedValue(undefined);
    const res = await call("linked-lists");
    expect(res.status).toBe(503);
  });

  it("404s an unknown or soft-deleted file", async () => {
    mocks.getActiveFile.mockResolvedValue(null);
    const res = await call("ghost");
    expect(res.status).toBe(404);
  });

  it("serves the active content as raw YAML with no-store", async () => {
    mocks.getActiveFile.mockResolvedValue({ name: "linked-lists", content: "id: x\n" });
    const res = await call("linked-lists");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/yaml");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("id: x\n");
  });
});

describe("PUT /api/files/[name] auth", () => {
  it("401s without a token, with WWW-Authenticate", async () => {
    const res = await putRequest("linked-lists", { content: "id: x\n" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(mocks.upsertFileForUser).not.toHaveBeenCalled();
  });

  it("403s a valid non-teacher token", async () => {
    const res = await putRequest("linked-lists", { content: "id: x\n" }, await mint(false));
    expect(res.status).toBe(403);
    expect(mocks.upsertFileForUser).not.toHaveBeenCalled();
  });
});

describe("PUT /api/files/[name]", () => {
  it("200s with name, kind, url and action on success", async () => {
    const res = await putRequest(
      "linked-lists",
      { kind: "tutor", content: "id: x\n" },
      await mint(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      name: "linked-lists",
      kind: "tutor",
      url: "https://app.example/api/files/linked-lists",
      action: "created",
    });
    expect(mocks.upsertFileForUser).toHaveBeenCalledWith("teacher-oid-1", {
      name: "linked-lists",
      kind: "tutor",
      content: "id: x\n",
    });
  });

  it("omits kind from the upsert when the body has none (update path)", async () => {
    mocks.upsertFileForUser.mockResolvedValue({
      ok: true,
      action: "updated",
      name: "linked-lists",
      kind: "tutor",
    });
    const res = await putRequest("linked-lists", { content: "id: x\n" }, await mint());
    expect(await res.json()).toMatchObject({ action: "updated" });
    expect(mocks.upsertFileForUser).toHaveBeenCalledWith("teacher-oid-1", {
      name: "linked-lists",
      kind: undefined,
      content: "id: x\n",
    });
  });

  it("400s a non-JSON body, a non-string kind, and a missing content", async () => {
    expect((await putRequest("n", "{not json", await mint())).status).toBe(400);
    expect((await putRequest("n", { kind: 5, content: "x" }, await mint())).status).toBe(400);
    expect((await putRequest("n", { kind: "tutor" }, await mint())).status).toBe(400);
    expect(mocks.upsertFileForUser).not.toHaveBeenCalled();
  });

  it("maps upsert failures: invalid → 400, validation → 400 errors, kind-mismatch/conflict → 409, unavailable → 503", async () => {
    mocks.upsertFileForUser.mockResolvedValue({
      ok: false,
      reason: "invalid",
      message: "bad",
    });
    expect((await putRequest("n", { content: "x" }, await mint())).status).toBe(400);

    mocks.upsertFileForUser.mockResolvedValue({
      ok: false,
      reason: "validation",
      errors: [{ code: "TUTOR_SCHEMA_ERROR", message: "bad" }],
    });
    const validation = await putRequest("n", { content: "x" }, await mint());
    expect(validation.status).toBe(400);
    expect(await validation.json()).toEqual({
      errors: [{ code: "TUTOR_SCHEMA_ERROR", message: "bad" }],
    });

    mocks.upsertFileForUser.mockResolvedValue({
      ok: false,
      reason: "kind-mismatch",
      message: "stored as tutor",
    });
    expect((await putRequest("n", { content: "x" }, await mint())).status).toBe(409);

    mocks.upsertFileForUser.mockResolvedValue({
      ok: false,
      reason: "conflict",
      message: "taken",
    });
    expect((await putRequest("n", { content: "x" }, await mint())).status).toBe(409);

    mocks.upsertFileForUser.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      message: "down",
    });
    expect((await putRequest("n", { content: "x" }, await mint())).status).toBe(503);
  });
});
